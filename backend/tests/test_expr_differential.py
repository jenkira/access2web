"""Differential test: random expressions go through the Python evaluator and the TypeScript evaluator, and the results must agree.

It checks four things for every case: whether the expression is valid, its value, the fields it refers to, and the result of a rename.
The TypeScript evaluator lives with the form editor prototype for now. If that file is not there, or Node is not installed,
the test is skipped, unless A2W_REQUIRE_DIFFERENTIAL is set. CI sets it, so that a missing Node fails the run and the
check cannot be skipped without anyone noticing.
"""
import json
import os
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from a2w.expr import ExprError, evaluate, parse_instant, refs, rename_ref

TOOL = Path(__file__).resolve().parents[2] / "spikes" / "spike5-form-editor" / "tools" / "eval-batch.ts"
NAMES = ["a", "b", "c", "d", "len", "x_1", "Qty"]
STRINGS = ["", "a", "B", "abc", "5", "0", "true", "ß", "İ", "ΑΣ", "\U0001F600", "é", "￿", "2026-03-01", "x y", "it's"]
NUMBERS = ["0", "1", "2", "0.5", "10", "100", "0.1", "0.2", "1e3", "2.5e-3", "1e308", "9007199254740993", "007", ".5"]
INSTANTS = ["2026-03-01T09:30:00Z", "2026-03-01T23:59:59Z", "2026-12-31T23:30:00-05:00", "2026-01-01T00:00:00+09:00", "2024-02-29T12:00:00Z"]
BINOPS = ["+", "-", "*", "/", "==", "!=", "<", ">", "<=", ">=", "&&", "||"]
FUNCS = [("isnull", 1), ("len", 1), ("lower", 1), ("upper", 1), ("coalesce", 0), ("today", 0)]
JUNK = ["(", ")", ",", "'", '"', "=", "&", "|", "!", "-", "+", "*", "/", "<", ">", ".", "\\", "é", " ", " ", "$", "@", "[", "]", "1e", "..", "  "]


def quote(r: random.Random, s: str) -> str:
    q = r.choice(["'", '"'])
    body = s.replace("\\", "\\\\").replace(q, "\\" + q)
    return q + body + q


def gen(r: random.Random, depth: int) -> str:
    if depth <= 0 or r.random() < 0.25:
        kind = r.random()
        if kind < 0.35:
            return r.choice(NAMES)
        if kind < 0.6:
            return r.choice(NUMBERS)
        if kind < 0.8:
            return quote(r, r.choice(STRINGS))
        return r.choice(["true", "false", "null", "TRUE", "Null", "today()"])
    kind = r.random()
    if kind < 0.55:
        return f"{gen(r, depth - 1)} {r.choice(BINOPS)} {gen(r, depth - 1)}"
    if kind < 0.7:
        return f"{r.choice(['!', '-'])}{gen(r, depth - 1)}"
    if kind < 0.8:
        return f"({gen(r, depth - 1)})"
    name, base = r.choice(FUNCS)
    argc = base if base else r.randint(0 if name == "today" else 1, 3)
    if name == "today":
        argc = 0
    return f"{name}({', '.join(gen(r, depth - 1) for _ in range(argc))})"


def spaced(r: random.Random, s: str) -> str:
    return "".join(c + (r.choice([" ", "\t", "\n", ""]) if c in "+-*/<>=!&|(),'" and r.random() < 0.2 else "") for c in s)


def mutate(r: random.Random, s: str) -> str:
    chars = list(s)
    for _ in range(r.randint(1, 3)):
        pos = r.randint(0, len(chars))
        op = r.random()
        if op < 0.4:
            chars.insert(pos, r.choice(JUNK))
        elif op < 0.7 and chars:
            del chars[min(pos, len(chars) - 1)]
        elif chars:
            i, j = r.randrange(len(chars)), r.randrange(len(chars))
            chars[i], chars[j] = chars[j], chars[i]
    return "".join(chars)


def record(r: random.Random) -> dict:
    pool = [None, True, False, 0, 1, -1, 2.5, 100, 1e308, 10**20, 10**400, "", "a", "5", "ß", "\U0001F600", [1], {"k": 1}, "2026-03-01", "B"]
    return {n: r.choice(pool) for n in NAMES if r.random() < 0.7}


def make_cases(n: int, seed: int) -> list[dict]:
    r = random.Random(seed)
    cases = []
    for i in range(n):
        expr = spaced(r, gen(r, r.randint(1, 5)))
        if i % 3 == 0:
            expr = mutate(r, expr)  # a third are damaged, so most of those are invalid
        c = {"expr": expr, "record": record(r), "now": r.choice(INSTANTS)}
        if r.random() < 0.5:
            c["rename"] = {"from": r.choice(NAMES + ["len", "true", "isnull", "today"]), "to": r.choice(["zz", "n_2", "a", "Qty"])}
        cases.append(c)
    return cases


def same(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    return float(a) == float(b)


def python_result(c: dict) -> dict:
    try:
        v = evaluate(c["expr"], c["record"], parse_instant(c["now"]))
        ren = rename_ref(c["expr"], c["rename"]["from"], c["rename"]["to"]) if "rename" in c else None
        return {"value": v, "refs": refs(c["expr"]), "renamed": ren}
    except ExprError:
        return {"error": True}


@pytest.mark.skipif((shutil.which("node") is None or not TOOL.exists()) and not os.environ.get("A2W_REQUIRE_DIFFERENTIAL"),
                    reason="node or the TypeScript evaluator is not available")
@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_python_and_typescript_agree(seed):
    cases = make_cases(2500, seed)
    proc = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", str(TOOL)], input=json.dumps(cases), capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr[-500:]
    ts = json.loads(proc.stdout)
    assert len(ts) == len(cases)
    valid = errors = 0
    problems = []
    for c, t in zip(cases, ts):
        p = python_result(c)
        if ("error" in p) != ("error" in t):
            problems.append(f"validity differs for {c['expr']!r}: python={'error' if 'error' in p else 'ok'} typescript={'error' if 'error' in t else 'ok'}")
            continue
        if "error" in p:
            errors += 1
            continue
        valid += 1
        if not same(p["value"], t["value"]):
            problems.append(f"value differs for {c['expr']!r} {c['record']!r}: python={p['value']!r} typescript={t['value']!r}")
        elif p["refs"] != t["refs"]:
            problems.append(f"refs differ for {c['expr']!r}: python={p['refs']} typescript={t['refs']}")
        elif p["renamed"] != t["renamed"]:
            problems.append(f"rename differs for {c['expr']!r} {c.get('rename')}: python={p['renamed']!r} typescript={t['renamed']!r}")
    print(f"\nseed {seed}: {valid} valid, {errors} invalid, {len(problems)} differences")
    assert not problems, "\n".join(problems[:10])
    assert valid > 800 and errors > 300, "the generator should produce both valid and invalid expressions"
