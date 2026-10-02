"""Publishing a new version: renames are carried to the data, the forms are replaced, and nothing is half applied."""
import copy
import json
import threading

import psycopg
import pytest
from psycopg.rows import dict_row

from a2w import authz, publish as pub, runtime
from a2w.migrate import Rename
from conftest import AUDITOR, OWNER, hdr
from test_forms_api import BASE_GRANTS, BOB, CARA, CUSTOMER_FORM, ORDER_FORM, grant, publish, save

DESIGNER = hdr("dee")
FORMS = [CUSTOMER_FORM, ORDER_FORM]


def field(entity, old, new):
    return {"kind": "field", "entity": entity, "from": old, "to": new}


def entity(old, new):
    return {"kind": "entity", "from": old, "to": new}


def republish(client, slug, renames=(), forms=None, base_version=1, who=OWNER):
    body = {"base_version": base_version, "renames": list(renames)}
    if forms is not None:
        body["forms"] = forms
    return client.post(f"/api/apps/{slug}/versions", headers=who, json=body)


def renamed_forms(old, new):
    """The forms as the editor would send them after the rename: the text of every rule and binding changed."""
    return [json.loads(json.dumps(f).replace(old, new)) for f in FORMS]


def state(db_url, slug):
    """What the database holds: the columns of each table, the current version, and the number of versions."""
    with psycopg.connect(db_url, row_factory=dict_row) as c:
        cols = {}
        for r in c.execute("select table_name, column_name from information_schema.columns where table_schema = %s "
                           "order by table_name, ordinal_position", ("app_" + slug,)):
            cols.setdefault(r["table_name"], []).append(r["column_name"])
        app = c.execute("select id, current_version from a2w_control.applications where slug = %s", (slug,)).fetchone()
        n = c.execute("select count(*) as n from a2w_control.app_versions where app_id = %s", (app["id"],)).fetchone()["n"]
        return {"columns": cols, "version": app["current_version"], "versions": n}


def definition(db_url, slug, version):
    with psycopg.connect(db_url, row_factory=dict_row) as c:
        return c.execute("select v.definition from a2w_control.app_versions v join a2w_control.applications a on a.id = v.app_id "
                         "where a.slug = %s and v.version = %s", (slug, version)).fetchone()["definition"]


def customers(client, slug):
    return client.get(f"/api/apps/{slug}/tables/customers/records", headers=BOB).json()["records"]


# ---- renaming a field
def test_a_renamed_field_keeps_its_data_and_the_form_saves_under_the_new_name(client, db_url):
    slug, _ = publish(client)
    before = {r["customer_name"]: r["email"] for r in customers(client, slug)}
    r = republish(client, slug, [field("customers", "email", "mail")], renamed_forms("email", "mail"))
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2 and r.json()["migration"] == [f'alter table "app_{slug}"."customers" rename column "email" to "mail"']
    cols = state(db_url, slug)["columns"]["customers"]
    assert "mail" in cols and "email" not in cols
    assert {x["customer_name"]: x["mail"] for x in customers(client, slug)} == before, "no value was lost or moved"
    ok = save(client, slug, "CustomerForm", {"customer_name": "Zed", "mail": "zed@x.test"}, version=2)
    assert ok.status_code == 201, ok.text
    old = save(client, slug, "CustomerForm", {"customer_name": "Yan", "email": "y@x.test"}, version=2)
    assert old.status_code == 422, "the old name is no longer a field of the form"
    assert save(client, slug, "CustomerForm", {"customer_name": "Xi", "mail": "ab"}, version=2).status_code == 422, "the rule still applies"


def test_the_definition_follows_a_field_rename_in_keys_indexes_and_relationships(client, db_url):
    slug, _ = publish(client)
    assert republish(client, slug, [field("customers", "customer_name", "title"), field("customers", "customerid", "id")],
                     renamed_forms("customer_name", "title")).status_code == 200
    d = definition(db_url, slug, 2)
    cust = next(e for e in d["entities"] if e["name"] == "customers")
    orders = next(e for e in d["entities"] if e["name"] == "orders")
    assert cust["primary_key"] == ["id"]
    assert cust["indexes"][0]["columns"] == ["title"]
    assert orders["foreign_keys"][0]["ref_columns"] == ["id"], "another entity's relationship follows the renamed column"
    assert d["version"] == 2
    # the database still enforces the relationship on the renamed key
    with psycopg.connect(db_url) as c:
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            c.execute(f'insert into "app_{slug}".orders (customerid, total) values (12345, 1)')


