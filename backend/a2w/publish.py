"""Create an import job, and publish an analysed application: schema, data, grants, tile."""
from psycopg import sql
from psycopg.types.json import Jsonb

import psycopg

from . import authz, db, ddl, formrules, migrate, runtime
from .definition import ConversionItem, Definition
from .importer import Analysis, Extraction, analyse, summarise
from .names import check_slug, schema_for

BATCH = 1000
LOCK_TIMEOUT = "5s"  # how long a new version waits for requests in flight before it gives up


class PublishError(Exception):
    pass


class Busy(PublishError):
    """The application is in use and did not become free in time. Nothing changed, so the caller can try again."""


def create_job(conn, owner_id: str, extraction: Extraction) -> tuple[int, Analysis]:
    a = analyse(extraction)
    job = conn.execute(
        "insert into a2w_control.import_jobs(owner_id, extraction, definition, classification) "
        "values (%s, %s, %s, %s) returning id",
        (owner_id, Jsonb(extraction.model_dump(mode="json")), Jsonb(a.definition.model_dump(mode="json")),
         Jsonb(a.classification))).fetchone()["id"]
    for i in a.items:
        _save_item(conn, job, i)
    db.audit(conn, owner_id, "upload", obj=f"import_job:{job}", detail=summarise(a.items))
    return job, a


def _save_item(conn, job: int, i: ConversionItem) -> None:
    conn.execute("insert into a2w_control.conversion_items(job_id, object_type, name, status, reason, vba_class, suggestion) "
                 "values (%s,%s,%s,%s,%s,%s,%s)",
                 (job, i.object_type, i.name, i.status, i.reason, i.vba_class, i.suggestion))


def get_report(conn, job: int) -> dict | None:
    j = conn.execute("select id, owner_id, status, classification from a2w_control.import_jobs where id = %s", (job,)).fetchone()
    if not j:
        return None
    items = conn.execute("select object_type, name, status, reason, vba_class, suggestion "
                         "from a2w_control.conversion_items where job_id = %s order by id", (job,)).fetchall()
    return {"job": j["id"], "owner_id": j["owner_id"], "status": j["status"], "classification": j["classification"],
            "summary": summarise([ConversionItem(**i) for i in items]), "items": items}


