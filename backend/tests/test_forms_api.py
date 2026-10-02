"""Forms in the backend: publish with forms, fetch a form, and save through a form with its rules checked on the server."""
import uuid

import psycopg
import pytest

from conftest import ADMIN, AUDITOR, OWNER, hdr, sample

BOB = hdr("bob")      # given view_data below
CARA = hdr("cara")    # given edit_data below
EVE = hdr("eve")      # given nothing

CUSTOMER_FORM = {"name": "CustomerForm", "title": "Customer", "entity": "customers", "rows": [
    {"id": "r1", "controls": [{"id": "c_name", "type": "text", "bind": "customer_name", "label": "Name"}]},
    {"id": "r2", "controls": [{"id": "c_email", "type": "text", "bind": "email", "label": "Email",
                               "visible": "customer_name != 'private'",
                               "validate": [{"expr": "isnull(email) || len(email) >= 5", "message": "Email is too short"}]}]},
]}
ORDER_FORM = {"name": "OrderForm", "title": "Order", "entity": "orders", "rows": [
    {"id": "r1", "controls": [
        {"id": "o_cust", "type": "number", "bind": "customerid", "label": "Customer"},
        {"id": "o_total", "type": "number", "bind": "total", "label": "Total",
         "validate": [{"expr": "total >= 0", "message": "Total must not be negative"}]},
        {"id": "o_date", "type": "date", "bind": "orderdate", "label": "Order date",
         "validate": [{"expr": "isnull(orderdate) || orderdate <= today()", "message": "Order date cannot be in the future"}]}]},
]}


def grant(subject, level, resource_type="application", resource_id=""):
    return {"subject_type": "user", "subject_id": subject, "level": level, "resource_type": resource_type, "resource_id": resource_id}


BASE_GRANTS = [grant("bob", "view_data"), grant("cara", "edit_data")]


def publish(client, forms=(CUSTOMER_FORM, ORDER_FORM), grants=BASE_GRANTS, slug=None):
    slug = slug or "f_" + uuid.uuid4().hex[:8]
    job = client.post("/api/authoring/import-jobs", json=sample(), headers=OWNER).json()["job"]
    r = client.post(f"/api/authoring/import-jobs/{job}/publish", headers=OWNER, json={
        "slug": slug, "name": "Forms " + slug, "confirmed_classification": "personal", "permissions_confirmed": True,
        "grants": list(grants), "forms": list(forms)})
    return slug, r


def save(client, slug, form, values, who=CARA, version=1, key=None):
    path = f"/api/apps/{slug}/forms/{form}/records" + (f"/{key}" if key is not None else "")
    return (client.put if key is not None else client.post)(path, headers=who, json={"version": version, "values": values})


# ---- publish
def test_publish_stores_the_forms_and_lists_only_those_the_user_may_view(client):
    slug, r = publish(client)
    assert r.status_code == 200, r.text
    info = client.get(f"/api/apps/{slug}", headers=BOB).json()
    assert [f["name"] for f in info["forms"]] == ["CustomerForm", "OrderForm"]
    owner = client.get(f"/api/apps/{slug}", headers=OWNER).json()
    assert owner["forms"] == [] and owner["tables"] == [], "manage alone gives no data access, so the owner sees no forms or tables"


@pytest.mark.parametrize("mutate,expected", [
    (lambda f: f["rows"][0]["controls"][0].update(bind="no_such_field"), "bound to unknown field no_such_field"),
    (lambda f: f["rows"][1]["controls"][0].update(visible="nope > 1"), "unknown field nope"),
    (lambda f: f["rows"][1]["controls"][0].update(visible="a >"), "visibility rule"),
    (lambda f: f["rows"][1]["controls"][0]["validate"][0].update(expr="len(email"), "validation rule"),
    (lambda f: f.update(entity="no_such_entity"), "unknown entity"),
    (lambda f: f["rows"][0]["controls"][0].update(id="a b"), "control id"),
])
def test_publish_refuses_a_form_with_a_rule_that_cannot_run(client, db_url, mutate, expected):
    import copy
    form = copy.deepcopy(CUSTOMER_FORM)
    mutate(form)
    slug, r = publish(client, forms=[form])
    assert r.status_code == 400 and r.json()["detail"].startswith("invalid forms:") and expected in r.json()["detail"], r.text
    with psycopg.connect(db_url) as c:  # nothing was created
        assert c.execute("select count(*) from a2w_control.applications where slug = %s", (slug,)).fetchone()[0] == 0
        assert c.execute("select count(*) from information_schema.schemata where schema_name = %s", ("app_" + slug,)).fetchone()[0] == 0


