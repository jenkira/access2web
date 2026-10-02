import test from "node:test";
import assert from "node:assert/strict";
import { demoDefinition } from "../fixtures/demo.ts";
import { History } from "../src/model/history.ts";
import { evaluate, truthy } from "../src/model/expr.ts";
import { failsWhenEmpty, ruleWarnings } from "../src/model/lint.ts";
import { OpError } from "../src/model/validate.ts";
import type { FieldType } from "../src/model/types.ts";
import type { Value } from "../src/model/expr.ts";

const types: Record<string, FieldType> = { qty: "number", discount: "number", status: "text", ship_date: "date", order_date: "date", flag: "bool", name: "text" };
const typeOf = (f: string) => types[f];
const warns = (expr: string, bound: string) => failsWhenEmpty(expr, bound, typeOf);

test("a rule that is false for an empty field is reported", () => {
  assert.equal(warns("discount >= 0", "discount"), true);
  assert.equal(warns("discount >= 0 && discount <= 1", "discount"), true);
  assert.equal(warns("len(name) > 2", "name"), true, "len(null) is 0, so an empty name fails");
  assert.equal(warns("ship_date >= order_date", "ship_date"), true, "a comparison with null is false whatever the other field holds");
  assert.equal(warns("name == 'a'", "name"), true);
});

test("a rule that already allows an empty field is not reported", () => {
  assert.equal(warns("isnull(discount) || discount >= 0", "discount"), false);
  assert.equal(warns("isnull(ship_date) || ship_date >= order_date", "ship_date"), false);
  assert.equal(warns("!discount || discount >= 0", "discount"), false, "an empty value is false, so ! makes it pass");
  assert.equal(warns("coalesce(discount, 0) >= 0", "discount"), false);
  assert.equal(warns("discount != 5", "discount"), false, "null != 5 is true");
  assert.equal(warns("len(name) < 10", "name"), false, "len(null) is 0, which is less than 10");
});

test("a rule that depends on another field is reported only if it fails for every value of that field", () => {
  assert.equal(warns("status == 'open' || qty > 0", "qty"), false, "it passes for an empty qty when status is open");
  assert.equal(warns("status != 'draft' && qty > 0", "qty"), true, "it fails for an empty qty whatever the status");
  assert.equal(warns("flag || qty > 0", "qty"), false);
});

test("a rule that does not mention the field, or that nothing satisfies, is not reported", () => {
  assert.equal(warns("qty > 0", "discount"), false, "it does not depend on discount");
  assert.equal(warns("discount > 5 && discount < 3", "discount"), false, "it is never true, which is a different problem");
  assert.equal(warns("false", "discount"), false);
});

test("the fix allows an empty value and keeps the rule for every filled value", () => {
  for (const [expr, field] of [["discount >= 0 && discount <= 1", "discount"], ["ship_date >= order_date", "ship_date"], ["len(name) > 2", "name"]] as const) {
    const fixed = `isnull(${field}) || (${expr})`;
    assert.equal(warns(fixed, field), false, `${fixed} should not warn`);
    for (const rec of [{ discount: 0.5, ship_date: "2026-03-10", order_date: "2026-03-01", name: "abc" }, { discount: 2, ship_date: "2026-02-01", order_date: "2026-03-01", name: "ab" }, { discount: -1, ship_date: "2026-03-01", order_date: "2026-03-01", name: "abcd" }]) {
      assert.equal(truthy(evaluate(fixed, rec)), truthy(evaluate(expr, rec)), `${fixed} for ${JSON.stringify(rec)}`);
    }
  }
});

test("the demo application: which rules warn", () => {
  const d = demoDefinition();
  const w = ruleWarnings(d).map((x) => `${x.form}/${x.control}/${x.ruleIndex}`);
  // l_disc and v_credit are optional fields with rules that reject empty. p_price and l_qty are required, o_ship already uses isnull.
  assert.deepEqual(w.sort(), ["CreditReviewForm/v_credit/0", "OrderLineForm/l_disc/0"]);
});

test("a required field is not reported, because it is already checked for being empty", () => {
  const d = demoDefinition();
  assert.equal(ruleWarnings(d, "ProductForm").length, 0);
});

