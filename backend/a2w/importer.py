"""Analyser: builds an application definition and a conversion report from extracted Access metadata.

The extraction input is the JSON shape the native tier (Jackcess) and the Windows worker emit.
The analyser never reads an Access file itself.
"""
import re
from pydantic import BaseModel, Field

from . import vba
from .dataclass import classify_fields
from .definition import (ConversionItem, Default, Definition, Entity, FieldDef,
                         ForeignKeyDef, IndexDef)
from .names import normalise
from .typemap import map_type


class XField(BaseModel):
    name: str
    type: str
    size: int | None = None
    precision: int | None = None
    scale: int | None = None
    required: bool = False
    default: str | None = None
    calculated: str | None = None


class XIndex(BaseModel):
    name: str
    columns: list[str]
    unique: bool = False


class XTable(BaseModel):
    name: str
    fields: list[XField]
    primary_key: list[str] = Field(default_factory=list)
    indexes: list[XIndex] = Field(default_factory=list)
    rows: list[dict] = Field(default_factory=list)


class XRelationship(BaseModel):
    name: str | None = None
    table: str
    columns: list[str]
    ref_table: str
    ref_columns: list[str]


class XNamed(BaseModel):
    name: str


class XModule(BaseModel):
    name: str
    source: str = ""


class Extraction(BaseModel):
    tables: list[XTable]
    relationships: list[XRelationship] = Field(default_factory=list)
    queries: list[XNamed] = Field(default_factory=list)
    forms: list[XNamed] = Field(default_factory=list)
    reports: list[XNamed] = Field(default_factory=list)
    macros: list[XNamed] = Field(default_factory=list)
    modules: list[XModule] = Field(default_factory=list)


class Analysis(BaseModel):
    definition: Definition
    items: list[ConversionItem]
    classification: dict
    # Per table: source field name -> field name, used to load rows.
    row_map: dict[str, dict[str, str]]


_NUM = re.compile(r"^-?\d+(\.\d+)?$")


def _default(expr: str | None) -> tuple[Default | None, str | None]:
    if expr is None or expr.strip() == "":
        return None, None
    e = expr.strip()
    if e.startswith("="):
        e = e[1:].strip()
    low = e.lower()
    if _NUM.match(e):
        return Default(kind="number", value=e), None
    if len(e) >= 2 and e[0] == e[-1] == '"':
        return Default(kind="string", value=e[1:-1].replace('""', '"')), None
    if low in ("true", "yes", "-1", "on"):
        return Default(kind="boolean", value="true"), None
    if low in ("false", "no", "off"):
        return Default(kind="boolean", value="false"), None
    if low in ("now()", "now"):
        return Default(kind="now"), None
    if low in ("date()", "date"):
        return Default(kind="today"), None
    return None, f"default expression {expr!r} is not supported; no default set"