def test_a_key_column_can_be_renamed_and_records_are_found_by_the_new_name(client):
    slug, _ = publish(client, forms=[ORDER_FORM])
    assert republish(client, slug, [field("customers", "customerid", "id")], forms=[ORDER_FORM]).status_code == 200
    rows = customers(client, slug)
    assert [r["id"] for r in rows] == [1, 2] and all("customerid" not in r for r in rows)
    assert client.get(f"/api/apps/{slug}/tables/customers/records/2", headers=BOB).json()["customer_name"] == "Birch"


# ---- renaming an entity
def test_a_renamed_entity_keeps_its_data_and_its_table_grants(client, db_url):
    slug, _ = publish(client, forms=[ORDER_FORM], grants=[*BASE_GRANTS, grant("tim", "view_data", "table", "customers")])
    tim = hdr("tim")
    assert client.get(f"/api/apps/{slug}/tables/customers/records", headers=tim).status_code == 200
    r = republish(client, slug, [entity("customers", "clients")], forms=[ORDER_FORM])
    assert r.status_code == 200, r.text
    assert "clients" in state(db_url, slug)["columns"] and "customers" not in state(db_url, slug)["columns"]
    rows = client.get(f"/api/apps/{slug}/tables/clients/records", headers=tim)
    assert rows.status_code == 200 and [x["customer_name"] for x in rows.json()["records"]] == ["Acme", "Birch"]
    assert client.get(f"/api/apps/{slug}/tables/customers/records", headers=tim).status_code == 403, "the old name is gone"
    # the table grant did not lapse into the application grants: bob (view_data, application) still reads, tim still only reads
    assert client.get(f"/api/apps/{slug}/tables/clients/records", headers=BOB).status_code == 200
    assert client.post(f"/api/apps/{slug}/tables/clients/records", headers=tim, json={"customer_name": "x"}).status_code == 403
    d = definition(db_url, slug, 2)
    assert next(e for e in d["entities"] if e["name"] == "orders")["foreign_keys"][0]["ref_entity"] == "clients"


def test_an_entity_rename_is_refused_while_a_form_still_names_the_old_entity(client, db_url):
    slug, _ = publish(client)
    before = state(db_url, slug)
    r = republish(client, slug, [entity("customers", "clients")])  # forms=None keeps CustomerForm, which names customers
    assert r.status_code == 400 and "unknown entity customers" in r.json()["detail"], r.text
    assert state(db_url, slug) == before, "nothing was changed"
    forms = [{**CUSTOMER_FORM, "entity": "clients"}, ORDER_FORM]
    assert republish(client, slug, [entity("customers", "clients")], forms).status_code == 200


def test_renames_apply_in_order_so_a_later_one_can_use_the_new_name(client, db_url):
    slug, _ = publish(client, forms=[ORDER_FORM])
    r = republish(client, slug, [entity("customers", "clients"), field("clients", "email", "mail")], forms=[ORDER_FORM])
    assert r.status_code == 200, r.text
    assert state(db_url, slug)["columns"]["clients"].count("mail") == 1


# ---- refusals leave nothing half done
@pytest.mark.parametrize("renames,expected", [
    ([field("customers", "email", "customer_name")], "already has a field customer_name"),
    ([field("customers", "nope", "x")], "unknown field nope"),
    ([field("nope", "email", "x")], "unknown entity nope"),
    ([entity("customers", "orders")], "entity orders already exists"),
    ([entity("nope", "x")], "unknown entity nope"),
    ([field("customers", "email", "email")], "already called email"),
    ([field("customers", "email", "Mail")], "not a valid name"),
    ([field("customers", "email", "1mail")], "not a valid name"),
    ([field("customers", "email", 'x"; drop table app_x.customers; --')], "not a valid name"),
    ([field("customers", "email", "a" * 64)], "not a valid name"),
    ([entity("customers", "")], "not a valid name"),
])
def test_a_rename_that_cannot_work_is_refused_and_changes_nothing(client, db_url, renames, expected):
    slug, _ = publish(client, forms=[ORDER_FORM])
    before = state(db_url, slug)
    r = republish(client, slug, renames, forms=[ORDER_FORM])
    assert r.status_code == 400 and expected in r.json()["detail"], r.text
    assert state(db_url, slug) == before


