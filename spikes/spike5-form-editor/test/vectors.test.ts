// The shared conformance vectors. The Python evaluator in backend/a2w/expr.py runs the same file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ExprError, evaluate, refs, renameRef } from "../src/model/expr.ts";

const spec = JSON.parse(readFileSync(new URL("../../../spec/expression/vectors.json", import.meta.url), "utf8"));
type Expect = { error: true } | { value: unknown };

test(`evaluate: ${spec.cases.length} cases`, () => {
  const failures: string[] = [];
  for (const c of spec.cases as { expr: string; record?: Record<string, unknown>; now?: string; expect: Expect; note?: string }[]) {
    const now = new Date(c.now ?? spec.now);
    try {
      const got = evaluate(c.expr, c.record ?? {}, now);
      if ("error" in c.expect) failures.push(`${JSON.stringify(c.expr)}: expected an error, got ${JSON.stringify(got)}`);
      else if (!Object.is(got, c.expect.value) && got !== c.expect.value) failures.push(`${JSON.stringify(c.expr)} ${JSON.stringify(c.record ?? {})}: expected ${JSON.stringify(c.expect.value)}, got ${JSON.stringify(got)}`);
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      if (!("error" in c.expect)) failures.push(`${JSON.stringify(c.expr)}: unexpected error ${e.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test(`rename: ${spec.rename.length} cases`, () => {
  for (const c of spec.rename as { expr: string; from: string; to: string; expect: Expect }[]) {
    if ("error" in c.expect) assert.throws(() => renameRef(c.expr, c.from, c.to), ExprError, JSON.stringify(c.expr));
    else assert.equal(renameRef(c.expr, c.from, c.to), c.expect.value, JSON.stringify(c.expr));
  }
});

test(`refs: ${spec.refs.length} cases`, () => {
  for (const c of spec.refs as { expr: string; expect: Expect }[]) {
    if ("error" in c.expect) assert.throws(() => refs(c.expr), ExprError);
    else assert.deepEqual(refs(c.expr), c.expect.value, JSON.stringify(c.expr));
  }
});
