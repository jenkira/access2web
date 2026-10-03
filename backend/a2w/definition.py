"""Application definition: the versioned JSON document the runtime interprets."""
from typing import Any, Literal
from pydantic import BaseModel, Field

Status = Literal["converted", "partly_converted", "not_converted"]


class Default(BaseModel):
    kind: Literal["number", "string", "boolean", "now", "today"]
    value: str | None = None


class FieldDef(BaseModel):
    name: str
    source_name: str
    type: str
    required: bool = False
    identity: bool = False
    default: Default | None = None


class IndexDef(BaseModel):
    name: str
    columns: list[str]
    unique: bool = False


class ForeignKeyDef(BaseModel):
    name: str
    columns: list[str]
    ref_entity: str
    ref_columns: list[str]


class Entity(BaseModel):
    name: str
    source_name: str
    fields: list[FieldDef]
    primary_key: list[str] = Field(default_factory=list)
    indexes: list[IndexDef] = Field(default_factory=list)
    foreign_keys: list[ForeignKeyDef] = Field(default_factory=list)

    def field(self, name: str) -> FieldDef | None:
        return next((f for f in self.fields if f.name == name), None)

    @property
    def single_key(self) -> str | None:
        return self.primary_key[0] if len(self.primary_key) == 1 else None


class ConversionItem(BaseModel):
    object_type: Literal["table", "field", "relationship", "index", "query", "form", "report", "macro", "procedure"]
    name: str
    status: Status
    reason: str = ""
    vba_class: str | None = None
    suggestion: str | None = None


class Definition(BaseModel):
    app: str
    version: int = 1
    entities: list[Entity]
    # Forms are JSON as the editor writes them: rows of controls. a2w.formrules checks them and applies their rules.
    forms: list[dict[str, Any]] = Field(default_factory=list)

    def entity(self, name: str) -> Entity | None:
        return next((e for e in self.entities if e.name == name), None)