def test_when_a_later_rename_fails_the_earlier_ones_are_not_kept(client, db_url):
    slug, _ = publish(client, forms=[ORDER_FORM])
    before = state(db_url, slug)
    r = republish(client, slug, [field("customers", "email", "mail"), field("customers", "nope", "x")], forms=[ORDER_FORM])
    assert r.status_code == 400
    assert state(db_url, slug) == before and "email" in before["columns"]["customers"]


def test_a_rename_that_the_database_refuses_rolls_back_the_whole_version(client, db_url):
    slug, _ = publish(client, forms=[ORDER_FORM])
    # The definition does not know about this column, so only the database can refuse the second rename.
    with psycopg.connect(db_url, autocommit=True) as c:
        c.execute(f'alter table "app_{slug}".customers add column mail text')
    before = state(db_url, slug)
    r = republish(client, slug, [field("customers", "customer_name", "title"), field("customers", "email", "mail")], forms=[ORDER_FORM])
    assert r.status_code == 400 and "nothing was changed" in r.json()["detail"], r.text
    after = state(db_url, slug)
    assert after == before and "title" not in after["columns"]["customers"], "the first rename was rolled back with the second"


def test_a_version_that_changes_nothing_is_refused(client):
    slug, _ = publish(client)
    r = republish(client, slug)
    assert r.status_code == 400 and "nothing to publish" in r.json()["detail"]
    assert republish(client, slug, forms=FORMS).status_code == 400, "the same forms are not a change"


# ---- forms only
def test_a_version_can_replace_the_forms_without_touching_the_tables(client, db_url):
    slug, _ = publish(client)
    before = state(db_url, slug)["columns"]
    changed = copy.deepcopy(CUSTOMER_FORM)
    changed["rows"][1]["controls"][0]["validate"][0]["message"] = "Email needs at least 5 characters"
    r = republish(client, slug, forms=[changed, ORDER_FORM])
    assert r.status_code == 200 and r.json()["migration"] == [] and r.json()["version"] == 2
    assert state(db_url, slug)["columns"] == before
    bad = save(client, slug, "CustomerForm", {"customer_name": "Zed", "email": "ab"}, version=2)
    assert bad.status_code == 422 and "Email needs at least 5 characters" in bad.text


def test_a_form_with_a_rule_that_cannot_run_is_refused(client, db_url):
    slug, _ = publish(client)
    bad = copy.deepcopy(CUSTOMER_FORM)
    bad["rows"][0]["controls"][0]["bind"] = "no_such_field"
    r = republish(client, slug, forms=[bad, ORDER_FORM])
    assert r.status_code == 400 and r.json()["detail"].startswith("invalid forms:")
    assert state(db_url, slug)["version"] == 1


# ---- versions and permissions
def test_a_stale_base_version_is_refused_with_the_current_version(client):
    slug, _ = publish(client)
    assert republish(client, slug, [field("customers", "email", "mail")], renamed_forms("email", "mail")).status_code == 200
    r = republish(client, slug, [field("customers", "customer_name", "title")], renamed_forms("customer_name", "title"), base_version=1)
    assert r.status_code == 409 and r.json() == {"error": "version_changed", "current": 2}


def test_an_open_form_from_the_old_version_must_reload_after_a_rename(client):
    slug, _ = publish(client)
    assert republish(client, slug, [field("customers", "email", "mail")], renamed_forms("email", "mail")).status_code == 200
    r = save(client, slug, "CustomerForm", {"customer_name": "Zed", "email": "z@x.test"}, version=1)
    assert r.status_code == 409 and r.json()["error"] == "version_changed"


