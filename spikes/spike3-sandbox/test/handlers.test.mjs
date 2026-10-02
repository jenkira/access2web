import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { setup, closePools, adminUrl } from "../src/db.mjs";
import { ModulePool } from "../src/sandbox.mjs";
import { runHandlerTx, baseInput } from "../src/run.mjs";
import { checkHandler } from "../src/check.mjs";

const mods = new ModulePool(4);
const src = (n) => readFileSync(new URL(`../handlers/${n}.ts`, import.meta.url), "utf8");
const inputs = JSON.parse(readFileSync(new URL("../handlers/inputs.json", import.meta.url), "utf8"));
const run = (name, i, extra = {}) =>
  runHandlerTx({ modulePool: mods, source: src(name), input: baseInput({ ...inputs[name].inputs[i] }), noDb: !inputs[name].db, ...extra });
const admin = async (sql, params = []) => { const c = new pg.Client({ connectionString: adminUrl() }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };

before(async () => { await setup(); });
after(async () => { await closePools(); });

test("every handler passes the static check", () => {
  for (const n of Object.keys(inputs)) assert.deepEqual(checkHandler(src(n)), [], n);
});

test("01 price validation", async () => {
  let r = await run("01-validate-price", 0);
  assert.equal(r.status, "ok"); assert.equal(r.value.valid, false);
  assert.deepEqual(r.ui.map((u) => u.op), ["message", "cancel"]);
  assert.equal((await run("01-validate-price", 2)).value.valid, true);
});

test("02 line total", async () => {
  assert.equal((await run("02-line-total", 0)).value.total, 6.75);
  assert.equal((await run("02-line-total", 1)).value.total, 1.25);
  assert.deepEqual((await run("02-line-total", 0)).ui, [{ op: "setValue", field: "line_total", value: 6.75 }]);
});

test("03 dates", async () => {
  assert.equal((await run("03-validate-dates", 0)).value.valid, false);
  assert.equal((await run("03-validate-dates", 1)).value.valid, true);
  assert.equal((await run("03-validate-dates", 2)).value.valid, true);
});

test("04 defaults use the event time, not the clock", async () => {
  const r = await run("04-new-order-defaults", 0);
  assert.deepEqual(r.ui, [{ op: "setValue", field: "status", value: "new" }, { op: "setValue", field: "order_date", value: "2026-03-01" }, { op: "setVisible", control: "ship_date", value: false }]);
  assert.deepEqual((await run("04-new-order-defaults", 1)).ui, [{ op: "setVisible", control: "ship_date", value: true }]);
});

test("05 credit check reads the database", async () => {
  assert.equal((await run("05-credit-check", 0)).value.exceeded, false);
  assert.equal((await run("05-credit-check", 1)).value.exceeded, true);
  assert.equal((await run("05-credit-check", 2)).value.exceeded, true);
});

test("06 stock update changes data and cancels when stock is short", async () => {
  const ok = await run("06-update-stock", 0);
  assert.deepEqual(ok.value, { ok: true, stock: 95 });
  assert.equal(ok.committed, false);
  assert.equal((await admin("select stock from app_a.products where id = 1"))[0].stock, 100, "not committed, so unchanged");
  const short = await run("06-update-stock", 1);
  assert.equal(short.value.ok, false); assert.equal(short.ui.at(-1).op, "cancel");
});

test("07 loop over records", async () => {
  assert.deepEqual((await run("07-recalc-order-total", 0)).value, { total: 75, lines: 2 });
  assert.deepEqual((await run("07-recalc-order-total", 1)).value, { total: 40, lines: 1 });
  assert.deepEqual((await run("07-recalc-order-total", 2)).value, { total: 0, lines: 0 });
});

test("08 name formatting", async () => {
  assert.equal((await run("08-full-name", 0)).value.name, "Lovelace, Ada");
  assert.equal((await run("08-full-name", 1)).value.name, "Turing");
  assert.equal((await run("08-full-name", 2)).value.name, "Grace");
});

test("09 status transitions", async () => {
  assert.equal((await run("09-status-transition", 0)).value.allowed, true);
  assert.equal((await run("09-status-transition", 1)).value.allowed, false);
  assert.equal((await run("09-status-transition", 2)).value.allowed, true);
});

test("10 archive loop", async () => {
  assert.equal((await run("10-archive-old-orders", 0)).value.archived, 4);
  assert.equal((await run("10-archive-old-orders", 1)).value.archived, 3);
  assert.equal((await run("10-archive-old-orders", 2)).value.archived, 0);
});

// ---- transactions
const FAILING = `function handler() { db.query("update products set stock = 0 where id = $1 returning id", [1]); throw new Error("boom"); }`;

test("a handler that throws leaves no partial change", async () => {
  const r = await runHandlerTx({ modulePool: mods, source: FAILING, commit: true });
  assert.equal(r.status, "error"); assert.equal(r.committed, false);
  assert.equal((await admin("select stock from app_a.products where id = 1"))[0].stock, 100);
});

test("a handler that cancels rolls back its writes", async () => {
  const src2 = `function handler() { db.query("update products set stock = 1 where id = $1 returning id", [1]); ui.cancel("no"); }`;
  const r = await runHandlerTx({ modulePool: mods, source: src2, commit: true });
  assert.equal(r.committed, false);
  assert.equal((await admin("select stock from app_a.products where id = 1"))[0].stock, 100);
});

test("a handler that hits the time limit after writing leaves no change", async () => {
  const s = `function handler() { db.query("update products set stock = 0 where id = $1 returning id", [1]); while (true) {} }`;
  const r = await runHandlerTx({ modulePool: mods, source: s, commit: true, useCheck: false });
  assert.equal(r.status, "time_limit"); assert.equal(r.committed, false);
  assert.equal((await admin("select stock from app_a.products where id = 1"))[0].stock, 100);
});

test("a successful handler commits when asked", async () => {
  const s = `function handler() { return db.query("update products set stock = stock - 1 where id = $1 returning stock", [1]); }`;
  const r = await runHandlerTx({ modulePool: mods, source: s, commit: true });
  assert.equal(r.committed, true);
  assert.equal((await admin("select stock from app_a.products where id = 1"))[0].stock, 99);
  await admin("update app_a.products set stock = 100 where id = 1");
});
