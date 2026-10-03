// Rename a field or an entity, and carry the change to every place that refers to it.
// Handlers are never edited. They are listed for review.
import { type Control, type Definition, type Form, clone } from "./types.ts";
import { renameRef } from "./expr.ts";
import { renameColumnInSql, renameTableInSql, type TableFields } from "./sql.ts";
import { IDENT, OpError, entityOf } from "./validate.ts";

export interface HandlerHit { handler: string; lines: number[] }
export interface RenamePlan {
  def: Definition;
  updated: string[];            // where the rename was applied automatically
  queriesToReview: string[];    // queries the rewriter could not place with certainty
  handlersToReview: HandlerHit[];
  migration: string[];          // SQL for the application's schema
}

export function schemaOf(def: Definition): string {
  return `app_${def.app}`;
}

const q = (s: string) => '"' + s.replaceAll('"', '""') + '"';

export function scanHandlers(def: Definition, name: string): HandlerHit[] {
  const re = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
  const hits: HandlerHit[] = [];
  for (const h of def.handlers) {
    const lines = h.source.split("\n").flatMap((l, i) => (re.test(l) ? [i + 1] : []));
    if (lines.length) hits.push({ handler: h.name, lines });
  }
  return hits;
}

function mapControls(f: Form, fn: (c: Control) => Control | void): void {
  for (const row of f.rows) row.controls = row.controls.map((c) => fn(c) ?? c);
}

function tableFields(def: Definition): TableFields {
  return Object.fromEntries(def.entities.map((e) => [e.table, e.fields.map((f) => f.name)]));
}

export function planRenameField(input: Definition, entityName: string, from: string, to: string): RenamePlan {
  const def = clone(input);
  const ent = entityOf(def, entityName);
  if (!ent.fields.some((f) => f.name === from)) throw new OpError(`unknown field ${from} in ${entityName}`);
  if (!IDENT.test(to)) throw new OpError(`${to} is not a valid field name`);
  if (ent.fields.some((f) => f.name === to)) throw new OpError(`${entityName} already has a field ${to}`);
  const updated: string[] = [];
  const fieldsBefore = tableFields(def);  // for query rewriting, before the entity changes

  for (const f of def.forms) {
    const own = f.entity === entityName;
    mapControls(f, (c) => {
      const before = JSON.stringify(c);
      if (own) {
        if ("bind" in c && c.bind === from) c.bind = to;
        if (c.visible !== undefined) c.visible = renameRef(c.visible, from, to);
        if ("validate" in c && c.validate) c.validate = c.validate.map((r) => ({ ...r, expr: renameRef(r.expr, from, to) }));
        if ("default" in c && c.default !== undefined) c.default = renameRef(c.default, from, to);
        if (c.type === "subform" && c.child.parentKey === from) c.child.parentKey = to;
      }
      if (c.type === "combo" && c.source.entity === entityName) {
        if (c.source.value === from) c.source.value = to;
        if (c.source.display === from) c.source.display = to;
      }
      if (c.type === "subform" && c.child.entity === entityName) {
        if (c.child.link === from) c.child.link = to;
        c.columns = c.columns.map((x) => (x === from ? to : x));
      }
      if (JSON.stringify(c) !== before) updated.push(`form ${f.name}, control ${c.id}`);
    });
  }

  const queriesToReview: string[] = [];
  for (const qd of def.queries) {
    const r = renameColumnInSql(qd.sql, ent.table, from, to, fieldsBefore);
    if (r.status === "updated") { qd.sql = r.sql; updated.push(`query ${qd.name}`); }
    else if (r.status === "ambiguous") queriesToReview.push(`${qd.name}: ${r.note}`);
  }

  ent.fields = ent.fields.map((x) => (x.name === from ? { ...x, name: to } : x));
  updated.unshift(`entity ${entityName}, field ${from}`);
  return {
    def, updated, queriesToReview,
    handlersToReview: scanHandlers(input, from),
    migration: [`alter table ${q(schemaOf(def))}.${q(ent.table)} rename column ${q(from)} to ${q(to)}`],
  };
}

export function planRenameEntity(input: Definition, from: string, to: string, newTable?: string): RenamePlan {
  const def = clone(input);
  const ent = entityOf(def, from);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(to)) throw new OpError(`${to} is not a valid entity name`);
  if (def.entities.some((e) => e.name === to)) throw new OpError(`entity ${to} already exists`);
  const table = newTable ?? ent.table;
  if (!IDENT.test(table)) throw new OpError(`${table} is not a valid table name`);
  if (table !== ent.table && def.entities.some((e) => e.table === table)) throw new OpError(`table ${table} already exists`);
  const updated: string[] = [`entity ${from}`];
  for (const f of def.forms) {
    if (f.entity === from) { f.entity = to; updated.push(`form ${f.name}`); }
    mapControls(f, (c) => {
      let hit = false;
      if (c.type === "combo" && c.source.entity === from) { c.source.entity = to; hit = true; }
      if (c.type === "subform" && c.child.entity === from) { c.child.entity = to; hit = true; }
      if (hit) updated.push(`form ${f.name}, control ${c.id}`);
    });
  }
  const queriesToReview: string[] = [];
  const oldTable = ent.table;
  if (table !== oldTable) {
    for (const qd of def.queries) {
      const r = renameTableInSql(qd.sql, oldTable, table);
      if (r.status === "updated") { qd.sql = r.sql; updated.push(`query ${qd.name}`); }
    }
  }
  ent.name = to; ent.table = table;
  return {
    def, updated, queriesToReview,
    handlersToReview: [...scanHandlers(input, from), ...(table !== oldTable ? scanHandlers(input, oldTable) : [])],
    migration: table !== oldTable ? [`alter table ${q(schemaOf(def))}.${q(oldTable)} rename to ${q(table)}`] : [],
  };
}
