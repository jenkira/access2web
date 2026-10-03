"""Authorisation: grants, resolution, and enforcement. Denies by default."""
from dataclasses import dataclass, field

LEVELS = ("open_application", "view_data", "edit_data", "delete_data", "run_reports",
          "design_application", "manage_application")

# A grant also covers the levels it implies. Delete does not imply view.
IMPLIES = {
    "manage_application": {"design_application", "open_application"},
    "design_application": {"open_application"},
    "edit_data": {"view_data", "open_application"},
    "delete_data": {"open_application"},
    "view_data": {"open_application"},
    "run_reports": {"open_application"},
}

APP_ONLY = {"open_application", "design_application", "manage_application"}


@dataclass(frozen=True)
class Identity:
    user_id: str
    groups: tuple[str, ...] = ()
    roles: tuple[str, ...] = ()

    @property
    def subjects(self) -> set[tuple[str, str]]:
        return ({("user", self.user_id)} | {("group", g) for g in self.groups} | {("role", r) for r in self.roles})

    @property
    def is_admin(self) -> bool:
        return "platform_admin" in self.roles


@dataclass(frozen=True)
class Grant:
    subject_type: str
    subject_id: str
    resource_type: str
    resource_id: str
    level: str


def covers(level: str, required: str) -> bool:
    return level == required or required in IMPLIES.get(level, set())


def decide(grants: list[Grant], ident: Identity, resource_type: str, resource_id: str, required: str) -> bool:
    """Apply the resolution rules from the technical design.

    1. Collect the user's identities.
    2. If any of those identities has a grant on the object, use only the grants on that object.
    3. Otherwise use the grants on the application.
    4. Allow if any collected grant covers the required level.
    5. Otherwise deny.
    """
    mine = [g for g in grants if (g.subject_type, g.subject_id) in ident.subjects]
    if resource_type != "application":
        on_object = [g for g in mine if g.resource_type == resource_type and g.resource_id == resource_id]
        if on_object:
            return any(covers(g.level, required) for g in on_object)
    on_app = [g for g in mine if g.resource_type == "application"]
    return any(covers(g.level, required) for g in on_app)


def load_grants(conn, app_id: int) -> list[Grant]:
    rows = conn.execute("select subject_type, subject_id, resource_type, resource_id, level "
                        "from a2w_control.grants where app_id = %s", (app_id,)).fetchall()
    return [Grant(**r) for r in rows]


def can(conn, app_id: int, ident: Identity, resource_type: str, resource_id: str, required: str) -> bool:
    # Read grants on every call so a change applies at once, with no sign-in needed.
    return decide(load_grants(conn, app_id), ident, resource_type, resource_id, required)


def visible_app_ids(conn, ident: Identity) -> set[int]:
    """Applications on which the identity holds any grant. Used for the portal tile list."""
    subs = ident.subjects
    rows = conn.execute("select g.app_id, g.subject_type, g.subject_id from a2w_control.grants g "
                        "join a2w_control.applications a on a.id = g.app_id where a.status = 'published'").fetchall()
    return {r["app_id"] for r in rows if (r["subject_type"], r["subject_id"]) in subs}


def validate_grant(subject_type: str, resource_type: str, resource_id: str, level: str) -> None:
    if level not in LEVELS:
        raise ValueError(f"unknown level {level!r}")
    if subject_type not in ("user", "group", "role"):
        raise ValueError(f"unknown subject type {subject_type!r}")
    if resource_type == "application":
        if resource_id:
            raise ValueError("application grants take no resource id")
    else:
        if resource_type not in ("table", "form", "report") or not resource_id:
            raise ValueError("object grants need a resource type and id")
        if level in APP_ONLY:
            raise ValueError(f"level {level} applies to the whole application")
