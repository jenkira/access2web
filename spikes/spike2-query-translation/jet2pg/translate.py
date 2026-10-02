"""Emit PostgreSQL from the Jet SQL AST. Every semantic difference found in the spike is handled or rejected here."""
import re
from dataclasses import dataclass, field

from .lexer import Unsupported, tokenize
from .parser import Parser, Select, parse

SCHEMA_FUNCS = "a2w_jet"

PRELUDE = f"""
create schema if not exists {SCHEMA_FUNCS};
-- VBA and Access Round() rounds halves to the even digit ("banker's rounding"). PostgreSQL rounds halves away from zero.
create or replace function {SCHEMA_FUNCS}.jet_round(x numeric, n int default 0) returns numeric language sql immutable as $$
  select case when abs(x * 10^n - trunc(x * 10^n)) = 0.5
              then (round(x * 10^n / 2) * 2) / 10^n
              else round(x * 10^n) / 10^n end
$$;
"""


@dataclass
class ColumnInfo:
    access_name: str
    pg_name: str
    type: str  # text int num date bool


@dataclass
class TableInfo:
    access_name: str
    pg_name: str
    columns: list[ColumnInfo]


@dataclass
class Catalog:
    schema: str
    tables: list[TableInfo]
    text_is_citext: bool = False  # text columns use the citext type, so comparisons ignore case natively

    def table(self, name: str) -> TableInfo | None:
        return next((t for t in self.tables if t.access_name.lower() == name.lower()), None)


@dataclass
class Result:
    status: str  # translated partly_translated failed
    sql: str = ""
    params: list[str] = field(default_factory=list)
    features: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    reason: str = ""
    kind: str = "select"


def q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


@dataclass
class Entry:
    alias: str          # lower-case alias used for lookup
    pg_alias: str       # alias emitted in SQL
    cols: dict[str, tuple[str, str, str]]  # lower access name -> (pg col, access name, type)


NUMERIC = ("int", "num")

_DATE_FMT = [("yyyy", "YYYY"), ("mmmm", "FMMonth"), ("mmm", "Mon"), ("mm", "MM"), ("dddd", "FMDay"), ("ddd", "Dy"),
             ("dd", "DD"), ("hh", "HH24"), ("nn", "MI"), ("ss", "SS"), ("m", "FMMM"), ("d", "FMDD"), ("yy", "YY")]
_NUM_FMT = {"0": "FM9999999990", "0.0": "FM9999999990.0", "0.00": "FM9999999990.00", "0.000": "FM9999999990.000",
            "#,##0": "FM999,999,999,990", "#,##0.0": "FM999,999,999,990.0", "#,##0.00": "FM999,999,999,990.00", "fixed": "FM9999999990.00",
            "standard": "FM999,999,999,990.00", "#.##": None}


