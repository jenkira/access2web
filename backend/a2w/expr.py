"""The expression language for visibility rules, validation rules, and defaults.

The specification is docs/EXPRESSIONS.md. The TypeScript evaluator in the form editor must give the same results,
and spec/expression/vectors.json holds the cases that both must pass.

Values are None, bool, float, and str. Every number is a float, as in the TypeScript evaluator, so both give the
same results for large numbers and for division. The module never calls eval and never reads anything but its arguments.
"""
import math
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

MAX_LENGTH = 500   # in code points
MAX_DEPTH = 64

Value = None | bool | float | str

_OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "+", "-", "*", "/", "(", ")", ","]
# Name and number of arguments. A negative count means "at least".
_FUNCS = {"isnull": 1, "len": 1, "coalesce": -1, "today": 0, "lower": 1, "upper": 1}
_PREC = {"||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6}
_NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_SPACE = " \t\r\n"


class ExprError(ValueError):
    """The expression is not valid. Nothing has run."""

    def __init__(self, message: str, pos: int = 0) -> None:
        super().__init__(message)
        self.pos = pos


class Tok:
    __slots__ = ("kind", "text", "start", "end")

    def __init__(self, kind: str, text: str, start: int, end: int) -> None:
        self.kind, self.text, self.start, self.end = kind, text, start, end


def tokenize(src: str) -> list[Tok]:
    if len(src) > MAX_LENGTH:
        raise ExprError(f"expression is longer than {MAX_LENGTH} characters")
    out: list[Tok] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in _SPACE:
            i += 1
            continue
        if "0" <= c <= "9" or (c == "." and i + 1 < n and "0" <= src[i + 1] <= "9"):
            m = _NUMBER.match(src, i)
            assert m is not None
            if not math.isfinite(float(m.group(0))):
                raise ExprError("number out of range", i)
            out.append(Tok("num", m.group(0), i, m.end()))
            i = m.end()
            continue
        if c in "\"'":
            j, chars = i + 1, []
            while j < n and src[j] != c:
                if src[j] == "\\" and j + 1 < n:
                    chars.append(src[j + 1])
                    j += 2
                else:
                    chars.append(src[j])
                    j += 1
            if j >= n:
                raise ExprError("unterminated string", i)
            out.append(Tok("str", "".join(chars), i, j + 1))
            i = j + 1
            continue
        if ("A" <= c <= "Z") or ("a" <= c <= "z") or c == "_":
            m = _IDENT.match(src, i)
            assert m is not None
            out.append(Tok("ident", m.group(0), i, m.end()))
            i = m.end()
            continue
        op = next((o for o in _OPS if src.startswith(o, i)), None)
        if op is None:
            raise ExprError(f"unexpected character {c!r}", i)
        out.append(Tok("op", op, i, i + len(op)))
        i += len(op)
    out.append(Tok("eof", "", n, n))
    return out


# Nodes are tuples: ("num", v), ("str", v), ("bool", v), ("null",), ("ref", name, tok),
# ("un", op, e), ("bin", op, l, r), ("call", fn, args).
Node = tuple


def parse(src: str) -> Node:
    t = tokenize(src)
    i = 0
    depth = 0

    def peek() -> Tok:
        return t[i]

    def eat_op(o: str) -> bool:
        nonlocal i
        if peek().kind == "op" and peek().text == o:
            i += 1
            return True
        return False

    def enter() -> None:
        nonlocal depth
        depth += 1
        if depth > MAX_DEPTH:
            raise ExprError("expression is nested too deeply", peek().start)

    def primary() -> Node:
        nonlocal i
        k = peek()
        if k.kind == "num":
            i += 1
            return ("num", float(k.text))
        if k.kind == "str":
            i += 1
            return ("str", k.text)
        if k.kind == "ident":
            i += 1
            low = k.text.lower()
            if low == "true":
                return ("bool", True)
            if low == "false":
                return ("bool", False)
            if low == "null":
                return ("null",)
            if peek().kind == "op" and peek().text == "(":
                if low not in _FUNCS:
                    raise ExprError(f"unknown function {k.text}", k.start)
                i += 1
                args: list[Node] = []
                if not eat_op(")"):
                    args.append(expr(0))
                    while eat_op(","):
                        args.append(expr(0))
                    if not eat_op(")"):
                        raise ExprError("expected )", peek().start)
                want = _FUNCS[low]
                if (len(args) != want) if want >= 0 else (len(args) < -want):
                    raise ExprError(f"{low}() takes {want if want >= 0 else f'at least {-want}'} argument(s)", k.start)
                return ("call", low, args)
            return ("ref", k.text, k)
        if eat_op("("):
            e = expr(0)
            if not eat_op(")"):
                raise ExprError("expected )", peek().start)
            return e
        raise ExprError("unexpected end of expression" if k.kind == "eof" else f"unexpected {k.text!r}", k.start)

    def unary() -> Node:
        enter()
        try:
            if eat_op("!"):
                return ("un", "!", unary())
            if eat_op("-"):
                return ("un", "-", unary())
            return primary()
        finally:
            _leave()

    def _leave() -> None:
        nonlocal depth
        depth -= 1

    def expr(min_prec: int) -> Node:
        nonlocal i
        enter()
        try:
            left = unary()
            while True:
                k = peek()
                p = _PREC.get(k.text) if k.kind == "op" else None
                if p is None or p < min_prec:
                    break
                i += 1
                right = expr(p + 1)
                left = ("bin", k.text, left, right)
            return left
        finally:
            _leave()

    try:
        e = expr(0)
    except RecursionError as exc:  # not reachable within the limits, but never let it escape as another error type
        raise ExprError("expression is too complex") from exc
    if peek().kind != "eof":
        raise ExprError(f"unexpected {peek().text!r}", peek().start)
    return e


def refs(src: str) -> list[str]:
    """Field names that an expression refers to, once each, in order of first use."""
    out: list[str] = []

    def walk(n: Node) -> None:
        k = n[0]
        if k == "ref":
            if n[1] not in out:
                out.append(n[1])
        elif k == "un":
            walk(n[2])
        elif k == "bin":
            walk(n[2])
            walk(n[3])
        elif k == "call":
            for a in n[2]:
                walk(a)

    walk(parse(src))
    return out


def rename_ref(src: str, old: str, new: str) -> str:
    """Rename a field in an expression. Only identifier tokens change, so the author's spacing is kept."""
    parse(src)  # raises if the expression is invalid
    out, last = [], 0
    for tk in tokenize(src):
        if tk.kind == "ident" and tk.text == old and not _is_func_or_literal(src, tk):
            out.append(src[last:tk.start])
            out.append(new)
            last = tk.end
    out.append(src[last:])
    return "".join(out)


def _is_func_or_literal(src: str, tk: Tok) -> bool:
    if tk.text.lower() in ("true", "false", "null"):
        return True
    rest = src[tk.end:].lstrip(_SPACE)
    return rest.startswith("(")  # a call such as isnull(...), not a field


def _finite(x: float) -> Value:
    return x if math.isfinite(x) else None


def _lookup(record: Mapping[str, Any], name: str) -> Value:
    """A value from a record: None, a bool, a finite number, or a string. Anything else counts as None."""
    if name not in record:
        return None
    v = record[name]
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, (int, float)):
        try:
            f = float(v)
        except OverflowError:  # an integer too large for a double
            return None
        return f if math.isfinite(f) else None
    return None


