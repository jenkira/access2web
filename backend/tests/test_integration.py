import uuid

import psycopg
import pytest

from conftest import ADMIN, AUDITOR, OWNER, hdr, sample

BOB = hdr("bob")
CARA = hdr("cara", groups="sales")


def publish(client, slug=None, data=None, grants=(), classification="personal", confirm=True):
    slug = slug or "app_" + uuid.uuid4().hex[:8]
    r = client.post("/api/authoring/import-jobs", json=data or sample(), headers=OWNER)
    assert r.status_code == 200, r.text
    job = r.json()["job"]
    r = client.post(f"/api/authoring/import-jobs/{job}/publish", headers=OWNER, json={
        "slug": slug, "name": "Sales " + slug, "description": "d", "confirmed_classification": classification,
        "permissions_confirmed": confirm, "grants": list(grants)})
    return slug, job, r


def grant(subject_type, subject_id, level, resource_type="application", resource_id=""):
    return {"subject_type": subject_type, "subject_id": subject_id, "level": level,
            "resource_type": resource_type, "resource_id": resource_id}


def test_unauthenticated_gets_401(client):
    assert client.get("/api/portal/tiles").status_code == 401


def test_report_lists_every_object(client):
    r = client.post("/api/authoring/import-jobs", json=sample(), headers=OWNER)
    body = r.json()
    names = {(i["object_type"], i["name"]) for i in body["items"]}
    assert ("procedure", "Form_frmCustomer.cmdMail_Click (belongs to cmdMail)") in names
    manual = [i for i in body["items"] if i["vba_class"] == "manual_redesign"]
    assert manual and manual[0]["suggestion"]
    assert body["summary"]["total"] == len(body["items"])
    assert body["classification"]["suggested"] == "personal"


def test_only_app_owners_can_upload(client):
    assert client.post("/api/authoring/import-jobs", json=sample(), headers=BOB).status_code == 403


def test_publish_requires_confirmations(client):
    _, _, r = publish(client, confirm=False)
    assert r.status_code == 400 and "permissions" in r.json()["detail"]
    _, _, r = publish(client, classification="")
    assert r.status_code == 400 and "classification" in r.json()["detail"]


def test_publish_end_to_end_with_default_deny(client):
    slug, job, r = publish(client, grants=[grant("user", "bob", "view_data")])
    assert r.status_code == 200, r.text
    base = f"/api/apps/{slug}/tables"

    # the owner has manage; manage does not include data access
    assert client.get(f"{base}/customers/records", headers=OWNER).status_code == 403
    # bob can view but not edit or delete
    rows = client.get(f"{base}/customers/records", headers=BOB).json()["records"]
    assert [r["customer_name"] for r in rows] == ["Acme", "Birch"]
    assert client.post(f"{base}/customers/records", headers=BOB, json={"customer_name": "x"}).status_code == 403
    assert client.delete(f"{base}/customers/records/1", headers=BOB).status_code == 403
    # a stranger sees nothing, and gets the same answer for a missing app
    stranger = client.get(f"{base}/customers/records", headers=hdr("eve"))
    missing = client.get("/api/apps/nope/tables/customers/records", headers=hdr("eve"))
    assert stranger.status_code == missing.status_code == 403
    assert stranger.json() == missing.json()


def test_portal_tiles_follow_grants(client):
    slug, _, _ = publish(client, grants=[grant("group", "sales", "view_data")])
    assert slug in [t["slug"] for t in client.get("/api/portal/tiles", headers=CARA).json()]
    assert slug not in [t["slug"] for t in client.get("/api/portal/tiles", headers=hdr("eve")).json()]


