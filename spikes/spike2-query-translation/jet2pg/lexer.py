import re
from dataclasses import dataclass


class Unsupported(Exception):
    """A construct the transpiler does not translate. The message is the reason shown to the owner."""


@dataclass
class Tok:
    kind: str  # num str date ident bracket op eof
    value: str
    pos: int = 0


_NUM = re.compile(r"\d+(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")
_OPS = ["<>", "<=", ">=", "=", "<", ">", "+", "-", "*", "/", "\\", "^", "&", "(", ")", ",", ".", "!", ";"]


def _date_literal(text: str) -> str:
    """Jet date literals are US format (m/d/yyyy) or ISO, with an optional time."""
    t = text.strip()
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?", t, re.I)
    if m:
        mo, d, y, hh, mi, ss, ap = m.groups()
        h = int(hh or 0)
        if ap and ap.upper() == "PM" and h < 12:
            h += 12
        if ap and ap.upper() == "AM" and h == 12:
            h = 0
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d} {h:02d}:{int(mi or 0):02d}:{int(ss or 0):02d}"
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?", t)
    if m:
        y, mo, d, hh, mi, ss = m.groups()
        return f"{y}-{mo}-{d} {int(hh or 0):02d}:{int(mi or 0):02d}:{int(ss or 0):02d}"
    raise Unsupported(f"date literal #{text}# is not in a recognised format")


def tokenize(s: str) -> list[Tok]:
    out: list[Tok] = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c.isspace():
            i += 1
        elif c in "\"'":
            j, buf = i + 1, []
            while True:
                if j >= n:
                    raise Unsupported("unterminated string literal")
                if s[j] == c:
                    if j + 1 < n and s[j + 1] == c:
                        buf.append(c)
                        j += 2
                        continue
                    break
                buf.append(s[j])
                j += 1
            out.append(Tok("str", "".join(buf), i))
            i = j + 1
        elif c == "#":
            j = s.find("#", i + 1)
            if j < 0:
                raise Unsupported("unterminated date literal")
            out.append(Tok("date", _date_literal(s[i + 1:j]), i))
            i = j + 1
        elif c == "[":
            j = s.find("]", i + 1)
            if j < 0:
                raise Unsupported("unterminated bracketed name")
            out.append(Tok("bracket", s[i + 1:j], i))
            i = j + 1
        elif c.isdigit() or (c == "." and i + 1 < n and s[i + 1].isdigit()):
            m = _NUM.match(s, i)
            out.append(Tok("num", m.group(0), i))
            i = m.end()
        elif c.isalpha() or c == "_":
            m = _IDENT.match(s, i)
            out.append(Tok("ident", m.group(0), i))
            i = m.end()
        else:
            for op in _OPS:
                if s.startswith(op, i):
                    out.append(Tok("op", op, i))
                    i += len(op)
                    break
            else:
                raise Unsupported(f"unexpected character {c!r}")
    out.append(Tok("eof", "", n))
    return out
