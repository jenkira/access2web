import test from "node:test";
import assert from "node:assert/strict";
import { demoDefinition } from "../fixtures/demo.ts";
import { History } from "../src/model/history.ts";
import { apply, type Op } from "../src/model/ops.ts";
import { canonical, type Control } from "../src/model/types.ts";
import { OpError, validateDefinition } from "../src/model/validate.ts";

const ids = (def: ReturnType<typeof demoDefinition>, form: string) => def.forms.find((f) => f.name === form)!.rows.map((r) => r.controls.map((c) => c.id).join("+"));
const newText = (id: string, bind: string): Control => ({ id, type: "text", bind, label: id });

test("the fixture forms are valid", () => { assert.deepEqual(validateDefinition(demoDefinition()), []); });

test("add a control to a row, and in a new row", () => {
  const d0 = demoDefinition();
  const d1 = apply(d0, { t: "addControl", form: "CustomerForm", place: { row: 0 }, control: newText("x1", "city") });
  assert.deepEqual(ids(d1, "CustomerForm")[0], "c_name+x1");
  const d2 = apply(d1, { t: "addControl", form: "CustomerForm", place: { newRowAt: 1, newRowId: "rn" }, control: newText("x2", "city") });
  assert.deepEqual(ids(d2, "CustomerForm").slice(0, 3), ["c_name+x1", "x2", "c_city+c_joined"]);
  assert.equal(ids(d0, "CustomerForm")[0], "c_name", "the input definition is not changed");
});

test("remove drops an empty row", () => {
  const d = apply(demoDefinition(), { t: "removeControl", form: "CustomerForm", id: "c_name" });
  assert.deepEqual(ids(d, "CustomerForm"), ["c_city+c_joined", "c_credit+c_active", "c_save"]);
});

test("move counts positions after the control is removed", () => {
  const d0 = demoDefinition();
  const a = apply(d0, { t: "moveControl", form: "CustomerForm", id: "c_city", place: { row: 0 }, index: 1 });
  assert.deepEqual(ids(a, "CustomerForm").slice(0, 2), ["c_name+c_city", "c_joined"]);
  const b = apply(d0, { t: "moveControl", form: "CustomerForm", id: "c_name", place: { row: 0 } });  // its own row vanished, so row 0 is c_city+c_joined
  assert.deepEqual(ids(b, "CustomerForm")[0], "c_city+c_joined+c_name");
});

test("labels: a label control has text, others have a label", () => {
  const d = apply(demoDefinition(), { t: "setLabel", form: "CustomerForm", id: "c_name", label: "Full name" });
  assert.equal((d.forms[0]!.rows[0]!.controls[0] as { label: string }).label, "Full name");
  assert.throws(() => apply(demoDefinition(), { t: "setLabel", form: "CustomerForm", id: "c_name", label: "  " }), OpError);
});

test("visibility, validation, and default are checked against the form's fields", () => {
  const d0 = demoDefinition();
  const d1 = apply(d0, { t: "setVisible", form: "CustomerForm", id: "c_city", expr: "active && credit_limit > 100" });
  assert.equal((d1.forms[0]!.rows[1]!.controls[0] as { visible?: string }).visible, "active && credit_limit > 100");
  for (const bad of ["nope > 1", "active &&", "foo(1)", "unit_price > 0"]) {
    assert.throws(() => apply(d0, { t: "setVisible", form: "CustomerForm", id: "c_city", expr: bad }), OpError, bad);
  }
  assert.throws(() => apply(d0, { t: "setValidation", form: "CustomerForm", id: "c_credit", rules: [{ expr: "credit_limit > 0", message: "" }] }), OpError);
  assert.throws(() => apply(d0, { t: "setDefault", form: "CustomerForm", id: "c_save", expr: "1" }), OpError, "a button has no default");
  assert.throws(() => apply(d0, { t: "setValidation", form: "CustomerForm", id: "c_save", rules: [] }), OpError);
  const cleared = apply(apply(d0, { t: "setValidation", form: "ProductForm", id: "p_price", rules: [] }), { t: "setDefault", form: "ProductForm", id: "p_price", expr: null });
  const c = cleared.forms[1]!.rows[2]!.controls[0] as { validate?: unknown; default?: unknown };
  assert.equal(c.validate, undefined); assert.equal(c.default, undefined);
});

test("an invalid edit changes nothing", () => {
  const d0 = demoDefinition();
  const before = canonical(d0);
  const bad: Op[] = [
    { t: "addControl", form: "CustomerForm", place: { row: 0 }, control: newText("c_name", "city") },       // id taken
    { t: "addControl", form: "CustomerForm", place: { row: 0 }, control: newText("z", "no_such_field") },
    { t: "addControl", form: "CustomerForm", place: { row: 99 }, control: newText("z", "city") },
    { t: "addControl", form: "CustomerForm", place: { row: 0 }, index: 9, control: newText("z", "city") },
    { t: "removeControl", form: "CustomerForm", id: "ghost" },
    { t: "moveControl", form: "NoForm", id: "c_name", place: { row: 0 } },
    { t: "renameField", entity: "Customer", from: "name", to: "city" },          // taken
    { t: "renameField", entity: "Customer", from: "ghost", to: "x" },
    { t: "renameField", entity: "Customer", from: "name", to: "Bad Name" },
    { t: "renameEntity", from: "Customer", to: "Order" },
  ];
  for (const op of bad) assert.throws(() => apply(d0, op), OpError, JSON.stringify(op));
  assert.equal(canonical(d0), before);
});

test("combo and subform controls are checked", () => {
  const d0 = demoDefinition();
  const combo: Control = { id: "k1", type: "combo", bind: "customer_id", label: "C", source: { entity: "Customer", value: "customerid", display: "ghost" } };
  assert.throws(() => apply(d0, { t: "addControl", form: "OrderForm", place: { row: 0 }, control: combo }), OpError);
  const sub: Control = { id: "k2", type: "subform", label: "L", child: { entity: "OrderLine", link: "ghost", parentKey: "orderid" }, columns: ["qty"] };
  assert.throws(() => apply(d0, { t: "addControl", form: "OrderForm", place: { newRowAt: 0, newRowId: "rz" }, control: sub }), OpError);
});

test("undo and redo move through the log, and a new edit drops the redo tail", () => {
  const h = new History(demoDefinition());
  h.do({ t: "setLabel", form: "CustomerForm", id: "c_name", label: "A" });
  h.do({ t: "setLabel", form: "CustomerForm", id: "c_name", label: "B" });
  assert.equal(h.log.length, 2);
  h.undo();
  assert.equal((h.current.forms[0]!.rows[0]!.controls[0] as { label: string }).label, "A");
  assert.ok(h.canRedo);
  h.do({ t: "setLabel", form: "CustomerForm", id: "c_name", label: "C" });
  assert.ok(!h.canRedo);
  assert.deepEqual(h.log.map((o) => (o as { label: string }).label), ["A", "C"]);
  h.undo(); h.undo(); h.undo();
  assert.ok(!h.canUndo);
  assert.equal(canonical(h.current), canonical(demoDefinition()));
  assert.ok(h.verify());
});

test("a rejected edit leaves the history unchanged", () => {
  const h = new History(demoDefinition());
  h.do({ t: "setLabel", form: "CustomerForm", id: "c_name", label: "A" });
  h.undo();
  assert.throws(() => h.do({ t: "removeControl", form: "CustomerForm", id: "ghost" }), OpError);
  assert.ok(h.canRedo, "the redo tail survives a rejected edit");
});
