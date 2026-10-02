// The small declarative expression language for visibility, validation, and defaults.
// Identifiers are field names of the form's entity. No assignment, no loops, no calls except the listed functions.
export class ExprError extends Error {
  pos: number;
  constructor(message: string, pos = 0) { super(message); this.name = "ExprError"; this.pos = pos; }
}

type TokKind = "num" | "str" | "ident" | "op" | "eof";
export interface Tok { kind: TokKind; text: string; start: number; end: number }

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "+", "-", "*", "/", "(", ")", ","];
const FUNCS = new Set(["isnull", "len", "coalesce", "today", "lower", "upper"]);

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?|^\d+\.?/.exec(src.slice(i))!;
      out.push({ kind: "num", text: m[0], start: i, end: i + m[0].length }); i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; } else s += src[j++]; }
      if (j >= src.length) throw new ExprError("unterminated string", i);
      out.push({ kind: "str", text: s, start: i, end: j + 1 }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ kind: "ident", text: m[0], start: i, end: i + m[0].length }); i += m[0].length; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character ${JSON.stringify(c)}`, i);
    out.push({ kind: "op", text: op, start: i, end: i + op.length }); i += op.length;
  }
  out.push({ kind: "eof", text: "", start: src.length, end: src.length });
  return out;
}

export type Node =
  | { k: "num"; v: number } | { k: "str"; v: string } | { k: "bool"; v: boolean } | { k: "null" }
  | { k: "ref"; name: string; tok: Tok }
  | { k: "un"; op: string; e: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "call"; fn: string; args: Node[] };

const PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6 };

export function parse(src: string): Node {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i]!;
  const eatOp = (o: string) => (peek().kind === "op" && peek().text === o ? (i++, true) : false);

  function primary(): Node {
    const k = peek();
    if (k.kind === "num") { i++; return { k: "num", v: Number(k.text) }; }
    if (k.kind === "str") { i++; return { k: "str", v: k.text }; }
    if (k.kind === "ident") {
      i++;
      const low = k.text.toLowerCase();
      if (low === "true") return { k: "bool", v: true };
      if (low === "false") return { k: "bool", v: false };
      if (low === "null") return { k: "null" };
      if (peek().kind === "op" && peek().text === "(") {
        if (!FUNCS.has(low)) throw new ExprError(`unknown function ${k.text}`, k.start);
        i++;
        const args: Node[] = [];
        if (!eatOp(")")) { do args.push(expr(0)); while (eatOp(",")); if (!eatOp(")")) throw new ExprError("expected )", peek().start); }
        return { k: "call", fn: low, args };
      }
      return { k: "ref", name: k.text, tok: k };
    }
    if (eatOp("(")) { const e = expr(0); if (!eatOp(")")) throw new ExprError("expected )", peek().start); return e; }
    throw new ExprError(`unexpected ${k.kind === "eof" ? "end of expression" : JSON.stringify(k.text)}`, k.start);
  }
  function unary(): Node {
    if (eatOp("!")) return { k: "un", op: "!", e: unary() };
    if (eatOp("-")) return { k: "un", op: "-", e: unary() };
    return primary();
  }
  function expr(minPrec: number): Node {
    let l = unary();
    for (;;) {
      const k = peek();
      const p = k.kind === "op" ? PREC[k.text] : undefined;
      if (p === undefined || p <= minPrec - 1 || p < minPrec) break;
      i++;
      const r = expr(p + 1);
      l = { k: "bin", op: k.text, l, r };
    }
    return l;
  }
  const e = expr(0);
  if (peek().kind !== "eof") throw new ExprError(`unexpected ${JSON.stringify(peek().text)}`, peek().start);
  return e;
}

/** Field names that an expression refers to. */
export function refs(src: string): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.k === "ref") out.push(n.name);
    else if (n.k === "un") walk(n.e);
    else if (n.k === "bin") { walk(n.l); walk(n.r); }
    else if (n.k === "call") n.args.forEach(walk);
  };
  walk(parse(src));
  return [...new Set(out)];
}

/** Rename a field in an expression. Only identifier tokens change, so the author's spacing is kept. */
export function renameRef(src: string, from: string, to: string): string {
  parse(src);  // throws if the expression is invalid
  let out = "", last = 0;
  for (const tk of tokenize(src)) {
    if (tk.kind === "ident" && tk.text === from && !isFuncOrLiteral(src, tk)) { out += src.slice(last, tk.start) + to; last = tk.end; }
  }
  return out + src.slice(last);
}

function isFuncOrLiteral(src: string, tk: Tok): boolean {
  const low = tk.text.toLowerCase();
  if (low === "true" || low === "false" || low === "null") return true;
  return /^\s*\(/.test(src.slice(tk.end));  // a call such as isnull(...), not a field
}

export type Value = number | string | boolean | null;

export function evaluate(src: string | Node, record: Record<string, Value>, now: Date = new Date()): Value {
  const n = typeof src === "string" ? parse(src) : src;
  const ev = (x: Node): Value => {
    switch (x.k) {
      case "num": case "str": case "bool": return x.v;
      case "null": return null;
      case "ref": return Object.hasOwn(record, x.name) ? record[x.name]! : null;
      case "un": { const v = ev(x.e); return x.op === "!" ? !truthy(v) : v === null ? null : -Number(v); }
      case "bin": return bin(x.op, x.l, x.r);
      case "call": return call(x.fn, x.args.map(ev));
    }
  };
  const bin = (op: string, l: Node, r: Node): Value => {
    if (op === "&&") return truthy(ev(l)) && truthy(ev(r));
    if (op === "||") return truthy(ev(l)) || truthy(ev(r));
    const a = ev(l), b = ev(r);
    switch (op) {
      case "==": return a === b;
      case "!=": return a !== b;
      case "<": case ">": case "<=": case ">=": {
        if (a === null || b === null) return false;  // a comparison with null is false, as in SQL
        return op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
      }
      case "+": return a === null || b === null ? null : typeof a === "string" || typeof b === "string" ? String(a) + String(b) : Number(a) + Number(b);
      case "-": return a === null || b === null ? null : Number(a) - Number(b);
      case "*": return a === null || b === null ? null : Number(a) * Number(b);
      case "/": return a === null || b === null || Number(b) === 0 ? null : Number(a) / Number(b);
    }
    throw new ExprError(`operator ${op} is not supported`);
  };
  const call = (fn: string, a: Value[]): Value => {
    switch (fn) {
      case "isnull": return a[0] === null || a[0] === undefined || a[0] === "";
      case "len": return a[0] === null ? 0 : String(a[0]).length;
      case "coalesce": return a.find((v) => v !== null && v !== "") ?? null;
      case "today": return now.toISOString().slice(0, 10);
      case "lower": return a[0] === null ? null : String(a[0]).toLowerCase();
      case "upper": return a[0] === null ? null : String(a[0]).toUpperCase();
    }
    throw new ExprError(`unknown function ${fn}`);
  };
  return ev(n);
}

export function truthy(v: Value): boolean {
  return v !== null && v !== false && v !== 0 && v !== "";
}
