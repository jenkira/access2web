"""Database access. One connection for each unit of work, in a transaction."""
import os
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

from .controldb import BOOTSTRAP


def database_url() -> str:
    return os.environ.get("A2W_DATABASE_URL", "postgresql://postgres:test@127.0.0.1:54329/postgres")


@contextmanager
def transaction(url: str | None = None):
    with psycopg.connect(url or database_url(), row_factory=dict_row) as conn:
        yield conn  # commits on success and rolls back on an exception


def bootstrap(url: str | None = None) -> None:
    with transaction(url) as conn:
        conn.execute(BOOTSTRAP)


def audit(conn, actor: str, action: str, app: str = "", obj: str = "", detail: dict | None = None) -> int:
    from psycopg.types.json import Jsonb
    row = conn.execute("select a2w_control.audit_append(%s, %s, %s, %s, %s) as seq",
                       (actor, app, obj, action, Jsonb(detail or {}))).fetchone()
    return row["seq"]
