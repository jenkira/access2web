"""A saved draft with a lock: take it, save to it, resume it, lose it, and publish from it."""
import json
import threading

import psycopg
import pytest
from psycopg.rows import dict_row

from a2w import authz, drafts
from conftest import AUDITOR, OWNER, hdr
from test_forms_api import BASE_GRANTS, BOB, CARA, CUSTOMER_FORM, ORDER_FORM, grant, publish

DEE, DAN, MIA = hdr("dee"), hdr("dan"), hdr("mia")
GRANTS = [*BASE_GRANTS, grant("dee", "design_application"), grant("dan", "design_application"), grant("mia", "manage_application")]
LOG = [{"t": "setLabel", "form": "CustomerForm", "id": "c_name", "label": "Full name"}]


def app(client):
    slug, r = publish(client, grants=GRANTS)
    assert r.status_code == 200, r.text
    return slug


def lock(client, slug, who=DEE):
    return client.post(f"/api/apps/{slug}/draft/lock", headers=who)


def save(client, slug, log=LOG, who=DEE):
    return client.put(f"/api/apps/{slug}/draft", headers=who, json={"log": log})


def view(client, slug, who=DEE):
    return client.get(f"/api/apps/{slug}/draft", headers=who)


def discard(client, slug, who=DEE):
    return client.delete(f"/api/apps/{slug}/draft", headers=who)


def sql(db_url, query, *args):
    with psycopg.connect(db_url, autocommit=True, row_factory=dict_row) as c:
        cur = c.execute(query, args)
        return cur.fetchall() if cur.description else None


def lapse(db_url, slug):
    sql(db_url, "update a2w_control.drafts set expires_at = now() - interval '1 second' "
                "where app_id = (select id from a2w_control.applications where slug = %s)", slug)


# ---- take, save, resume
def test_taking_the_lock_starts_an_empty_draft_at_the_current_version(client):
    slug = app(client)
    r = lock(client, slug)
    assert r.status_code == 200, r.text
    assert r.json()["base_version"] == 1 and r.json()["log"] == [] and r.json()["expires_at"]
    mine = view(client, slug).json()
    assert mine["current_version"] == 1
    assert mine["draft"]["locked_by"] == "dee" and mine["draft"]["mine"] is True and mine["draft"]["log"] == []
    assert view(client, slug, hdr("dan")).json()["draft"]["mine"] is False


def test_a_saved_draft_comes_back_when_the_holder_takes_the_lock_again(client):
    slug = app(client)
    lock(client, slug)
    r = save(client, slug)
    assert r.status_code == 200 and r.json()["saved"] == 1 and r.json()["stale"] is False
    again = lock(client, slug)  # a reload, or another browser
    assert again.status_code == 200 and again.json()["log"] == LOG and again.json()["base_version"] == 1
    assert view(client, slug).json()["draft"]["log"] == LOG


def test_a_save_replaces_the_log_and_extends_the_lease(client, db_url):
    slug = app(client)
    lock(client, slug)
    sql(db_url, "update a2w_control.drafts set expires_at = now() + interval '5 seconds' where app_id = (select id from a2w_control.applications where slug = %s)", slug)
    soon = view(client, slug).json()["draft"]["expires_at"]
    assert save(client, slug, LOG + LOG).status_code == 200
    d = view(client, slug).json()["draft"]
    assert d["expires_at"] > soon and len(d["log"]) == 2
    assert save(client, slug, []).status_code == 200 and view(client, slug).json()["draft"]["log"] == []


def test_taking_the_lock_again_extends_the_lease(client, db_url):
    slug = app(client)
    lock(client, slug)
    sql(db_url, "update a2w_control.drafts set expires_at = now() + interval '5 seconds' where app_id = (select id from a2w_control.applications where slug = %s)", slug)
    assert lock(client, slug).status_code == 200
    assert sql(db_url, "select expires_at > now() + interval '10 minutes' as long from a2w_control.drafts "
                       "where app_id = (select id from a2w_control.applications where slug = %s)", slug)[0]["long"]


# ---- the lock
def test_someone_else_is_told_who_holds_the_draft_and_cannot_touch_it(client):
    slug = app(client)
    lock(client, slug)
    save(client, slug)
    for r in (lock(client, slug, DAN), save(client, slug, [], DAN), discard(client, slug, DAN)):
        assert r.status_code == 409, r.text
        assert r.json()["error"] == "draft_locked" and r.json()["locked_by"] == "dee" and r.json()["expires_at"]
    seen = view(client, slug, DAN).json()["draft"]
    assert seen["locked_by"] == "dee" and seen["mine"] is False and "log" not in seen, "the edits go only to the holder"
    assert view(client, slug).json()["draft"]["log"] == LOG, "nothing of dee's was changed"


def test_a_save_without_a_draft_is_refused(client):
    slug = app(client)
    r = save(client, slug)
    assert r.status_code == 409 and r.json()["error"] == "no_draft"


