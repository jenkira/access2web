import { type Control, type Definition, type Rule, clone } from "./types.ts";
import { OpError, checkControl, checkExpr, checkRules, findControl, formOf } from "./validate.ts";
import { planRenameEntity, planRenameField } from "./rename.ts";

export type Place = { row: number } | { newRowAt: number; newRowId: string };

export type Op =
  | { t: "addControl"; form: string; place: Place; index?: number; control: Control }
  | { t: "removeControl"; form: string; id: string }
  | { t: "moveControl"; form: string; id: string; place: Place; index?: number }
  | { t: "setLabel"; form: string; id: string; label: string }
  | { t: "setVisible"; form: string; id: string; expr: string | null }
  | { t: "setValidation"; form: string; id: string; rules: Rule[] }
  | { t: "setDefault"; form: string; id: string; expr: string | null }
  | { t: "renameField"; entity: string; from: string; to: string }
  | { t: "renameEntity"; from: string; to: string; table?: string };

function place(def: Definition, formName: string, p: Place, control: Control, index?: number): void {
  const f = formOf(def, formName);
  if ("row" in p) {
    const r = f.rows[p.row];
    if (!r) throw new OpError(`no row ${p.row}`);
    const i = index ?? r.controls.length;
    if (i < 0 || i > r.controls.length) throw new OpError(`no position ${i} in row ${p.row}`);
    r.controls.splice(i, 0, control);
  } else {
    if (p.newRowAt < 0 || p.newRowAt > f.rows.length) throw new OpError(`no row position ${p.newRowAt}`);
    if (f.rows.some((r) => r.id === p.newRowId)) throw new OpError(`row id ${p.newRowId} is taken`);
    f.rows.splice(p.newRowAt, 0, { id: p.newRowId, controls: [control] });
  }
}

function remove(def: Definition, formName: string, id: string): Control {
  const f = formOf(def, formName);
  const at = findControl(f, id);
  const [c] = f.rows[at.row]!.controls.splice(at.index, 1);
  if (f.rows[at.row]!.controls.length === 0) f.rows.splice(at.row, 1);
  return c!;
}

const bound = (c: Control) => "bind" in c;

/** Apply one operation. Returns a new definition, or throws OpError and changes nothing. Replaying a log gives the same result. */
export function apply(input: Definition, op: Op): Definition {
  const def = clone(input);
  switch (op.t) {
    case "addControl": {
      const f = formOf(def, op.form);
      if (f.rows.some((r) => r.controls.some((c) => c.id === op.control.id))) throw new OpError(`control id ${op.control.id} is taken`);
      checkControl(def, f, op.control);
      place(def, op.form, op.place, clone(op.control), op.index);
      break;
    }
    case "removeControl": remove(def, op.form, op.id); break;
    case "moveControl": {
      const c = remove(def, op.form, op.id);  // positions below count after the removal
      place(def, op.form, op.place, c, op.index);
      break;
    }
    case "setLabel": {
      const { control: c } = findControl(formOf(def, op.form), op.id);
      if (!op.label.trim()) throw new OpError("a label cannot be empty");
      if (c.type === "label") c.text = op.label; else c.label = op.label;
      break;
    }
    case "setVisible": {
      const f = formOf(def, op.form);
      const { control: c } = findControl(f, op.id);
      if (op.expr === null) delete c.visible; else { checkExpr(def, f, op.expr, "visibility rule"); c.visible = op.expr; }
      break;
    }
    case "setValidation": {
      const f = formOf(def, op.form);
      const { control: c } = findControl(f, op.id);
      if (!bound(c)) throw new OpError(`control ${op.id} cannot have validation rules`);
      checkRules(def, f, op.rules);
      if (op.rules.length === 0) delete (c as { validate?: Rule[] }).validate; else (c as { validate?: Rule[] }).validate = clone(op.rules);
      break;
    }
    case "setDefault": {
      const f = formOf(def, op.form);
      const { control: c } = findControl(f, op.id);
      if (!bound(c)) throw new OpError(`control ${op.id} cannot have a default`);
      if (op.expr === null) delete (c as { default?: string }).default; else { checkExpr(def, f, op.expr, "default"); (c as { default?: string }).default = op.expr; }
      break;
    }
    case "renameField": return planRenameField(def, op.entity, op.from, op.to).def;
    case "renameEntity": return planRenameEntity(def, op.from, op.to, op.table).def;
  }
  return def;
}