def publish(conn, job_id: int, who: authz.Identity, *, slug: str, name: str, description: str, icon: str,
            confirmed_classification: str, permissions_confirmed: bool,
            grants: list[dict], forms: list[dict] | None = None) -> dict:
    check_slug(slug)
    if confirmed_classification not in ("general", "personal", "sensitive"):
        raise PublishError("confirm the data classification: general, personal, or sensitive")
    if not permissions_confirmed:
        raise PublishError("confirm the permissions summary before publishing")
    if conn.execute("select 1 from a2w_control.applications where slug = %s", (slug,)).fetchone():
        raise PublishError("An application with that slug already exists.")
    job = conn.execute("select * from a2w_control.import_jobs where id = %s for update", (job_id,)).fetchone()
    if not job:
        raise PublishError("import job not found")
    if job["owner_id"] != who.user_id and not who.is_admin:
        raise PublishError("only the job owner can publish")
    if job["status"] != "analysed":
        raise PublishError(f"import job is {job['status']}")
    suggested = job["classification"]["suggested"]
    order = ["general", "personal", "sensitive"]
    if order.index(confirmed_classification) < order.index(suggested):
        # Owners can raise the class freely. Lowering it below the suggestion is allowed but recorded.
        db.audit(conn, who.user_id, "classification_lowered", app=slug,
                 detail={"suggested": suggested, "confirmed": confirmed_classification})
    for g in grants:
        authz.validate_grant(g["subject_type"], g["resource_type"], g.get("resource_id", ""), g["level"])

    d = Definition.model_validate(job["definition"])
    d.app = slug
    # A rule that cannot run is never stored. Entity and field names are the ones in the conversion report.
    d.forms = list(forms or [])
    problems = formrules.validate_forms(d.model_dump(mode="json"))
    if problems:
        shown = "; ".join(problems[:10]) + (f"; and {len(problems) - 10} more" if len(problems) > 10 else "")
        raise PublishError(f"invalid forms: {shown}")
    ex = Extraction.model_validate(job["extraction"])
    row_map = analyse(ex).row_map

    app_id = conn.execute(
        "insert into a2w_control.applications(slug, name, description, icon, owner_id, classification) "
        "values (%s,%s,%s,%s,%s,%s) returning id",
        (slug, name, description, icon, job["owner_id"], confirmed_classification)).fetchone()["id"]

    schema, role = schema_for(slug), ddl.role_for(slug)
    conn.execute(sql.SQL("create schema {}").format(sql.Identifier(schema)))
    conn.execute(sql.SQL("create role {} nologin").format(sql.Identifier(role)))
    conn.execute(sql.SQL("grant {} to current_user").format(sql.Identifier(role)))
    for e in d.entities:
        for stmt in ddl.create_table(slug, e):
            conn.execute(stmt)

    extra: list[ConversionItem] = []
    tables = {t.name: t for t in ex.tables}
    for e in d.entities:
        src = tables[e.source_name]
        fmap = row_map[e.name]
        cols = [f for f in e.fields]
        src_by_field = {v: k for k, v in fmap.items()}
        insert = sql.SQL("insert into {}.{} ({}) values ({})").format(
            sql.Identifier(schema), sql.Identifier(e.name),
            sql.SQL(", ").join(sql.Identifier(f.name) for f in cols),
            sql.SQL(", ").join(sql.Placeholder() * len(cols)))
        with conn.cursor() as cur:
            for i in range(0, len(src.rows), BATCH):
                cur.executemany(insert, [[r.get(src_by_field[f.name]) for f in cols]
                                         for r in src.rows[i:i + BATCH]])
        count = conn.execute(sql.SQL("select count(*) as n from {}.{}").format(
            sql.Identifier(schema), sql.Identifier(e.name))).fetchone()["n"]
        if count != len(src.rows):
            raise PublishError(f"row count mismatch in {e.source_name}: source {len(src.rows)}, loaded {count}")
        for f in e.fields:
            if f.identity:
                conn.execute(sql.SQL("select setval(pg_get_serial_sequence({}, {}), "
                                     "greatest((select coalesce(max({}), 0) from {}.{}), 1), "
                                     "(select count(*) > 0 from {}.{}))").format(
                    sql.Literal(f"{schema}.{e.name}"), sql.Literal(f.name), sql.Identifier(f.name),
                    sql.Identifier(schema), sql.Identifier(e.name), sql.Identifier(schema), sql.Identifier(e.name)))

    # Foreign keys go on after the load. Orphans are reported, never dropped.
    for e in d.entities:
        keep = []
        for fk in e.foreign_keys:
            n = conn.execute(ddl.orphan_count(slug, e, fk)).fetchone()["count"]
            if n:
                extra.append(ConversionItem(
                    object_type="relationship", name=f"{e.source_name}.{fk.name}", status="partly_converted",
                    reason=f"{n} orphan rows violate the relationship; constraint not created. Fix the rows and add it later."))
                continue
            conn.execute(ddl.add_foreign_key(slug, e, fk))
            keep.append(fk)
        e.foreign_keys = keep

    for e in d.entities:
        conn.execute(ddl.audit_trigger(slug, e))
    for stmt in ddl.grant_role(slug, d):
        conn.execute(stmt)

    for i in extra:
        _save_item(conn, job_id, i)
    conn.execute("insert into a2w_control.app_versions(app_id, version, definition, published_by) values (%s,1,%s,%s)",
                 (app_id, Jsonb(d.model_dump(mode="json")), who.user_id))
    all_grants = [{"subject_type": "user", "subject_id": job["owner_id"], "resource_type": "application",
                   "resource_id": "", "level": "manage_application"}] + grants
    for g in all_grants:
        conn.execute("insert into a2w_control.grants(app_id, subject_type, subject_id, resource_type, resource_id, level, granted_by) "
                     "values (%s,%s,%s,%s,%s,%s,%s) on conflict do nothing",
                     (app_id, g["subject_type"], g["subject_id"], g["resource_type"], g.get("resource_id", ""),
                      g["level"], who.user_id))
        db.audit(conn, who.user_id, "grant", app=slug, obj=g.get("resource_id") or "application",
                 detail={"subject": f"{g['subject_type']}:{g['subject_id']}", "level": g["level"]})
    conn.execute("update a2w_control.import_jobs set status = 'published', app_id = %s where id = %s", (app_id, job_id))
    db.audit(conn, who.user_id, "publish", app=slug, detail={"version": 1, "classification": confirmed_classification})
    return {"app_id": app_id, "slug": slug, "version": 1}


