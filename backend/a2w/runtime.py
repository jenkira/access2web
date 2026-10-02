"""Runtime: record access for a published application. Every call checks permissions first."""
from psycopg import sql
from psycopg.types.json import Jsonb

from . import authz, db, ddl
from .definition import Definition, Entity
from .names import schema_for

MAX_PAGE = 500


class Denied(Exception):
    """Raised for a missing application, a hidden application, and a refusal alike."""


class NotFound(Exception):
    """The application and permission are fine, but the record does not exist."""


class BadRequest(Exception):
    pass


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


def create_record(conn, slug, ident, table, values) -> dict:
    app, d = load_app(conn, slug)
    e = _entity(d, table)
    _require(conn, app, ident, table, "edit_data")
    values = _clean(e, values)
    _scope(conn, app, ident)
    q = sql.SQL("insert into {}.{} ({}) values ({}) returning *").format(
        sql.Identifier(schema_for(slug)), sql.Identifier(e.name),
        sql.SQL(", ").join(sql.Identifier(k) for k in values), sql.SQL(", ").join(sql.Placeholder() * len(values)))
    return conn.execute(q, list(values.values())).fetchone()


def update_record(conn, slug, ident, table, key, values) -> dict:
    app, d = load_app(conn, slug)
    e = _entity(d, table)
    _require(conn, app, ident, table, "edit_data")
    values = _clean(e, values, for_update=True)
    _scope(conn, app, ident)
    q = sql.SQL("update {}.{} set {} where {} = %s returning *").format(
        sql.Identifier(schema_for(slug)), sql.Identifier(e.name),
        sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k in values), _key(e, key))
    row = conn.execute(q, [*values.values(), key]).fetchone()
    if not row:
        raise NotFound()
    return row


def delete_record(conn, slug, ident, table, key) -> None:
    app, d = load_app(conn, slug)
    e = _entity(d, table)
    _require(conn, app, ident, table, "delete_data")
    _scope(conn, app, ident)
    cur = conn.execute(sql.SQL("delete from {}.{} where {} = %s").format(
        sql.Identifier(schema_for(slug)), sql.Identifier(e.name), _key(e, key)), (key,))
    if cur.rowcount == 0:
        raise NotFound()
