"""Text columns are citext, as Access ignores case in text (decision D22), and the size from Access is still enforced."""
import psycopg
import pytest

from a2w.typemap import map_type
from conftest import OWNER, hdr
from test_forms_api import BASE_GRANTS, CARA, CUSTOMER_FORM, ORDER_FORM, publish


def db(db_url, slug, query, *args, fetch=True):
    with psycopg.connect(db_url, autocommit=True) as c:
        c.execute(f'set search_path = "app_{slug}", public')
        c.execute("select set_config('a2w.user', 'test', false)")  # the audit trigger refuses a change with no user
        cur = c.execute(query, args)
        return cur.fetchall() if fetch and cur.description else None


# ---- the mapping
@pytest.mark.parametrize("access_type,size,max_length", [
    ("Short Text", 50, 50), ("Short Text", None, 255), ("Text", 10, 10), ("short text", 255, 255),
    ("Long Text", None, None), ("Memo", None, None), ("Hyperlink", None, None),
])
def test_every_kind_of_text_maps_to_citext_and_only_short_text_has_a_size(access_type, size, max_length):
    m = map_type(access_type, size)
    assert m.pg_type == "citext" and m.max_length == max_length


@pytest.mark.parametrize("access_type,pg", [
    ("Long Integer", "integer"), ("Currency", "numeric(19,4)"), ("Date/Time", "timestamp"), ("Yes/No", "boolean"),
    ("Replication ID", "uuid"), ("Double", "double precision"),
])
def test_types_that_are_not_text_are_unchanged(access_type, pg):
    m = map_type(access_type)
    assert m.pg_type == pg and m.max_length is None


# ---- in the database
def test_a_published_application_has_citext_columns_and_the_size_as_a_check(client, db_url):
    slug, r = publish(client)
    assert r.status_code == 200, r.text
    cols = {c[0]: c[1] for c in db(db_url, slug, "select column_name, udt_name from information_schema.columns "
                                                 "where table_schema = %s and table_name = 'customers'", "app_" + slug)}
    assert cols["customer_name"] == "citext" and cols["email"] == "citext" and cols["customerid"] == "int4"
    checks = db(db_url, slug, "select pg_get_constraintdef(c.oid) from pg_constraint c join pg_class t on t.oid = c.conrelid "
                              "join pg_namespace n on n.oid = t.relnamespace where n.nspname = %s and t.relname = 'customers' and c.contype = 'c'", "app_" + slug)
    text = " ".join(x[0] for x in checks)
    assert "char_length((customer_name)::text) <= 50" in text and "char_length((email)::text) <= 80" in text


def test_text_compares_groups_and_removes_duplicates_without_regard_to_case(client, db_url):
    slug, _ = publish(client)
    db(db_url, slug, "insert into customers (customer_name, email) values ('LONDON', 'x'), ('london', 'y'), ('London', 'z')", fetch=False)
    assert db(db_url, slug, "select count(*) from customers where customer_name = 'london'")[0][0] == 3, "equality ignores case"
    assert db(db_url, slug, "select count(distinct customer_name) from customers where lower(customer_name) = 'london'")[0][0] == 1, "distinct treats them as one"
    assert len(db(db_url, slug, "select customer_name from customers where customer_name = 'london' group by customer_name")) == 1, "so does group by"
    assert db(db_url, slug, "select count(*) from customers where customer_name = 'acme'")[0][0] == 1, "and the migrated row 'Acme' matches 'acme'"
    assert db(db_url, slug, "select count(*) from customers where customer_name like 'AC%%'")[0][0] == 1, "like too"


def test_the_size_from_access_is_still_enforced_by_the_database(client, db_url):
    slug, _ = publish(client)
    db(db_url, slug, "insert into customers (customer_name) values (repeat('x', 50))", fetch=False)
    with pytest.raises(psycopg.errors.CheckViolation):
        db(db_url, slug, "insert into customers (customer_name) values (repeat('x', 51))", fetch=False)
    db(db_url, slug, "insert into customers (customer_name, email) values ('a', repeat('y', 80))", fetch=False)
    with pytest.raises(psycopg.errors.CheckViolation):
        db(db_url, slug, "insert into customers (customer_name, email) values ('a', repeat('y', 81))", fetch=False)


def test_a_value_that_is_too_long_is_a_400_through_the_api_for_a_create_and_for_a_form_save(client):
    slug, _ = publish(client)
    r = client.post(f"/api/apps/{slug}/forms/OrderForm/records", headers=CARA, json={"version": 1, "values": {"customerid": 1, "total": 1}})
    assert r.status_code == 201, "a form on a table without text fields is unaffected"
    form = client.post(f"/api/apps/{slug}/forms/CustomerForm/records", headers=CARA, json={"version": 1, "values": {"customer_name": "y" * 51}})
    assert form.status_code == 400 and "not valid" in form.json()["detail"], form.text
    ok = client.post(f"/api/apps/{slug}/forms/CustomerForm/records", headers=CARA, json={"version": 1, "values": {"customer_name": "y" * 50}})
    assert ok.status_code == 201


def test_a_record_saved_through_the_api_is_found_without_regard_to_case_and_is_audited_as_text(client, db_url):
    slug, _ = publish(client)
    made = client.post(f"/api/apps/{slug}/forms/CustomerForm/records", headers=CARA, json={"version": 1, "values": {"customer_name": "Zed"}})
    assert made.status_code == 201 and made.json()["customer_name"] == "Zed", "the value comes back as it was written"
    assert db(db_url, slug, "select count(*) from customers where customer_name = 'ZED'")[0][0] == 1
    ev = client.get(f"/api/audit?app={slug}", headers=hdr("aud", roles="auditor")).json()
    ins = next(e for e in ev if e["action"] == "insert" and e["detail"]["new"].get("customer_name") == "Zed")
    assert ins["object"] == "customers"


def test_the_size_survives_a_rename_of_the_field_and_of_the_entity(client, db_url):
    slug, _ = publish(client, grants=BASE_GRANTS)
    import json
    forms = [json.loads(json.dumps(f).replace("customer_name", "title").replace("customers", "clients")) for f in (CUSTOMER_FORM, ORDER_FORM)]
    forms[1]["entity"] = "orders"
    r = client.post(f"/api/apps/{slug}/versions", headers=OWNER, json={"base_version": 1, "forms": forms, "renames": [
        {"kind": "field", "entity": "customers", "from": "customer_name", "to": "title"}, {"kind": "entity", "from": "customers", "to": "clients"}]})
    assert r.status_code == 200, r.text
    db(db_url, slug, "insert into clients (title) values (repeat('x', 50))", fetch=False)
    with pytest.raises(psycopg.errors.CheckViolation):
        db(db_url, slug, "insert into clients (title) values (repeat('x', 51))", fetch=False)
    assert db(db_url, slug, "select count(*) from clients where title = 'ACME'")[0][0] == 1, "and the column is still citext"


def test_the_extension_is_created_by_the_bootstrap(db_url):
    with psycopg.connect(db_url) as c:
        assert c.execute("select count(*) from pg_extension where extname = 'citext'").fetchone()[0] == 1
