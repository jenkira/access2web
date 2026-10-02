// Advisory checks on a definition. A warning never blocks an edit or a publish.
//
// The check here is for a rule that is false when its own field is empty. In the expression language a comparison with
// null is false, so `discount >= 0` rejects an empty discount, and an owner who meant "optional" has made the field required.
// The warning says so, and offers the fix: `isnull(discount) || (discount >= 0)`.
import { parse, refs, evaluate, truthy, type Node, type Value } from "./expr.ts";
import { allControls, type Control, type Definition, type Form, type FieldType } from "./types.ts";

export interface RuleWarning {
  form: string;
  control: string;
  ruleIndex: number;
  field: string;
  message: string;
  /** The rule rewritten to allow an empty value. */
  fix: string;
}

const TYPE_SAMPLES: Record<FieldType, Value[]> = {
  number: [0, 1, 100, -1],
  text: ["a", "zz"],
  bool: [false, true],
  date: ["2026-01-01", "2026-12-31"],
};
const MAX_COMBINATIONS = 2000;

function literals(n: Node, out: Set<Value> = new Set()): Set<Value> {
  if (n.k === "num" || n.k === "str" || n.k === "bool") out.add(n.v);
  else if (n.k === "un") literals(n.e, out);
  else if (n.k === "bin") { literals(n.l, out); literals(n.r, out); }
  else if (n.k === "call") n.args.forEach((a) => literals(a, out));
  return out;
}

/**
 * Does `expr` fail whenever `bound` is empty, yet pass for some filled value?
 * Other fields take sample values, plus every literal that appears in the expression, so a rule such as
 * `status == 'open' || qty > 0` is not reported: it passes for an empty qty when status is open.
 */
export function failsWhenEmpty(expr: string, bound: string, typeOf: (field: string) => FieldType | undefined): boolean {
  const used = refs(expr);
  if (!used.includes(bound)) return false;
  const lits = [...literals(parse(expr))];
  // Boundary values for every number in the rule: x > 5 needs 6, and len(x) > 5 needs a string of six or more characters.
  const extra: Value[] = [];
  for (const v of lits) if (typeof v === "number" && Number.isFinite(v)) {
    extra.push(v - 1, v + 1, -v - 1, -v, -v + 1);  // a negative number in a rule is a literal with a minus sign in front
    if (Number.isInteger(v) && v >= 0 && v <= 200) extra.push("a".repeat(v), "a".repeat(v + 1));
  }
  const samples = (f: string): Value[] => [null, ...(TYPE_SAMPLES[typeOf(f) ?? "text"] ?? []), ...lits, ...extra];
  const others = used.filter((f) => f !== bound).slice(0, 4);  // the rest stay empty
  const filled = samples(bound).filter((v) => v !== null);
  let combos: Record<string, Value>[] = [{}];
  for (const f of others) {
    const next: Record<string, Value>[] = [];
    for (const c of combos) for (const v of samples(f)) { next.push({ ...c, [f]: v }); if (next.length >= MAX_COMBINATIONS) break; }
    combos = next;
  }
  const now = new Date("2026-03-01T00:00:00Z");
  let passesFilled = false;
  for (const c of combos) {
    if (truthy(evaluate(expr, { ...c, [bound]: null }, now))) return false;  // it passes for an empty value somewhere
    if (!passesFilled) for (const v of filled) if (truthy(evaluate(expr, { ...c, [bound]: v }, now))) { passesFilled = true; break; }
  }
  return passesFilled;  // a rule that nothing satisfies is a different problem
}

export function warningsForControl(def: Definition, form: Form, c: Control): RuleWarning[] {
  if (!("bind" in c) || !c.validate) return [];
  const ent = def.entities.find((e) => e.name === form.entity);
  const field = ent?.fields.find((f) => f.name === c.bind);
  if (!field || field.required || field.key) return [];  // a required field is already checked for being empty
  const typeOf = (name: string) => ent?.fields.find((f) => f.name === name)?.type;
  const out: RuleWarning[] = [];
  c.validate.forEach((r, i) => {
    if (!failsWhenEmpty(r.expr, c.bind, typeOf)) return;
    out.push({
      form: form.name, control: c.id, ruleIndex: i, field: c.bind,
      message: `Rule ${i + 1} is false when ${c.label} is empty, so ${c.label} cannot be left empty. If the field is optional, allow an empty value.`,
      fix: `isnull(${c.bind}) || (${r.expr})`,
    });
  });
  return out;
}

export function ruleWarnings(def: Definition, formName?: string): RuleWarning[] {
  return def.forms.filter((f) => !formName || f.name === formName).flatMap((f) => allControls(f).flatMap((c) => warningsForControl(def, f, c)));
}
