import { allControls, type Control, type Definition, type Entity, type Form, type Rule } from "./types.ts";
import { ExprError, refs } from "./expr.ts";

export class OpError extends Error {
  constructor(message: string) { super(message); this.name = "OpError"; }
}

export const IDENT = /^[a-z_][a-z0-9_]*$/;

export function entityOf(def: Definition, name: string): Entity {
  const e = def.entities.find((x) => x.name === name);
  if (!e) throw new OpError(`unknown entity ${name}`);
  return e;
}

export function formOf(def: Definition, name: string): Form {
  const f = def.forms.find((x) => x.name === name);
  if (!f) throw new OpError(`unknown form ${name}`);
  return f;
}

export function findControl(f: Form, id: string): { row: number; index: number; control: Control } {
  for (const [r, row] of f.rows.entries()) {
    const i = row.controls.findIndex((c) => c.id === id);
    if (i >= 0) return { row: r, index: i, control: row.controls[i]! };
  }
  throw new OpError(`unknown control ${id}`);
}

/** An expression must parse, and may only refer to fields of the form's entity. */
export function checkExpr(def: Definition, form: Form, src: string, what: string): void {
  const e = entityOf(def, form.entity);
  let used: string[];
  try { used = refs(src); } catch (err) { if (err instanceof ExprError) throw new OpError(`${what}: ${err.message}`); throw err; }
  for (const u of used) if (!e.fields.some((f) => f.name === u)) throw new OpError(`${what}: unknown field ${u}`);
}

export function checkRules(def: Definition, form: Form, rules: Rule[]): void {
  for (const r of rules) {
    if (typeof r.message !== "string" || !r.message.trim()) throw new OpError("a validation rule needs a message");
    checkExpr(def, form, r.expr, "validation rule");
  }
}

const CONTROL_TYPES = new Set(["text", "number", "date", "checkbox", "textarea", "combo", "label", "button", "subform"]);
const BOUND_TYPES = new Set(["text", "number", "date", "checkbox", "textarea", "combo"]);

export function checkControl(def: Definition, form: Form, c: Control): void {
  if (!c.id || !/^[A-Za-z][A-Za-z0-9_]*$/.test(c.id)) throw new OpError("control id must be letters, digits, and underscores");
  if (!CONTROL_TYPES.has(c.type)) throw new OpError(`control ${c.id} has unknown type ${c.type}`);
  const text = c.type === "label" ? c.text : (c as { label?: unknown }).label;
  if (typeof text !== "string" || !text.trim()) throw new OpError(`control ${c.id} needs ${c.type === "label" ? "text" : "a label"}`);
  if (BOUND_TYPES.has(c.type) && !entityOf(def, form.entity).fields.some((f) => f.name === (c as { bind?: string }).bind)) throw new OpError(`control ${c.id} is bound to unknown field ${(c as { bind?: string }).bind}`);
  if (c.type === "combo") {
    const src = entityOf(def, c.source.entity);
    for (const f of [c.source.value, c.source.display]) if (!src.fields.some((x) => x.name === f)) throw new OpError(`combo ${c.id} refers to unknown field ${f} of ${src.name}`);
  }
  if (c.type === "subform") {
    const child = entityOf(def, c.child.entity);
    if (!child.fields.some((f) => f.name === c.child.link)) throw new OpError(`subform ${c.id} links on unknown field ${c.child.link}`);
    if (!entityOf(def, form.entity).fields.some((f) => f.name === c.child.parentKey)) throw new OpError(`subform ${c.id} uses unknown parent key ${c.child.parentKey}`);
    for (const col of c.columns) if (!child.fields.some((f) => f.name === col)) throw new OpError(`subform ${c.id} shows unknown column ${col}`);
  }
  if (c.visible !== undefined) checkExpr(def, form, c.visible, "visibility rule");
  if ("validate" in c && c.validate) checkRules(def, form, c.validate);
  if ("default" in c && c.default !== undefined) checkExpr(def, form, c.default, "default");
}

/** Every problem in a definition, so publish can refuse a broken draft. Empty means valid. */
export function validateDefinition(def: Definition): string[] {
  const problems: string[] = [];
  const guard = (fn: () => void, where: string) => { try { fn(); } catch (e) { if (e instanceof OpError) problems.push(`${where}: ${e.message}`); else throw e; } };
  const names = new Set<string>();
  for (const form of def.forms) {
    if (names.has(form.name)) problems.push(`form ${form.name}: duplicate form name`);
    names.add(form.name);
    guard(() => entityOf(def, form.entity), `form ${form.name}`);
    if (!def.entities.some((e) => e.name === form.entity)) continue;
    const seen = new Set<string>();
    for (const c of allControls(form)) {
      if (seen.has(c.id)) problems.push(`form ${form.name}: duplicate control id ${c.id}`);
      seen.add(c.id);
      guard(() => checkControl(def, form, c), `form ${form.name}`);
    }
  }
  return problems;
}
