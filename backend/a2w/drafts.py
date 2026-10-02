"""A saved draft with a lock: the edits to the next version of an application, held by one designer at a time.

The draft is the editor's log of operations, stored as the editor wrote it. The backend cannot replay the log, so it only
checks its shape and size. The editor replays it on resume, and publishing checks the result: the forms and the renames
that the editor sends are validated again by publish.republish.

The lock is a lease. It lasts LEASE_SECONDS from the last save, and every save extends it. When it has lapsed, another
designer may take the draft over, and the earlier holder's next save is refused. A person with manage application can
discard a draft at any time.
"""
import json

from psycopg.types.json import Jsonb

from . import authz, db, runtime

LEASE_SECONDS = 30 * 60
MAX_OPS = 5000
MAX_BYTES = 1_000_000


class DraftLocked(Exception):
    """Someone else holds the draft."""

    def __init__(self, locked_by: str, expires_at) -> None:
        super().__init__(f"draft is locked by {locked_by}")
        self.locked_by, self.expires_at = locked_by, expires_at


class DraftOutOfDate(Exception):
    """The draft started from a version that is no longer current."""

    def __init__(self, base: int, current: int) -> None:
        super().__init__(f"draft started from version {base}, now {current}")
        self.base, self.current = base, current


class NoDraft(Exception):
    """There is no draft to save to. Take the lock first."""


class BadDraft(ValueError):
    """The log is not a list of operations, or it is too large."""


def _app(conn, slug: str, ident: authz.Identity) -> dict:
    """The application, if the person may design it. A missing application and a refusal look alike."""
    app, _ = runtime.load_app(conn, slug)
    if not (ident.is_admin or authz.can(conn, app["id"], ident, "application", "", "design_application")):
        raise runtime.Denied()
    return app


def _can_manage(conn, app: dict, ident: authz.Identity) -> bool:
    return ident.is_admin or authz.can(conn, app["id"], ident, "application", "", "manage_application")


def _check_log(log) -> list:
    if not isinstance(log, list) or len(log) > MAX_OPS or not all(isinstance(o, dict) and isinstance(o.get("t"), str) for o in log):
        raise BadDraft(f"the draft must be a list of at most {MAX_OPS} operations, each with a type")
    if len(json.dumps(log)) > MAX_BYTES:
        raise BadDraft("the draft is too large")
    return log


def _row(conn, app_id: int):
    """The draft, locked for this transaction, with whether its lease has lapsed."""
    return conn.execute("select *, expires_at <= now() as expired from a2w_control.drafts where app_id = %s for update", (app_id,)).fetchone()


def view(conn, slug: str, ident: authz.Identity) -> dict:
    """Who holds the draft, and until when. The log goes only to the holder."""
    app = _app(conn, slug, ident)
    d = conn.execute("select *, expires_at <= now() as expired from a2w_control.drafts where app_id = %s", (app["id"],)).fetchone()
    out: dict = {"current_version": app["current_version"], "draft": None}
    if d:
        mine = d["locked_by"] == ident.user_id
        out["draft"] = {"locked_by": d["locked_by"], "base_version": d["base_version"], "expires_at": d["expires_at"],
                        "expired": d["expired"], "mine": mine, "stale": d["base_version"] != app["current_version"]}
        if mine:
            out["draft"]["log"] = d["log"]
    return out


def lock(conn, slug: str, ident: authz.Identity) -> dict:
    """Take the draft, or resume one that is already yours. Takes over a lapsed draft, and its log is dropped."""
    app = _app(conn, slug, ident)
    me, current = ident.user_id, app["current_version"]
    new = ("insert into a2w_control.drafts(app_id, locked_by, base_version, log, expires_at) "
           "values (%s, %s, %s, '[]'::jsonb, now() + make_interval(secs => %s)) on conflict (app_id) do nothing returning *")
    d = conn.execute(new, (app["id"], me, current, LEASE_SECONDS)).fetchone()
    if d:
        db.audit(conn, me, "draft_locked", app=slug, detail={"base_version": current})
        return _lock_result(d)
    d = _row(conn, app["id"])
    if d["locked_by"] != me:
        if not d["expired"]:
            raise DraftLocked(d["locked_by"], d["expires_at"])
        previous = d["locked_by"]
        d = conn.execute("update a2w_control.drafts set locked_by = %s, locked_at = now(), base_version = %s, log = '[]'::jsonb, "
                         "expires_at = now() + make_interval(secs => %s) where app_id = %s returning *",
                         (me, current, LEASE_SECONDS, app["id"])).fetchone()
        db.audit(conn, me, "draft_taken_over", app=slug, detail={"from": previous, "base_version": current})
        return _lock_result(d)
    if d["base_version"] != current:
        raise DraftOutOfDate(d["base_version"], current)
    d = conn.execute("update a2w_control.drafts set expires_at = now() + make_interval(secs => %s) where app_id = %s returning *",
                     (LEASE_SECONDS, app["id"])).fetchone()
    return _lock_result(d)


def _lock_result(d: dict) -> dict:
    return {"base_version": d["base_version"], "log": d["log"], "expires_at": d["expires_at"]}


def save(conn, slug: str, ident: authz.Identity, log) -> dict:
    """Replace the draft's log. Only the holder may save, and a save extends the lease."""
    app = _app(conn, slug, ident)
    log = _check_log(log)
    d = _row(conn, app["id"])
    if d is None:
        raise NoDraft()
    if d["locked_by"] != ident.user_id:
        raise DraftLocked(d["locked_by"], d["expires_at"])
    d = conn.execute("update a2w_control.drafts set log = %s, expires_at = now() + make_interval(secs => %s) "
                     "where app_id = %s returning *", (Jsonb(log), LEASE_SECONDS, app["id"])).fetchone()
    return {"saved": len(log), "expires_at": d["expires_at"], "stale": d["base_version"] != app["current_version"]}


def discard(conn, slug: str, ident: authz.Identity) -> dict:
    """Throw the draft away. The holder may, anyone with design may once the lease has lapsed, and manage may at any time."""
    app = _app(conn, slug, ident)
    d = _row(conn, app["id"])
    if d is None:
        return {"discarded": False}
    if d["locked_by"] != ident.user_id and not d["expired"] and not _can_manage(conn, app, ident):
        raise DraftLocked(d["locked_by"], d["expires_at"])
    conn.execute("delete from a2w_control.drafts where app_id = %s", (app["id"],))
    db.audit(conn, ident.user_id, "draft_discarded", app=slug, detail={"held_by": d["locked_by"], "edits": len(d["log"])})
    return {"discarded": True}


def check_not_locked_by_another(conn, app_id: int, ident: authz.Identity) -> None:
    """Called by publish: a new version must not run over someone else's active draft."""
    d = _row(conn, app_id)
    if d and not d["expired"] and d["locked_by"] != ident.user_id:
        raise DraftLocked(d["locked_by"], d["expires_at"])