test("the warning carries a fix that removes it, and undo brings it back", () => {
  const h = new History(demoDefinition());
  const [w] = ruleWarnings(h.current, "OrderLineForm");
  assert.ok(w);
  assert.equal(w.fix, "isnull(discount) || (discount >= 0 && discount <= 1)");
  const rules = [{ expr: w.fix, message: "Discount is between 0 and 1" }];
  h.do({ t: "setValidation", form: "OrderLineForm", id: "l_disc", rules });
  assert.equal(ruleWarnings(h.current, "OrderLineForm").length, 0);
  h.undo();
  assert.equal(ruleWarnings(h.current, "OrderLineForm").length, 1);
  assert.ok(h.verify());
});

test("adding a rule that rejects empty makes a warning", () => {
  const h = new History(demoDefinition());
  assert.equal(ruleWarnings(h.current, "CustomerForm").length, 0);
  h.do({ t: "setValidation", form: "CustomerForm", id: "c_credit", rules: [{ expr: "credit_limit > 0", message: "Must be positive" }] });
  const w = ruleWarnings(h.current, "CustomerForm");
  assert.equal(w.length, 1);
  assert.match(w[0]!.message, /Rule 1 is false when Credit limit is empty/);
});

test("linting never throws for a valid definition", () => {
  const h = new History(demoDefinition());
  assert.doesNotThrow(() => ruleWarnings(h.current));
  assert.throws(() => h.do({ t: "setValidation", form: "CustomerForm", id: "c_credit", rules: [{ expr: "nope > 0", message: "m" }] }), OpError);
});

// ---- a sampling check is only as good as its samples, so compare it with brute force on random rules
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("the lint agrees with brute force on 600 random rules", () => {
  const r = rng(99);
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const atom = (vars: string[]): string => {
    const k = r();
    const v = pick(vars);
    if (k < 0.35) return `${v} ${pick([">", "<", ">=", "<=", "==", "!="])} ${Math.floor(r() * 9) - 3}`;
    if (k < 0.5) return `isnull(${v})`;
    if (k < 0.6) return `!${v}`;
    if (k < 0.7) return `len(${v}) ${pick([">", "<", ">=", "<="])} ${Math.floor(r() * 5)}`;
    if (k < 0.8) return `${v} == ${pick(["'a'", "'zz'", "true", "false", "null"])}`;
    if (k < 0.9) return `coalesce(${v}, 1) ${pick([">", "<="])} ${Math.floor(r() * 4)}`;
    return v;
  };
  const rule = (vars: string[], d: number): string => (d <= 0 || r() < 0.3 ? atom(vars) : `(${rule(vars, d - 1)} ${pick(["&&", "||"])} ${rule(vars, d - 1)})`);

  // a dense grid: every value a rule written with these literals could tell apart
  const grid: Value[] = [null, true, false, "", ...Array.from({ length: 41 }, (_, i) => (i - 20) / 2), ...["a", "zz", "abc", "abcd", "abcde", "abcdef", "x y"]];
  let agree = 0, warned = 0;
  const disagreements: string[] = [];
  for (let n = 0; n < 600; n++) {
    const two = r() < 0.5;
    const vars = two ? ["x", "y"] : ["x"];
    const expr = rule(vars, 2);
    const refsUsed = new Set<string>(); for (const m of expr.matchAll(/\b[xy]\b/g)) refsUsed.add(m[0]);
    if (!refsUsed.has("x")) { n--; continue; }
    // brute force: for every value of y, does the rule fail when x is empty, and does it pass for some filled x?
    const ys = refsUsed.has("y") ? grid : [null];
    let failsEmptyEverywhere = true, passesFilled = false;
    for (const y of ys) {
      if (truthy(evaluate(expr, { x: null, y }))) failsEmptyEverywhere = false;
      for (const x of grid) if (x !== null && truthy(evaluate(expr, { x, y }))) passesFilled = true;
    }
    const truth = failsEmptyEverywhere && passesFilled;
    const got = failsWhenEmpty(expr, "x", () => "number");
    if (truth) warned++;
    if (got === truth) agree++; else disagreements.push(`${expr}: lint ${got}, brute force ${truth}`);
  }
  console.log(`# 600 random rules: ${warned} should warn, ${agree} agree with brute force, ${disagreements.length} differ`);
  assert.ok(warned > 50, "the generator should produce rules that warn");
  assert.deepEqual(disagreements.slice(0, 10), []);
});
