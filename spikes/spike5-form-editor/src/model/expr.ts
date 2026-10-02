// The expression language for visibility rules, validation rules, and defaults.
// The specification is docs/EXPRESSIONS.md. The Python evaluator in backend/a2w/expr.py must give the same results,
// and spec/expression/vectors.json holds the cases that both must pass.
export class ExprError extends Error {
  pos: number;
  constructor(message: string, pos = 0) { super(message); this.name = "ExprError"; this.pos = pos; }
}

export const MAX_LENGTH = 500;
export const MAX_DEPTH = 64;

type TokKind = "num" | "str" | "ident" | "op" | "eof";
export interface Tok { kind: TokKind; text: string; start: number; end: number }

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "+", "-", "*", "/", "(", ")", ","];
// Name and number of arguments. A negative count means "at least".
const FUNCS: Record<string, number> = { isnull: 1, len: 1, coalesce: -1, today: 0, lower: 1, upper: 1 };

export function tokenize(src: string): Tok[] {
  if (Array.from(src).length > MAX_LENGTH) throw new ExprError(`expression is longer than ${MAX_LENGTH} characters`);  // counted in code points
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      if (!Number.isFinite(Number(m[0]))) throw new ExprError("number out of range", i);
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
  let i = 0, depth = 0;
  const peek = () => t[i]!;
  const eatOp = (o: string) => (peek().kind === "op" && peek().text === o ? (i++, true) : false);
  const enter = () => { if (++depth > MAX_DEPTH) throw new ExprError("expression is nested too deeply", peek().start); };

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
        if (!Object.hasOwn(FUNCS, low)) throw new ExprError(`unknown function ${k.text}`, k.start);
        i++;
        const args: Node[] = [];
        if (!eatOp(")")) { do args.push(expr(0)); while (eatOp(",")); if (!eatOp(")")) throw new ExprError("expected )", peek().start); }
        const want = FUNCS[low]!;
        if (want >= 0 ? args.length !== want : args.length < -want) throw new ExprError(`${low}() takes ${want >= 0 ? want : `at least ${-want}`} argument${(want >= 0 ? want : -want) === 1 ? "" : "s"}`, k.start);
        return { k: "call", fn: low, args };
      }
      return { k: "ref", name: k.text, tok: k };
    }
    if (eatOp("(")) { const e = expr(0); if (!eatOp(")")) throw new ExprError("expected )", peek().start); return e; }
    throw new ExprError(`unexpected ${k.kind === "eof" ? "end of expression" : JSON.stringify(k.text)}`, k.start);
  }
  function unary(): Node {
    enter();
    try {
      if (eatOp("!")) return { k: "un", op: "!", e: unary() };
      if (eatOp("-")) return { k: "un", op: "-", e: unary() };
      return primary();
    } finally { depth--; }
  }
  function expr(minPrec: number): Node {
    enter();
    try {
      let l = unary();
      for (;;) {
        const k = peek();
        const p = k.kind === "op" ? PREC[k.text] : undefined;
        if (p === undefined || p < minPrec) break;
        i++;
        const r = expr(p + 1);
        l = { k: "bin", op: k.text, l, r };
      }
      return l;
    } finally { depth--; }
  }
  const e = expr(0);
  if (peek().kind !== "eof") throw new ExprError(`unexpected ${JSON.stringify(peek().text)}`, peek().start);
  return e;
}

/** Field names that an expression refers to, once each, in order of first use. */
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
  return /^[ \t\r\n]*\(/.test(src.slice(tk.end));  // a call such as isnull(...), not a field
}

export type Value = number | string | boolean | null;

const isNum = (v: Value): v is number => typeof v === "number";
const isStr = (v: Value): v is string => typeof v === "string";
const finite = (v: number): Value => (Number.isFinite(v) ? v : null);

/** Order two strings by Unicode code point, so every implementation agrees. */
function cmpStr(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!; if (d) return d; }
  return x.length - y.length;
}

/** A value from a record: null, a boolean, a finite number, or a string. Anything else counts as null. */
function lookup(record: Record<string, unknown>, name: string): Value {
  if (!Object.hasOwn(record, name)) return null;
  const v = record[name];
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

export function evaluate(src: string | Node, record: Record<string, unknown>, now: Date = new Date()): Value {
  const n = typeof src === "string" ? parse(src) : src;
  const ev = (x: Node): Value => {
    switch (x.k) {
      case "num": case "str": case "bool": return x.v;
      case "null": return null;
      case "ref": return lookup(record, x.name);
      case "un": { const v = ev(x.e); return x.op === "!" ? !truthy(v) : isNum(v) ? -v : null; }
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
        // Only two numbers or two strings have an order. Any other pair, including null, gives false.
        let c: number;
        if (isNum(a) && isNum(b)) c = a < b ? -1 : a > b ? 1 : 0;
        else if (isStr(a) && isStr(b)) c = Math.sign(cmpStr(a, b));
        else return false;
        return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
      }
      case "+": return isNum(a) && isNum(b) ? finite(a + b) : isStr(a) && isStr(b) ? a + b : null;
      case "-": return isNum(a) && isNum(b) ? finite(a - b) : null;
      case "*": return isNum(a) && isNum(b) ? finite(a * b) : null;
      case "/": return isNum(a) && isNum(b) && b !== 0 ? finite(a / b) : null;
    }
    throw new ExprError(`operator ${op} is not supported`);
  };
  const call = (fn: string, a: Value[]): Value => {
    const a0: Value = a[0] ?? null;  // the parser has already checked the number of arguments
    switch (fn) {
      case "isnull": return a0 === null || a0 === "";
      case "len": return a0 === null ? 0 : isStr(a0) ? Array.from(a0).length : null;
      case "coalesce": return a.find((v) => v !== null && v !== "") ?? null;
      case "today": return now.toISOString().slice(0, 10);
      case "lower": return isStr(a0) ? a0.toLowerCase() : null;
      case "upper": return isStr(a0) ? a0.toUpperCase() : null;
    }
    throw new ExprError(`unknown function ${fn}`);
  };
  return ev(n);
}

export function truthy(v: Value): boolean {
  return v !== null && v !== false && v !== 0 && v !== "";
}
