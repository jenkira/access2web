// The editor's definition and the Python backend's definition describe the same application in two shapes.
// This module converts between them. It has no network code, so the tests can run it directly.
import type { Definition, Entity, Field, FieldType, Form } from "../model/types.ts";
import type { Op } from "../model/ops.ts";

/** An entity as the backend returns it. The backend names a table and its entity alike. */
export interface NativeEntity {
  name: string;
  primary_key?: string[];
  fields: { name: string; type: string; required?: boolean; identity?: boolean }[];
}

export interface NativeDefinition { version: number; entities: NativeEntity[]; forms: Form[] }

/** The renames that the backend carries to the data. */
export type NativeRename =
  | { kind: "field"; entity: string; from: string; to: string }
  | { kind: "entity"; from: string; to: string };

export class AdapterError extends Error {}

/** A PostgreSQL column type, as a type the editor knows. */
export function editorType(pg: string): FieldType {
  const t = pg.trim().toLowerCase();
  if (t === "boolean") return "bool";
  if (t.startsWith("timestamp") || t === "date") return "date";
  if (/^(smallint|integer|bigint|real|double precision|numeric|decimal)\b/.test(t)) return "number";
  return "text";  // varchar, text, uuid
}

export function entityFromNative(e: NativeEntity): Entity {
  const pk = e.primary_key ?? [];
  const fields: Field[] = e.fields.map((f) => {
    const out: Field = { name: f.name, type: editorType(f.type) };
    if (f.required) out.required = true;
    // The server never counts a key as required, because the database gives it a value. The editor must agree.
    if (f.identity || pk.includes(f.name)) out.key = true;
    return out;
  });
  return { name: e.name, table: e.name, fields };
}

/** The editor's definition for a native one. The backend has no saved queries or handlers yet, so there are none. */
export function fromNative(app: string, n: NativeDefinition): Definition {
  return { app, version: n.version, entities: n.entities.map(entityFromNative), forms: structuredClone(n.forms), queries: [], handlers: [] };
}

/**
 * The renames in an editor log, in order. Other edits are not listed, because the forms are sent whole.
 * An entity in the backend has the name of its table, so a rename that gives the table another name cannot be carried out.
 */
export function renamesOf(log: Op[]): NativeRename[] {
  const out: NativeRename[] = [];
  for (const op of log) {
    if (op.t === "renameField") out.push({ kind: "field", entity: op.entity, from: op.from, to: op.to });
    else if (op.t === "renameEntity") {
      if (op.table !== undefined && op.table !== op.to) {
        throw new AdapterError(`The table of an entity has the name of the entity, so ${op.from} cannot be renamed ${op.to} with the table ${op.table}.`);
      }
      out.push({ kind: "entity", from: op.from, to: op.to });
    }
  }
  return out;
}
