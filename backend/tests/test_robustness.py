"""Names that end in a newline, and form JSON that is the wrong shape: refused with a reason, never a 500."""
import copy

import pytest

from a2w import importer, names
from a2w.formrules import validate_forms
from conftest import OWNER
from test_forms_api import CUSTOMER_FORM, ORDER_FORM, publish

# ---- a name that ends in a newline
@pytest.mark.parametrize("bad", ["mail\n", "customers\n", "_x\n", "a" * 63 + "\n"])
def test_an_identifier_cannot_end_in_a_newline(bad):
    with pytest.raises(ValueError):
        names.check_ident(bad)
    with pytest.raises(ValueError):
        names.quote(bad)


@pytest.mark.parametrize("bad", ["abc\n", "ab_c\n", "my_app\n"])
def test_a_slug_cannot_end_in_a_newline(bad):
    assert names.SLUG.match(bad) is None
    with pytest.raises(ValueError):
        names.check_slug(bad)
    with pytest.raises(ValueError):
        names.schema_for(bad)


@pytest.mark.parametrize("good", ["mail", "_x", "a1_b2", "a" * 63])
def test_names_that_were_valid_still_are(good):
    assert names.check_ident(good) == good and names.quote(good) == f'"{good}"'
    assert names.check_slug("ab_c1") == "ab_c1" and names.schema_for("ab_c1") == "app_ab_c1"


def test_a_number_default_cannot_end_in_a_newline():
    assert importer._NUM.match("5\n") is None and importer._NUM.match("-1.50\n") is None
    assert importer._NUM.match("5") and importer._NUM.match("-1.50")


def test_a_control_id_cannot_end_in_a_newline():
    form = copy.deepcopy(CUSTOMER_FORM)
    form["rows"][0]["controls"][0]["id"] = "c_name\n"
    problems = validate_forms(DEFINITION(form))
    assert any("control id must be letters, digits, and underscores" in p for p in problems), problems


# ---- form JSON of the wrong shape
def DEFINITION(*forms):
    return {"entities": [{"name": "customers", "fields": [{"name": "customer_name"}, {"name": "email"}]}], "forms": list(forms)}


def good():
    return copy.deepcopy(CUSTOMER_FORM)


def with_(path, value):
    f = good()
    node = f
    for k in path[:-1]:
        node = node[k]
    if value is ...:
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return f


CTL = ["rows", 0, "controls", 0]
EMAIL = ["rows", 1, "controls", 0]
MALFORMED = {
    "not an object": 5, "a list": [], "a string": "x", "null": None, "empty": {},
    "name is a list": with_(["name"], ["x"]), "name is a number": with_(["name"], 5), "name is empty": with_(["name"], "  "),
    "no name": with_(["name"], ...), "entity is a list": with_(["entity"], ["customers"]), "no entity": with_(["entity"], ...),
    "no rows": with_(["rows"], ...), "rows is a string": with_(["rows"], "x"), "rows is an object": with_(["rows"], {"a": 1}),
    "a row is a number": with_(["rows", 0], 5), "a row has no controls": with_(["rows", 0, "controls"], ...),
    "controls is a string": with_(["rows", 0, "controls"], "x"), "a control is a string": with_(CTL, "x"),
    "a control id is a list": with_(CTL + ["id"], ["a"]), "a control id is missing": with_(CTL + ["id"], ...),
    "a control type is a list": with_(CTL + ["type"], ["text"]), "a control type is a dict": with_(CTL + ["type"], {}),
    "bind is a list": with_(CTL + ["bind"], ["customer_name"]), "bind is a dict": with_(CTL + ["bind"], {"a": 1}),
    "label is a number": with_(CTL + ["label"], 5),
    "visible is a number": with_(EMAIL + ["visible"], 5), "visible is a list": with_(EMAIL + ["visible"], ["a"]),
    "default is a number": with_(EMAIL + ["default"], 5),
    "validate is a string": with_(EMAIL + ["validate"], "x"), "validate holds a number": with_(EMAIL + ["validate"], [5]),
    "a rule expression is a number": with_(EMAIL + ["validate"], [{"expr": 5, "message": "m"}]),
    "a rule expression is a list": with_(EMAIL + ["validate"], [{"expr": ["a"], "message": "m"}]),
    "source is a list": with_(CTL, {"id": "c", "type": "combo", "bind": "email", "label": "L", "source": ["x"]}),
    "source entity is a list": with_(CTL, {"id": "c", "type": "combo", "bind": "email", "label": "L", "source": {"entity": ["x"], "value": "a", "display": "b"}}),
    "child is a string": with_(CTL, {"id": "c", "type": "subform", "label": "L", "child": "x", "columns": []}),
    "child link is a list": with_(CTL, {"id": "c", "type": "subform", "label": "L", "child": {"entity": "customers", "link": ["a"], "parentKey": "email"}, "columns": []}),
    "columns is a string": with_(CTL, {"id": "c", "type": "subform", "label": "L", "child": {"entity": "customers", "link": "email", "parentKey": "email"}, "columns": "abc"}),
    "columns holds a number": with_(CTL, {"id": "c", "type": "subform", "label": "L", "child": {"entity": "customers", "link": "email", "parentKey": "email"}, "columns": [1]}),
}


@pytest.mark.parametrize("form", MALFORMED.values(), ids=MALFORMED.keys())
def test_a_form_of_the_wrong_shape_gets_a_reason_and_not_an_error(form):
    problems = validate_forms(DEFINITION(form))
    assert problems and all(isinstance(p, str) and p for p in problems), problems


def test_a_well_formed_form_is_still_valid_and_one_bad_form_does_not_hide_another_problem():
    assert validate_forms(DEFINITION(good())) == []
    dup = good()
    problems = validate_forms(DEFINITION(5, good(), dup))
    assert "a form must be an object" in problems and any("duplicate form name" in p for p in problems), problems


@pytest.mark.parametrize("bad", [MALFORMED["no rows"], MALFORMED["name is a list"], MALFORMED["a rule expression is a number"], MALFORMED["bind is a list"]])
def test_publishing_forms_of_the_wrong_shape_is_a_400_and_creates_nothing(client, bad):
    slug, r = publish(client, forms=[bad])
    assert r.status_code == 400 and r.json()["detail"].startswith("invalid forms:"), r.text
    assert client.get(f"/api/apps/{slug}", headers=OWNER).status_code in (401, 403, 404)


@pytest.mark.parametrize("bad", [MALFORMED["no rows"], MALFORMED["name is a list"], MALFORMED["a rule expression is a number"], MALFORMED["bind is a list"]])
def test_a_new_version_with_forms_of_the_wrong_shape_is_a_400_and_changes_nothing(client, bad):
    slug, _ = publish(client)
    r = client.post(f"/api/apps/{slug}/versions", headers=OWNER, json={"base_version": 1, "forms": [bad, ORDER_FORM]})
    assert r.status_code == 400 and r.json()["detail"].startswith("invalid forms:"), r.text
    assert client.get(f"/api/apps/{slug}/definition", headers=OWNER).json()["version"] == 1