def test_manage_can_discard_an_active_draft_and_the_holder_then_loses_it(client):
    slug = app(client)
    lock(client, slug)
    save(client, slug)
    assert discard(client, slug, MIA).json() == {"discarded": True}
    assert view(client, slug).json()["draft"] is None
    assert save(client, slug).json()["error"] == "no_draft"
    assert lock(client, slug, DAN).status_code == 200
    assert save(client, slug, [], DEE).json()["error"] == "draft_locked", "the old holder cannot save over the new one"


def test_the_holder_can_discard_their_own_draft_and_discarding_nothing_is_harmless(client):
    slug = app(client)
    assert discard(client, slug).json() == {"discarded": False}
    lock(client, slug)
    assert discard(client, slug).json() == {"discarded": True} and view(client, slug).json()["draft"] is None


# ---- the lease
def test_a_lapsed_draft_can_be_taken_over_and_the_old_log_is_dropped(client, db_url):
    slug = app(client)
    lock(client, slug)
    save(client, slug)
    lapse(db_url, slug)
    assert view(client, slug, DAN).json()["draft"]["expired"] is True
    r = lock(client, slug, DAN)
    assert r.status_code == 200 and r.json()["log"] == [] and r.json()["base_version"] == 1
    assert save(client, slug, [], DEE).json()["error"] == "draft_locked", "the earlier holder is told they lost it"
    events = [(e["actor"], e["action"], e["detail"]) for e in client.get(f"/api/audit?app={slug}", headers=AUDITOR).json() if e["action"].startswith("draft_")]
    assert ("dan", "draft_taken_over", {"from": "dee", "base_version": 1}) in events


def test_anyone_with_design_can_discard_a_lapsed_draft(client, db_url):
    slug = app(client)
    lock(client, slug)
    lapse(db_url, slug)
    assert discard(client, slug, DAN).json() == {"discarded": True}


def test_the_holder_can_still_save_after_their_own_lease_lapsed_if_nobody_took_it(client, db_url):
    slug = app(client)
    lock(client, slug)
    lapse(db_url, slug)
    assert save(client, slug).status_code == 200 and view(client, slug).json()["draft"]["expired"] is False


def test_only_one_of_many_simultaneous_lockers_gets_the_draft(client, db_url):
    slug = app(client)
    results, barrier = [], threading.Barrier(8)

    def go(n):
        ident = authz.Identity(f"d{n}", roles=())
        with psycopg.connect(db_url, row_factory=dict_row) as c:
            sql_grant = "insert into a2w_control.grants(app_id, subject_type, subject_id, resource_type, resource_id, level, granted_by) " \
                        "select id, 'user', %s, 'application', '', 'design_application', 'test' from a2w_control.applications where slug = %s"
            c.execute(sql_grant, (ident.user_id, slug))
            c.commit()
            barrier.wait()
            try:
                drafts.lock(c, slug, ident); c.commit(); results.append("won")
            except drafts.DraftLocked as e:
                c.rollback(); results.append(("locked", e.locked_by))

    threads = [threading.Thread(target=go, args=(n,)) for n in range(8)]
    [t.start() for t in threads]; [t.join(20) for t in threads]
    assert results.count("won") == 1 and len(results) == 8, results
    holder = sql(db_url, "select locked_by from a2w_control.drafts where app_id = (select id from a2w_control.applications where slug = %s)", slug)[0]["locked_by"]
    assert all(r == ("locked", holder) for r in results if r != "won"), "the others were all told the same holder"


# ---- who may use drafts
@pytest.mark.parametrize("who", [BOB, CARA, hdr("eve")], ids=["view", "edit", "nobody"])
def test_data_access_without_design_cannot_use_drafts(client, who):
    slug = app(client)
    for r in (view(client, slug, who), lock(client, slug, who), save(client, slug, [], who), discard(client, slug, who)):
        assert r.status_code == 403, r.text
    assert view(client, slug).json()["draft"] is None


def test_design_manage_and_an_administrator_can_hold_a_draft_and_an_unknown_application_is_refused(client):
    slug = app(client)
    for who in (DEE, OWNER, hdr("ada", roles="platform_admin")):
        assert lock(client, slug, who).status_code == 200, who
        assert discard(client, slug, who).status_code == 200
    assert lock(client, "no_such_app").status_code == 403


# ---- what a log may be
@pytest.mark.parametrize("body,status", [
    ({"log": "x"}, 422), ({"log": [1]}, 422), ({}, 422),
    ({"log": [{"no_type": 1}]}, 400), ({"log": [{"t": 5}]}, 400),
    ({"log": [{"t": "setLabel"}] * (drafts.MAX_OPS + 1)}, 400),
    ({"log": [{"t": "setLabel", "label": "x" * (drafts.MAX_BYTES + 1)}]}, 400),
])
def test_a_log_that_is_not_a_list_of_operations_or_is_too_large_is_refused_and_the_draft_is_kept(client, body, status):
    slug = app(client)
    lock(client, slug); save(client, slug)
    assert client.put(f"/api/apps/{slug}/draft", headers=DEE, json=body).status_code == status
    assert view(client, slug).json()["draft"]["log"] == LOG