def test_crud_and_audit_old_new_values(client):
    slug, _, _ = publish(client, grants=[grant("user", "bob", "edit_data"), grant("user", "bob", "delete_data")])
    base = f"/api/apps/{slug}/tables/customers/records"
    r = client.post(base, headers=BOB, json={"customer_name": "Cedar"})
    assert r.status_code == 201, r.text
    new = r.json()
    assert new["customerid"] == 3  # identity sequence continues above migrated ids
    assert client.put(f"{base}/3", headers=BOB, json={"customer_name": "Cedar 2"}).json()["customer_name"] == "Cedar 2"
    assert client.get(f"{base}/3", headers=BOB).json()["customer_name"] == "Cedar 2"
    assert client.delete(f"{base}/3", headers=BOB).status_code == 204
    assert client.get(f"{base}/3", headers=BOB).status_code == 404

    ev = client.get(f"/api/audit?app={slug}", headers=AUDITOR).json()
    changes = [e for e in ev if e["object"] == "customers" and e["action"] in ("insert", "update", "delete")]
    assert [e["action"] for e in reversed(changes)] == ["insert", "update", "delete"]
    assert all(e["actor"] == "bob" for e in changes)
    upd = next(e for e in changes if e["action"] == "update")
    assert upd["detail"]["old"]["customer_name"] == "Cedar" and upd["detail"]["new"]["customer_name"] == "Cedar 2"
    # migration itself does not flood the log with one row per migrated record
    assert not [e for e in ev if e["action"] == "insert" and e["detail"]["new"].get("customer_name") == "Acme"]
    assert client.get("/api/audit/verify", headers=AUDITOR).json()["intact"] is True


def test_constraint_and_type_errors_are_clean(client):
    slug, _, _ = publish(client, grants=[grant("user", "bob", "edit_data")])
    base = f"/api/apps/{slug}/tables/customers/records"
    assert client.post(base, headers=BOB, json={}).status_code == 400  # no fields
    assert client.post(base, headers=BOB, json={"email": "x"}).status_code == 409  # required name missing
    assert client.post(base, headers=BOB, json={"customer_name": "x", "bogus": 1}).status_code == 400
    assert client.post(base, headers=BOB, json={"customer_name": "y" * 51}).status_code == 400  # too long
    orders = f"/api/apps/{slug}/tables/orders/records"
    assert client.post(orders, headers=BOB, json={"customerid": 999}).status_code == 409  # foreign key


def test_sql_injection_in_field_names_is_rejected(client):
    slug, _, _ = publish(client, grants=[grant("user", "bob", "edit_data")])
    base = f"/api/apps/{slug}/tables/customers/records"
    assert client.post(base, headers=BOB, json={'customer_name"; drop table x; --': "1"}).status_code == 400
    assert client.get(f'/api/apps/{slug}/tables/customers"/records', headers=BOB).status_code == 403
    assert client.get(f"{base}/1%20or%201=1", headers=BOB).status_code in (400, 404)


def test_object_level_override(client):
    slug, _, _ = publish(client, grants=[grant("user", "bob", "edit_data"),
                                         grant("user", "bob", "view_data", "table", "orders")])
    assert client.post(f"/api/apps/{slug}/tables/customers/records", headers=BOB,
                       json={"customer_name": "ok"}).status_code == 201
    assert client.get(f"/api/apps/{slug}/tables/orders/records", headers=BOB).status_code == 200
    assert client.post(f"/api/apps/{slug}/tables/orders/records", headers=BOB, json={"customerid": 1}).status_code == 403


def test_permission_changes_apply_without_new_sign_in(client):
    slug, _, _ = publish(client)
    base = f"/api/apps/{slug}/tables/customers/records"
    assert client.get(base, headers=BOB).status_code == 403
    r = client.post(f"/api/apps/{slug}/grants", headers=OWNER, json=grant("user", "bob", "view_data"))
    assert r.status_code == 201
    assert client.get(base, headers=BOB).status_code == 200
    gid = next(g["id"] for g in client.get(f"/api/apps/{slug}/grants", headers=OWNER).json() if g["subject_id"] == "bob")
    assert client.delete(f"/api/apps/{slug}/grants/{gid}", headers=OWNER).status_code == 200
    assert client.get(base, headers=BOB).status_code == 403
    actions = [e["action"] for e in client.get(f"/api/audit?app={slug}", headers=AUDITOR).json()]
    assert "grant" in actions and "revoke" in actions


def test_only_managers_change_permissions(client):
    slug, _, _ = publish(client, grants=[grant("user", "bob", "design_application")])
    g = grant("user", "eve", "view_data")
    assert client.post(f"/api/apps/{slug}/grants", headers=BOB, json=g).status_code == 403  # design is not manage
    assert client.post(f"/api/apps/{slug}/grants", headers=hdr("eve"), json=g).status_code == 403
    assert client.post(f"/api/apps/{slug}/grants", headers=ADMIN, json=g).status_code == 201
    assert client.post(f"/api/apps/{slug}/grants", headers=OWNER, json=grant("user", "x", "root")).status_code == 400