def test_design_can_edit_but_only_manage_can_publish_a_version(client, db_url):
    slug, _ = publish(client, grants=[*BASE_GRANTS, grant("dee", "design_application")])
    changed = copy.deepcopy(CUSTOMER_FORM)
    changed["title"] = "Customer details"
    for who in (DESIGNER, BOB, CARA, hdr("eve")):
        assert republish(client, slug, forms=[changed, ORDER_FORM], who=who).status_code == 403, who
    assert state(db_url, slug)["version"] == 1
    assert republish(client, slug, forms=[changed, ORDER_FORM], who=OWNER).status_code == 200
    changed_again = copy.deepcopy(changed)
    changed_again["title"] = "Customer record"
    assert republish(client, slug, forms=[changed_again, ORDER_FORM], who=hdr("ada", roles="platform_admin"),
                     base_version=2).status_code == 200, "an administrator can publish too"


def test_an_unknown_or_unpublished_application_is_refused_the_same_way(client):
    assert republish(client, "no_such_app", [field("customers", "email", "mail")]).status_code == 403
    slug, _ = publish(client)
    assert client.post(f"/api/apps/{slug}/unpublish", headers=OWNER).status_code == 200
    assert republish(client, slug, [field("customers", "email", "mail")]).status_code == 403


# ---- the audit log
def test_the_audit_log_records_the_version_and_keeps_its_chain_through_a_rename(client):
    slug, _ = publish(client, forms=[ORDER_FORM])
    made = client.post(f"/api/apps/{slug}/tables/customers/records", headers=CARA, json={"customer_name": "Old name"})
    assert made.status_code == 201, made.text  # a form exists only for orders, so customers is written through the table route
    assert republish(client, slug, [entity("customers", "clients")], forms=[ORDER_FORM]).status_code == 200
    again = client.post(f"/api/apps/{slug}/tables/clients/records", headers=CARA, json={"customer_name": "New name"})
    assert again.status_code == 201, again.text
    ev = client.get(f"/api/audit?app={slug}", headers=AUDITOR).json()
    published = [e for e in ev if e["action"] == "publish"]
    newest = published[0]
    assert newest["actor"] == "olive" and newest["detail"]["version"] == 2
    assert newest["detail"]["renames"] == [{"kind": "entity", "from": "customers", "to": "clients"}]
    assert [e["object"] for e in ev if e["action"] == "insert" and e["detail"]["new"].get("customer_name") == "New name"] == ["clients"]
    assert client.get("/api/audit/verify", headers=AUDITOR).json()["intact"] is True


# ---- requests in flight
def test_a_new_version_gives_up_cleanly_while_a_request_is_in_flight(client, db_url, monkeypatch):
    slug, _ = publish(client, forms=[ORDER_FORM])
    monkeypatch.setattr(pub, "LOCK_TIMEOUT", "300ms")
    with psycopg.connect(db_url, row_factory=dict_row) as in_flight:
        runtime.load_app(in_flight, slug)  # a request that has read the definition and has not finished
        r = republish(client, slug, [field("customers", "email", "mail")], forms=[ORDER_FORM])
        assert r.status_code == 409 and "in use" in r.json()["detail"], r.text
    assert state(db_url, slug)["version"] == 1 and "email" in state(db_url, slug)["columns"]["customers"]
    assert republish(client, slug, [field("customers", "email", "mail")], forms=[ORDER_FORM]).status_code == 200, "free again"


def test_a_request_that_starts_during_a_new_version_waits_and_reads_the_new_version(client, db_url):
    slug, _ = publish(client, forms=[ORDER_FORM])
    seen: dict = {}

    def reader():
        with psycopg.connect(db_url, row_factory=dict_row) as c:
            _, d = runtime.load_app(c, slug)
            seen["version"] = d.version
            seen["fields"] = [f.name for f in d.entity("customers").fields]
            # the definition and the table agree, so a query by the new name works
            seen["rows"] = c.execute(f'select mail from "app_{slug}".customers').fetchall()

    with psycopg.connect(db_url, row_factory=dict_row) as publisher:
        pub.republish(publisher, slug, authz.Identity("olive", roles=("app_owner",)), base_version=1,
                      renames=[Rename.model_validate(field("customers", "email", "mail"))], forms=[ORDER_FORM])
        t = threading.Thread(target=reader)
        t.start()
        t.join(0.5)
        assert t.is_alive(), "the request waits while the new version is being published"
        assert not seen
    t.join(10)  # the publisher's transaction has committed
    assert not t.is_alive() and seen["version"] == 2 and "mail" in seen["fields"] and "email" not in seen["fields"]
    assert len(seen["rows"]) == 2
