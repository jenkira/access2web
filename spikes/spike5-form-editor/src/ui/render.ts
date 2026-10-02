// Render a form from its definition. Visibility, validation, and defaults are evaluated live, in the browser,
// with the same expression code the server uses to check a saved record.
import { evaluate, truthy, type Value } from "../model/expr.ts";
import { type Control, type Definition, type Form, allControls } from "../model/types.ts";
import { h } from "./dom.ts";

export type Rec = Record<string, Value>;
export interface Lookups { [entity: string]: Record<string, Value>[] }
export interface RenderOptions {
  lookups?: Lookups;
  record?: Rec;
  isNew?: boolean;
  now?: Date;
  /** Called with each control element, for the editor to add selection and drag handlers. */
  decorate?: (el: HTMLElement, c: Control) => void;
}
export interface FormView {
  el: HTMLFormElement;
  getRecord(): Rec;
  setRecord(r: Rec): void;
  /** Rules that fail for visible controls. */
  errors(): { control: string; message: string }[];
  refresh(): void;
}

const inputType: Record<string, string> = { text: "text", number: "number", date: "date", checkbox: "checkbox" };

export function failedRules(def: Definition, form: Form, rec: Rec, now = new Date()): { control: string; message: string }[] {
  const out: { control: string; message: string }[] = [];
  for (const c of allControls(form)) {
    if (!("bind" in c) || !c.validate) continue;
    if (c.visible !== undefined && !truthy(evaluate(c.visible, rec, now))) continue;  // a hidden control is not checked
    for (const r of c.validate) if (!truthy(evaluate(r.expr, rec, now))) out.push({ control: c.id, message: r.message });
  }
  const ent = def.entities.find((e) => e.name === form.entity);
  for (const c of allControls(form)) {
    if (!("bind" in c)) continue;
    const f = ent?.fields.find((x) => x.name === c.bind);
    if (f?.required && !f.key && (c.visible === undefined || truthy(evaluate(c.visible, rec, now))) && (rec[c.bind] === null || rec[c.bind] === undefined || rec[c.bind] === "")) {
      out.push({ control: c.id, message: `${c.label} is required` });
    }
  }
  return out;
}

/** Keys of a record that no control on the form binds to. The server refuses a record that has any. */
export function unknownFields(form: Form, record: Record<string, unknown>): string[] {
  const bound = new Set(allControls(form).flatMap((c) => ("bind" in c ? [c.bind] : [])));
  return Object.keys(record).filter((k) => !bound.has(k));
}

