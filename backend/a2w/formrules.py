"""Server-side check of a record against a form's rules.

This is the Python counterpart of failedRules in the form editor. The server runs it for every save, because a check
in the browser can be bypassed. The shared vectors in spec/expression/forms.json hold the cases that both must pass.

A definition here is the JSON shape of the application definition: entities, and forms made of rows of controls.
"""
import re
from collections.abc import Iterator, Mapping
from datetime import datetime
from typing import Any

from .expr import ExprError, evaluate, refs, truthy

CONTROL_TYPES = {"text", "number", "date", "checkbox", "textarea", "combo", "label", "button", "subform"}
BOUND_TYPES = {"text", "number", "date", "checkbox", "textarea", "combo"}
_CONTROL_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_]*\Z")


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
    primary = set(entity.get("primary_key", ())) if entity else set()
    for c in all_controls(form):
        if "bind" not in c:
            continue
        f = fields.get(c["bind"])
        # A key is never "required" here: the database gives it a value.
        if f and f.get("required") and not (f.get("key") or f.get("identity") or c["bind"] in primary) and _visible(c, record, now):
            v = record.get(c["bind"])
            if v is None or v == "":
                out.append({"control": c["id"], "message": f"{c['label']} is required"})
    return out


def unknown_fields(form: Mapping[str, Any], record: Mapping[str, Any]) -> list[str]:
    """Keys of the record that no control on the form binds to. The server refuses a record that has any."""
    bound = {c["bind"] for c in all_controls(form) if "bind" in c}
    return [k for k in record if k not in bound]


def _is_str_list(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _shape_problems(form: Any) -> list[str]:
    """Why a form cannot even be read: a missing or wrongly typed part. Checked before anything else looks inside the form.

    Form JSON comes from the editor, and from anyone who calls the API, so nothing in it can be assumed. Without this, a
    form with no rows, or a name that is a list, would raise an error and the person would get a 500 instead of a reason.
    """
    if not isinstance(form, dict):
        return ["a form must be an object"]
    name = form.get("name")
    where = f"form {name}" if isinstance(name, str) else "a form"
    out: list[str] = []
    if not isinstance(name, str) or not name.strip():
        out.append(f"{where}: name must be text")
    if not isinstance(form.get("entity"), str):
        out.append(f"{where}: entity must be text")
    rows = form.get("rows")
    if not isinstance(rows, list):
        return out + [f"{where}: rows must be a list"]
    for r, row in enumerate(rows):
        if not isinstance(row, dict) or not isinstance(row.get("controls"), list):
            out.append(f"{where}: row {r + 1} must have a list of controls")
            continue
        for c, ctl in enumerate(row["controls"]):
            at = f"{where}: control {c + 1} of row {r + 1}"
            if not isinstance(ctl, dict):
                out.append(f"{at} must be an object")
                continue
            if not isinstance(ctl.get("id"), str):
                out.append(f"{at}: id must be text")
            if not isinstance(ctl.get("type"), str):
                out.append(f"{at}: type must be text")
            for key in ("label", "text", "bind", "visible", "default"):
                if key in ctl and ctl[key] is not None and not isinstance(ctl[key], str):
                    out.append(f"{at}: {key} must be text")
            rules = ctl.get("validate")
            if rules is not None and not (isinstance(rules, list) and all(
                    isinstance(x, dict) and isinstance(x.get("expr", ""), str) for x in rules)):
                out.append(f"{at}: validate must be a list of rules, each with text for its expression")
            for key, parts in (("source", ("entity", "value", "display")), ("child", ("entity", "link", "parentKey"))):
                v = ctl.get(key)
                if v is not None and not (isinstance(v, dict) and all(isinstance(v.get(x), str) for x in parts if x in v)):
                    out.append(f"{at}: {key} must be an object whose {', '.join(parts)} are text")
            if "columns" in ctl and not _is_str_list(ctl["columns"]):
                out.append(f"{at}: columns must be a list of text")
    return out


def validate_forms(definition: Mapping[str, Any]) -> list[str]:
    """Every problem that would stop a form from working. An empty list means the forms are valid.

    Publish refuses a definition with problems, so a rule that cannot run is never stored. The TypeScript editor has the same
    check (validateDefinition), and spec/expression/validation.json holds the cases that both must agree on.
    """
    problems: list[str] = []
    entities = {e["name"]: e for e in definition.get("entities", [])}

    def field_names(entity_name: str) -> set[str]:
        return {f["name"] for f in entities[entity_name]["fields"]}

    seen_forms: set[str] = set()
    for form in definition.get("forms", []):
        bad_shape = _shape_problems(form)
        if bad_shape:
            problems.extend(bad_shape)
            continue
        where = f"form {form.get('name')}"
        if form.get("name") in seen_forms:
            problems.append(f"{where}: duplicate form name")
        seen_forms.add(form.get("name"))
        entity = form.get("entity")
        if entity not in entities:
            problems.append(f"{where}: unknown entity {entity}")
            continue
        own = field_names(entity)
        seen_ids: set[str] = set()

        def check_expr(src: str, what: str, where: str = where, own: set[str] = own) -> None:
            try:
                used = refs(src)
            except ExprError as e:
                problems.append(f"{where}: {what}: {e}")
                return
            for u in used:
                if u not in own:
                    problems.append(f"{where}: {what}: unknown field {u}")

        for c in all_controls(form):
            cid = c.get("id")
            if not isinstance(cid, str) or not _CONTROL_ID.match(cid):
                problems.append(f"{where}: control id must be letters, digits, and underscores")
                continue
            if cid in seen_ids:
                problems.append(f"{where}: duplicate control id {cid}")
            seen_ids.add(cid)
            ctype = c.get("type")
            if ctype not in CONTROL_TYPES:
                problems.append(f"{where}: control {cid} has unknown type {ctype}")
                continue
            text = c.get("text") if ctype == "label" else c.get("label")
            if not isinstance(text, str) or not text.strip():
                problems.append(f"{where}: control {cid} needs {'text' if ctype == 'label' else 'a label'}")
            if ctype in BOUND_TYPES and c.get("bind") not in own:
                problems.append(f"{where}: control {cid} is bound to unknown field {c.get('bind')}")
            if ctype == "combo":
                src = c.get("source") or {}
                if src.get("entity") not in entities:
                    problems.append(f"{where}: combo {cid} refers to unknown entity {src.get('entity')}")
                else:
                    other = field_names(src["entity"])
                    for key in ("value", "display"):
                        if src.get(key) not in other:
                            problems.append(f"{where}: combo {cid} refers to unknown field {src.get(key)} of {src['entity']}")
            if ctype == "subform":
                child = c.get("child") or {}
                if child.get("entity") not in entities:
                    problems.append(f"{where}: subform {cid} refers to unknown entity {child.get('entity')}")
                else:
                    other = field_names(child["entity"])
                    if child.get("link") not in other:
                        problems.append(f"{where}: subform {cid} links on unknown field {child.get('link')}")
                    if child.get("parentKey") not in own:
                        problems.append(f"{where}: subform {cid} uses unknown parent key {child.get('parentKey')}")
                    for col in c.get("columns", []):
                        if col not in other:
                            problems.append(f"{where}: subform {cid} shows unknown column {col}")
            if c.get("visible") is not None:
                check_expr(c["visible"], "visibility rule")
            for rule in c.get("validate") or []:
                if not isinstance(rule.get("message"), str) or not rule["message"].strip():
                    problems.append(f"{where}: a validation rule needs a message")
                check_expr(rule.get("expr", ""), "validation rule")
            if c.get("default") is not None:
                check_expr(c["default"], "default")
    return problems
