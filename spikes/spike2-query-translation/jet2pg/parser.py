"""Recursive-descent parser for the Jet SQL subset. Produces tuple-based nodes."""
from dataclasses import dataclass, field

from .lexer import Tok, Unsupported, tokenize

RESERVED = {"SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "UNION", "INNER", "LEFT", "RIGHT", "JOIN", "ON",
            "AS", "AND", "OR", "NOT", "IN", "LIKE", "BETWEEN", "IS", "NULL", "PIVOT", "TRANSFORM", "SET", "VALUES",
            "OUTER", "FULL", "CROSS", "ASC", "DESC", "BY", "ALL", "DISTINCT", "TOP", "MOD", "INTO", "WITH", "OWNERACCESS"}


@dataclass
class Select:
    items: list = field(default_factory=list)      # (expr, alias|None)
    distinct: bool = False
    distinctrow: bool = False
    top: tuple | None = None                      # (n, percent)
    source: tuple | None = None
    where: tuple | None = None
    group: list = field(default_factory=list)
    having: tuple | None = None
    order: list = field(default_factory=list)      # (expr, 'ASC'|'DESC')
    union: tuple | None = None                    # (all, Select)
    transform: tuple | None = None                # (agg expr, alias)
    pivot: tuple | None = None
    pivot_in: list | None = None