def test_unpublish_hides_app(client):
    slug, _, _ = publish(client, grants=[grant("user", "bob", "view_data")])
    assert client.post(f"/api/apps/{slug}/unpublish", headers=BOB).status_code == 403
    assert client.post(f"/api/apps/{slug}/unpublish", headers=OWNER).status_code == 200
    assert client.get(f"/api/apps/{slug}/tables/customers/records", headers=BOB).status_code == 403
    assert slug not in [t["slug"] for t in client.get("/api/portal/tiles", headers=BOB).json()]


def test_orphan_rows_are_reported_not_dropped(client):
    slug, job, r = publish(client, data=sample(orphan=True), grants=[grant("user", "bob", "edit_data")])
    assert r.status_code == 200, r.text
    rows = client.get(f"/api/apps/{slug}/tables/orders/records", headers=BOB).json()["records"]
    assert len(rows) == 3  # orphan row kept
    items = client.get(f"/api/authoring/import-jobs/{job}/report", headers=OWNER).json()["items"]
    orphan = [i for i in items if i["object_type"] == "relationship" and "orphan" in i["reason"]]
    assert orphan and "1 orphan" in orphan[0]["reason"]


def test_failed_publish_leaves_nothing_behind(client, db_url):
    bad = sample()
    bad["tables"][0]["rows"].append({"CustomerID": 1, "Customer Name": "dup"})  # duplicate key
    slug, job, r = publish(client, data=bad)
    assert r.status_code == 400 and "duplicate key" in r.json()["detail"]
    with psycopg.connect(db_url) as c:
        assert c.execute("select count(*) from a2w_control.applications where slug = %s", (slug,)).fetchone()[0] == 0
        assert c.execute("select count(*) from information_schema.schemata where schema_name = %s", ("app_" + slug,)).fetchone()[0] == 0
        assert c.execute("select status from a2w_control.import_jobs where id = %s", (job,)).fetchone()[0] == "analysed"


def test_slug_is_validated(client):
    _, _, r = publish(client, slug="Bad Slug; drop")
    assert r.status_code == 400


def test_apps_are_isolated(client, db_url):
    a, _, _ = publish(client, grants=[grant("user", "bob", "view_data")])
    b, _, _ = publish(client, grants=[grant("user", "bob", "view_data")])
    with psycopg.connect(db_url) as c:
        c.execute(f'set role "app_{a}"')
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute(f'select * from "app_{b}".customers')
        c.rollback()
        c.execute(f'set role "app_{a}"')
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("select * from a2w_control.audit_events")


# ---- audit store ----
def test_audit_is_append_only_and_tamper_evident(client, db_url):
    publish(client)
    with psycopg.connect(db_url, autocommit=True) as c:
        for stmt in ("update a2w_control.audit_events set actor = 'x'", "delete from a2w_control.audit_events",
                     "truncate a2w_control.audit_events"):
            with pytest.raises(psycopg.errors.RaiseException):
                c.execute(stmt)
        assert c.execute("select a2w_control.audit_verify()").fetchone()[0] is None
        # a database owner who disables the trigger can still change a row, and the chain shows it
        c.execute("alter table a2w_control.audit_events disable trigger audit_no_change")
        seq = c.execute("select min(seq) from a2w_control.audit_events where seq > 1").fetchone()[0]
        c.execute("update a2w_control.audit_events set actor = 'mallory' where seq = %s", (seq,))
        assert c.execute("select a2w_control.audit_verify()").fetchone()[0] == seq
        c.execute("update a2w_control.audit_events set actor = 'olive' where seq = %s", (seq,))
        c.execute("alter table a2w_control.audit_events enable trigger audit_no_change")
        assert c.execute("select a2w_control.audit_verify()").fetchone()[0] is None


def test_record_change_needs_user_context(client, db_url):
    slug, _, _ = publish(client)
    with psycopg.connect(db_url) as c:
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute(f'insert into "app_{slug}".customers (customer_name) values (\'x\')')


def test_audit_access_is_restricted(client):
    assert client.get("/api/audit", headers=BOB).status_code == 403
    assert client.get("/api/audit/verify", headers=OWNER).status_code == 403
    assert client.get("/api/audit", headers=AUDITOR).status_code == 200


def test_duplicate_slug_is_rejected(client):
    slug, _, _ = publish(client)
    _, _, r = publish(client, slug=slug)
    assert r.status_code == 400 and "already exists" in r.json()["detail"]