def test_publish_without_forms_still_works(client):
    slug, r = publish(client, forms=[])
    assert r.status_code == 200
    assert client.get(f"/api/apps/{slug}", headers=BOB).json()["forms"] == []


# ---- fetching a form
def test_get_form_returns_the_form_and_its_version(client):
    slug, _ = publish(client)
    r = client.get(f"/api/apps/{slug}/forms/CustomerForm", headers=BOB)
    assert r.status_code == 200
    assert r.json()["version"] == 1 and r.json()["form"]["entity"] == "customers"


def test_a_missing_form_and_a_forbidden_form_look_the_same(client):
    slug, _ = publish(client)
    forbidden = client.get(f"/api/apps/{slug}/forms/CustomerForm", headers=EVE)
    missing = client.get(f"/api/apps/{slug}/forms/NoSuchForm", headers=BOB)
    assert forbidden.status_code == missing.status_code == 403 and forbidden.json() == missing.json()
    assert save(client, slug, "NoSuchForm", {}, who=CARA).json() == forbidden.json()


# ---- saving through a form
def test_a_valid_save_writes_the_record_and_the_audit_row(client, db_url):
    slug, _ = publish(client)
    r = save(client, slug, "CustomerForm", {"customer_name": "Dahlia", "email": "dahlia@x.test"})
    assert r.status_code == 201, r.text
    assert r.json()["customer_name"] == "Dahlia" and r.json()["customerid"] == 3
    ev = client.get(f"/api/audit?app={slug}", headers=AUDITOR).json()
    insert = next(e for e in ev if e["object"] == "customers" and e["action"] == "insert")
    assert insert["actor"] == "cara" and insert["detail"]["new"]["customer_name"] == "Dahlia"
    assert client.get("/api/audit/verify", headers=AUDITOR).json()["intact"] is True


def test_a_rule_failure_is_422_with_the_messages_and_nothing_is_written(client):
    slug, _ = publish(client)
    r = save(client, slug, "CustomerForm", {"customer_name": "Dahlia", "email": "ab"})
    assert r.status_code == 422
    assert r.json() == {"error": "validation", "errors": [{"control": "c_email", "message": "Email is too short"}]}
    names = [x["customer_name"] for x in client.get(f"/api/apps/{slug}/tables/customers/records", headers=BOB).json()["records"]]
    assert "Dahlia" not in names


def test_a_missing_required_value_is_reported_after_the_rule_errors(client):
    slug, _ = publish(client)
    r = save(client, slug, "CustomerForm", {"email": "ab"})
    assert r.status_code == 422
    assert [e["message"] for e in r.json()["errors"]] == ["Email is too short", "Name is required"]
    assert [e["control"] for e in r.json()["errors"]] == ["c_email", "c_name"]


def test_a_field_the_form_does_not_have_is_refused(client):
    slug, _ = publish(client)
    r = save(client, slug, "CustomerForm", {"customer_name": "x", "customerid": 99, "hacker": 1})
    assert r.status_code == 422 and r.json() == {"error": "unknown_fields", "fields": ["customerid", "hacker"]}


def test_a_hidden_control_is_not_checked(client):
    slug, _ = publish(client)
    r = save(client, slug, "CustomerForm", {"customer_name": "private", "email": "ab"})
    assert r.status_code == 201, "the email control is hidden for 'private', so its rule does not run"


