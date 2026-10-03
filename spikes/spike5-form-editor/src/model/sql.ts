// Token-level rewriting of PostgreSQL query text, for rename. It handles the query shapes the converter emits:
// select, joins, aliases, qualified and unqualified columns. A query it cannot place with certainty is reported, never guessed.
export type SqlTok = { kind: "ws" | "str" | "qid" | "id" | "num" | "p"; text: string };

const KEYWORDS = new Set(["select", "from", "where", "group", "order", "by", "having", "limit", "offset", "union", "all", "intersect", "except",
  "join", "inner", "left", "right", "full", "outer", "cross", "natural", "on", "using", "as", "and", "or", "not", "in", "is", "null", "like", "ilike",
  "between", "case", "when", "then", "else", "end", "distinct", "asc", "desc", "true", "false", "with", "returning", "fetch", "for", "set", "values", "into"]);
const FROM_END = new Set(["where", "group", "order", "having", "limit", "offset", "union", "intersect", "except", "returning", "fetch", "for", "window"]);

export function tokenizeSql(sql: string): SqlTok[] {
  const out: SqlTok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { const m = /^\s+/.exec(sql.slice(i))!; out.push({ kind: "ws", text: m[0] }); i += m[0].length; }
    else if (c === "-" && sql[i + 1] === "-") { const j = sql.indexOf("\n", i); const e = j < 0 ? sql.length : j; out.push({ kind: "ws", text: sql.slice(i, e) }); i = e; }
    else if (c === "/" && sql[i + 1] === "*") { const j = sql.indexOf("*/", i + 2); const e = j < 0 ? sql.length : j + 2; out.push({ kind: "ws", text: sql.slice(i, e) }); i = e; }
    else if (c === "'") { let j = i + 1; while (j < sql.length) { if (sql[j] === "'") { if (sql[j + 1] === "'") j += 2; else break; } else j++; } out.push({ kind: "str", text: sql.slice(i, j + 1) }); i = j + 1; }
    else if (c === '"') { let j = i + 1; while (j < sql.length) { if (sql[j] === '"') { if (sql[j + 1] === '"') j += 2; else break; } else j++; } out.push({ kind: "qid", text: sql.slice(i, j + 1) }); i = j + 1; }
    else if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!; out.push({ kind: "id", text: m[0] }); i += m[0].length; }
    else if (/[0-9]/.test(c)) { const m = /^[0-9]+(?:\.[0-9]+)?/.exec(sql.slice(i))!; out.push({ kind: "num", text: m[0] }); i += m[0].length; }
    else { out.push({ kind: "p", text: c }); i++; }
  }
  return out;
}

const nameOf = (t: SqlTok): string => (t.kind === "qid" ? t.text.slice(1, -1).replaceAll('""', '"') : t.text.toLowerCase());
const isName = (t: SqlTok | undefined): t is SqlTok => !!t && (t.kind === "qid" || (t.kind === "id" && !KEYWORDS.has(t.text.toLowerCase())));
const quoteName = (n: string) => '"' + n.replaceAll('"', '""') + '"';

export type TableFields = Record<string, string[]>;  // table -> column names
export interface SqlResult { sql: string; status: "updated" | "unchanged" | "ambiguous"; changes: number; note?: string }

interface TableRef { table: string; alias: string; tokIdx: number[] }

function tableRefs(t: SqlTok[]): { refs: TableRef[]; unsupported: boolean } {
  const refs: TableRef[] = [];
  let unsupported = false, expect = false, inFrom = false;
  const next = (i: number) => { let j = i + 1; while (t[j]?.kind === "ws") j++; return j; };
  for (let i = 0; i < t.length; i++) {
    const tk = t[i]!;
    if (tk.kind === "id") {
      const low = tk.text.toLowerCase();
      if (low === "from") { expect = true; inFrom = true; continue; }
      if (low === "join") { expect = true; continue; }
      if (FROM_END.has(low)) inFrom = false;
    }
    if (tk.kind === "p" && tk.text === "," && inFrom) { expect = true; continue; }
    if (!expect || tk.kind === "ws") continue;
    expect = false;
    if (tk.kind === "p" && tk.text === "(") { unsupported = true; continue; }  // a derived table
    if (!isName(tk)) continue;
    let j = i, first = tk, idxs = [i];
    const dot = next(j);
    if (t[dot]?.text === "." && isName(t[next(dot)])) { j = next(dot); first = t[j]!; idxs = [j]; }  // schema.table: the table is the second part
    let alias = nameOf(first);
    let k = next(j);
    if (t[k]?.kind === "id" && t[k]!.text.toLowerCase() === "as") k = next(k);
    if (isName(t[k]) && !(t[k]!.kind === "id" && KEYWORDS.has(t[k]!.text.toLowerCase()))) { alias = nameOf(t[k]!); idxs.push(k); }
    refs.push({ table: nameOf(first), alias, tokIdx: idxs });
  }
  return { refs, unsupported };
}

