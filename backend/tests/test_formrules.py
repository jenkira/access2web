"""Run the shared form-rule vectors against the Python checker."""
import json
from pathlib import Path

import pytest

from a2w.expr import parse_instant
from a2w.formrules import failed_rules, find_form, unknown_fields

SPEC = json.loads((Path(__file__).resolve().parents[2] / "spec" / "expression" / "forms.json").read_text(encoding="utf-8"))
NOW = parse_instant(SPEC["now"])


@pytest.mark.parametrize("i,case", list(enumerate(SPEC["cases"])), ids=lambda x: x if isinstance(x, int) else x["form"])
def test_form_vector(i, case):
    form = find_form(SPEC["definition"], case["form"])
    assert failed_rules(SPEC["definition"], form, case["record"], NOW) == case["errors"], case.get("note", "")
    assert unknown_fields(form, case["record"]) == case["unknown"]


def test_unknown_form_raises():
    with pytest.raises(KeyError):
        find_form(SPEC["definition"], "NoSuchForm")


def test_a_rule_that_cannot_be_evaluated_is_not_swallowed():
    from a2w.expr import ExprError
    definition = {"entities": [{"name": "E", "fields": [{"name": "a", "type": "number"}]}],
                  "forms": [{"name": "F", "entity": "E", "rows": [{"id": "r", "controls": [
                      {"id": "c", "type": "number", "bind": "a", "label": "A", "validate": [{"expr": "a >", "message": "m"}]}]}]}]}
    with pytest.raises(ExprError):
        failed_rules(definition, definition["forms"][0], {"a": 1})


def test_a_hidden_required_control_is_not_required():
    definition = {"entities": [{"name": "E", "fields": [{"name": "a", "type": "text", "required": True}, {"name": "b", "type": "bool"}]}],
                  "forms": [{"name": "F", "entity": "E", "rows": [{"id": "r", "controls": [
                      {"id": "c", "type": "text", "bind": "a", "label": "A", "visible": "b"},
                      {"id": "d", "type": "checkbox", "bind": "b", "label": "B"}]}]}]}
    form = definition["forms"][0]
    assert failed_rules(definition, form, {"b": False}) == []
    assert failed_rules(definition, form, {"b": True}) == [{"control": "c", "message": "A is required"}]
