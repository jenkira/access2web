"""What the form editor needs from the backend: the whole definition for designers, the entity with a form, and its static files."""
import json

import pytest
from fastapi.testclient import TestClient

from conftest import OWNER, hdr
from test_forms_api import BASE_GRANTS, BOB, CARA, CUSTOMER_FORM, ORDER_FORM, grant, publish

DESIGNER = hdr("dee")
GRANTS = [*BASE_GRANTS, grant("dee", "design_application")]


def definition(client, slug, who):
    return client.get(f"/api/apps/{slug}/definition", headers=who)


def test_design_and_manage_can_read_the_whole_definition(client):
    slug, _ = publish(client, grants=GRANTS)
    for who in (DESIGNER, OWNER):
        r = definition(client, slug, who)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["version"] == 1
        assert [e["name"] for e in body["entities"]] == ["customers", "orders"]
        assert [f["name"] for f in body["forms"]] == ["CustomerForm", "OrderForm"]
        cust = body["entities"][0]
        assert cust["primary_key"] == ["customerid"]
        assert {f["name"]: f["type"] for f in cust["fields"]}["customer_name"] == "varchar(50)"
        assert set(cust) == {"name", "primary_key", "fields"}, "no internal detail such as source names or indexes"


@pytest.mark.parametrize("who", [BOB, CARA, hdr("eve")], ids=["view", "edit", "nobody"])
def test_data_access_without_design_cannot_read_the_definition(client, who):
    slug, _ = publish(client, grants=GRANTS)
    assert definition(client, slug, who).status_code == 403


def test_the_definition_of_an_unknown_or_unpublished_application_is_refused_alike(client):
    assert definition(client, "no_such_app", OWNER).status_code == 403
    slug, _ = publish(client, grants=GRANTS)
    client.post(f"/api/apps/{slug}/unpublish", headers=OWNER)
    assert definition(client, slug, OWNER).status_code == 403


def test_the_definition_shows_the_current_version_after_a_new_one(client):
    slug, _ = publish(client, grants=GRANTS)
    assert client.post(f"/api/apps/{slug}/versions", headers=OWNER, json={
        "base_version": 1, "renames": [{"kind": "field", "entity": "customers", "from": "email", "to": "mail"}],
        "forms": [json.loads(json.dumps(CUSTOMER_FORM).replace("email", "mail")), ORDER_FORM]}).status_code == 200
    body = definition(client, slug, DESIGNER).json()
    assert body["version"] == 2 and "mail" in [f["name"] for f in body["entities"][0]["fields"]]


def test_a_form_comes_with_its_entity_so_the_browser_can_tell_required_fields_and_keys(client):
    slug, _ = publish(client, grants=GRANTS)
    r = client.get(f"/api/apps/{slug}/forms/CustomerForm", headers=BOB)
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == 1 and body["form"]["name"] == "CustomerForm"
    ent = body["entity"]
    assert set(ent) == {"name", "primary_key", "fields"} and ent["name"] == "customers"
    by_name = {f["name"]: f for f in ent["fields"]}
    assert by_name["customer_name"]["required"] is True and by_name["customerid"]["identity"] is True


def test_a_form_the_person_cannot_view_does_not_give_its_entity_away(client):
    slug, _ = publish(client, grants=GRANTS)
    r = client.get(f"/api/apps/{slug}/forms/CustomerForm", headers=hdr("eve"))
    assert r.status_code == 403 and "customers" not in r.text


def test_the_editor_files_are_served_when_a_directory_is_set_and_nothing_else_is(tmp_path, monkeypatch, db_url):
    (tmp_path / "public").mkdir(); (tmp_path / "dist").mkdir(); (tmp_path / "src").mkdir()
    (tmp_path / "public" / "index.html").write_text("<p>page</p>")
    (tmp_path / "dist" / "main.js").write_text("// script")
    (tmp_path / "src" / "secret.ts").write_text("// not served")
    (tmp_path / "package.json").write_text("{}")
    monkeypatch.setenv("A2W_EDITOR_DIR", str(tmp_path))
    from a2w.api import create_app
    c = TestClient(create_app())
    assert c.get("/editor/public/index.html").text == "<p>page</p>"
    assert c.get("/editor/dist/main.js").status_code == 200
    for path in ("/editor/src/secret.ts", "/editor/package.json", "/editor/public/../src/secret.ts", "/editor/%2e%2e/package.json"):
        assert c.get(path).status_code == 404, path


def test_without_the_setting_there_is_no_editor_route(client, monkeypatch):
    monkeypatch.delenv("A2W_EDITOR_DIR", raising=False)
    assert client.get("/editor/public/index.html").status_code == 404
