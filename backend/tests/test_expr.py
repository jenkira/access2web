"""Run the shared conformance vectors against the Python evaluator, and test what the vectors cannot say."""
import json
from pathlib import Path

import pytest

from a2w.expr import ExprError, evaluate, parse_instant, refs, rename_ref, to_json, truthy

SPEC = json.loads((Path(__file__).resolve().parents[2] / "spec" / "expression" / "vectors.json").read_text(encoding="utf-8"))


def same(got, want) -> bool:
    """Equal values of the same type. A bool is never equal to a number."""
    if want is None or got is None:
        return want is None and got is None
    if isinstance(want, bool) or isinstance(got, bool):
        return isinstance(want, bool) and isinstance(got, bool) and want == got
    if isinstance(want, str) or isinstance(got, str):
        return isinstance(want, str) and isinstance(got, str) and want == got
    return float(want) == got and isinstance(got, float)  # every number the evaluator returns is a float


@pytest.mark.parametrize("case", SPEC["cases"], ids=lambda c: c["expr"][:40])
def test_evaluate_vector(case):
    now = parse_instant(case.get("now", SPEC["now"]))
    if "error" in case["expect"]:
        with pytest.raises(ExprError):
            evaluate(case["expr"], case.get("record", {}), now)
    else:
        got = evaluate(case["expr"], case.get("record", {}), now)
        assert same(got, case["expect"]["value"]), f"{case['expr']!r}: expected {case['expect']['value']!r}, got {got!r}"


@pytest.mark.parametrize("case", SPEC["rename"], ids=lambda c: c["expr"][:40] or "empty")
def test_rename_vector(case):
    if "error" in case["expect"]:
        with pytest.raises(ExprError):
            rename_ref(case["expr"], case["from"], case["to"])
    else:
        assert rename_ref(case["expr"], case["from"], case["to"]) == case["expect"]["value"]


@pytest.mark.parametrize("case", SPEC["refs"], ids=lambda c: c["expr"][:40])
def test_refs_vector(case):
    if "error" in case["expect"]:
        with pytest.raises(ExprError):
            refs(case["expr"])
    else:
        assert refs(case["expr"]) == case["expect"]["value"]


# ---- things the vectors cannot express
def test_every_number_is_a_float():
    assert type(evaluate("1 + 2", {})) is float
    assert type(evaluate("len('abc')", {})) is float
    assert type(evaluate("a", {"a": 7})) is float, "an int in the record becomes a float"


def test_a_bool_is_not_a_number():
    assert evaluate("a + 1", {"a": True}) is None
    assert evaluate("a == 1", {"a": True}) is False
    assert evaluate("a < 2", {"a": True}) is False
    assert evaluate("-a", {"a": True}) is None


def test_to_json_keeps_whole_numbers_exact():
    assert to_json(evaluate("2 + 2", {})) == 4 and isinstance(to_json(4.0), int)
    assert to_json(1.5) == 1.5
    assert isinstance(to_json(2.0**60), float), "a whole number beyond 2**53 stays a float"
    assert to_json("x") == "x" and to_json(None) is None and to_json(True) is True


def test_truthy():
    assert [truthy(v) for v in (None, False, 0.0, "", True, 1.0, "0", "a")] == [False, False, False, False, True, True, True, True]


def test_integers_too_large_for_a_double_count_as_null():
    assert evaluate("a", {"a": 10**400}) is None
    assert evaluate("a", {"a": 10**20}) == 1e20


def test_the_evaluator_does_not_run_code():
    # Names are looked up in the record. Nothing in an expression can reach Python.
    for src in ["__import__", "__import__('os')", "a.__class__", "open('x')", "exec", "(lambda: 1)()"]:
        try:
            evaluate(src, {"a": 1})
        except ExprError:
            pass
    assert evaluate("__import__", {}) is None


def test_a_bad_expression_never_raises_anything_but_exprerror():
    for src in ["(" * 500, "'" * 501, "\x00", "a" * 600, "1 +" * 200, ")" * 100, "-" * 300 + "1"]:
        try:
            evaluate(src, {})
        except ExprError:
            continue
        except Exception as e:  # noqa: BLE001
            pytest.fail(f"{src[:20]!r} raised {type(e).__name__}")


def test_default_now_is_utc_today():
    from datetime import datetime, timezone
    assert evaluate("today()", {}) == datetime.now(timezone.utc).date().isoformat()
