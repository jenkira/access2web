import test from "node:test";
import assert from "node:assert/strict";
import { checkSql, SqlRejected } from "../src/sqlguard.mjs";
import { checkHandler } from "../src/check.mjs";

const ok = (s, p = []) => assert.doesNotThrow(() => checkSql(s, p), s);
const bad = (s, p = []) => assert.throws(() => checkSql(s, p), SqlRejected, s);

test("sql guard accepts parameterised statements", () => {
  ok("select id from customers where id = $1", [1]);
  ok("update orders set total = $1 where id = $2 returning id", [5, 1]);
  ok("with t as (select 1 as x) select x from t");
  ok("insert into orderlines (qty) values ($1) returning id", [3]);
});

test("sql guard rejects quotes, comments, and statement separators", () => {
  bad("select 'x'"); bad('select "x"'); bad("select 1; select 2"); bad("select 1 -- c"); bad("select /* c */ 1"); bad("select $$x$$");
  bad("select e\\x");
});

test("sql guard rejects other statement types and risky functions", () => {
  for (const s of ["drop table x", "create table x(a int)", "set role app_b", "reset role", "copy x to stdout", "grant all on x to y", "call p()", "do $x$ begin end $x$"]) bad(s);
  for (const s of ["select set_config($1,$2,true)", "select current_setting($1)", "select pg_read_file($1)", "select lo_import($1)", "select dblink($1)", "select pg_terminate_backend(1)"]) bad(s, ["a", "b"]);
});

test("sql guard checks parameters", () => {
  bad("select $1", [{}]); bad("select $1", [[1]]); bad("select $1", "x"); bad("select $1", Array(51).fill(1));
  ok("select $1", [null]); ok("select $1", [true]);
});

test("static check flags banned names, imports, and string-built SQL", () => {
  assert.ok(checkHandler("import x from 'y'; function handler(){}").length);
  assert.ok(checkHandler("function handler(){ return fetch('x'); }").length);
  assert.ok(checkHandler("function handler(){ return eval('1'); }").length);
  assert.ok(checkHandler("function handler(){ return db.query('select ' + 1); }").length);
  assert.ok(checkHandler("function handler(){ const s = 'x'; return db.query(s); }").length);
  assert.ok(checkHandler("function handler(){ return db.query(`select ${1}`); }").length);
  assert.deepEqual(checkHandler("function handler(){ return db.query('select 1 as x', []); }"), []);
  assert.deepEqual(checkHandler("function handler(){ return db.query(`select 1 as x`); }"), []);
});

test("static check does not flag property names that match banned words", () => {
  assert.deepEqual(checkHandler("function handler(){ return ctx.record.new?.process; }"), []);
});
