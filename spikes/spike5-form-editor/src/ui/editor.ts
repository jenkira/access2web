// Form editor prototype. Every edit goes through History as an operation, so undo, redo, and the log come for free.
// Every operation can be done with the keyboard: buttons for move, fields for properties. Drag and drop is an extra.
import { History } from "../model/history.ts";
import type { Op } from "../model/ops.ts";
import { planRenameField } from "../model/rename.ts";
import { OpError } from "../model/validate.ts";
import { type Control, type Definition, type Form, allControls } from "../model/types.ts";
import { h } from "./dom.ts";
import { type Lookups, renderForm } from "./render.ts";

const ADDABLE = ["text", "number", "date", "checkbox", "textarea"] as const;

export interface EditorHooks { saveDraft?(log: Op[]): Promise<string>; publish?(): Promise<string> }

export class Editor {
  readonly history: History;
  form: string;
  selected: string | null = null;
  private status = "";
  private statusKind: "status" | "alert" = "status";
  private renamePreview: ReturnType<typeof planRenameField> | null = null;
  private renameDraft = { field: "", to: "" };  // kept across renders, so a preview does not reset the choice
  private counter = 0;

  private root: HTMLElement;
  private lookups: Lookups;
  private hooks: EditorHooks;

  constructor(root: HTMLElement, def: Definition, lookups: Lookups, hooks: EditorHooks = {}, form?: string) {
    this.root = root; this.lookups = lookups; this.hooks = hooks;
    this.history = new History(def);
    this.form = form ?? def.forms[0]!.name;
    document.addEventListener("keydown", (e) => this.onKey(e));
    this.render();
  }

  private get def(): Definition { return this.history.current; }
  private get formDef(): Form { return this.def.forms.find((f) => f.name === this.form)!; }
  private locate(id: string) {
    for (const [r, row] of this.formDef.rows.entries()) { const i = row.controls.findIndex((c) => c.id === id); if (i >= 0) return { r, i, row }; }
    return null;
  }

  // ---- doing things
  private say(msg: string, kind: "status" | "alert" = "status") { this.status = msg; this.statusKind = kind; }

  /** Apply an edit. A rejected edit shows its reason and changes nothing. */
  tryDo(op: Op, ok: string): boolean {
    try { this.history.do(op); this.say(ok); this.renamePreview = null; this.render(); return true; }
    catch (e) { if (e instanceof OpError) { this.say(`Not changed: ${e.message}`, "alert"); this.render(); return false; } throw e; }
  }

  private nextId(): string {
    const used = new Set(allControls(this.formDef).map((c) => c.id));
    do this.counter++; while (used.has(`ctl_${this.counter}`));
    return `ctl_${this.counter}`;
  }

  add(type: (typeof ADDABLE)[number], bind: string) {
    const label = bind.replaceAll("_", " ");
    const control = { id: this.nextId(), type, bind, label } as Control;
    const at = this.selected ? this.locate(this.selected) : null;
    const op: Op = at ? { t: "addControl", form: this.form, place: { row: at.r }, index: at.i + 1, control } : { t: "addControl", form: this.form, place: { newRowAt: this.formDef.rows.length, newRowId: `row_${control.id}` }, control };
    if (this.tryDo(op, `Added ${label}.`)) this.selected = control.id;
    this.render();
  }

  remove() {
    if (!this.selected) return;
    const id = this.selected;
    if (this.tryDo({ t: "removeControl", form: this.form, id }, "Removed the control.")) this.selected = null;
    this.render();
  }