export function renderForm(def: Definition, formName: string, opts: RenderOptions = {}): FormView {
  const found = def.forms.find((f) => f.name === formName);
  if (!found) throw new Error(`unknown form ${formName}`);
  const form: Form = found;
  const now = opts.now ?? new Date();
  const rec: Rec = { ...(opts.record ?? {}) };
  const ent = def.entities.find((e) => e.name === form.entity)!;
  if (opts.isNew) {
    for (const c of allControls(form)) if ("bind" in c && c.default !== undefined && (rec[c.bind] === undefined || rec[c.bind] === null)) rec[c.bind] = evaluate(c.default, rec, now);
  }

  const titleId = `form-${form.name}-title`;
  const root = h("form", { "aria-labelledby": titleId, novalidate: true, class: "form" });
  root.append(h("h2", { id: titleId }, form.title));
  const wrappers = new Map<string, { wrap: HTMLElement; input?: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; err?: HTMLElement; c: Control }>();

  const readValue = (c: Control, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): Value => {
    if (c.type === "checkbox") return (el as HTMLInputElement).checked;
    if (c.type === "number") return el.value === "" ? null : Number(el.value);
    if (c.type === "combo") { if (el.value === "") return null; const n = Number(el.value); return Number.isNaN(n) ? el.value : n; }
    return el.value === "" ? null : el.value;
  };
  const writeValue = (c: Control, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, v: Value) => {
    if (c.type === "checkbox") (el as HTMLInputElement).checked = v === true;
    else el.value = v === null || v === undefined ? "" : String(v);
  };

  for (const r of form.rows) {
    const rowEl = h("div", { class: "row", "data-row": r.id });
    for (const c of r.controls) {
      const wrap = h("div", { class: `field field-${c.type}`, "data-control": c.id });
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined;
      let err: HTMLElement | undefined;
      const inputId = `ctl-${form.name}-${c.id}`;
      if (c.type === "label") wrap.append(h("p", {}, c.text));
      else if (c.type === "button") wrap.append(h("button", { type: "button", id: inputId }, c.label));
      else if (c.type === "subform") {
        const child = def.entities.find((e) => e.name === c.child.entity)!;
        wrap.append(h("div", { class: "subform", id: inputId }));
        void child;
      } else {
        const lab = h("label", { for: inputId }, c.label);
        const f = ent.fields.find((x) => x.name === c.bind);
        if (c.type === "combo") {
          const sel = h("select", { id: inputId, name: c.bind });
          sel.append(h("option", { value: "" }, ""));
          for (const row of opts.lookups?.[c.source.entity] ?? []) sel.append(h("option", { value: String(row[c.source.value]) }, String(row[c.source.display] ?? "")));
          input = sel;
        } else if (c.type === "textarea") input = h("textarea", { id: inputId, name: c.bind, rows: "3" });
        else input = h("input", { id: inputId, name: c.bind, type: inputType[c.type]!, ...(c.type === "number" ? { step: "any" } : {}) });
        if (f?.required) input.setAttribute("aria-required", "true");
        err = h("div", { class: "error", id: `${inputId}-error`, role: "alert" });
        input.setAttribute("aria-describedby", err.id);
        if (c.type === "checkbox") wrap.append(h("div", { class: "check" }, input, lab), err); else wrap.append(lab, input, err);
        input.addEventListener("input", () => { rec[c.bind] = readValue(c, input!); refresh(); });
        input.addEventListener("change", () => { rec[c.bind] = readValue(c, input!); refresh(); });
      }
      opts.decorate?.(wrap, c);
      wrappers.set(c.id, { wrap, input, err, c });
      rowEl.append(wrap);
    }
    root.append(rowEl);
  }

  function renderSubforms() {
    for (const { wrap, c } of wrappers.values()) {
      if (c.type !== "subform") continue;
      const host = wrap.querySelector(".subform")!;
      const child = def.entities.find((e) => e.name === c.child.entity)!;
      const key = rec[c.child.parentKey];
      const rows = key === null || key === undefined ? null : (opts.lookups?.[c.child.entity] ?? []).filter((x) => x[c.child.link] === key);
      host.replaceChildren();
      const heading = h("h3", { id: `${host.id}-h` }, c.label);
      host.append(heading);
      if (rows === null) { host.append(h("p", {}, "Save the record to add lines.")); continue; }
      const table = h("table", { "aria-labelledby": heading.id });
      table.append(h("thead", {}, h("tr", {}, ...c.columns.map((col) => h("th", { scope: "col" }, col)))));
      const body = h("tbody");
      for (const row of rows) body.append(h("tr", {}, ...c.columns.map((col) => h("td", {}, String(row[col] ?? "")))));
      if (!rows.length) body.append(h("tr", {}, h("td", { colspan: String(c.columns.length) }, "No lines")));
      table.append(body);
      host.append(table);
      void child;
    }
  }

  function refresh() {
    const failed = failedRules(def, form, rec, now);
    for (const { wrap, input, err, c } of wrappers.values()) {
      const visible = c.visible === undefined || truthy(evaluate(c.visible, rec, now));
      wrap.hidden = !visible;
      if (input && err) {
        const msgs = failed.filter((x) => x.control === c.id && (touched.has(c.id) || submitted)).map((x) => x.message);
        err.textContent = msgs.join(" ");
        if (msgs.length) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
      }
    }
    for (const rowEl of root.querySelectorAll<HTMLElement>(".row")) rowEl.hidden = [...rowEl.children].every((x) => (x as HTMLElement).hidden);  // no empty gaps
    renderSubforms();
  }

  const touched = new Set<string>();
  let submitted = false;
  for (const { input, c } of wrappers.values()) input?.addEventListener("blur", () => { touched.add(c.id); refresh(); });
  root.addEventListener("submit", (e) => { e.preventDefault(); submitted = true; refresh(); });

  const view: FormView = {
    el: root,
    getRecord: () => ({ ...rec }),
    setRecord(r) { Object.assign(rec, r); for (const { input, c } of wrappers.values()) if (input && "bind" in c) writeValue(c, input, rec[c.bind] ?? null); refresh(); },
    errors: () => failedRules(def, form, rec, now),
    refresh,
  };
  view.setRecord(rec);
  return view;
}
