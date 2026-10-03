"""Access to PostgreSQL type mapping (technical design, Table 4)."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Mapped:
    pg_type: str | None  # None means the field is not migrated
    identity: bool = False
    note: str | None = None  # reason when the field is only partly converted
    max_length: int | None = None  # the field size from Access, kept as a check because citext has no length


_SIMPLE = {
    # Access ignores case when it compares, groups, sorts, and removes duplicates from text, so text is citext (decision D22).
    "long text": "citext", "memo": "citext", "hyperlink": "citext",
    "byte": "smallint", "integer": "smallint", "long integer": "integer",
    "single": "real", "double": "double precision",
    "currency": "numeric(19,4)", "date/time": "timestamp",
    "yes/no": "boolean", "replication id": "uuid",
}


def map_type(access_type: str, size: int | None = None,
             precision: int | None = None, scale: int | None = None) -> Mapped:
    t = access_type.strip().lower()
    if t in ("short text", "text"):
        return Mapped("citext", max_length=int(size) if size else 255)
    if t == "autonumber":
        return Mapped("integer", identity=True)
    if t in ("decimal", "numeric"):
        if precision and scale is not None:
            return Mapped(f"numeric({int(precision)},{int(scale)})")
        return Mapped("numeric", note="precision and scale missing from source; used unconstrained numeric")
    if t in _SIMPLE:
        return Mapped(_SIMPLE[t])
    if t in ("ole object", "attachment"):
        return Mapped(None, note="binary data needs object storage, which is not built yet; field not migrated")
    if t in ("multi-value", "multivalue", "multi-value field"):
        return Mapped(None, note="multi-value fields need a junction table, which is not built yet; field not migrated")
    return Mapped(None, note=f"unknown Access type {access_type!r}; field not migrated")
