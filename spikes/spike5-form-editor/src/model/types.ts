// Definition model for the form editor spike. It extends the application definition in the technical design.
export type FieldType = "text" | "number" | "date" | "bool";

export interface Field { name: string; type: FieldType; required?: boolean; key?: boolean }
export interface Entity { name: string; table: string; fields: Field[] }

export interface Rule { expr: string; message: string }

interface Base { id: string; visible?: string }
interface Bound extends Base { bind: string; label: string; validate?: Rule[]; default?: string }

export type Control =
  | (Bound & { type: "text" | "number" | "date" | "checkbox" | "textarea" })
  | (Bound & { type: "combo"; source: { entity: string; value: string; display: string } })
  | (Base & { type: "label"; text: string })
  | (Base & { type: "button"; label: string; handler?: string })
  | (Base & { type: "subform"; label: string; child: { entity: string; link: string; parentKey: string }; columns: string[] });

export interface Row { id: string; controls: Control[] }
export interface Form { name: string; title: string; entity: string; rows: Row[] }
export interface QueryDef { name: string; sql: string }
export interface HandlerDef { name: string; event: string; source: string }

export interface Definition {
  app: string;
  version: number;
  entities: Entity[];
  forms: Form[];
  queries: QueryDef[];
  handlers: HandlerDef[];
}

export function allControls(f: Form): Control[] {
  return f.rows.flatMap((r) => r.controls);
}

/** Stable JSON: keys sorted, so two equal definitions always give the same text. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val);
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}
