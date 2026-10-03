import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setup, closePools } from "../src/db.mjs";
import { WorkerPool } from "../src/workerpool.mjs";
import { runHandlerTx, baseInput } from "../src/run.mjs";

const pool = new WorkerPool(4);
const runner = (o) => pool.run(o);
const handler = (n) => readFileSync(new URL(`../handlers/${n}.ts`, import.meta.url), "utf8");

before(async () => { await setup(); });
after(async () => { await pool.close(); await closePools(); });

const bomb = `function handler() { return new Array(2e9).fill(0).length; }`;
const loop = `function handler() { while (true) {} }`;
const regex = `function handler() { return /^(a+)+$/.test("a".repeat(45) + "b"); }`;

test("hostile runs do not disturb concurrent normal runs", async () => {
  const t0 = performance.now();
  const normal = Array.from({ length: 12 }, (_, i) => runHandlerTx({
    runner, source: handler("07-recalc-order-total"), input: baseInput({ record: { new: { id: (i % 2) + 1 } } }) }));
  const hostile = [bomb, loop, regex, bomb].map((source) => runHandlerTx({ runner, source, noDb: true, useCheck: false }));
  const [good, bad] = await Promise.all([Promise.all(normal), Promise.all(hostile)]);
  for (const [i, r] of good.entries()) {
    assert.equal(r.status, "ok", `normal run ${i}`);
    assert.equal(r.value.total, (i % 2) + 1 === 1 ? 75 : 40);
  }
  assert.deepEqual(bad.map((r) => r.status).sort(), ["memory_limit", "memory_limit", "time_limit", "watchdog"].sort());
  assert.ok(performance.now() - t0 < 4000, "everything finishes within a few seconds");
});

test("the pool recovers after it terminates a worker", async () => {
  const r1 = await runHandlerTx({ runner, source: regex, noDb: true, useCheck: false });
  assert.equal(r1.status, "watchdog");
  for (let i = 0; i < 6; i++) {
    const r = await runHandlerTx({ runner, source: `function handler() { return ${i}; }`, noDb: true });
    assert.equal(r.value, i);
  }
});

test("a run that leaves state behind does not affect the next run", async () => {
  await runHandlerTx({ runner, source: `function handler() { globalThis.leak = 1; Object.prototype.polluted = 1; return 1; }`, noDb: true, useCheck: false });
  const r = await runHandlerTx({ runner, source: `function handler() { return [typeof leak, typeof ({}).polluted]; }`, noDb: true });
  assert.deepEqual(r.value, ["undefined", "undefined"]);
});

test("a failed handler through the worker pool still rolls back", async () => {
  const r = await runHandlerTx({ runner, commit: true, source: `function handler() { db.query("update products set stock = 0 where id = $1 returning id", [2]); throw new Error("x"); }` });
  assert.equal(r.status, "error"); assert.equal(r.committed, false);
  const check = await runHandlerTx({ runner, source: `function handler() { return db.query("select stock from products where id = $1", [2]); }` });
  assert.equal(Number(check.value[0].stock), 20);
});