class Parser:
    def __init__(self, sql: str) -> None:
        self.t = tokenize(sql)
        self.i = 0
        self.declared: dict[str, str] = {}

    # ---- helpers ----
    @property
    def cur(self) -> Tok:
        return self.t[self.i]

    def kw(self, *words: str) -> bool:
        c = self.cur
        return c.kind == "ident" and c.value.upper() in words

    def eat_kw(self, *words: str) -> str | None:
        if self.kw(*words):
            v = self.cur.value.upper()
            self.i += 1
            return v
        return None

    def need_kw(self, *words: str) -> str:
        v = self.eat_kw(*words)
        if v is None:
            raise Unsupported(f"parse error: expected {'/'.join(words)} near {self.cur.value!r}")
        return v

    def op(self, *ops: str) -> bool:
        return self.cur.kind == "op" and self.cur.value in ops

    def eat_op(self, *ops: str) -> str | None:
        if self.op(*ops):
            v = self.cur.value
            self.i += 1
            return v
        return None

    def need_op(self, o: str) -> None:
        if not self.eat_op(o):
            raise Unsupported(f"parse error: expected {o!r} near {self.cur.value!r}")

    # ---- statements ----
    def statement(self):
        if self.eat_kw("PARAMETERS"):
            while True:
                name = self.cur.value
                self.i += 1
                typ = self.cur.value
                self.i += 1
                self.declared[name.lower()] = typ.lower()
                if not self.eat_op(","):
                    break
            self.need_op(";")
        if self.kw("SELECT", "TRANSFORM"):
            node = ("select", self.select_union())
        elif self.kw("INSERT"):
            node = self.insert()
        elif self.kw("UPDATE"):
            node = self.update()
        elif self.kw("DELETE"):
            node = self.delete()
        else:
            raise Unsupported(f"unsupported statement starting with {self.cur.value!r}")
        self.eat_op(";")
        if self.cur.kind != "eof":
            raise Unsupported(f"parse error: unexpected {self.cur.value!r}")
        return node

    def select_union(self) -> Select:
        s = self.select()
        cur = s
        while self.kw("UNION"):
            self.i += 1
            all_ = bool(self.eat_kw("ALL"))
            nxt = self.select()
            cur.union = (all_, nxt)
            cur = nxt
        return s

    def select(self) -> Select:
        s = Select()
        if self.eat_kw("TRANSFORM"):
            agg = self.expr()
            alias = self.alias()
            s.transform = (agg, alias)
        self.need_kw("SELECT")
        if self.eat_kw("DISTINCT"):
            s.distinct = True
        elif self.eat_kw("DISTINCTROW"):
            s.distinct = True
            s.distinctrow = True
        if self.eat_kw("TOP"):
            n = self.cur
            if n.kind != "num":
                raise Unsupported("TOP needs a number")
            self.i += 1
            s.top = (n.value, bool(self.eat_kw("PERCENT")))
        while True:
            if self.op("*"):
                self.i += 1
                s.items.append((("star", None), None))
            else:
                e = self.expr()
                s.items.append((e, self.alias()))
            if not self.eat_op(","):
                break
        if self.eat_kw("INTO"):
            raise Unsupported("make-table queries (SELECT INTO) are not translated")
        if self.eat_kw("FROM"):
            s.source = self.source_list()
        if self.eat_kw("WHERE"):
            s.where = self.expr()
        if self.eat_kw("GROUP"):
            self.need_kw("BY")
            s.group = [self.expr()]
            while self.eat_op(","):
                s.group.append(self.expr())
        if self.eat_kw("HAVING"):
            s.having = self.expr()
        if self.eat_kw("PIVOT"):
            s.pivot = self.concat()
            if self.eat_kw("IN"):
                self.need_op("(")
                s.pivot_in = [self.expr()]
                while self.eat_op(","):
                    s.pivot_in.append(self.expr())
                self.need_op(")")
        if self.eat_kw("ORDER"):
            self.need_kw("BY")
            while True:
                e = self.expr()
                d = self.eat_kw("ASC", "DESC") or "ASC"
                s.order.append((e, d))
                if not self.eat_op(","):
                    break
        if self.eat_kw("WITH"):
            self.need_kw("OWNERACCESS")
            self.need_kw("OPTION")
        return s

    def alias(self) -> str | None:
        if self.eat_kw("AS"):
            return self.name_token()
        return None

    def name_token(self) -> str:
        c = self.cur
        if c.kind in ("ident", "bracket"):
            self.i += 1
            return c.value
        raise Unsupported(f"parse error: expected a name near {c.value!r}")

    # ---- FROM ----
    def source_list(self):
        src = self.join_expr()
        while self.eat_op(","):
            src = ("join", "CROSS", src, self.join_expr(), None)
        return src

    def join_expr(self):
        left = self.primary_source()
        while True:
            kind = None
            if self.kw("INNER"):
                self.i += 1
                self.need_kw("JOIN")
                kind = "INNER"
            elif self.kw("LEFT", "RIGHT"):
                kind = self.cur.value.upper()
                self.i += 1
                self.eat_kw("OUTER")
                self.need_kw("JOIN")
            elif self.kw("JOIN"):
                self.i += 1
                kind = "INNER"
            elif self.kw("FULL", "CROSS"):
                raise Unsupported(f"{self.cur.value.upper()} JOIN does not exist in Jet SQL")
            if kind is None:
                return left
            right = self.primary_source()
            self.need_kw("ON")
            left = ("join", kind, left, right, self.expr())

    def primary_source(self):
        if self.eat_op("("):
            if self.kw("SELECT", "TRANSFORM"):
                sub = self.select_union()
                self.need_op(")")
                alias = self.alias() or (self.name_token() if self.cur.kind == "ident" and self.cur.value.upper() not in RESERVED else None)
                if not alias:
                    raise Unsupported("subquery in FROM needs an alias")
                return ("sub", sub, alias)
            inner = self.source_list()
            self.need_op(")")
            return inner
        name = self.name_token()
        if self.op(".") and self.t[self.i + 1].kind in ("ident", "bracket"):
            raise Unsupported("tables from other databases or schemas are not translated")
        alias = None
        if self.eat_kw("AS"):
            alias = self.name_token()
        elif self.cur.kind == "ident" and self.cur.value.upper() not in RESERVED:
            alias = self.name_token()
        return ("table", name, alias)

    # ---- action queries ----
    def insert(self):
        self.need_kw("INSERT")
        self.need_kw("INTO")
        table = self.name_token()
        cols = []
        if self.eat_op("("):
            cols.append(self.name_token())
            while self.eat_op(","):
                cols.append(self.name_token())
            self.need_op(")")
        if self.eat_kw("VALUES"):
            self.need_op("(")
            vals = [self.expr()]
            while self.eat_op(","):
                vals.append(self.expr())
            self.need_op(")")
            return ("insert_values", table, cols, vals)
        if self.kw("SELECT"):
            return ("insert_select", table, cols, self.select_union())
        raise Unsupported("INSERT needs VALUES or SELECT")

    def update(self):
        self.need_kw("UPDATE")
        src = self.source_list()
        self.need_kw("SET")
        sets = []
        while True:
            target = self.column_parts()
            self.need_op("=")
            sets.append((target, self.expr()))
            if not self.eat_op(","):
                break
        where = self.expr() if self.eat_kw("WHERE") else None
        return ("update", src, sets, where)

    def delete(self):
        self.need_kw("DELETE")
        self.eat_op("*")
        self.need_kw("FROM")
        src = self.source_list()
        where = self.expr() if self.eat_kw("WHERE") else None
        return ("delete", src, where)

    def column_parts(self) -> list[str]:
        parts = [self.name_token()]
        while self.op(".", "!"):
            self.i += 1
            parts.append(self.name_token())
        return parts

    # ---- expressions ----
    def expr(self):
        return self.or_expr()

    def or_expr(self):
        l = self.and_expr()
        while self.eat_kw("OR"):
            l = ("bin", "OR", l, self.and_expr())
        return l

    def and_expr(self):
        l = self.not_expr()
        while self.eat_kw("AND"):
            l = ("bin", "AND", l, self.not_expr())
        return l

    def not_expr(self):
        if self.eat_kw("NOT"):
            return ("not", self.not_expr())
        return self.predicate()

    def predicate(self):
        l = self.concat()
        while True:
            neg = False
            save = self.i
            if self.kw("NOT") and self.t[self.i + 1].kind == "ident" and self.t[self.i + 1].value.upper() in ("IN", "LIKE", "BETWEEN"):
                self.i += 1
                neg = True
            if self.op("=", "<>", "<", ">", "<=", ">="):
                o = self.cur.value
                self.i += 1
                l = ("cmp", o, l, self.concat())
            elif self.eat_kw("IS"):
                n = bool(self.eat_kw("NOT"))
                self.need_kw("NULL")
                l = ("isnull", l, n)
            elif self.eat_kw("LIKE"):
                l = ("like", l, self.concat(), neg)
            elif self.eat_kw("BETWEEN"):
                lo = self.concat()
                self.need_kw("AND")
                l = ("between", l, lo, self.concat(), neg)
            elif self.eat_kw("IN"):
                self.need_op("(")
                if self.kw("SELECT"):
                    sub = self.select_union()
                    self.need_op(")")
                    l = ("in_sub", l, sub, neg)
                else:
                    vals = [self.expr()]
                    while self.eat_op(","):
                        vals.append(self.expr())
                    self.need_op(")")
                    l = ("in", l, vals, neg)
            else:
                self.i = save
                return l

    def concat(self):
        l = self.additive()
        while self.eat_op("&"):
            l = ("bin", "&", l, self.additive())
        return l

    def additive(self):
        l = self.mod()
        while self.op("+", "-"):
            o = self.cur.value
            self.i += 1
            l = ("bin", o, l, self.mod())
        return l

    def mod(self):
        l = self.intdiv()
        while self.eat_kw("MOD"):
            l = ("bin", "MOD", l, self.intdiv())
        return l

    def intdiv(self):
        l = self.mul()
        while self.eat_op("\\"):
            l = ("bin", "\\", l, self.mul())
        return l

    def mul(self):
        l = self.unary()
        while self.op("*", "/"):
            o = self.cur.value
            self.i += 1
            l = ("bin", o, l, self.unary())
        return l

    def unary(self):
        if self.op("-", "+"):
            o = self.cur.value
            self.i += 1
            e = self.unary()
            return ("neg", e) if o == "-" else e
        return self.power()

    def power(self):
        l = self.primary()
        if self.eat_op("^"):
            return ("bin", "^", l, self.unary())
        return l

    def primary(self):
        c = self.cur
        if c.kind == "num":
            self.i += 1
            return ("num", c.value)
        if c.kind == "str":
            self.i += 1
            return ("str", c.value)
        if c.kind == "date":
            self.i += 1
            return ("date", c.value)
        if self.eat_op("("):
            if self.kw("SELECT"):
                sub = self.select_union()
                self.need_op(")")
                return ("sub", sub)
            e = self.expr()
            self.need_op(")")
            return ("paren", e)
        if c.kind in ("ident", "bracket"):
            up = c.value.upper() if c.kind == "ident" else None
            if up == "NULL":
                self.i += 1
                return ("null",)
            if up in ("TRUE", "YES", "ON"):
                self.i += 1
                return ("bool", True)
            if up in ("FALSE", "NO", "OFF"):
                self.i += 1
                return ("bool", False)
            if up == "EXISTS" and self.t[self.i + 1].value == "(":
                self.i += 2
                sub = self.select_union()
                self.need_op(")")
                return ("exists", sub)
            is_call = c.kind == "ident" and self.t[self.i + 1].kind == "op" and self.t[self.i + 1].value == "("
            if up in RESERVED and up not in ("MOD",) and not is_call:
                raise Unsupported(f"parse error: unexpected keyword {c.value}")
            self.i += 1
            if c.kind == "ident" and self.op("("):
                self.i += 1
                args = []
                if not self.op(")"):
                    if self.op("*"):
                        self.i += 1
                        args.append(("star", None))
                    else:
                        args.append(self.expr())
                    while self.eat_op(","):
                        args.append(self.expr())
                self.need_op(")")
                return ("func", c.value, args)
            parts = [(c.value, c.kind)]
            while self.op(".", "!") and self.t[self.i + 1].kind in ("ident", "bracket", "op"):
                if self.t[self.i + 1].kind == "op":
                    if self.t[self.i + 1].value == "*" and self.cur.value == ".":
                        self.i += 2
                        return ("star", parts[0][0])
                    break
                self.i += 1
                parts.append((self.cur.value, self.cur.kind))
                self.i += 1
            return ("col", [p[0] for p in parts], any(p[1] == "bracket" for p in parts))
        raise Unsupported(f"parse error near {c.value!r}")


def parse(sql: str):
    p = Parser(sql)
    node = p.statement()
    return node, p.declared
