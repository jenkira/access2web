"""Runtime: record access for a published application. Every call checks permissions first."""
from datetime import datetime, timezone

from psycopg import sql
from psycopg.types.json import Jsonb

from . import authz, db, ddl, formrules
from .definition import Definition, Entity
from .names import schema_for

MAX_PAGE = 500


class Denied(Exception):
    """Raised for a missing application, a hidden application, and a refusal alike."""


class NotFound(Exception):
    """The application and permission are fine, but the record does not exist."""


class BadRequest(Exception):
    pass


class VersionChanged(Exception):
    """The form the user has open is from an earlier version of the application."""

    def __init__(self, current: int) -> None:
        super().__init__(f"version changed to {current}")
        self.current = current


class FormRequired(Exception):
    """The table has a form, so records in it are saved through a form, where the form's rules apply."""

    def __init__(self, table: str, forms: list[str]) -> None:
        super().__init__(f"{table} is saved through a form")
        self.table, self.forms = table, forms


class Unprocessable(Exception):
    """The record breaks a form rule, or holds a field the form does not have. The payload is the response body."""

    def __init__(self, payload: dict) -> None:
        super().__init__(payload.get("error", "unprocessable"))
        self.payload = payload


def load_app(conn, slug: str) -> tuple[dict, Definition]:
    app = conn.execute("select * from a2w_control.applications where slug = %s and status = 'published'", (slug,)).fetchone()
    if not app:
        raise Denied()
    v = conn.execute("select definition from a2w_control.app_versions where app_id = %s and version = %s",
                     (app["id"], app["current_version"])).fetchone()
    return app, Definition.model_validate(v["definition"])


def _entity(d: Definition, table: str) -> Entity:
    e = d.entity(table)
    if not e:
        raise Denied()
    return e


def _scope(conn, app: dict, ident: authz.Identity) -> None:
    """Run the rest of the transaction as the application's role, with the user recorded for the audit trigger."""
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(ddl.role_for(app["slug"]))))
    conn.execute("select set_config('a2w.user', %s, true)", (ident.user_id,))


def _require(conn, app, ident, table, level) -> None:
    if not authz.can(conn, app["id"], ident, "table", table, level):
        raise Denied()


def _clean(e: Entity, values: dict, *, for_update: bool = False) -> dict:
    out = {}
    for k, v in values.items():
        f = e.field(k)
        if f is None:
            raise BadRequest(f"unknown field {k!r}")
        if f.identity and not for_update and v is None:
            continue
        out[k] = v
    if not out:
        raise BadRequest("no fields given")
    return out


def _key(e: Entity, key: str) -> sql.Composable:
    if not e.single_key:
        raise BadRequest("this table has no single-column primary key; edit and delete are not available")
    return sql.Identifier(e.single_key)


def list_records(conn, slug, ident, table, limit=100, offset=0) -> dict:
    app, d = load_app(conn, slug)
    e = _entity(d, table)
    _require(conn, app, ident, table, "view_data")
    limit = max(1, min(int(limit), MAX_PAGE))
    _scope(conn, app, ident)
    order = sql.SQL(", ").join(sql.Identifier(c) for c in (e.primary_key or [e.fields[0].name]))
    rows = conn.execute(sql.SQL("select * from {}.{} order by {} limit %s offset %s").format(
        sql.Identifier(schema_for(slug)), sql.Identifier(e.name), order), (limit, int(offset))).fetchall()
    return {"records": rows, "limit": limit, "offset": int(offset)}


def get_record(conn, slug, ident, table, key) -> dict:
    app, d = load_app(conn, slug)
    e = _entity(d, table)
    _require(conn, app, ident, table, "view_data")
    _scope(conn, app, ident)
    row = conn.execute(sql.SQL("select * from {}.{} where {} = %s").format(
        sql.Identifier(schema_for(slug)), sql.Identifier(e.name), _key(e, key)), (key,)).fetchone()
    if not row:
        raise NotFound()
    return row


def _insert(conn, slug: str, e: Entity, values: dict) -> dict:
    q = sql.SQL("insert into {}.{} ({}) values ({}) returning *").format(
        sql.Identifier(schema_for(slug)), sql.Identifier(e.name),
        sql.SQL(", ").join(sql.Identifier(k) for k in values), sql.SQL(", ").join(sql.Placeholder() * len(values)))
    return conn.execute(q, list(values.values())).fetchone()


