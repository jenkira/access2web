"""Identifier handling. Every identifier in generated SQL passes through here."""
import re

_IDENT = re.compile(r"^[a-z_][a-z0-9_]{0,62}\Z")  # \Z, because $ also matches before a trailing newline
SLUG = re.compile(r"^[a-z][a-z0-9_]{1,40}\Z")


def normalise(source: str, used: set[str], prefix: str = "x") -> str:
    """Return a unique, lower-case PostgreSQL identifier derived from an Access name."""
    name = re.sub(r"[^a-z0-9]+", "_", source.lower()).strip("_")
    if not name or name[0].isdigit():
        name = f"{prefix}_{name}".rstrip("_")
    name = name[:60]
    candidate, n = name, 2
    while candidate in used:
        candidate = f"{name}_{n}"
        n += 1
    used.add(candidate)
    return candidate


def check_ident(name: str) -> str:
    if not _IDENT.match(name):
        raise ValueError(f"invalid identifier: {name!r}")
    return name


def quote(name: str) -> str:
    """Quote a validated identifier."""
    return '"' + check_ident(name) + '"'


def check_slug(slug: str) -> str:
    if not SLUG.match(slug):
        raise ValueError("slug must start with a letter and use 2 to 41 lower-case letters, digits, or underscores")
    return slug


def schema_for(slug: str) -> str:
    return "app_" + check_slug(slug)