  /** Positions in a move count after the control leaves its row, and an emptied row disappears. */
  move(dir: "earlier" | "later" | "rowUp" | "rowDown" | "newRowAbove" | "newRowBelow") {
    if (!this.selected) return;
    const at = this.locate(this.selected);
    if (!at) return;
    const single = at.row.controls.length === 1;
    let place: Extract<Op, { t: "moveControl" }>["place"]; let index: number | undefined;
    if (dir === "earlier") { place = { row: at.r }; index = at.i - 1; }
    else if (dir === "later") { place = { row: at.r }; index = at.i + 1; }
    else if (dir === "rowUp") { place = { row: at.r - 1 }; }
    else if (dir === "rowDown") { place = { row: single ? at.r : at.r + 1 }; }
    else if (dir === "newRowAbove") { place = { newRowAt: at.r, newRowId: `row_${this.selected}_${this.history.position}` }; }
    else { place = { newRowAt: at.r + 1, newRowId: `row_${this.selected}_${this.history.position}` }; }
    const names = { earlier: "earlier in the row", later: "later in the row", rowUp: "to the row above", rowDown: "to the row below", newRowAbove: "to a new row above", newRowBelow: "to a new row below" };
    this.tryDo({ t: "moveControl", form: this.form, id: this.selected, place, index }, `Moved ${this.selected} ${names[dir]}.`);
  }

  private canMove(dir: string): boolean {
    if (!this.selected) return false;
    const at = this.locate(this.selected);
    if (!at) return false;
    const single = at.row.controls.length === 1, rows = this.formDef.rows.length;
    return dir === "earlier" ? at.i > 0 : dir === "later" ? at.i < at.row.controls.length - 1 : dir === "rowUp" ? at.r > 0
      : dir === "rowDown" ? at.r < rows - 1 : !single;
  }

  /** Drop a control before another control, or at the end of a row. */
  drop(srcId: string, targetId: string | null, rowId: string) {
    const f = this.formDef;
    const src = this.locate(srcId);
    if (!src || srcId === targetId) return;
    // Work out positions as they will be after the source is removed.
    const rowsAfter = f.rows.map((r) => ({ id: r.id, ids: r.controls.map((c) => c.id).filter((x) => x !== srcId) })).filter((r) => r.ids.length);
    const rowIdx = rowsAfter.findIndex((r) => r.id === rowId);
    if (rowIdx < 0) return;
    const index = targetId ? rowsAfter[rowIdx]!.ids.indexOf(targetId) : rowsAfter[rowIdx]!.ids.length;
    this.selected = srcId;
    this.tryDo({ t: "moveControl", form: this.form, id: srcId, place: { row: rowIdx }, index: Math.max(0, index) }, `Moved ${srcId}.`);
  }

  /** Save the current log to the server before publishing, so Publish always publishes what is on screen. */
  async hooks_saveForPublish(): Promise<void> { await this.hooks.saveDraft?.(this.history.log); }