def analyse(ex: Extraction) -> Analysis:
    items: list[ConversionItem] = []
    entities: list[Entity] = []
    row_map: dict[str, dict[str, str]] = {}
    table_names: set[str] = set()
    by_source: dict[str, Entity] = {}

    for t in ex.tables:
        ename = normalise(t.name, table_names, "t")
        used: set[str] = set()
        fields: list[FieldDef] = []
        fmap: dict[str, str] = {}
        notes: list[str] = []
        for f in t.fields:
            m = map_type(f.type, f.size, f.precision, f.scale)
            if m.pg_type is None:
                notes.append(f"{f.name}: {m.note}")
                items.append(ConversionItem(object_type="field", name=f"{t.name}.{f.name}",
                                            status="not_converted", reason=m.note or ""))
                continue
            fname = normalise(f.name, used, "f")
            default, dnote = _default(f.default)
            if m.note:
                notes.append(f"{f.name}: {m.note}")
            if dnote:
                notes.append(f"{f.name}: {dnote}")
            if f.calculated:
                notes.append(f"{f.name}: calculated expression not converted; migrated values are static")
            fields.append(FieldDef(name=fname, source_name=f.name, type=m.pg_type, identity=m.identity,
                                   required=f.required or m.identity, default=None if m.identity else default))
            fmap[f.name] = fname
        pk = [fmap[c] for c in t.primary_key if c in fmap]
        if t.primary_key and len(pk) != len(t.primary_key):
            pk = []
            notes.append("primary key includes a field that was not migrated; no primary key created")
        indexes, idx_used = [], set()
        for ix in t.indexes:
            cols = [fmap[c] for c in ix.columns if c in fmap]
            if len(cols) != len(ix.columns):
                items.append(ConversionItem(object_type="index", name=f"{t.name}.{ix.name}",
                                            status="not_converted", reason="index uses a field that was not migrated"))
                continue
            indexes.append(IndexDef(name=normalise(f"{ename}_{ix.name}", idx_used, "ix"), columns=cols, unique=ix.unique))
        ent = Entity(name=ename, source_name=t.name, fields=fields, primary_key=pk, indexes=indexes)
        if len(pk) != 1:
            notes.append("no single-column primary key; records can be listed and created but not edited or deleted")
        entities.append(ent)
        by_source[t.name] = ent
        row_map[ename] = fmap
        items.append(ConversionItem(object_type="table", name=t.name,
                                    status="partly_converted" if notes else "converted", reason="; ".join(notes)))

    fk_used: set[str] = set()
    for r in ex.relationships:
        label = r.name or f"{r.table}->{r.ref_table}"
        child, parent = by_source.get(r.table), by_source.get(r.ref_table)
        if not child or not parent:
            items.append(ConversionItem(object_type="relationship", name=label, status="not_converted",
                                        reason="a table in the relationship does not exist in the source"))
            continue
        cmap, pmap = row_map[child.name], row_map[parent.name]
        cols = [cmap.get(c) for c in r.columns]
        refs = [pmap.get(c) for c in r.ref_columns]
        if None in cols or None in refs or len(cols) != len(refs):
            items.append(ConversionItem(object_type="relationship", name=label, status="not_converted",
                                        reason="relationship uses a field that was not migrated"))
            continue
        target_unique = refs == parent.primary_key or any(i.unique and i.columns == refs for i in parent.indexes)
        if not target_unique:
            items.append(ConversionItem(object_type="relationship", name=label, status="not_converted",
                                        reason="referenced fields are not a primary key or unique index"))
            continue
        child.foreign_keys.append(ForeignKeyDef(name=normalise(f"fk_{child.name}_{parent.name}", fk_used, "fk"),
                                                columns=cols, ref_entity=parent.name, ref_columns=refs))
        items.append(ConversionItem(object_type="relationship", name=label, status="converted"))

    for q in ex.queries:
        items.append(ConversionItem(object_type="query", name=q.name, status="not_converted",
                                    reason="query translation is not built yet (Spike 2)"))
    for f in ex.forms:
        items.append(ConversionItem(object_type="form", name=f.name, status="not_converted",
                                    reason="form generation is a phase 2 feature; use the generated table screens"))
    for r in ex.reports:
        items.append(ConversionItem(object_type="report", name=r.name, status="not_converted",
                                    reason="report generation is a phase 2 feature"))
    for m in ex.macros:
        items.append(ConversionItem(object_type="macro", name=m.name, status="not_converted",
                                    reason="macro conversion is not built yet"))

    for p in vba.inventory([m.model_dump() for m in ex.modules]):
        status = {vba.STANDARD: "not_converted", vba.TRANSLATABLE: "not_converted", vba.MANUAL: "not_converted"}[p.vba_class]
        where = f" (belongs to {p.belongs_to})" if p.belongs_to else ""
        reason = {
            vba.STANDARD: "standard pattern; fixed-mapping conversion is a phase 2 feature",
            vba.TRANSLATABLE: "translatable logic; AI translation is a phase 3 feature",
            vba.MANUAL: f"manual redesign: {p.reason}",
        }[p.vba_class]
        items.append(ConversionItem(object_type="procedure", name=f"{p.module}.{p.name}{where}", status=status,
                                    reason=reason, vba_class=p.vba_class, suggestion=p.suggestion))

    definition = Definition(app="", entities=entities)
    classification = classify_fields([(e.name, [f.name for f in e.fields]) for e in entities])
    return Analysis(definition=definition, items=items, classification=classification, row_map=row_map)


def summarise(items: list[ConversionItem]) -> dict:
    out = {"converted": 0, "partly_converted": 0, "not_converted": 0}
    for i in items:
        out[i.status] += 1
    out["total"] = len(items)
    return out