/** Rename a column of one table everywhere it is used in the query. */
export function renameColumnInSql(sql: string, table: string, from: string, to: string, fields: TableFields): SqlResult {
  const t = tokenizeSql(sql);
  const { refs, unsupported } = tableRefs(t);
  const byAlias = new Map<string, string>();
  for (const r of refs) { if (byAlias.has(r.alias) && byAlias.get(r.alias) !== r.table) return { sql, status: "ambiguous", changes: 0, note: "an alias is used for two tables" }; byAlias.set(r.alias, r.table); }
  if (!refs.some((r) => r.table === table)) return { sql, status: "unchanged", changes: 0 };
  if (unsupported) return { sql, status: "ambiguous", changes: 0, note: "the query uses a derived table" };
  const skip = new Set(refs.flatMap((r) => r.tokIdx));
  const owners = refs.filter((r) => (fields[r.table] ?? []).includes(from));
  let changes = 0;
  const out = t.map((x) => ({ ...x }));
  const prevSig = (i: number) => { let j = i - 1; while (j >= 0 && t[j]!.kind === "ws") j--; return j; };
  const nextSig = (i: number) => { let j = i + 1; while (j < t.length && t[j]!.kind === "ws") j++; return j; };
  let depth = 0, seenFrom = false;
  for (let i = 0; i < t.length; i++) {
    const tk = t[i]!;
    if (tk.kind === "p" && tk.text === "(") depth++;
    if (tk.kind === "p" && tk.text === ")") depth--;
    if (tk.kind === "id" && tk.text.toLowerCase() === "from" && depth === 0) seenFrom = true;
    if (skip.has(i) || !(tk.kind === "qid" || tk.kind === "id") || nameOf(tk) !== from) continue;
    const p = prevSig(i), n = nextSig(i);
    if (t[n]?.text === "(") continue;  // a function call
    if (t[p]?.kind === "id" && t[p]!.text.toLowerCase() === "as") continue;  // an output alias
    let target: string | undefined;
    if (t[p]?.text === ".") {
      const q = prevSig(p);
      target = t[q] && isName(t[q]) ? byAlias.get(nameOf(t[q]!)) : undefined;
      if (t[prevSig(q)]?.text === ".") continue;  // schema-qualified: not handled, left as is
      if (target !== table) continue;
    } else {
      if (owners.length !== 1) { if (owners.some((r) => r.table === table)) return { sql, status: "ambiguous", changes: 0, note: "an unqualified column could belong to more than one table" }; continue; }
      if (owners[0]!.table !== table) continue;
    }
    // A bare select-list column has the column name as its output name. Keep it, so nothing downstream changes.
    const bareOutput = !seenFrom && depth === 0 && t[p]?.text !== "." ? true : !seenFrom && depth === 0;
    const hasAlias = t[n]?.kind === "id" && t[n]!.text.toLowerCase() === "as";
    out[i] = { kind: "qid", text: quoteName(to) };
    changes++;
    if (bareOutput && !hasAlias && (t[n]?.text === "," || (t[n]?.kind === "id" && t[n]!.text.toLowerCase() === "from"))) out[i] = { kind: "qid", text: `${quoteName(to)} as ${quoteName(from)}` };
  }
  return { sql: out.map((x) => x.text).join(""), status: changes ? "updated" : "unchanged", changes };
}

/** Rename a table everywhere it appears in the query. */
export function renameTableInSql(sql: string, from: string, to: string): SqlResult {
  const t = tokenizeSql(sql);
  const { refs } = tableRefs(t);
  const hit = refs.filter((r) => r.table === from);
  if (!hit.length) return { sql, status: "unchanged", changes: 0 };
  const out = t.map((x) => ({ ...x }));
  let changes = 0;
  const unaliased = new Set<string>();
  for (const r of hit) {
    const nameIdx = r.tokIdx[0]!;
    out[nameIdx] = { kind: "qid", text: quoteName(to) }; changes++;
    if (r.tokIdx.length === 1) unaliased.add(from);  // later "from"."col" qualifiers follow the table name
  }
  if (unaliased.size) {
    for (let i = 0; i < t.length; i++) {
      const tk = t[i]!;
      if (!(tk.kind === "qid" || tk.kind === "id") || nameOf(tk) !== from || refs.some((r) => r.tokIdx.includes(i))) continue;
      let n = i + 1; while (t[n]?.kind === "ws") n++;
      if (t[n]?.text === ".") { out[i] = { kind: "qid", text: quoteName(to) }; changes++; }
    }
  }
  return { sql: out.map((x) => x.text).join(""), status: "updated", changes };
}

/** Columns and tables a query refers to, as written. Used to validate a draft before it is published. */
export function referencedNames(sql: string): { tables: string[] } {
  return { tables: tableRefs(tokenizeSql(sql)).refs.map((r) => r.table) };
}
