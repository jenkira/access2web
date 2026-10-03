// Runs each of the 10 handlers 1,000 times and records time, including start-up (a clean instance each run).
import fs from "node:fs";
import { setup, closePools } from "./db.mjs";
import { ModulePool } from "./sandbox.mjs";
import { WorkerPool } from "./workerpool.mjs";
import { runIvm } from "./ivm.mjs";
import { runHandlerTx, baseInput } from "./run.mjs";

const RUNS = Number(process.env.RUNS ?? 1000);
const dir = new URL("../handlers/", import.meta.url);
const inputs = JSON.parse(fs.readFileSync(new URL("inputs.json", dir), "utf8"));
const names = Object.keys(inputs);
const src = (n) => fs.readFileSync(new URL(`${n}.ts`, dir), "utf8");

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const stats = (arr) => ({ p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: Math.max(...arr), mean: arr.reduce((a, b) => a + b, 0) / arr.length });
const r2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));

async function measure(label, makeRunner) {
  const { runner, modulePool, close } = makeRunner();
  const out = { label, handlers: {}, all: [], allVm: [] };
  const coldT = performance.now();
  await runHandlerTx({ modulePool, runner, source: `function handler() { return 1; }`, noDb: true });
  out.coldStartMs = Math.round(performance.now() - coldT);
  for (const n of names) {
    const total = [], vm = [];
    const s = src(n);
    for (let i = 0; i < RUNS + 20; i++) {
      const input = baseInput(inputs[n].inputs[i % inputs[n].inputs.length]);
      const r = await runHandlerTx({ modulePool, runner, source: s, input, noDb: !inputs[n].db, commit: false });
      if (r.status !== "ok") throw new Error(`${n} run ${i}: ${r.status} ${JSON.stringify(r.error)}`);
      if (i >= 20) { total.push(r.ms); vm.push(r.vmMs); }  // the first 20 runs warm the JIT and the connection pool
    }
    out.handlers[n] = { db: inputs[n].db, total: r2(stats(total)), sandboxOnly: r2(stats(vm)) };
    out.all.push(...total); out.allVm.push(...vm);
    console.log(label.padEnd(10), n.padEnd(24), "p50", out.handlers[n].total.p50, "p95", out.handlers[n].total.p95, "max", out.handlers[n].total.max, "ms");
  }
  out.overall = { total: r2(stats(out.all)), sandboxOnly: r2(stats(out.allVm)), runs: out.all.length };
  delete out.all; delete out.allVm;
  // Concurrency: 16 runs at once through the pool.
  const t = performance.now();
  await Promise.all(Array.from({ length: 64 }, (_, i) => runHandlerTx({ modulePool, runner, source: src("07-recalc-order-total"), input: baseInput(inputs["07-recalc-order-total"].inputs[i % 3]) })));
  out.concurrent64Ms = Math.round(performance.now() - t);
  await close();
  return out;
}

await setup();
const results = [];
results.push(await measure("worker", () => { const p = new WorkerPool(4); return { runner: (o) => p.run(o), modulePool: null, close: () => p.close() }; }));
results.push(await measure("v8-isolate", () => ({ runner: (o) => runIvm(o), modulePool: null, close: async () => {} })));
results.push(await measure("in-process", () => { const p = new ModulePool(4); return { runner: null, modulePool: p, close: async () => {} }; }));
await closePools();
fs.mkdirSync(new URL("../work", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../work/normal.json", import.meta.url), JSON.stringify(results, null, 1));
for (const r of results) console.log(r.label, "overall", JSON.stringify(r.overall), "cold start", r.coldStartMs, "ms; 64 concurrent runs", r.concurrent64Ms, "ms");
process.exit(0);
