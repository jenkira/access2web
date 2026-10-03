// The adapter between the editor's definition and the backend's.
import test from "node:test";
import assert from "node:assert/strict";
import { AdapterError, editorType, entityFromNative, fromNative, renamesOf } from "../src/backend/adapter.ts";
import type { Op } from "../src/model/ops.ts";

test("PostgreSQL types map to the editor's four types", () => {
  const cases: [string, string][] = [
    ["integer", "number"], ["smallint", "number"], ["bigint", "number"], ["real", "number"], ["double precision", "number"],
    ["numeric(19,4)", "number"], ["numeric", "number"], ["timestamp", "date"], ["date", "date"], ["boolean", "bool"],
    ["varchar(50)", "text"], ["text", "text"], ["uuid", "text"],
  ];
  for (const [pg, want] of cases) assert.equal(editorType(pg), want, pg);
});

test("a key or an identity column is a key, and nothing else is", () => {
  const e = entityFromNative({ name: "customers", primary_key: ["customerid"], fields: [
    { name: "customerid", type: "integer", required: true, identity: true }, { name: "customer_name", type: "varchar(50)", required: true },
    { name: "email", type: "varchar(80)" }, { name: "code", type: "integer", identity: true } ] });
  assert.deepEqual(e.fields.map((f) => [f.name, f.type, !!f.required, !!f.key]), [
    ["customerid", "number", true, true], ["customer_name", "text", true, false], ["email", "text", false, false], ["code", "number", false, true]]);
  assert.equal(e.table, e.name, "the backend names a table and its entity alike");
});

test("a column in a composite key counts as a key, as it does on the server", () => {
  const e = entityFromNative({ name: "lines", primary_key: ["a", "b"], fields: [{ name: "a", type: "integer", required: true }, { name: "b", type: "integer", required: true }, { name: "c", type: "text", required: true }] });
  assert.deepEqual(e.fields.map((f) => !!f.key), [true, true, false]);
});

test("a native definition becomes an editor definition with no queries or handlers, and the forms are copied", () => {
  const forms = [{ name: "F", title: "F", entity: "customers", rows: [] }];
  const d = fromNative("shop", { version: 3, entities: [{ name: "customers", fields: [{ name: "x", type: "text" }] }], forms });
  assert.equal(d.app, "shop"); assert.equal(d.version, 3);
  assert.deepEqual([d.queries, d.handlers], [[], []]);
  assert.notEqual(d.forms[0], forms[0], "editing the draft must not change the loaded object");
});

test("only renames are taken from a log, in order, as the backend writes them", () => {
  const log: Op[] = [
    { t: "setLabel", form: "F", id: "c", label: "x" },
    { t: "renameEntity", from: "customers", to: "clients" },
    { t: "renameField", entity: "clients", from: "email", to: "mail" },
    { t: "setVisible", form: "F", id: "c", expr: null },
  ];
  assert.deepEqual(renamesOf(log), [{ kind: "entity", from: "customers", to: "clients" }, { kind: "field", entity: "clients", from: "email", to: "mail" }]);
  assert.deepEqual(renamesOf([]), []);
});

test("a rename that would give the table another name than the entity is refused", () => {
  assert.throws(() => renamesOf([{ t: "renameEntity", from: "customers", to: "clients", table: "client_table" }]), AdapterError);
  assert.deepEqual(renamesOf([{ t: "renameEntity", from: "customers", to: "clients", table: "clients" }]), [{ kind: "entity", from: "customers", to: "clients" }]);
});
