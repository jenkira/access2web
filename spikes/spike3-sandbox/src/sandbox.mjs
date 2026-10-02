// Spike 3 host: runs a handler in QuickJS compiled to WebAssembly.
// Each call gets a clean runtime and context (the clean-instance rule in the technical design).
import { newQuickJSAsyncWASMModule, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { checkSql } from "./sqlguard.mjs";
import { transpile } from "./check.mjs";
import { applyUi } from "./ui.mjs";

export const DEFAULT_LIMITS = {
  timeMs: 250,            // wall-clock limit for the whole handler, including database waits
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  maxQueries: 100,
  maxRows: 5000,
  maxResultBytes: 256 * 1024,
  maxUi: 100,
  hardMs: 2000,           // the host gives up on a run that ignores the limits
};


// One suspended asyncified call at a time per module instance, so concurrent runs need separate modules.
export class ModulePool {
  constructor(size = 4) { this.size = size; this.free = []; this.created = 0; this.waiters = []; }
  async acquire() {
    if (this.free.length) return this.free.pop();
    if (this.created < this.size) { this.created++; return { mod: await newQuickJSAsyncWASMModule() }; }
    return new Promise((res) => this.waiters.push(res));
  }
  release(slot, poisoned = false) {
    if (poisoned) {  // a module that ran an abandoned call is not reused
      this.created--;
      if (this.waiters.length) { this.created++; newQuickJSAsyncWASMModule().then((mod) => this.waiters.shift()({ mod })); }
      return;
    }
    if (this.waiters.length) this.waiters.shift()(slot); else this.free.push(slot);
  }
}

export const PRELUDE = `
(() => {
  const input = JSON.parse(__input);
  const dbq = __dbq, uiq = __ui;
  const deepFreeze = (o) => { if (o && typeof o === "object") { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };
  const ctx = deepFreeze(input);
  const db = Object.freeze({ query: (sql, params) => JSON.parse(dbq(String(sql), JSON.stringify(params === undefined ? [] : params))) });
  const ui = Object.freeze({
    message: (t) => uiq("message", t), setVisible: (c, v) => uiq("setVisible", c, v),
    setValue: (f, v) => uiq("setValue", f, v), cancel: (r) => uiq("cancel", r),
  });
  // No clock and no randomness except what the host gives: ctx.now is the time of the event.
  const FROZEN = Date.parse(ctx.now), D = Date;
  function FrozenDate(...a) { if (!new.target) return new D(FROZEN).toString(); return a.length ? new D(...a) : new D(FROZEN); }
  FrozenDate.prototype = D.prototype; FrozenDate.now = () => FROZEN; FrozenDate.parse = D.parse; FrozenDate.UTC = D.UTC;
  Object.defineProperty(D.prototype, "constructor", { value: FrozenDate, writable: false, configurable: false });
  Object.defineProperty(globalThis, "Date", { value: FrozenDate, writable: false, configurable: false });
  Object.defineProperty(Math, "random", { value: () => { throw new Error("Math.random is not available to handlers"); }, writable: false, configurable: false });
  Object.defineProperty(globalThis, "ctx", { value: ctx, writable: false, configurable: false });
  Object.defineProperty(globalThis, "db", { value: db, writable: false, configurable: false });
  Object.defineProperty(globalThis, "ui", { value: ui, writable: false, configurable: false });
  delete globalThis.__input; delete globalThis.__dbq; delete globalThis.__ui;
})();
`;

function describe(err) {
  if (err && typeof err === "object") return { name: String(err.name ?? "Error"), message: String(err.message ?? "").slice(0, 300) };
  return { name: "Error", message: String(err).slice(0, 300) };
}

/**
 * Run one handler. `client` is a pg client already inside a transaction, or null for handlers with no database.
 * The caller owns the transaction. This function reports whether the handler succeeded.
 */
export async function runQuickJS({ pool, js, input, client = null, limits = {}, unsafeNoSqlGuard = false }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const t0 = performance.now();
  const stats = { queries: 0, dbMs: 0 };
  const ui = [];
  const slot = await pool.acquire();
  let poisoned = false;
  let runtime, vm;
  const out = { status: "ok", value: null, ui, error: null, stats };
  const watchdog = new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("host watchdog: run ignored its limits"), { name: "WatchdogTimeout" })), L.hardMs).unref());
  try {
    runtime = slot.mod.newRuntime();
    runtime.setMemoryLimit(L.memoryBytes);
    runtime.setMaxStackSize(L.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + L.timeMs));
    vm = runtime.newContext();

    const setStr = (name, value) => { const h = vm.newString(value); vm.setProp(vm.global, name, h); h.dispose(); };
    setStr("__input", JSON.stringify(input));

    const dbFn = vm.newAsyncifiedFunction("__dbq", async (sqlH, paramsH) => {
      const sql = vm.getString(sqlH);
      let params;
      try { params = JSON.parse(vm.getString(paramsH)); } catch { throw new Error("params are not valid JSON"); }
      if (!client) throw new Error("this handler has no database access");
      if (++stats.queries > L.maxQueries) throw new Error(`more than ${L.maxQueries} queries in one run`);
      if (!unsafeNoSqlGuard) checkSql(sql, params);  // the flag exists only so the hostile suite can test the layers below the guard
      const s = performance.now();
      try {
        const r = await client.query({ text: sql, values: params });
        const rows = r.rows ?? [];
        if (rows.length > L.maxRows) throw new Error(`query returned more than ${L.maxRows} rows`);
        const text = JSON.stringify(rows);
        if (text.length > L.maxResultBytes) throw new Error("query result is too large");
        return vm.newString(text);
      } finally { stats.dbMs += performance.now() - s; }
    });
    vm.setProp(vm.global, "__dbq", dbFn); dbFn.dispose();

    const uiFn = vm.newFunction("__ui", (opH, aH, bH) => applyUi(ui, L, vm.getString(opH), vm.dump(aH), bH ? vm.dump(bH) : undefined));
    vm.setProp(vm.global, "__ui", uiFn); uiFn.dispose();

    const body = async () => {
      vm.unwrapResult(await vm.evalCodeAsync(PRELUDE, "prelude.js")).dispose();
      const code = `${js}\n;JSON.stringify((() => { const r = handler(); return r === undefined ? null : r; })())`;
      const res = await vm.evalCodeAsync(code, "handler.js");
      if (res.error) { const e = vm.dump(res.error); res.error.dispose(); throw Object.assign(new Error(e?.message ?? String(e)), { name: e?.name ?? "Error", fromVm: true }); }
      const text = vm.getString(res.value); res.value.dispose();
      if (text.length > L.maxResultBytes) throw Object.assign(new Error("handler result is too large"), { name: "ResultRejected" });
      out.value = JSON.parse(text);
    };
    await Promise.race([body(), watchdog]);
  } catch (e) {
    const d = describe(e);
    out.error = d;
    if (d.name === "WatchdogTimeout") { out.status = "watchdog"; poisoned = true; }
    else if (/interrupted/i.test(d.message)) out.status = "time_limit";
    else if (/out of memory/i.test(d.message)) out.status = "memory_limit";
    else if (/call stack/i.test(d.message)) out.status = "stack_limit";
    else if (d.name === "SqlRejected" || d.name === "ResultRejected") out.status = "rejected";
    else out.status = "error";
  } finally {
    if (!poisoned) {
      try { vm?.dispose(); } catch { /* a context that hit a limit can fail to dispose; the runtime goes with it */ }
      try { runtime?.dispose(); } catch { /* same */ }
    }
    pool.release(slot, poisoned);
  }
  out.ms = performance.now() - t0;
  out.vmMs = out.ms - stats.dbMs;
  return out;
}
