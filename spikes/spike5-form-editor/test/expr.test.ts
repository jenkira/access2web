import test from "node:test";
import assert from "node:assert/strict";
import { ExprError, evaluate, parse, refs, renameRef, tokenize } from "../src/model/expr.ts";

test("references are found once each, and functions and literals are not references", () => {
  assert.deepEqual(refs("a > 1 && !isnull(b) || a * 2 <= 10"), ["a", "b"]);
  assert.deepEqual(refs("true && null == x"), ["x"]);
  assert.deepEqual(refs("coalesce(a, b, 'c')"), ["a", "b"]);
});

test("arithmetic, comparison, and precedence", () => {
  assert.equal(evaluate("1 + 2 * 3", {}), 7);
  assert.equal(evaluate("(1 + 2) * 3", {}), 9);
  assert.equal(evaluate("10 - 4 - 3", {}), 3);
  assert.equal(evaluate("a >= 3 && a < 5", { a: 4 }), true);
  assert.equal(evaluate("a == 'x' || b", { a: "y", b: false }), false);
  assert.equal(evaluate("-a + 5", { a: 2 }), 3);
});

test("null follows SQL: comparisons with null are false, arithmetic with null is null", () => {
  assert.equal(evaluate("a > 1", { a: null }), false);
  assert.equal(evaluate("a + 1", { a: null }), null);
  assert.equal(evaluate("isnull(a)", { a: null }), true);
  assert.equal(evaluate("isnull(a)", { a: "" }), true);
  assert.equal(evaluate("coalesce(a, 5)", { a: null }), 5);
  assert.equal(evaluate("a / 0", { a: 1 }), null);
});

test("functions", () => {
  assert.equal(evaluate("len(a)", { a: "abcd" }), 4);
  assert.equal(evaluate("upper(a) == 'AB'", { a: "ab" }), true);
  assert.equal(evaluate("today()", {}, new Date("2026-03-01T10:00:00Z")), "2026-03-01");
});

test("invalid expressions are rejected with a position", () => {
  for (const bad of ["a +", "foo(1)", "a b", "'x", "(a", "a = 1", "1 +* 2", "", "a &"]) {
    assert.throws(() => parse(bad), (e: unknown) => e instanceof ExprError, JSON.stringify(bad));
  }
});

test("rename changes identifiers only, and keeps the author's spacing", () => {
  assert.equal(renameRef("Qty*Price > 1 && isnull(Qty)", "Qty", "Quantity"), "Quantity*Price > 1 && isnull(Quantity)");
  assert.equal(renameRef("name == 'name' && len(name) > 0", "name", "title"), "title == 'name' && len(title) > 0");
  assert.equal(renameRef("isnull(a)", "isnull", "x"), "isnull(a)", "a function is not a field");
  assert.equal(renameRef("a_b + a", "a", "z"), "a_b + z", "a longer name is not touched");
});

test("renaming leaves an expression that means the same thing", () => {
  const rec = { a: 3, b: 4 };
  for (const src of ["a * b + a", "a > 2 && !isnull(b)", "coalesce(a, b) / 2"]) {
    assert.equal(evaluate(renameRef(src, "a", "zz"), { zz: 3, b: 4 }), evaluate(src, rec));
  }
});

test("tokenizer keeps positions", () => {
  const t = tokenize("ab + 12");
  assert.deepEqual(t.map((x) => [x.kind, x.start, x.end]), [["ident", 0, 2], ["op", 3, 4], ["num", 5, 7], ["eof", 7, 7]]);
});
