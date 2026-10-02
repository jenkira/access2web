"""HTTP API. Every route resolves identity and permissions before it does any work."""
import os
from typing import Any

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from . import authz, db, migrate, publish as pub, runtime
from .authz import Identity
from .importer import Extraction
from .portal import DevHeaderPortal, PortalAdapter, Tile

DENIED = HTTPException(403, "You do not have permission to use this application or resource.")


class GrantIn(BaseModel):
    subject_type: str
    subject_id: str
    resource_type: str = "application"
    resource_id: str = ""
    level: str


class FormSaveIn(BaseModel):
    version: int  # the version of the form that the browser opened
    values: dict[str, Any]


class VersionIn(BaseModel):
    base_version: int  # the version that the editor started from
    renames: list[migrate.Rename] = Field(default_factory=list)
    forms: list[dict[str, Any]] | None = None  # None keeps the current forms


class PublishIn(BaseModel):
    slug: str
    name: str
    description: str = ""
    icon: str = "app"
    confirmed_classification: str
    permissions_confirmed: bool
    grants: list[GrantIn] = Field(default_factory=list)
    forms: list[dict[str, Any]] = Field(default_factory=list)


def create_app(portal: PortalAdapter | None = None) -> FastAPI:
    app = FastAPI(title="Access2Web", version="0.1.0")
    portal = portal or DevHeaderPortal()
    app.state.portal = portal

    def identity(request: Request) -> Identity:
        ident = portal.identity({k.lower(): v for k, v in request.headers.items()})
        if ident is None:
            raise HTTPException(401, "Sign in required.")
        return ident

    def need_role(ident: Identity, *roles: str) -> None:
        if not (ident.is_admin or any(r in ident.roles for r in roles)):
            raise DENIED

    def can_manage(conn, app_row, ident) -> bool:
        return ident.is_admin or authz.can(conn, app_row["id"], ident, "application", "", "manage_application")

    @app.exception_handler(runtime.Denied)
    async def _denied(_: Request, __: runtime.Denied):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": DENIED.detail}, status_code=403)

    @app.exception_handler(runtime.NotFound)
    async def _nf(_: Request, __):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Record not found."}, status_code=404)

    @app.exception_handler(runtime.VersionChanged)
    async def _version(_: Request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse({"error": "version_changed", "current": exc.current}, status_code=409)

    @app.exception_handler(runtime.FormRequired)
    async def _form_required(_: Request, exc):
        from fastapi.responses import JSONResponse
        names = ", ".join(exc.forms)
        return JSONResponse({"error": "form_required", "forms": exc.forms,
                             "detail": f"Records in this table are saved through a form, so that its rules apply. Use: {names}."},
                            status_code=409)

    @app.exception_handler(runtime.Unprocessable)
    async def _unprocessable(_: Request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse(exc.payload, status_code=422)

    @app.exception_handler(runtime.BadRequest)
    async def _bad(_: Request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(psycopg.errors.IntegrityError)
    async def _integrity(_: Request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": f"The data breaks a rule: {exc.diag.message_primary}"}, status_code=409)

    @app.exception_handler(psycopg.errors.DataError)
    async def _data(_: Request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": f"A value is not valid: {exc.diag.message_primary}"}, status_code=400)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    # ---- authoring ----
    @app.post("/api/authoring/import-jobs")
    def create_job(extraction: Extraction, ident: Identity = Depends(identity)):
        need_role(ident, "app_owner")
        with db.transaction() as conn:
            job, a = pub.create_job(conn, ident.user_id, extraction)
            return pub.get_report(conn, job)

    @app.get("/api/authoring/import-jobs/{job_id}/report")
    def report(job_id: int, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            r = pub.get_report(conn, job_id)
            if not r or (r["owner_id"] != ident.user_id and not ident.is_admin):
                raise DENIED
            return r

    @app.post("/api/authoring/import-jobs/{job_id}/publish")
    def publish_job(job_id: int, body: PublishIn, ident: Identity = Depends(identity)):
        need_role(ident, "app_owner")
        try:
            with db.transaction() as conn:
                out = pub.publish(conn, job_id, ident, slug=body.slug, name=body.name, description=body.description,
                                  icon=body.icon, confirmed_classification=body.confirmed_classification,
                                  permissions_confirmed=body.permissions_confirmed,
                                  grants=[g.model_dump() for g in body.grants], forms=body.forms)
        except pub.PublishError as e:
            raise HTTPException(400, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        except psycopg.Error as e:
            # Source data that breaks a rule. The transaction rolled back, so nothing was created.
            raise HTTPException(400, f"Publishing failed and nothing was created: {e.diag.message_primary}")
        portal.register(Tile(body.slug, body.name, body.description, body.icon, ident.user_id, f"/apps/{body.slug}"))
        return out

    @app.post("/api/apps/{slug}/versions")
    def publish_version(slug: str, body: VersionIn, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            row = conn.execute("select id from a2w_control.applications where slug = %s and status = 'published'", (slug,)).fetchone()
            if not row or not can_manage(conn, row, ident):
                raise DENIED
            try:
                return pub.republish(conn, slug, ident, base_version=body.base_version, renames=body.renames, forms=body.forms)
            except pub.Busy as e:
                raise HTTPException(409, str(e))
            except pub.PublishError as e:
                raise HTTPException(400, str(e))
            except psycopg.Error as e:
                raise HTTPException(400, f"Publishing failed and nothing was changed: {e.diag.message_primary}")

    @app.post("/api/apps/{slug}/unpublish")
    def unpublish(slug: str, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            row = conn.execute("select id from a2w_control.applications where slug = %s and status = 'published'", (slug,)).fetchone()
            if not row or not can_manage(conn, row, ident):
                raise DENIED
            conn.execute("update a2w_control.applications set status = 'unpublished' where id = %s", (row["id"],))
            db.audit(conn, ident.user_id, "unpublish", app=slug)
        portal.unregister(slug)
        return {"slug": slug, "status": "unpublished"}

    # ---- portal ----
    @app.get("/api/portal/tiles")
    def tiles(ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            ids = authz.visible_app_ids(conn, ident)
            if not ids:
                return []
            rows = conn.execute("select slug, name, description, icon, owner_id from a2w_control.applications "
                                "where id = any(%s) order by name", (list(ids),)).fetchall()
        return [{**r, "launch": f"/apps/{r['slug']}"} for r in rows]

    # ---- permissions ----
    @app.get("/api/apps/{slug}/grants")
    def list_grants(slug: str, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            row = conn.execute("select id from a2w_control.applications where slug = %s", (slug,)).fetchone()
            if not row or not can_manage(conn, row, ident):
                raise DENIED
            return conn.execute("select id, subject_type, subject_id, resource_type, resource_id, level "
                                "from a2w_control.grants where app_id = %s order by id", (row["id"],)).fetchall()

    @app.post("/api/apps/{slug}/grants", status_code=201)
    def add_grant(slug: str, g: GrantIn, ident: Identity = Depends(identity)):
        try:
            authz.validate_grant(g.subject_type, g.resource_type, g.resource_id, g.level)
        except ValueError as e:
            raise HTTPException(400, str(e))
        with db.transaction() as conn:
            row = conn.execute("select id from a2w_control.applications where slug = %s", (slug,)).fetchone()
            if not row or not can_manage(conn, row, ident):
                raise DENIED
            conn.execute("insert into a2w_control.grants(app_id, subject_type, subject_id, resource_type, resource_id, level, granted_by) "
                         "values (%s,%s,%s,%s,%s,%s,%s) on conflict do nothing",
                         (row["id"], g.subject_type, g.subject_id, g.resource_type, g.resource_id, g.level, ident.user_id))
            db.audit(conn, ident.user_id, "grant", app=slug, obj=g.resource_id or "application",
                     detail={"subject": f"{g.subject_type}:{g.subject_id}", "level": g.level})
        return {"status": "granted"}

    @app.delete("/api/apps/{slug}/grants/{grant_id}")
    def revoke_grant(slug: str, grant_id: int, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            row = conn.execute("select id from a2w_control.applications where slug = %s", (slug,)).fetchone()
            if not row or not can_manage(conn, row, ident):
                raise DENIED
            g = conn.execute("delete from a2w_control.grants where id = %s and app_id = %s returning *", (grant_id, row["id"])).fetchone()
            if not g:
                raise HTTPException(404, "Grant not found.")
            db.audit(conn, ident.user_id, "revoke", app=slug, obj=g["resource_id"] or "application",
                     detail={"subject": f"{g['subject_type']}:{g['subject_id']}", "level": g["level"]})
        return {"status": "revoked"}

    # ---- runtime ----
    @app.get("/api/apps/{slug}")
    def app_info(slug: str, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            row, d = runtime.load_app(conn, slug)
            if row["id"] not in authz.visible_app_ids(conn, ident):
                raise DENIED
            tables = [e.name for e in d.entities
                      if authz.can(conn, row["id"], ident, "table", e.name, "view_data")]
            forms = [{"name": f["name"], "title": f.get("title", f["name"]), "entity": f["entity"]} for f in d.forms
                     if authz.can(conn, row["id"], ident, "form", f["name"], "view_data")]
            return {"slug": slug, "name": row["name"], "tables": tables, "forms": forms,
                    "entities": [e.model_dump(mode="json", include={"name", "source_name", "fields", "primary_key"})
                                 for e in d.entities if e.name in tables]}

    @app.get("/api/apps/{slug}/forms/{form}")
    def get_form(slug: str, form: str, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            return runtime.get_form(conn, slug, ident, form)

    @app.post("/api/apps/{slug}/forms/{form}/records", status_code=201)
    def save_form_new(slug: str, form: str, body: FormSaveIn, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            return runtime.save_form(conn, slug, ident, form, body.values, version=body.version)

    @app.put("/api/apps/{slug}/forms/{form}/records/{key}")
    def save_form_existing(slug: str, form: str, key: str, body: FormSaveIn, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            return runtime.save_form(conn, slug, ident, form, body.values, version=body.version, key=key)

    @app.get("/api/apps/{slug}/tables/{table}/records")
    def list_records(slug: str, table: str, limit: int = 100, offset: int = 0, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            return runtime.list_records(conn, slug, ident, table, limit, offset)

    @app.get("/api/apps/{slug}/tables/{table}/records/{key}")
    def get_record(slug: str, table: str, key: str, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            return runtime.get_record(conn, slug, ident, table, key)

    @app.post("/api/apps/{slug}/tables/{table}/records", status_code=201)
    def create_record(slug: str, table: str, values: dict[str, Any], ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            return runtime.create_record(conn, slug, ident, table, values)

    @app.put("/api/apps/{slug}/tables/{table}/records/{key}")
    def update_record(slug: str, table: str, key: str, values: dict[str, Any], ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            return runtime.update_record(conn, slug, ident, table, key, values)

    @app.delete("/api/apps/{slug}/tables/{table}/records/{key}", status_code=204)
    def delete_record(slug: str, table: str, key: str, ident: Identity = Depends(identity)):
        with db.transaction() as conn:
            runtime.delete_record(conn, slug, ident, table, key)

    # ---- audit ----
    @app.get("/api/audit")
    def audit_search(app: str = "", actor: str = "", action: str = "", limit: int = 100,
                     ident: Identity = Depends(identity)):
        need_role(ident, "auditor")
        limit = max(1, min(limit, 1000))
        with db.transaction() as conn:
            return conn.execute(
                "select seq, ts, actor, app, object, action, detail from a2w_control.audit_events "
                "where (%s = '' or app = %s) and (%s = '' or actor = %s) and (%s = '' or action = %s) "
                "order by seq desc limit %s", (app, app, actor, actor, action, action, limit)).fetchall()

    @app.get("/api/audit/verify")
    def audit_verify(ident: Identity = Depends(identity)):
        need_role(ident, "auditor")
        with db.transaction() as conn:
            bad = conn.execute("select a2w_control.audit_verify() as bad").fetchone()["bad"]
        return {"intact": bad is None, "first_bad_seq": bad}

    web_dir = os.environ.get("A2W_WEB_DIR")
    if web_dir and os.path.isdir(web_dir):
        from fastapi.staticfiles import StaticFiles
        app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")  # last, so API routes win

    return app


app = create_app()
