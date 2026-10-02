"""Rename a field or an entity: change the stored definition and generate the SQL that carries the change to the data.

The browser sends renames as structured operations, never as SQL. Every identifier passes through names.check_ident
and is quoted by psycopg, so a name cannot change the shape of a statement.

A rename keeps the data, because PostgreSQL renames the column or table in place. The definition's foreign keys,
indexes, and primary key are changed here, so that it still describes the database.
"""
from typing import Literal

from psycopg import sql
from pydantic import BaseModel, ConfigDict, Field

from .definition import Definition
from .names import check_ident, schema_for


class MigrationError(ValueError):
    """The rename cannot be applied. Nothing has changed."""


class Rename(BaseModel):
    """`{"kind": "field", "entity": "customers", "from": "email", "to": "mail"}` or
    `{"kind": "entity", "from": "customers", "to": "clients"}`."""
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    kind: Literal["field", "entity"]
    entity: str = ""
    from_: str = Field(alias="from")
    to: str


def _swap(names: list[str], old: str, new: str) -> list[str]:
    return [new if n == old else n for n in names]


def apply(slug: str, definition: Definition, renames: list[Rename]) -> tuple[Definition, list[sql.Composable]]:
    """Apply renames in order, each checked against the result of the one before. Returns a new definition and the SQL.

    The input definition is not changed. Forms are not changed either: the caller sends the forms it wants, and
    publishing checks them against the renamed entities.
    """
    d = definition.model_copy(deep=True)
    schema = sql.Identifier(schema_for(slug))
    out: list[sql.Composable] = []
    for r in renames:
        try:
            check_ident(r.to)
        except ValueError:
            raise MigrationError(f"{r.to!r} is not a valid name: use lower-case letters, digits, and underscores, "
                                 f"starting with a letter or underscore") from None
        if r.from_ == r.to:
            raise MigrationError(f"{r.from_} is already called {r.to}")
        if r.kind == "entity":
            ent = d.entity(r.from_)
            if ent is None:
                raise MigrationError(f"unknown entity {r.from_}")
            if d.entity(r.to):
                raise MigrationError(f"entity {r.to} already exists")
            ent.name = r.to
            for other in d.entities:
                for fk in other.foreign_keys:
                    if fk.ref_entity == r.from_:
                        fk.ref_entity = r.to
            out.append(sql.SQL("alter table {}.{} rename to {}").format(schema, sql.Identifier(r.from_), sql.Identifier(r.to)))
        else:
            ent = d.entity(r.entity)
            if ent is None:
                raise MigrationError(f"unknown entity {r.entity}")
            fld = ent.field(r.from_)
            if fld is None:
                raise MigrationError(f"unknown field {r.from_} in {r.entity}")
            if ent.field(r.to):
                raise MigrationError(f"{r.entity} already has a field {r.to}")
            fld.name = r.to
            ent.primary_key = _swap(ent.primary_key, r.from_, r.to)
            for ix in ent.indexes:
                ix.columns = _swap(ix.columns, r.from_, r.to)
            for fk in ent.foreign_keys:
                fk.columns = _swap(fk.columns, r.from_, r.to)
            for other in d.entities:
                for fk in other.foreign_keys:
                    if fk.ref_entity == ent.name:
                        fk.ref_columns = _swap(fk.ref_columns, r.from_, r.to)
            out.append(sql.SQL("alter table {}.{} rename column {} to {}").format(
                schema, sql.Identifier(ent.name), sql.Identifier(r.from_), sql.Identifier(r.to)))
    return d, out