def _eq(a: Value, b: Value) -> bool:
    """Strict equality: a value equals only a value of its own type."""
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    return a == b  # two floats


def truthy(v: Value) -> bool:
    """None, False, 0, and the empty string are false. Everything else is true."""
    if v is None or v is False:
        return False
    if v is True:
        return True
    if isinstance(v, float):
        return v != 0
    return v != ""


def _is_num(v: Value) -> bool:
    return isinstance(v, float)  # a bool is not a float, so True is never a number


def _default_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_instant(text: str) -> datetime:
    """Read an ISO 8601 instant such as 2026-03-01T09:30:00Z. A time with no offset is taken as UTC."""
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def evaluate(src: "str | Node", record: Mapping[str, Any], now: datetime | None = None) -> Value:
    """Evaluate an expression against a record. Raises ExprError only for an invalid expression."""
    node = parse(src) if isinstance(src, str) else src
    moment = now or _default_now()

    def ev(x: Node) -> Value:
        k = x[0]
        if k in ("num", "str", "bool"):
            return x[1]
        if k == "null":
            return None
        if k == "ref":
            return _lookup(record, x[1])
        if k == "un":
            v = ev(x[2])
            if x[1] == "!":
                return not truthy(v)
            return -v if _is_num(v) else None
        if k == "bin":
            return binary(x[1], x[2], x[3])
        return call(x[1], [ev(a) for a in x[2]])

    def binary(op: str, l: Node, r: Node) -> Value:
        if op == "&&":
            return truthy(ev(l)) and truthy(ev(r))
        if op == "||":
            return truthy(ev(l)) or truthy(ev(r))
        a, b = ev(l), ev(r)
        if op == "==":
            return _eq(a, b)
        if op == "!=":
            return not _eq(a, b)
        if op in ("<", ">", "<=", ">="):
            # Only two numbers or two strings have an order. Any other pair, including None, gives False.
            if _is_num(a) and _is_num(b):
                pass
            elif isinstance(a, str) and isinstance(b, str):
                pass  # Python compares str by code point, as the specification says
            else:
                return False
            return a < b if op == "<" else a > b if op == ">" else a <= b if op == "<=" else a >= b
        try:
            if op == "+":
                if _is_num(a) and _is_num(b):
                    return _finite(a + b)
                return a + b if isinstance(a, str) and isinstance(b, str) else None
            if not (_is_num(a) and _is_num(b)):
                return None
            if op == "-":
                return _finite(a - b)
            if op == "*":
                return _finite(a * b)
            if op == "/":
                return None if b == 0 else _finite(a / b)
        except OverflowError:
            return None
        raise ExprError(f"operator {op} is not supported")

    def call(fn: str, a: list[Value]) -> Value:
        a0: Value = a[0] if a else None  # the parser has already checked the number of arguments
        if fn == "isnull":
            return a0 is None or (isinstance(a0, str) and a0 == "")
        if fn == "len":
            return 0.0 if a0 is None else float(len(a0)) if isinstance(a0, str) else None
        if fn == "coalesce":
            return next((v for v in a if v is not None and not (isinstance(v, str) and v == "")), None)
        if fn == "today":
            return moment.astimezone(timezone.utc).date().isoformat()
        if fn == "lower":
            return a0.lower() if isinstance(a0, str) else None
        if fn == "upper":
            return a0.upper() if isinstance(a0, str) else None
        raise ExprError(f"unknown function {fn}")

    try:
        return ev(node)
    except RecursionError as exc:
        raise ExprError("expression is too complex") from exc


def to_json(v: Value) -> Any:
    """A value ready for JSON: a whole number that a double holds exactly becomes an int."""
    if isinstance(v, float) and v.is_integer() and abs(v) < 2**53:
        return int(v)
    return v