def test_a_form_from_an_earlier_version_is_told_to_reload(client):
    slug, _ = publish(client)
    r = save(client, slug, "CustomerForm", {"customer_name": "x"}, version=0)
    assert r.status_code == 409 and r.json() == {"error": "version_changed", "current": 1}
    r = save(client, slug, "CustomerForm", {"customer_name": "x"}, version=2)
    assert r.status_code == 409, "a version from the future is also wrong"


def test_a_rule_on_an_empty_field_fails_because_null_comparisons_are_false(client):
    slug, _ = publish(client)
    r = save(client, slug, "OrderForm", {"customerid": 1})
    assert r.status_code == 422 and r.json()["errors"] == [{"control": "o_total", "message": "Total must not be negative"}]
    assert save(client, slug, "OrderForm", {"customerid": 1, "total": 5}).status_code == 201


def test_today_in_a_rule_uses_the_servers_date(client):
    slug, _ = publish(client)
    future = save(client, slug, "OrderForm", {"customerid": 1, "total": 1, "orderdate": "2999-01-01"})
    assert future.status_code == 422 and future.json()["errors"][0]["message"] == "Order date cannot be in the future"
    assert save(client, slug, "OrderForm", {"customerid": 1, "total": 1, "orderdate": "2020-01-01"}).status_code == 201


def test_the_database_still_enforces_its_own_rules_after_the_form_rules_pass(client):
    slug, _ = publish(client)
    r = save(client, slug, "OrderForm", {"customerid": 999, "total": 1})  # no such customer
    assert r.status_code == 409, "the foreign key refused it"


def test_update_through_a_form_applies_the_rules(client):
    slug, _ = publish(client)
    assert save(client, slug, "CustomerForm", {"customer_name": "Acme 2", "email": "acme@x.test"}, key=1).json()["customer_name"] == "Acme 2"
    bad = save(client, slug, "CustomerForm", {"customer_name": "Acme 3", "email": "no"}, key=1)
    assert bad.status_code == 422
    assert client.get(f"/api/apps/{slug}/tables/customers/records/1", headers=BOB).json()["customer_name"] == "Acme 2", "the failed save changed nothing"
    assert save(client, slug, "CustomerForm", {"customer_name": "x"}, key=9999).status_code == 404


# ---- permissions
def test_saving_needs_edit_data_on_the_form(client):
    slug, _ = publish(client)
    for who in (BOB, EVE, OWNER):
        assert save(client, slug, "CustomerForm", {"customer_name": "x"}, who=who).status_code == 403
    assert save(client, slug, "CustomerForm", {"customer_name": "x"}, who=CARA).status_code == 201


def test_a_permission_failure_is_reported_before_a_stale_version(client):
    slug, _ = publish(client)
    r = save(client, slug, "CustomerForm", {"customer_name": "x"}, who=EVE, version=0)
    assert r.status_code == 403, "a person with no permission learns nothing about versions"


def test_a_grant_on_the_form_replaces_the_application_grants_for_that_form(client):
    grants = [grant("dan", "edit_data"), grant("dan", "view_data", "form", "CustomerForm"),   # app edit, but form view only
              grant("fay", "edit_data", "form", "CustomerForm")]                               # form edit only
    slug, _ = publish(client, grants=grants)
    dan, fay = hdr("dan"), hdr("fay")
    assert save(client, slug, "CustomerForm", {"customer_name": "x"}, who=dan).status_code == 403, "the form grant replaces the application grant"
    assert save(client, slug, "OrderForm", {"customerid": 1, "total": 1}, who=dan).status_code == 201, "other forms still use the application grant"
    assert save(client, slug, "CustomerForm", {"customer_name": "x"}, who=fay).status_code == 201
    assert save(client, slug, "OrderForm", {"customerid": 1, "total": 1}, who=fay).status_code == 403, "fay has no grant on the other form"
    assert client.get(f"/api/apps/{slug}/tables/customers/records", headers=fay).status_code == 403, "and none on the table"


def test_the_form_list_shows_only_forms_the_user_may_view(client):
    grants = [grant("gus", "view_data", "form", "OrderForm"), grant("gus", "open_application")]
    slug, _ = publish(client, grants=grants)
    assert [f["name"] for f in client.get(f"/api/apps/{slug}", headers=hdr("gus")).json()["forms"]] == ["OrderForm"]
    assert client.get(f"/api/apps/{slug}/forms/CustomerForm", headers=hdr("gus")).status_code == 403