def republish(conn, slug: str, who: authz.Identity, *, base_version: int, renames: list[migrate.Rename],
              forms: list[dict] | None = None) -> dict:
    """Publish a new version of a published application: carry renames to the data, and replace the forms.

    Everything happens in the caller's transaction, so a failure leaves the application as it was. `forms=None` keeps
    the current forms, and they are checked against the renamed entities, so a rename that would break a form is
    refused instead of half applied. Adding and removing fields and entities is not handled here.
    """
    # Requests in flight hold a share lock on this row (runtime.load_app). Taking the row for update waits for them,
    # and new requests wait for this transaction, so no request runs with a definition that does not match the tables.
    conn.execute(sql.SQL("set local lock_timeout = {}").format(sql.Literal(LOCK_TIMEOUT)))
    try:
        app = conn.execute("select * from a2w_control.applications where slug = %s and status = 'published' for update",
                           (slug,)).fetchone()
    except psycopg.errors.LockNotAvailable:
        raise Busy("The application is in use. Try again in a moment.") from None
    if not app:
        raise runtime.Denied()
    if app["current_version"] != base_version:
        raise runtime.VersionChanged(app["current_version"])
    old = Definition.model_validate(conn.execute(
        "select definition from a2w_control.app_versions where app_id = %s and version = %s",
        (app["id"], app["current_version"])).fetchone()["definition"])

    try:
        d, statements = migrate.apply(slug, old, renames)
    except migrate.MigrationError as e:
        raise PublishError(str(e)) from None
    if forms is not None:
        d.forms = list(forms)
    if not renames and d.forms == old.forms:
        raise PublishError("nothing to publish: no renames, and the forms are unchanged")
    problems = formrules.validate_forms(d.model_dump(mode="json"))
    if problems:
        shown = "; ".join(problems[:10]) + (f"; and {len(problems) - 10} more" if len(problems) > 10 else "")
        raise PublishError(f"invalid forms: {shown}")

    try:
        for stmt in statements:
            conn.execute(stmt)
    except psycopg.errors.LockNotAvailable:
        raise Busy("The application is in use. Try again in a moment.") from None
    # A grant on a table is stored by the table's name, so it follows an entity rename.
    for r in renames:
        if r.kind == "entity":
            conn.execute("update a2w_control.grants set resource_id = %s "
                         "where app_id = %s and resource_type = 'table' and resource_id = %s", (r.to, app["id"], r.from_))

    version = app["current_version"] + 1
    d.version = version
    conn.execute("insert into a2w_control.app_versions(app_id, version, definition, published_by) values (%s,%s,%s,%s)",
                 (app["id"], version, Jsonb(d.model_dump(mode="json")), who.user_id))
    conn.execute("update a2w_control.applications set current_version = %s where id = %s", (version, app["id"]))
    db.audit(conn, who.user_id, "publish", app=slug, detail={
        "version": version, "renames": [r.model_dump(by_alias=True, exclude_defaults=True) for r in renames],
        "forms_changed": d.forms != old.forms})
    return {"slug": slug, "version": version, "migration": [s_.as_string(conn) for s_ in statements]}