def _update(conn, slug: str, e: Entity, key: str, values: dict) -> dict:
    q = sql.SQL("update {}.{} set {} where {} = %s returning *").format(
        sql.Identifier(schema_for(slug)), sql.Identifier(e.name),
        sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k in values), _key(e, key))
    row = conn.execute(q, [*values.values(), key]).fetchone()
    if not row:
        raise NotFound()
    return row


def _require_no_form(d: Definition, table: str) -> None:
    """A table that has a form is written through a form, so that its rules cannot be skipped.

    This applies to create and update. Reads are not affected. Delete is not affected, because a delete cannot leave a
    record that breaks a rule, and there is no form route for it.
    """
    forms = [f["name"] for f in d.forms if f.get("entity") == table]
    if forms:
        raise FormRequired(table, forms)


def create_record(conn, slug, ident, table, values) -> dict:
    app, d = load_app(conn, slug)
    e = _entity(d, table)
    _require(conn, app, ident, table, "edit_data")  # permission first, so a person without it learns nothing about forms
    _require_no_form(d, table)
    values = _clean(e, values)
    _scope(conn, app, ident)
    return _insert(conn, slug, e, values)


def update_record(conn, slug, ident, table, key, values) -> dict:
    app, d = load_app(conn, slug)
    e = _entity(d, table)
    _require(conn, app, ident, table, "edit_data")
    _require_no_form(d, table)
    values = _clean(e, values, for_update=True)
    _scope(conn, app, ident)
    return _update(conn, slug, e, key, values)


# ---- forms
def _form(d: Definition, name: str) -> dict:
    form = next((f for f in d.forms if f.get("name") == name), None)
    if form is None:
        raise Denied()  # a form that does not exist looks the same as a form you may not use
    return form


def get_form(conn, slug, ident, form_name) -> dict:
    """The form, and the version of the application it belongs to. The browser sends the version back when it saves."""
    app, d = load_app(conn, slug)
    form = _form(d, form_name)
    if not authz.can(conn, app["id"], ident, "form", form_name, "view_data"):
        raise Denied()
    return {"version": app["current_version"], "form": form}


def save_form(conn, slug, ident, form_name, values, *, version: int, key: str | None = None) -> dict:
    """Save a record through a form. Checks run in this order, and a failure stops the save:

    1. The form exists and the user has edit_data on it. Both failures give the same answer.
    2. The form is from the current version of the application, or the user must reload.
    3. The record holds only fields that the form binds.
    4. Every rule on a visible control is true, and every visible required field has a value.

    The form's rules apply to every save through the form. The table routes refuse to create or update a record in a table
    that has a form, so there is no way around the rules.
    """
    app, d = load_app(conn, slug)
    form = _form(d, form_name)
    if not authz.can(conn, app["id"], ident, "form", form_name, "edit_data"):
        raise Denied()
    if version != app["current_version"]:
        raise VersionChanged(app["current_version"])
    if not isinstance(values, dict):
        raise BadRequest("values must be an object")
    unknown = formrules.unknown_fields(form, values)
    if unknown:
        raise Unprocessable({"error": "unknown_fields", "fields": unknown})
    # One instant for the whole save, so every rule that uses today() sees the same date.
    errors = formrules.failed_rules(d.model_dump(mode="json"), form, values, datetime.now(timezone.utc))
    if errors:
        raise Unprocessable({"error": "validation", "errors": errors})
    e = _entity(d, form["entity"])
    clean = _clean(e, values, for_update=key is not None)
    _scope(conn, app, ident)
    return _update(conn, slug, e, key, clean) if key is not None else _insert(conn, slug, e, clean)


def delete_record(conn, slug, ident, table, key) -> None:
    app, d = load_app(conn, slug)
    e = _entity(d, table)
    _require(conn, app, ident, table, "delete_data")
    _scope(conn, app, ident)
    cur = conn.execute(sql.SQL("delete from {}.{} where {} = %s").format(
        sql.Identifier(schema_for(slug)), sql.Identifier(e.name), _key(e, key)), (key,))
    if cur.rowcount == 0:
        raise NotFound()
