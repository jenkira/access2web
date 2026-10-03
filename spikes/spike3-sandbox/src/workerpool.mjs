// Pool of worker threads that each run one handler at a time. A run that outlives its hard limit
// has its thread terminated, whatever the guest code is doing.
import { Worker } from "node:worker_threads";
import { DEFAULT_LIMITS } from "./sandbox.mjs";

const WORKER = new URL("./worker.mjs", import.meta.url);

export class WorkerPool {
  // `all` holds every live worker, busy or idle. close() must end all of them: a worker thread that is still alive keeps the
  // process alive, so a pool that ended only its idle workers hung the process at exit.
  constructor(size = 4) { this.size = size; this.idle = []; this.count = 0; this.waiters = []; this.all = new Set(); }

  async spawn() {
    const worker = new Worker(WORKER);
    this.all.add(worker);
    try {
      await new Promise((res, rej) => { worker.once("message", (m) => (m.type === "ready" ? res() : rej(new Error("bad hello")))); worker.once("error", rej); });
    } catch (e) { this.all.delete(worker); await worker.terminate(); throw e; }
    return { worker };
  }

  async take() {
    if (this.idle.length) return this.idle.pop();
    if (this.count < this.size) { this.count++; try { return await this.spawn(); } catch (e) { this.count--; throw e; } }
    return new Promise((res) => this.waiters.push(res));
  }

  give(w, poisoned) {
    if (poisoned) {
      this.all.delete(w.worker);
      w.worker.terminate();
      this.count--;
      if (this.waiters.length) {
        this.count++;
        // The waiter may be gone by the time the worker is ready, so the worker is never assumed to have one.
        this.spawn().then((n) => { const next = this.waiters.shift(); if (next) next(n); else this.idle.push(n); },
                          () => { this.count--; });
      }
      return;
    }
    if (this.waiters.length) this.waiters.shift()(w); else this.idle.push(w);
  }

  /** Same contract as runQuickJS, so callers can swap one for the other. */
  async run({ js, input, client = null, limits = {}, unsafeNoSqlGuard = false }) {
    const L = { ...DEFAULT_LIMITS, ...limits };
    const hardMs = limits.hardMs ?? L.timeMs + 500;
    const w = await this.take();
    const t0 = performance.now();
    return new Promise((resolve) => {
      let done = false;
      const finish = (result, poisoned) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        w.worker.off("message", onMsg);
        w.worker.off("error", onErr);
        result.ms = performance.now() - t0;
        result.vmMs = result.ms - (result.stats?.dbMs ?? 0);
        this.give(w, poisoned);
        resolve(result);
      };
      const empty = (status, name, message) => ({ status, value: null, ui: [], error: { name, message }, stats: { queries: 0, dbMs: 0 } });
      const onMsg = async (m) => {
        if (m.type === "db") {
          try {
            const r = await client.query({ text: m.text, values: m.values });
            if (!done) w.worker.postMessage({ type: "dbres", id: m.id, rows: r.rows });
          } catch (e) {
            if (!done) w.worker.postMessage({ type: "dbres", id: m.id, error: { name: e.name, message: e.message } });
          }
        } else if (m.type === "done") finish(m.result, false);
      };
      const onErr = (e) => finish(empty("worker_crash", e.name ?? "Error", String(e.message)), true);
      const timer = setTimeout(() => finish(empty("watchdog", "WatchdogTimeout", `worker terminated after ${hardMs} ms`), true), hardMs);
      w.worker.on("message", onMsg);
      w.worker.once("error", onErr);
      w.worker.postMessage({ type: "run", js, input, limits: { ...limits, hardMs: hardMs + 1000 }, unsafe: unsafeNoSqlGuard, hasDb: !!client });
    });
  }

  async close() {
    const all = [...this.all];
    this.all.clear(); this.idle = []; this.waiters = [];
    await Promise.all(all.map((w) => w.terminate()));
  }
}