# ---- saves must go through a form
def test_a_table_with_a_form_cannot_be_created_in_or_updated_through_the_table_routes(client):
    slug, _ = publish(client)
    created = client.post(f"/api/apps/{slug}/tables/customers/records", headers=CARA, json={"customer_name": "Zed", "email": "ab"})
    assert created.status_code == 409
    assert created.json()["error"] == "form_required" and created.json()["forms"] == ["CustomerForm"]
    assert "CustomerForm" in created.json()["detail"], "the message says where to go"
    updated = client.put(f"/api/apps/{slug}/tables/customers/records/1", headers=CARA, json={"email": "ab"})
    assert updated.status_code == 409 and updated.json()["error"] == "form_required"
    names = [x["customer_name"] for x in client.get(f"/api/apps/{slug}/tables/customers/records", headers=BOB).json()["records"]]
    assert "Zed" not in names and "Acme" in names, "nothing was written"
    # the same record through the form is checked
    assert save(client, slug, "CustomerForm", {"customer_name": "Zed", "email": "ab"}).status_code == 422


def test_a_table_without_a_form_is_still_written_through_the_table_routes(client):
    slug, _ = publish(client, forms=[CUSTOMER_FORM])  # no form for orders
    r = client.post(f"/api/apps/{slug}/tables/orders/records", headers=CARA, json={"customerid": 1, "total": 5})
    assert r.status_code == 201
    assert client.put(f"/api/apps/{slug}/tables/orders/records/{r.json()['orderid']}", headers=CARA, json={"total": 6}).status_code == 200


def test_an_application_with_no_forms_behaves_as_before(client):
    slug, _ = publish(client, forms=[])
    assert client.post(f"/api/apps/{slug}/tables/customers/records", headers=CARA, json={"customer_name": "Zed"}).status_code == 201


def test_reads_and_deletes_are_not_affected(client):
    slug, _ = publish(client, grants=[*BASE_GRANTS, grant("dee", "delete_data"), grant("dee", "view_data")])
    dee = hdr("dee")
    made = save(client, slug, "CustomerForm", {"customer_name": "Gone"}).json()
    assert client.get(f"/api/apps/{slug}/tables/customers/records/{made['customerid']}", headers=BOB).status_code == 200
    assert client.delete(f"/api/apps/{slug}/tables/customers/records/{made['customerid']}", headers=dee).status_code == 204


def test_a_person_without_edit_data_gets_the_plain_refusal_and_learns_nothing_about_forms(client):
    slug, _ = publish(client)
    for who in (BOB, EVE):
        r = client.post(f"/api/apps/{slug}/tables/customers/records", headers=who, json={"customer_name": "x"})
        assert r.status_code == 403 and "form" not in json_text(r), f"{who}: {r.text}"


def json_text(r) -> str:
    return r.text.lower()


def test_every_form_on_the_table_is_named(client):
    second = {**CUSTOMER_FORM, "name": "CustomerQuickForm", "title": "Quick add"}
    slug, r = publish(client, forms=[CUSTOMER_FORM, second])
    assert r.status_code == 200, r.text
    res = client.post(f"/api/apps/{slug}/tables/customers/records", headers=CARA, json={"customer_name": "x"})
    assert res.status_code == 409 and res.json()["forms"] == ["CustomerForm", "CustomerQuickForm"]


def test_a_person_with_only_table_edit_data_and_no_form_access_cannot_write(client):
    """Edit data on the table is not enough once the table has a form. The person needs edit data on the form, which an
    application-level grant gives. A grant on the table alone does not."""
    slug, _ = publish(client, grants=[grant("tim", "edit_data", "table", "customers")])
    assert client.post(f"/api/apps/{slug}/tables/customers/records", headers=hdr("tim"), json={"customer_name": "x"}).status_code == 409
    assert save(client, slug, "CustomerForm", {"customer_name": "x"}, who=hdr("tim")).status_code == 403