class Emitter:
    def __init__(self, catalog: Catalog, declared: dict[str, str], pivot_provider=None) -> None:
        self.cat = catalog
        self.declared = declared
        self.pivot_provider = pivot_provider
        self.scopes: list[list[Entry]] = []
        self.params: list[str] = []
        self.features: set[str] = set()
        self.warnings: list[str] = []
        self.splice: dict[str, tuple[str, str]] = {}
        self.depth = 0
        self.ci = catalog.text_is_citext

    # ------------------------------------------------------------------ helpers
    def feat(self, name: str) -> None:
        self.features.add(name)

    def warn(self, msg: str) -> None:
        if msg not in self.warnings:
            self.warnings.append(msg)

    def param(self, name: str) -> str:
        if name not in self.params:
            self.params.append(name)
        self.feat("parameter")
        return f"${self.params.index(name) + 1}"

    # ------------------------------------------------------------------ name resolution
    def resolve(self, parts: list[str], bracketed: bool):
        if len(parts) > 2:
            raise Unsupported("reference to a form or report control (" + "!".join(parts) + "); map it to a parameter")
        lo = [p.lower() for p in parts]
        if lo[0] in ("forms", "reports", "screen") and len(parts) > 1:
            raise Unsupported("reference to a form or report control (" + "!".join(parts) + "); map it to a parameter")
        for scope in reversed(self.scopes):
            if len(parts) == 2:
                for e in scope:
                    if e.alias == lo[0] and lo[1] in e.cols:
                        pg, _, ty = e.cols[lo[1]]
                        return f"{q(e.pg_alias)}.{q(pg)}", ty
            else:
                hits = [(e, e.cols[lo[0]]) for e in scope if lo[0] in e.cols]
                if len(hits) > 1:
                    raise Unsupported(f"ambiguous column {parts[0]!r}")
                if hits:
                    e, (pg, _, ty) = hits[0]
                    return f"{q(e.pg_alias)}.{q(pg)}", ty
        if len(parts) == 1 and lo[0] in self.splice:
            return self.splice[lo[0]]
        if len(parts) == 1 and (bracketed or lo[0] in self.declared):
            return self.param(parts[0]), self.declared_type(lo[0])
        raise Unsupported(f"unknown column or table {'.'.join(parts)!r}")

    def declared_type(self, name: str) -> str:
        t = self.declared.get(name, "")
        return {"text": "text", "short": "int", "long": "int", "integer": "int", "currency": "num", "double": "num",
                "single": "num", "datetime": "date", "bit": "bool"}.get(t, "unk")

    # ------------------------------------------------------------------ expressions
    def expr(self, e) -> tuple[str, str]:
        k = e[0]
        m = getattr(self, "e_" + k, None)
        if m is None:
            raise Unsupported(f"expression kind {k} is not translated")
        return m(e)

    def e_num(self, e):
        return e[1], "int" if re.fullmatch(r"\d+", e[1]) else "num"

    def e_str(self, e):
        return lit(e[1]), "text"

    def e_date(self, e):
        self.feat("date literal")
        return f"timestamp {lit(e[1])}", "date"

    def e_null(self, e):
        return "NULL", "unk"

    def e_bool(self, e):
        return ("TRUE" if e[1] else "FALSE"), "bool"

    def e_paren(self, e):
        s, t = self.expr(e[1])
        return f"({s})", t

    def e_neg(self, e):
        s, t = self.expr(e[1])
        return f"(-{s})", t

    def e_col(self, e):
        self.feat("bracketed name" if e[2] else "column")
        return self.resolve(e[1], e[2])

    def e_star(self, e):
        raise Unsupported("* is only allowed in the select list or Count(*)")

    def e_sub(self, e):
        self.feat("subquery")
        return "(" + self.select(e[1], nested=True) + ")", "unk"

    def e_exists(self, e):
        self.feat("exists")
        return "EXISTS (" + self.select(e[1], nested=True) + ")", "bool"

    def e_not(self, e):
        s, _ = self.expr(e[1])
        return f"(NOT {s})", "bool"

    def e_isnull(self, e):
        s, _ = self.expr(e[1])
        self.feat("Is Null")
        return f"({s} IS {'NOT ' if e[2] else ''}NULL)", "bool"

    def e_between(self, e):
        v, t = self.expr(e[1])
        lo, _ = self.expr(e[2])
        hi, _ = self.expr(e[3])
        if t == "text" and not self.ci:
            v, lo, hi = f"lower({v})", f"lower({lo})", f"lower({hi})"
            self.feat("case-insensitive text")
        return f"({v} {'NOT ' if e[4] else ''}BETWEEN {lo} AND {hi})", "bool"

    def e_in(self, e):
        v, t = self.expr(e[1])
        vals = [self.expr(x) for x in e[2]]
        if (t == "text" or any(tt == "text" for _, tt in vals)) and not self.ci:
            self.feat("case-insensitive text")
            return f"(lower({v}) {'NOT ' if e[3] else ''}IN ({', '.join(f'lower({s})' for s, _ in vals)}))", "bool"
        return f"({v} {'NOT ' if e[3] else ''}IN ({', '.join(s for s, _ in vals)}))", "bool"

    def e_in_sub(self, e):
        v, t = self.expr(e[1])
        sub = self.select(e[2], nested=True)
        self.feat("subquery")
        if t == "text" and not self.ci:
            self.warn("IN with a subquery compares text case-sensitively in PostgreSQL; Access ignores case")
        return f"({v} {'NOT ' if e[3] else ''}IN ({sub}))", "bool"

    def e_cmp(self, e):
        o = e[1]
        (l, lt), (r, rt) = self.expr(e[2]), self.expr(e[3])
        # Access stores True as -1 and False as 0, and lets code compare a Yes/No column with a number.
        if lt == "bool" and e[3][0] in ("num", "neg"):
            r = "FALSE" if r == "0" else "TRUE"
            rt = "bool"
        elif rt == "bool" and e[2][0] in ("num", "neg"):
            l = "FALSE" if l == "0" else "TRUE"
            lt = "bool"
        if (lt == "text" or rt == "text") and not self.ci:
            self.feat("case-insensitive text")
            return f"(lower({l}) {o} lower({r}))", "bool"
        return f"({l} {o} {r})", "bool"

    def e_like(self, e):
        self.feat("Like")
        v, _ = self.expr(e[1])
        pat = self.like_pattern(e[2])
        op = "LIKE" if self.ci else "ILIKE"  # citext LIKE already ignores case
        return f"({v} {'NOT ' if e[3] else ''}{op} {pat})", "bool"

    def like_pattern(self, p) -> str:
        def lit_pat(s: str) -> str:
            if "[" in s or "#" in s:
                raise Unsupported("Like pattern uses [] character classes or # digit matching")
            s = s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            return s.replace("*", "%").replace("?", "_")

        if p[0] == "str":
            return lit(lit_pat(p[1]))
        pieces = []
        stack = [p]
        flat = []
        while stack:  # flatten an & chain
            n = stack.pop(0)
            if n[0] == "bin" and n[1] == "&":
                stack = [n[2], n[3]] + stack
            else:
                flat.append(n)
        for n in flat:
            if n[0] == "str":
                pieces.append(lit(lit_pat(n[1])))
            else:
                s, _ = self.expr(n)
                pieces.append(f"replace(replace(({s})::text, '*', '%'), '?', '_')")
                self.warn("Like pattern comes from a value; a literal % or _ in that value acts as a wildcard")
        return " || ".join(pieces)

    def e_bin(self, e):
        o = e[1]
        if o in ("AND", "OR"):
            (l, _), (r, _) = self.expr(e[2]), self.expr(e[3])
            return f"({l} {o} {r})", "bool"
        if o == "&":
            return self.concat(e)
        (l, lt), (r, rt) = self.expr(e[2]), self.expr(e[3])
        if o == "+":
            if lt == "text" or rt == "text":
                return f"({l} || {r})", "text"
            if lt == "date" and rt in NUMERIC + ("unk",):
                self.feat("date arithmetic")
                return f"({l} + ({r}) * interval '1 day')", "date"
            if rt == "date" and lt in NUMERIC:
                return f"({r} + ({l}) * interval '1 day')", "date"
            return f"({l} + {r})", self.arith_type(lt, rt)
        if o == "-":
            if lt == "date" and rt == "date":
                self.feat("date arithmetic")
                return f"(extract(epoch from ({l} - {r})) / 86400.0)", "num"
            if lt == "date" and rt in NUMERIC + ("unk",):
                self.feat("date arithmetic")
                return f"({l} - ({r}) * interval '1 day')", "date"
            return f"({l} - {r})", self.arith_type(lt, rt)
        if o == "*":
            return f"({l} * {r})", self.arith_type(lt, rt)
        if o == "/":
            return f"(({l})::double precision / ({r}))", "num"
        if o == "\\":
            self.feat("integer division")
            return f"(({SCHEMA_FUNCS}.jet_round(({l})::numeric))::bigint / ({SCHEMA_FUNCS}.jet_round(({r})::numeric))::bigint)", "int"
        if o == "MOD":
            self.feat("Mod")
            return f"(({SCHEMA_FUNCS}.jet_round(({l})::numeric))::bigint % ({SCHEMA_FUNCS}.jet_round(({r})::numeric))::bigint)", "int"
        if o == "^":
            return f"power(({l})::double precision, ({r})::double precision)", "num"
        raise Unsupported(f"operator {o} is not translated")

    @staticmethod
    def arith_type(a: str, b: str) -> str:
        return "int" if a == b == "int" else "num"

    def concat(self, e):
        flat, stack = [], [e]
        while stack:
            n = stack.pop(0)
            if n[0] == "bin" and n[1] == "&":
                stack = [n[2], n[3]] + stack
            else:
                flat.append(n)
        parts = []
        for n in flat:
            s, t = self.expr(n)
            if t == "text":
                parts.append(s)
            elif t == "int":
                parts.append(f"({s})::text")
            elif t == "num":
                parts.append(f"trim_scale(({s})::numeric)::text")
            elif t == "unk":
                parts.append(f"({s})::text")
            else:
                raise Unsupported(f"& with a {'date' if t == 'date' else 'Yes/No'} value converts it to text by locale; wrap it in Format()")
        self.feat("& concatenation")
        return f"concat({', '.join(parts)})", "text"

    # ------------------------------------------------------------------ functions
    def e_func(self, e):
        name, args = e[1], e[2]
        lo = name.lower()
        self.feat("fn:" + name)
        if lo in ("dlookup", "dcount", "dsum", "davg", "dmin", "dmax"):
            return self.domain(lo, args)
        if lo in ("count", "sum", "avg", "min", "max", "stdev", "var", "first", "last", "stdevp", "varp"):
            return self.aggregate(lo, args)
        em = [self.expr(a) if a[0] != "star" else ("*", "star") for a in args]
        s = [x[0] for x in em]
        t = [x[1] for x in em]

        def need(n):
            if len(args) != n:
                raise Unsupported(f"{name} with {len(args)} arguments is not translated")

        if lo == "iif":
            need(3)
            return f"(CASE WHEN {s[0]} THEN {s[1]} ELSE {s[2]} END)", t[1] if t[1] != "unk" else t[2]
        if lo == "switch":
            if len(args) % 2:
                raise Unsupported("Switch needs pairs of arguments")
            whens = " ".join(f"WHEN {s[i]} THEN {s[i + 1]}" for i in range(0, len(args), 2))
            return f"(CASE {whens} END)", t[1]
        if lo == "choose":
            whens = " ".join(f"WHEN {i} THEN {s[i]}" for i in range(1, len(args)))
            return f"(CASE ({s[0]})::int {whens} END)", t[1] if len(t) > 1 else "unk"
        if lo == "nz":
            if len(args) == 2:
                return f"COALESCE({s[0]}, {s[1]})", t[0] if t[0] != "unk" else t[1]
            need(1)
            default = {"text": "''", "int": "0", "num": "0", "bool": "FALSE"}.get(t[0])
            if default is None:
                raise Unsupported("Nz without a default needs a column of known type; add a default value")
            return f"COALESCE({s[0]}, {default})", t[0]
        if lo == "isnull":
            need(1)
            return f"({s[0]} IS NULL)", "bool"
        simple = {"ucase": ("upper", "text"), "lcase": ("lower", "text"), "len": ("length", "int"),
                  "abs": ("abs", "num"), "sgn": ("sign", "int"), "sqr": ("sqrt", "num"), "exp": ("exp", "num"),
                  "log": ("ln", "num"), "chr": ("chr", "text"), "asc": ("ascii", "int")}
        if lo in simple:
            need(1)
            fn, ty = simple[lo]
            return f"{fn}({s[0]})", t[0] if lo in ("abs",) else ty
        if lo == "trim":
            need(1)
            return f"btrim({s[0]}, ' ')", "text"
        if lo == "ltrim":
            need(1)
            return f"ltrim({s[0]}, ' ')", "text"
        if lo == "rtrim":
            need(1)
            return f"rtrim({s[0]}, ' ')", "text"
        if lo in ("left", "right"):
            need(2)
            return f"{lo}({s[0]}, {s[1]})", "text"
        if lo == "mid":
            if len(args) == 2:
                return f"substr({s[0]}, {s[1]})", "text"
            need(3)
            return f"substr({s[0]}, {s[1]}, {s[2]})", "text"
        if lo == "replace":
            need(3)
            self.warn("InStr and Replace case rules in Access are unconfirmed; the translation is case-sensitive")
            return f"replace({s[0]}, {s[1]}, {s[2]})", "text"
        if lo == "instr":
            need(2)
            self.warn("InStr and Replace case rules in Access are unconfirmed; the translation is case-sensitive")
            return f"strpos({s[0]}, {s[1]})", "int"
        if lo == "space":
            need(1)
            return f"repeat(' ', {s[0]})", "text"
        if lo == "string":
            need(2)
            return f"repeat(left({s[1]}, 1), {s[0]})", "text"
        if lo == "round":
            if len(args) == 1:
                return f"{SCHEMA_FUNCS}.jet_round(({s[0]})::numeric)", "num"
            need(2)
            return f"{SCHEMA_FUNCS}.jet_round(({s[0]})::numeric, ({s[1]})::int)", "num"
        if lo == "int":
            need(1)
            return f"floor({s[0]})", "num"
        if lo == "fix":
            need(1)
            return f"trunc({s[0]})", "num"
        if lo in ("cint", "clng"):
            need(1)
            return f"({SCHEMA_FUNCS}.jet_round(({s[0]})::numeric))::integer", "int"
        if lo in ("cdbl", "csng", "ccur", "cdec"):
            need(1)
            return f"({s[0]})::{'numeric(19,4)' if lo == 'ccur' else 'double precision'}", "num"
        if lo == "cstr":
            need(1)
            if t[0] in ("date", "bool"):
                raise Unsupported("CStr of a date or Yes/No value depends on locale; use Format()")
            return (f"trim_scale(({s[0]})::numeric)::text" if t[0] == "num" else f"({s[0]})::text"), "text"
        if lo == "cdate":
            need(1)
            return f"({s[0]})::timestamp", "date"
        if lo == "date":
            return "current_date", "date"
        if lo == "now":
            return "localtimestamp(0)", "date"
        if lo in ("year", "month", "day", "hour", "minute", "second"):
            need(1)
            return f"(extract({lo} from {s[0]}))::int", "int"
        if lo == "weekday":
            need(1)
            self.warn("Weekday assumes Sunday is the first day of the week")
            return f"(extract(dow from {s[0]})::int + 1)", "int"
        if lo == "dateserial":
            need(3)
            self.warn("DateSerial accepts out-of-range months and days in Access; make_date raises an error")
            return f"make_date(({s[0]})::int, ({s[1]})::int, ({s[2]})::int)", "date"
        if lo == "dateadd":
            need(3)
            return self.dateadd(args, s)
        if lo == "datediff":
            if len(args) != 3:
                raise Unsupported("DateDiff with first-day arguments is not translated")
            return self.datediff(args, s)
        if lo == "datepart":
            need(2)
            unit = self.interval_unit(args[0])
            fields = {"yyyy": "year", "m": "month", "d": "day", "q": "quarter", "h": "hour", "n": "minute", "s": "second"}
            if unit not in fields:
                raise Unsupported(f"DatePart interval {unit!r} is not translated")
            return f"(extract({fields[unit]} from {s[1]}))::int", "int"
        if lo == "format":
            need(2)
            return self.format(args, s, t)
        raise Unsupported(f"function {name}() is not translated")

    def interval_unit(self, a) -> str:
        if a[0] != "str":
            raise Unsupported("a date function needs a literal interval such as \"d\"")
        return a[1].lower()

    def dateadd(self, args, s):
        unit = self.interval_unit(args[0])
        mk = {"d": "days", "m": "months", "yyyy": "years", "ww": "weeks", "h": "hours", "n": "mins", "s": "secs"}
        if unit == "q":
            return f"(({s[2]}) + make_interval(months => (({s[1]})::int * 3)))", "date"
        if unit not in mk:
            raise Unsupported(f"DateAdd interval {unit!r} is not translated")
        self.feat("date arithmetic")
        return f"(({s[2]}) + make_interval({mk[unit]} => ({s[1]})::int))", "date"

    def datediff(self, args, s):
        unit = self.interval_unit(args[0])
        a, b = s[1], s[2]
        if unit == "d":
            return f"(({b})::date - ({a})::date)", "int"
        if unit == "yyyy":
            return f"(extract(year from {b})::int - extract(year from {a})::int)", "int"
        if unit == "m":
            return f"((extract(year from {b})::int - extract(year from {a})::int) * 12 + extract(month from {b})::int - extract(month from {a})::int)", "int"
        if unit == "q":
            return (f"((extract(year from {b})::int - extract(year from {a})::int) * 4 "
                    f"+ extract(quarter from {b})::int - extract(quarter from {a})::int)"), "int"
        raise Unsupported(f"DateDiff interval {unit!r} is not translated")

    def format(self, args, s, t):
        if args[1][0] != "str":
            raise Unsupported("Format with a computed format string is not translated")
        f = args[1][1]
        if t[0] == "date":
            out, i = [], 0
            low = f.lower()
            while i < len(f):
                for src, dst in _DATE_FMT:
                    if low.startswith(src, i):
                        out.append(dst)
                        i += len(src)
                        break
                else:
                    ch = f[i]
                    out.append(f'"{ch}"' if ch.isalpha() else ch)
                    i += 1
            return f"to_char({s[0]}, {lit(''.join(out))})", "text"
        key = f.lower()
        if key in _NUM_FMT and _NUM_FMT[key]:
            return f"to_char({s[0]}, {lit(_NUM_FMT[key])})", "text"
        raise Unsupported(f"Format string {f!r} is not translated")

    def aggregate(self, lo: str, args):
        self.feat("aggregate")
        if lo in ("first", "last"):
            raise Unsupported(f"{lo.title()}() depends on physical record order, which PostgreSQL does not keep")
        if len(args) != 1:
            raise Unsupported(f"{lo}() needs one argument")
        if args[0][0] == "star":
            return "count(*)", "int"
        s, t = self.expr(args[0])
        fn = {"stdev": "stddev_samp", "stdevp": "stddev_pop", "var": "var_samp", "varp": "var_pop"}.get(lo, lo)
        if lo in ("min", "max") and t == "text" and not self.ci:
            self.warn(f"{lo.title()} of text compares case-sensitively in PostgreSQL; Access ignores case")
        return f"{fn}({s})", "int" if lo == "count" else ("num" if lo in ("sum", "avg", "stdev", "var", "stdevp", "varp") else t)

    # ------------------------------------------------------------------ domain aggregates
    def domain(self, lo: str, args):
        self.feat("domain aggregate")
        if len(args) < 2 or args[1][0] != "str":
            raise Unsupported("domain aggregate needs a literal table name")
        tname = args[1][1].strip().strip("[]")
        tbl = self.cat.table(tname)
        if not tbl:
            raise Unsupported(f"domain aggregate refers to unknown table {tname!r}")
        crit = None
        if len(args) > 2:
            crit = self.splice_text(args[2])
        expr_text = self.splice_text(args[0])
        entry = self.entry_for(tbl, None)
        self.n_domain = getattr(self, "n_domain", 0) + 1
        entry.pg_alias = f"dom{self.n_domain}"  # unique, so a value from the outer row is never captured by the inner table
        self.scopes.append([entry])
        try:
            if expr_text.strip() == "*":
                val, vt = "*", "unk"
            else:
                val, vt = self.sub_expr(expr_text)
            where = ""
            if crit and crit.strip():
                w, _ = self.sub_expr(crit)
                where = f" WHERE {w}"
        finally:
            self.scopes.pop()
        frm = f"{q(self.cat.schema)}.{q(tbl.pg_name)} AS {q(entry.pg_alias)}"
        if lo == "dlookup":
            return f"(SELECT {val} FROM {frm}{where} LIMIT 1)", vt
        fn = {"dcount": "count", "dsum": "sum", "davg": "avg", "dmin": "min", "dmax": "max"}[lo]
        return f"(SELECT {fn}({val}) FROM {frm}{where})", ("int" if lo == "dcount" else "num" if lo != "dlookup" else vt)

    def splice_text(self, node) -> str:
        """Turn a string argument, possibly built with &, into text. Embedded values become placeholders."""
        flat, stack = [], [node]
        while stack:
            n = stack.pop(0)
            if n[0] == "bin" and n[1] == "&":
                stack = [n[2], n[3]] + stack
            else:
                flat.append(n)
        text = ""
        for i, n in enumerate(flat):
            if n[0] == "str":
                text += n[1]
                continue
            s, t = self.expr(n)
            key = f"__e{len(self.splice)}__"
            self.splice[key] = (s, t)
            nxt = flat[i + 1][1] if i + 1 < len(flat) and flat[i + 1][0] == "str" else ""
            if text.endswith("'") and nxt.startswith("'") and text.count("'") % 2 == 1:
                text, flat[i + 1] = text[:-1], ("str", nxt[1:])  # drop the quotes around a text value
            elif text.endswith("#") and nxt.startswith("#"):
                text, flat[i + 1] = text[:-1], ("str", nxt[1:])  # drop the # around a date value
            elif text.count("'") % 2 == 1:
                raise Unsupported("domain aggregate builds its criteria inside quotes in a way that cannot be translated")
            text += " " + key + " "
        return text

    def sub_expr(self, text: str):
        p = Parser(text)
        e = p.expr()
        if p.cur.kind != "eof":
            raise Unsupported(f"parse error in domain aggregate argument near {p.cur.value!r}")
        return self.expr(e)

    # ------------------------------------------------------------------ SELECT
    def entry_for(self, tbl: TableInfo, alias: str | None) -> Entry:
        a = (alias or tbl.access_name)
        cols = {c.access_name.lower(): (c.pg_name, c.access_name, c.type) for c in tbl.columns}
        return Entry(a.lower(), alias or tbl.pg_name, cols)

    def source(self, src, entries: list[Entry]) -> str:
        k = src[0]
        if k == "table":
            tbl = self.cat.table(src[1])
            if not tbl:
                raise Unsupported(f"unknown table or saved query {src[1]!r}")
            ent = self.entry_for(tbl, src[2])
            if any(e.alias == ent.alias for e in entries):
                ent = Entry(ent.alias + "_" + str(len(entries)), ent.pg_alias + "_" + str(len(entries)), ent.cols)
            entries.append(ent)
            self.feat("table")
            return f"{q(self.cat.schema)}.{q(tbl.pg_name)} AS {q(ent.pg_alias)}"
        if k == "sub":
            self.feat("subquery in FROM")
            sql, cols = self.select(src[1], nested=True, want_cols=True)
            ent = Entry(src[2].lower(), src[2], {n.lower(): (n, n, t) for n, t in cols})
            entries.append(ent)
            return f"({sql}) AS {q(src[2])}"
        if k == "join":
            left = self.source(src[2], entries)
            right = self.source(src[3], entries)
            if src[1] == "CROSS":
                return f"{left}, {right}"
            self.feat("join:" + src[1].lower())
            self.scopes.append(entries)  # the ON clause sees every table
            try:
                on, _ = self.expr(src[4])
            finally:
                self.scopes.pop()
            return f"({left} {src[1]} JOIN {right} ON {on})"
        raise Unsupported(f"source {k} is not translated")

    def select(self, s: Select, nested=False, want_cols=False):
        if s.transform is not None or s.pivot is not None:
            if nested:
                raise Unsupported("a crosstab query inside another query is not translated")
            return self.crosstab(s)
        entries: list[Entry] = []
        from_sql = self.source(s.source, entries) if s.source else None
        self.scopes.append(entries)
        try:
            items, cols = [], []
            n_expr = 1000
            for e, alias in s.items:
                if e[0] == "star":
                    for ent in ([x for x in entries if x.alias == (e[1] or "").lower()] if e[1] else entries):
                        for pg, an, ty in ent.cols.values():
                            items.append(f"{q(ent.pg_alias)}.{q(pg)} AS {q(an)}")
                            cols.append((an, ty))
                    continue
                sql, ty = self.expr(e)
                if alias:
                    name = alias
                elif e[0] == "col":
                    name = e[1][-1]
                    hit = self.lookup_name(e[1])
                    name = hit or name
                else:
                    name = f"Expr{n_expr}"
                    n_expr += 1
                items.append(f"{sql} AS {q(name)}")
                cols.append((name, ty))
            out = "SELECT "
            if s.distinct:
                out += "DISTINCT "
                self.feat("DISTINCT")
                if s.distinctrow:
                    self.warn("DISTINCTROW treated as DISTINCT")
                if any(t == "text" for _, t in cols) and not self.ci:
                    self.warn("DISTINCT on text compares case-sensitively in PostgreSQL; Access ignores case")
            out += ", ".join(items)
            if from_sql:
                out += " FROM " + from_sql
            if s.where:
                w, _ = self.expr(s.where)
                out += " WHERE " + w
            if s.group:
                self.feat("GROUP BY")
                gs = []
                for g in s.group:
                    sql, ty = self.expr(g)
                    if ty == "text" and not self.ci:
                        self.warn("GROUP BY on text groups case-sensitively in PostgreSQL; Access groups ignoring case")
                    gs.append(sql)
                out += " GROUP BY " + ", ".join(gs)
            if s.having:
                h, _ = self.expr(s.having)
                out += " HAVING " + h
            if s.union:
                self.feat("UNION")
                if not s.union[0] and not self.ci and any(ty == "text" for _, ty in cols):
                    self.warn("UNION removes duplicates case-sensitively in PostgreSQL; Access ignores case")
                out += (" UNION ALL " if s.union[0] else " UNION ") + self.select(s.union[1], nested=True)
            if s.order:
                self.feat("ORDER BY")
                out += " ORDER BY " + ", ".join(self.order_item(o, cols) + (" DESC" if d == "DESC" else "") for o, d in s.order)
            if s.top:
                self.feat("TOP")
                if s.top[1]:
                    raise Unsupported("TOP n PERCENT is not translated")
                if s.order:
                    out += f" FETCH FIRST {s.top[0]} ROWS WITH TIES"  # Access TOP includes ties
                else:
                    out += f" LIMIT {s.top[0]}"
                    self.warn("TOP without ORDER BY returns an arbitrary set of rows in both systems")
            if s.distinct and s.distinctrow is False:
                pass
        finally:
            self.scopes.pop()
        return (out, cols) if want_cols else out

    def lookup_name(self, parts: list[str]) -> str | None:
        lo = [p.lower() for p in parts]
        for scope in reversed(self.scopes):
            for e in scope:
                if len(parts) == 2 and e.alias != lo[0]:
                    continue
                if lo[-1] in e.cols:
                    return e.cols[lo[-1]][1]
        return None

    def order_item(self, e, cols) -> str:
        if e[0] == "num":
            return e[1]
        if e[0] == "col" and len(e[1]) == 1:
            for name, _ in cols:
                if name.lower() == e[1][0].lower():
                    return q(name)
        return self.expr(e)[0]

    # ------------------------------------------------------------------ crosstab
    def crosstab(self, s: Select) -> str:
        self.feat("crosstab")
        if s.transform is None or s.pivot is None:
            raise Unsupported("crosstab needs both TRANSFORM and PIVOT")
        if s.union or s.top or s.distinct:
            raise Unsupported("crosstab with UNION, TOP, or DISTINCT is not translated")
        entries: list[Entry] = []
        from_sql = self.source(s.source, entries)
        self.scopes.append(entries)
        try:
            row_items, n_expr = [], 1000
            for e, alias in s.items:
                sql, ty = self.expr(e)
                name = alias or (self.lookup_name(e[1]) if e[0] == "col" else None) or f"Expr{n_expr}"
                if not alias and e[0] != "col":
                    n_expr += 1
                row_items.append(f"{sql} AS {q(name)}")
            piv, pty = self.expr(s.pivot)
            agg_node = s.transform[0]
            if agg_node[0] != "func":
                raise Unsupported("TRANSFORM needs an aggregate function")
            where = ""
            if s.where:
                w, _ = self.expr(s.where)
                where = " WHERE " + w
            values = None
            if s.pivot_in is not None:
                values = [self.pivot_value(v) for v in s.pivot_in]
            elif self.pivot_provider:
                values = self.pivot_provider(f"SELECT DISTINCT {piv} FROM {from_sql}{where} ORDER BY 1")
                self.warn("pivot columns were taken from the data when the query was translated")
            if values is None:
                raise Unsupported("crosstab without an IN list needs its pivot values read from the data first")
            cols = []
            for v in values:
                if v is None:
                    cond, label = f"{piv} IS NULL", "<>"
                else:
                    vl = lit(str(v)) if isinstance(v, str) else str(v)
                    cond = f"lower({piv}) = lower({vl})" if pty == "text" and not self.ci else f"{piv} = {vl}"
                    label = str(v)
                agg_sql, _ = self.expr(agg_node)
                cols.append(f"CASE WHEN count(*) FILTER (WHERE {cond}) = 0 THEN NULL ELSE {self.with_filter(agg_sql, cond)} END AS {q(label)}")
            out = "SELECT " + ", ".join(row_items + cols) + " FROM " + from_sql + where
            if s.group:
                out += " GROUP BY " + ", ".join(self.expr(g)[0] for g in s.group)
            if s.order:
                out += " ORDER BY " + ", ".join(self.order_item(o, [(re.sub(r'.* AS "(.*)"$', r"\1", i), "unk") for i in row_items]) + (" DESC" if d == "DESC" else "") for o, d in s.order)
        finally:
            self.scopes.pop()
        return out

    @staticmethod
    def with_filter(agg_sql: str, cond: str) -> str:
        return f"{agg_sql} FILTER (WHERE {cond})"

    def pivot_value(self, v):
        if v[0] == "str":
            return v[1]
        if v[0] == "num":
            return int(v[1]) if re.fullmatch(r"\d+", v[1]) else float(v[1])
        raise Unsupported("PIVOT IN list must hold literals")

    # ------------------------------------------------------------------ action queries
    def action(self, node) -> tuple[str, str]:
        kind = node[0]
        if kind == "insert_values":
            tbl = self.need_table(node[1])
            cols = [self.col_name(tbl, c) for c in node[2]] if node[2] else [c.pg_name for c in tbl.columns]
            self.scopes.append([])
            try:
                vals = [self.expr(v)[0] for v in node[3]]
            finally:
                self.scopes.pop()
            return f"INSERT INTO {q(self.cat.schema)}.{q(tbl.pg_name)} ({', '.join(q(c) for c in cols)}) VALUES ({', '.join(vals)})", "insert"
        if kind == "insert_select":
            tbl = self.need_table(node[1])
            cols = [self.col_name(tbl, c) for c in node[2]]
            sel = self.select(node[3], nested=True)
            cl = f" ({', '.join(q(c) for c in cols)})" if cols else ""
            return f"INSERT INTO {q(self.cat.schema)}.{q(tbl.pg_name)}{cl} {sel}", "insert"
        if kind == "delete":
            src, where = node[1], node[2]
            if src[0] != "table":
                raise Unsupported("DELETE with a join is not translated")
            entries: list[Entry] = []
            frm = self.source(src, entries)
            self.scopes.append(entries)
            try:
                w = " WHERE " + self.expr(where)[0] if where else ""
            finally:
                self.scopes.pop()
            return f"DELETE FROM {frm}{w}", "delete"
        if kind == "update":
            return self.update(node), "update"
        raise Unsupported(f"{kind} is not translated")

    def need_table(self, name: str) -> TableInfo:
        t = self.cat.table(name)
        if not t:
            raise Unsupported(f"unknown table {name!r}")
        return t

    @staticmethod
    def col_name(tbl: TableInfo, access: str) -> str:
        for c in tbl.columns:
            if c.access_name.lower() == access.lower():
                return c.pg_name
        raise Unsupported(f"unknown column {access!r} in {tbl.access_name}")

    def update(self, node) -> str:
        src, sets, where = node[1], node[2], node[3]
        entries: list[Entry] = []
        if src[0] == "table":
            frm, extra_where = self.source(src, entries), []
            target = entries[0]
            tbl = self.need_table(src[1])
            extra_from = ""
            join_on = None
        elif src[0] == "join" and src[1] == "INNER" and src[2][0] == "table" and src[3][0] == "table":
            first = self.source(src[2], entries)
            second = self.source(src[3], entries)
            target, tbl = entries[0], self.need_table(src[2][1])
            frm, extra_from, join_on = first, second, src[4]
        else:
            raise Unsupported("UPDATE with this join shape is not translated")
        self.scopes.append(entries)
        try:
            assigns = []
            for tgt, e in sets:
                col = self.col_name(tbl, tgt[-1])
                assigns.append(f"{q(col)} = {self.expr(e)[0]}")
            conds = []
            if join_on:
                conds.append(self.expr(join_on)[0])
            if where:
                conds.append(self.expr(where)[0])
        finally:
            self.scopes.pop()
        out = f"UPDATE {frm} SET {', '.join(assigns)}"
        if extra_from:
            out += f" FROM {extra_from}"
        if conds:
            out += " WHERE " + " AND ".join(conds)
        return out


def translate(sql: str, catalog: Catalog, pivot_provider=None) -> Result:
    try:
        node, declared = parse(sql)
        em = Emitter(catalog, declared, pivot_provider)
        if node[0] == "select":
            s = node[1]
            kind = "crosstab" if s.transform else "select"
            out = em.select(s)
        else:
            out, kind = em.action(node)
    except Unsupported as e:
        msg = str(e)
        return Result("failed", reason=msg, kind="unknown")
    except RecursionError:
        return Result("failed", reason="query is too deeply nested")
    feats = sorted(em.features)
    status = "partly_translated" if em.warnings else "translated"
    return Result(status, sql=out, params=em.params, features=feats, warnings=em.warnings, kind=kind)