  undo() { if (this.history.canUndo) { this.history.undo(); this.say("Undid the last edit."); this.keepSelection(); this.render(); } }
  redo() { if (this.history.canRedo) { this.history.redo(); this.say("Redid the edit."); this.keepSelection(); this.render(); } }
  private keepSelection() { if (this.selected && !this.locate(this.selected)) this.selected = null; if (!this.def.forms.some((f) => f.name === this.form)) this.form = this.def.forms[0]!.name; }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select")) return;  // the field's own undo applies while typing
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); }
    else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); this.redo(); }
    else if (e.key === "Delete" && this.selected && t.closest("[data-control], .control-list")) { e.preventDefault(); this.remove(); }
  }

  // ---- drawing
  render() {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.fk;
    const f = this.formDef;
    const ent = this.def.entities.find((e) => e.name === f.entity)!;
    const btn = (key: string, label: string, onClick: () => void, enabled = true, extra: Record<string, string> = {}) => {
      const b = h("button", { type: "button", "data-fk": key, disabled: !enabled, ...extra }, label);
      b.addEventListener("click", onClick);
      return b;
    };

    const formSel = h("select", { id: "form-select", "data-fk": "form-select" });
    for (const x of this.def.forms) formSel.append(h("option", { value: x.name, selected: x.name === this.form }, x.title));
    formSel.addEventListener("change", () => { this.form = formSel.value; this.selected = null; this.render(); });

    const typeSel = h("select", { id: "add-type", "data-fk": "add-type" }, ...ADDABLE.map((t) => h("option", { value: t }, t)));
    const fieldSel = h("select", { id: "add-field", "data-fk": "add-field" }, ...ent.fields.map((x) => h("option", { value: x.name }, x.name)));

    const toolbar = h("div", { class: "toolbar", role: "toolbar", "aria-label": "Edit the form" },
      btn("undo", "Undo", () => this.undo(), this.history.canUndo, { "aria-keyshortcuts": "Control+Z" }),
      btn("redo", "Redo", () => this.redo(), this.history.canRedo, { "aria-keyshortcuts": "Control+Y" }),
      h("label", { for: "add-type" }, "Type"), typeSel, h("label", { for: "add-field" }, "Field"), fieldSel,
      btn("add", "Add control", () => this.add(typeSel.value as (typeof ADDABLE)[number], fieldSel.value)),
      btn("remove", "Remove", () => this.remove(), !!this.selected));
    const moves = h("div", { class: "toolbar", role: "toolbar", "aria-label": "Move the selected control" },
      btn("m-earlier", "Earlier in row", () => this.move("earlier"), this.canMove("earlier")),
      btn("m-later", "Later in row", () => this.move("later"), this.canMove("later")),
      btn("m-up", "To row above", () => this.move("rowUp"), this.canMove("rowUp")),
      btn("m-down", "To row below", () => this.move("rowDown"), this.canMove("rowDown")),
      btn("m-nu", "To new row above", () => this.move("newRowAbove"), this.canMove("newRowAbove")),
      btn("m-nd", "To new row below", () => this.move("newRowBelow"), this.canMove("newRowBelow")));

    // control list: the keyboard route to selecting a control
    const list = h("ul", { class: "control-list" });
    for (const [ri, row] of f.rows.entries()) {
      const inner = h("ul", {});
      for (const c of row.controls) {
        const name = "bind" in c ? c.label : c.type === "label" ? c.text : c.label;
        const b = h("button", { type: "button", "aria-pressed": String(this.selected === c.id), "data-fk": `sel-${c.id}`, "data-select": c.id }, `${name} (${c.type})`);
        b.addEventListener("click", () => { this.selected = c.id; this.render(); });
        inner.append(h("li", {}, b));
      }
      list.append(h("li", {}, h("span", {}, `Row ${ri + 1}`), inner));
    }

    // preview with selection and drag and drop
    const view = renderForm(this.def, this.form, {
      lookups: this.lookups, isNew: true,
      decorate: (el, c) => {
        el.tabIndex = -1;
        el.classList.toggle("selected", this.selected === c.id);
        el.draggable = true;
        el.addEventListener("click", (e) => { e.stopPropagation(); if (this.selected !== c.id) { this.selected = c.id; this.render(); } });
        el.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/plain", c.id); });
        el.addEventListener("dragover", (e) => e.preventDefault());
        el.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); const src = e.dataTransfer?.getData("text/plain"); const row = el.closest<HTMLElement>("[data-row]")!.dataset.row!; if (src) this.drop(src, c.id, row); });
      },
    });
    for (const rowEl of view.el.querySelectorAll<HTMLElement>("[data-row]")) {
      rowEl.addEventListener("dragover", (e) => e.preventDefault());
      rowEl.addEventListener("drop", (e) => { e.preventDefault(); const src = e.dataTransfer?.getData("text/plain"); if (src) this.drop(src, null, rowEl.dataset.row!); });
    }
    // The preview must not submit or take focus away from the editor's own controls.
    for (const el of view.el.querySelectorAll<HTMLElement>("input, select, textarea, button")) el.setAttribute("tabindex", "-1");

    const preview = h("section", { class: "preview", "aria-label": "Form preview" }, view.el);
    const props = this.properties(btn);
    const rename = this.renamePanel(btn);
    const draft = h("section", { class: "panel", "aria-labelledby": "draft-h" }, h("h2", { id: "draft-h" }, "Draft"),
      h("p", {}, `Edits in the log: ${this.history.log.length}`),
      btn("save", "Save draft", async () => { if (!this.hooks.saveDraft) return; try { this.say(await this.hooks.saveDraft(this.history.log)); } catch (e) { this.say((e as Error).message, "alert"); } this.render(); }, !!this.hooks.saveDraft),
      btn("publish", "Publish", async () => { if (!this.hooks.publish) return; try { this.say(await this.hooks.publish()); } catch (e) { this.say((e as Error).message, "alert"); } this.render(); }, !!this.hooks.publish));

    const status = h("div", { id: "status", role: this.statusKind, "aria-live": this.statusKind === "alert" ? "assertive" : "polite" }, this.status);

    this.root.replaceChildren(
      h("div", { class: "bar" }, h("label", { for: "form-select" }, "Form"), formSel, toolbar), moves, status,
      h("div", { class: "editor-grid" },
        h("nav", { "aria-label": "Controls" }, h("h2", {}, "Controls"), list),
        preview,
        h("div", {}, props, rename, draft)));
    if (focusKey) this.root.querySelector<HTMLElement>(`[data-fk="${focusKey}"]`)?.focus();
  }

  private properties(btn: (key: string, label: string, fn: () => void, enabled?: boolean, extra?: Record<string, string>) => HTMLButtonElement): HTMLElement {
    const sec = h("section", { class: "panel", "aria-labelledby": "props-h" }, h("h2", { id: "props-h" }, "Properties"));
    const c = this.selected ? allControls(this.formDef).find((x) => x.id === this.selected) : undefined;
    if (!c) { sec.append(h("p", {}, "Select a control to edit it.")); return sec; }
    const field = (id: string, label: string, value: string, apply: (v: string) => void, help?: string) => {
      const input = h("input", { id, type: "text", value, "data-fk": id, ...(help ? { "aria-describedby": `${id}-help` } : {}) });
      input.addEventListener("change", () => apply(input.value));
      return h("div", { class: "prop" }, h("label", { for: id }, label), input, help ? h("div", { id: `${id}-help`, class: "help" }, help) : "");
    };
    const labelValue = c.type === "label" ? c.text : c.label;
    sec.append(field("p-label", c.type === "label" ? "Text" : "Label", labelValue, (v) => this.tryDo({ t: "setLabel", form: this.form, id: c.id, label: v }, "Changed the label.")));
    sec.append(field("p-visible", "Show when", c.visible ?? "", (v) => this.tryDo({ t: "setVisible", form: this.form, id: c.id, expr: v.trim() === "" ? null : v }, v.trim() === "" ? "The control is always shown." : "Changed the visibility rule."), "Leave empty to always show. Example: status == 'shipped'"));
    if ("bind" in c) {
      sec.append(field("p-default", "Default value", c.default ?? "", (v) => this.tryDo({ t: "setDefault", form: this.form, id: c.id, expr: v.trim() === "" ? null : v }, "Changed the default."), "An expression. Example: today()"));
      const rules = h("fieldset", {}, h("legend", {}, "Validation rules"));
      const rows = (c.validate ?? []).map((r) => ({ ...r }));
      const draftRules = rows.length ? rows : [];
      draftRules.forEach((r, i) => {
        const e = h("input", { type: "text", value: r.expr, "aria-label": `Rule ${i + 1} expression`, "data-fk": `rule-e-${i}` });
        const m = h("input", { type: "text", value: r.message, "aria-label": `Rule ${i + 1} message`, "data-fk": `rule-m-${i}` });
        e.addEventListener("input", () => { r.expr = e.value; }); m.addEventListener("input", () => { r.message = m.value; });
        rules.append(h("div", { class: "rule" }, e, m, btn(`rule-del-${i}`, "Remove rule", () => { draftRules.splice(i, 1); this.tryDo({ t: "setValidation", form: this.form, id: c.id, rules: draftRules }, "Removed the rule."); }, true, { "aria-label": `Remove rule ${i + 1}` })));
      });
      const ne = h("input", { type: "text", id: "rule-new-e", "aria-label": "New rule expression", placeholder: "qty > 0", "data-fk": "rule-new-e" });
      const nm = h("input", { type: "text", id: "rule-new-m", "aria-label": "New rule message", placeholder: "Message shown when it fails", "data-fk": "rule-new-m" });
      rules.append(h("div", { class: "rule" }, ne, nm, btn("rule-add", "Add rule", () => this.tryDo({ t: "setValidation", form: this.form, id: c.id, rules: [...draftRules, { expr: ne.value, message: nm.value }] }, "Added the rule."))));
      if (draftRules.length) rules.append(btn("rule-save", "Save rules", () => this.tryDo({ t: "setValidation", form: this.form, id: c.id, rules: draftRules }, "Saved the rules.")));
      sec.append(rules);
    }
    return sec;
  }

  private renamePanel(btn: (key: string, label: string, fn: () => void, enabled?: boolean, extra?: Record<string, string>) => HTMLButtonElement): HTMLElement {
    const ent = this.def.entities.find((e) => e.name === this.formDef.entity)!;
    if (!ent.fields.some((x) => x.name === this.renameDraft.field)) this.renameDraft = { field: ent.fields[0]!.name, to: "" };
    const fieldSel = h("select", { id: "rn-field", "data-fk": "rn-field" }, ...ent.fields.map((x) => h("option", { value: x.name, selected: x.name === this.renameDraft.field }, x.name)));
    const nameIn = h("input", { id: "rn-to", type: "text", "data-fk": "rn-to", value: this.renameDraft.to });
    fieldSel.addEventListener("change", () => { this.renameDraft.field = fieldSel.value; this.renamePreview = null; });
    nameIn.addEventListener("input", () => { this.renameDraft.to = nameIn.value; });
    const sec = h("section", { class: "panel", "aria-labelledby": "rn-h" }, h("h2", { id: "rn-h" }, "Rename a field"),
      h("div", { class: "prop" }, h("label", { for: "rn-field" }, `Field of ${ent.name}`), fieldSel),
      h("div", { class: "prop" }, h("label", { for: "rn-to" }, "New name"), nameIn),
      btn("rn-preview", "Preview rename", () => {
        try { this.renamePreview = planRenameField(this.def, ent.name, fieldSel.value, nameIn.value); this.say("Preview ready."); } catch (e) { if (e instanceof OpError) { this.renamePreview = null; this.say(`Not changed: ${e.message}`, "alert"); } else throw e; }
        this.render();
      }));
    const p = this.renamePreview;
    if (p) {
      sec.append(h("h3", {}, "This rename will update"), h("ul", { id: "rn-updated" }, ...p.updated.map((u) => h("li", {}, u))));
      sec.append(h("h3", {}, "Handlers to review"), p.handlersToReview.length ? h("ul", { id: "rn-handlers" }, ...p.handlersToReview.map((x) => h("li", {}, `${x.handler}, lines ${x.lines.join(", ")}`))) : h("p", {}, "None."));
      sec.append(h("h3", {}, "Data migration, applied when the draft is published"), h("pre", { id: "rn-sql", tabindex: "0", role: "region", "aria-label": "Data migration SQL" }, p.migration.join(";\n")));
      sec.append(btn("rn-apply", "Apply rename", () => { const to = nameIn.value, from = fieldSel.value; if (this.tryDo({ t: "renameField", entity: ent.name, from, to }, `Renamed ${from} to ${to}.`)) this.renameDraft = { field: to, to: "" }; }));
    }
    return sec;
  }
}
