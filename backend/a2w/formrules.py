"""Server-side check of a record against a form's rules.

This is the Python counterpart of failedRules in the form editor. The server runs it for every save, because a check
in the browser can be bypassed. The shared vectors in spec/expression/forms.json hold the cases that both must pass.

A definition here is the JSON shape of the application definition: entities, and forms made of rows of controls.
"""
from collections.abc import Iterator, Mapping
from datetime import datetime
from typing import Any

from .expr import evaluate, truthy


def all_controls(form: Mapping[str, Any]) -> Iterator[Mapping[str, Any]]:
    for row in form["rows"]:
        yield from row["controls"]


def find_form(definition: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    for f in definition["forms"]:
        if f["name"] == name:
            return f
    raise KeyError(name)


def _visible(control: Mapping[str, Any], record: Mapping[str, Any], now: datetime | None) -> bool:
    expr = control.get("visible")
    return expr is None or truthy(evaluate(expr, record, now))


def failed_rules(definition: Mapping[str, Any], form: Mapping[str, Any], record: Mapping[str, Any],
                 now: datetime | None = None) -> list[dict[str, str]]:
    """Every rule that fails, as {"control", "message"}.

    Rule errors come first, then required-field errors, each in control order. A hidden control is not checked.
    A rule on an empty field fails, because a comparison with null is false. Write isnull(x) || ... for an optional field.
    """
    out: list[dict[str, str]] = []
    for c in all_controls(form):
        if "bind" not in c or not c.get("validate"):
            continue
        if not _visible(c, record, now):
            continue
        for rule in c["validate"]:
            if not truthy(evaluate(rule["expr"], record, now)):
                out.append({"control": c["id"], "message": rule["message"]})
    entity = next((e for e in definition["entities"] if e["name"] == form["entity"]), None)
    fields = {f["name"]: f for f in (entity["fields"] if entity else [])}
    for c in all_controls(form):
        if "bind" not in c:
            continue
        f = fields.get(c["bind"])
        if f and f.get("required") and not f.get("key") and _visible(c, record, now):
            v = record.get(c["bind"])
            if v is None or v == "":
                out.append({"control": c["id"], "message": f"{c['label']} is required"})
    return out


def unknown_fields(form: Mapping[str, Any], record: Mapping[str, Any]) -> list[str]:
    """Keys of the record that no control on the form binds to. The server refuses a record that has any."""
    bound = {c["bind"] for c in all_controls(form) if "bind" in c}
    return [k for k in record if k not in bound]