def test_a_log_is_stored_exactly_as_the_editor_wrote_it(client):
    slug = app(client)
    lock(client, slug)
    log = [{"t": "addControl", "form": "F", "place": {"newRowAt": 1, "newRowId": "r9"}, "control": {"id": "x", "type": "text", "bind": "a", "label": "Ünïcode ✓"}},
           {"t": "setValidation", "form": "F", "id": "x", "rules": [{"expr": "len(a) > 1", "message": "m"}]}]
    save(client, slug, log)
    assert view(client, slug).json()["draft"]["log"] == log


# ---- publishing
def test_a_new_version_is_refused_while_someone_else_holds_an_active_draft(client, db_url):
    slug = app(client)
    lock(client, slug, DEE)
    r = client.post(f"/api/apps/{slug}/versions", headers=OWNER, json={"base_version": 1, "renames": [], "forms": [{**CUSTOMER_FORM, "title": "New"}, ORDER_FORM]})
    assert r.status_code == 409 and r.json()["error"] == "draft_locked" and r.json()["locked_by"] == "dee", r.text
    assert sql(db_url, "select current_version from a2w_control.applications where slug = %s", slug)[0]["current_version"] == 1
    assert view(client, slug).json()["draft"]["locked_by"] == "dee", "the draft is untouched"


def test_the_holder_publishes_the_draft_and_it_is_gone_and_the_next_lock_starts_from_the_new_version(client):
    slug = app(client)
    assert lock(client, slug, MIA).status_code == 200
    save(client, slug, LOG, MIA)
    r = client.post(f"/api/apps/{slug}/versions", headers=MIA, json={"base_version": 1, "renames": [], "forms": [{**CUSTOMER_FORM, "title": "New"}, ORDER_FORM]})
    assert r.status_code == 200, r.text
    assert view(client, slug, MIA).json()["draft"] is None
    again = lock(client, slug, MIA).json()
    assert again["base_version"] == 2 and again["log"] == []


def test_a_lapsed_draft_does_not_stop_a_new_version_and_is_removed_by_it(client, db_url):
    slug = app(client)
    lock(client, slug, DEE); save(client, slug)
    lapse(db_url, slug)
    r = client.post(f"/api/apps/{slug}/versions", headers=OWNER, json={"base_version": 1, "renames": [], "forms": [{**CUSTOMER_FORM, "title": "New"}, ORDER_FORM]})
    assert r.status_code == 200, r.text
    assert view(client, slug, DEE).json()["draft"] is None
    assert save(client, slug, [], DEE).json()["error"] == "no_draft"


def test_a_refused_version_keeps_the_draft(client):
    slug = app(client)
    lock(client, slug, MIA); save(client, slug, LOG, MIA)
    bad = client.post(f"/api/apps/{slug}/versions", headers=MIA, json={"base_version": 1, "renames": [{"kind": "field", "entity": "customers", "from": "nope", "to": "x"}]})
    assert bad.status_code == 400
    assert view(client, slug, MIA).json()["draft"]["log"] == LOG, "an edit that cannot be published is not lost"


def test_a_version_without_a_draft_still_publishes(client):
    slug = app(client)
    r = client.post(f"/api/apps/{slug}/versions", headers=OWNER, json={"base_version": 1, "forms": [{**CUSTOMER_FORM, "title": "New"}, ORDER_FORM]})
    assert r.status_code == 200


def test_a_draft_that_started_from_an_old_version_cannot_be_resumed_and_can_be_discarded(client, db_url):
    """The routes keep a draft and a version together, so this cannot arise through them. The check guards a row that was changed by hand."""
    slug = app(client)
    lock(client, slug)
    sql(db_url, "update a2w_control.drafts set base_version = 0 where app_id = (select id from a2w_control.applications where slug = %s)", slug)
    r = lock(client, slug)
    assert r.status_code == 409 and r.json()["error"] == "draft_out_of_date" and r.json()["base"] == 0 and r.json()["current"] == 1
    assert view(client, slug).json()["draft"]["stale"] is True
    assert discard(client, slug).json() == {"discarded": True}
    assert lock(client, slug).json()["base_version"] == 1


def test_locking_and_discarding_are_recorded_and_saves_are_not(client):
    slug = app(client)
    lock(client, slug); save(client, slug); save(client, slug); discard(client, slug)
    actions = [e["action"] for e in client.get(f"/api/audit?app={slug}", headers=AUDITOR).json() if e["action"].startswith("draft_")]
    assert sorted(actions) == ["draft_discarded", "draft_locked"]
    assert client.get("/api/audit/verify", headers=AUDITOR).json()["intact"] is True
