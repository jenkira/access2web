"""Run the Spike 2 measurement. Usage: python run_spike.py

Needs: PostgreSQL (A2W_SPIKE_ADMIN_URL), Java, and UCanAccess jars in UC_LIB.
"""
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import psycopg

import corpus
import fixtures
import reference
from jet2pg import translate
from jet2pg.translate import PRELUDE

HERE = Path(__file__).parent
WORK = HERE / "work"
ADMIN = os.environ.get("A2W_SPIKE_ADMIN_URL", "postgresql://postgres:test@127.0.0.1:54329/postgres")
UC_LIB = os.environ.get("UC_LIB", "/var/tmp/sp/uc/lib")
DB = "a2w_spike2"


def unesc(s: str) -> str:
    return re.sub(r"\\(.)", lambda m: {"t": "\t", "n": "\n", "r": "\r"}.get(m.group(1), m.group(1)), s)


def oracle_literal(v) -> str:
    if isinstance(v, datetime):
        return f"#{v.month}/{v.day}/{v.year}#"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return str(v)


def oracle_sql(entry) -> str:
    sql = entry["oracle"] or entry["sql"]
    if entry["params"]:
        sql = re.sub(r"^PARAMETERS[^;]*;\s*", "", sql, flags=re.I)
        for k, v in entry["params"].items():
            sql = sql.replace(f"[{k}]", oracle_literal(v))
    return sql


def run_oracle() -> dict[str, dict]:
    WORK.mkdir(exist_ok=True)
    (WORK / "schema.sql").write_text("\n".join(fixtures.access_ddl()) + "\n")
    (WORK / "data.tsv").write_text(fixtures.tsv_data())
    lines = []
    for e in corpus.C:
        lines.append("\t".join([e["id"], e["kind"], e["check"] or "-", oracle_sql(e)]))
    (WORK / "queries.tsv").write_text("\n".join(lines) + "\n")
    out = WORK / "oracle_out"
    for f in out.glob("*.tsv") if out.exists() else []:
        f.unlink()
    cp = f"{UC_LIB}/*:{HERE / 'oracle' / 'classes'}"
    r = subprocess.run(["java", "-cp", cp, "Oracle", str(WORK / "oracle.accdb"), str(WORK / "schema.sql"),
                        str(WORK / "data.tsv"), str(WORK / "queries.tsv"), str(out)], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        sys.exit("oracle failed:\n" + r.stderr[-2000:])
    res = {}
    for e in corpus.C:
        lines = (out / f"{e['id']}.tsv").read_text(encoding="utf-8").split("\n")
        if lines[0].startswith("ERROR\t"):
            res[e["id"]] = {"error": unesc(lines[0].split("\t", 1)[1])}
            continue
        cols = [unesc(c) for c in lines[0].split("\t")]
        rows = []
        for ln in lines[1:]:
            if ln == "":
                continue
            row = []
            for c in ln.split("\t"):
                row.append(None if c == "N" else (c[:1], unesc(c[2:])))
            rows.append(row)
        res[e["id"]] = {"cols": cols, "rows": [[norm_oracle(c) for c in r] for r in rows]}
    return res


def norm_num(x: float):
    return round(x, 6) + 0.0


def norm_oracle(c):
    if c is None:
        return None
    t, v = c
    if t == "n":
        return norm_num(float(v))
    if t == "b":
        return v == "1"
    if t == "d":
        return v if " " in v else v + " 00:00:00"
    return v


def norm_pg(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float, Decimal)):
        return norm_num(float(v))
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d") + " 00:00:00"
    return v


def key(row):
    return tuple((0, "") if v is None else (1, repr(v)) for v in row)


def setup_pg(citext=False):
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute(f'drop database if exists "{DB}" with (force)')
        c.execute(f'create database "{DB}"')
    url = ADMIN.rsplit("/", 1)[0] + "/" + DB
    conn = psycopg.connect(url)
    conn.execute(PRELUDE)
    if citext:
        conn.execute("create extension if not exists citext")
    conn.execute(fixtures.pg_ddl(citext))
    for a, (pg, cols) in fixtures.T.items():
        ph = ",".join(["%s"] * len(cols))
        with conn.cursor() as cur:
            cur.executemany(f'insert into {fixtures.SCHEMA}.{pg} values ({ph})', fixtures.data()[a])
    conn.commit()
    return conn


def bind(sql: str) -> str:
    return re.sub(r"\$(\d+)", r"%(p\1)s", sql.replace("%", "%%"))


def run_pg(conn, e, res):
    params = {f"p{i + 1}": e["params"][n] for i, n in enumerate(res.params)}
    q = bind(res.sql)
    try:
        if e["kind"] == "select":
            cur = conn.execute(q, params)
        else:
            conn.execute(q, params)
            tbl = fixtures.T[e["check"]][0]
            cur = conn.execute(f"select * from {fixtures.SCHEMA}.{tbl}")
        cols = [d.name for d in cur.description]
        rows = [[norm_pg(v) for v in r] for r in cur.fetchall()]
        return {"cols": cols, "rows": rows}
    except Exception as ex:  # report the database error as a defect
        return {"error": str(ex).splitlines()[0]}
    finally:
        conn.rollback()


def compare(pg, ora, e):
    if "error" in ora:
        return None, "oracle could not run the query: " + ora["error"][:120]
    if "error" in pg:
        return False, "PostgreSQL error: " + pg["error"][:160]
    if e["kind"] == "select":
        pc, oc = [c.lower() for c in pg["cols"]], [c.lower() for c in ora["cols"]]
        if len(pc) != len(oc):
            return False, f"column count {len(pc)} vs {len(oc)}"
        if pc != oc:
            return False, f"column names differ: {pg['cols']} vs {ora['cols']}"
    pr, orr = sorted(pg["rows"], key=key), sorted(ora["rows"], key=key)
    if len(pr) != len(orr):
        return False, f"row count {len(pr)} vs {len(orr)}"
    for a, b in zip(pr, orr):
        if key(a) != key(b):
            return False, f"values differ, for example {a} vs {b}"
    return True, ""


def main():
    citext = "--citext" in sys.argv
    ora = run_oracle()
    for id_, fn in reference.REFS.items():  # crosstabs: UCanAccess cannot run them
        cols, rows = fn()
        ora[id_] = {"cols": cols, "rows": [[reference.f(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v for v in r] for r in rows], "ref": True}
    conn = setup_pg(citext)
    provider = lambda sql: [r[0] for r in conn.execute(sql).fetchall()]  # noqa: E731
    results = []
    for e in corpus.C:
        res = translate(e["sql"], fixtures.catalog(citext), provider if e["pivot_from_data"] else None)
        row = {"id": e["id"], "group": e["group"], "oracle": "python reference" if ora[e["id"]].get("ref") else ("rewritten for UCanAccess" if e["oracle"] else "UCanAccess"), "sql": e["sql"], "status": res.status, "reason": res.reason,
               "warnings": res.warnings, "features": res.features, "pg_sql": res.sql, "expect": e["expect"]}
        if res.status != "failed":
            pg = run_pg(conn, e, res)
            ok, why = compare(pg, ora[e["id"]], e)
            row.update(match=ok, detail=why)
        else:
            row.update(match=None, detail="")
        results.append(row)
    (WORK / ("results_citext.json" if citext else "results.json")).write_text(json.dumps(results, indent=1, default=str))
    summarise(results)


def summarise(r):
    n = len(r)
    clean = [x for x in r if x["status"] == "translated"]
    partly = [x for x in r if x["status"] == "partly_translated"]
    failed = [x for x in r if x["status"] == "failed"]
    produced = clean + partly
    cmp_ = [x for x in produced if x["match"] is not None]
    matched = [x for x in cmp_ if x["match"]]
    print(f"queries {n}: translated clean {len(clean)}, with warnings {len(partly)}, failed {len(failed)}")
    print(f"translated without edits (clean + warnings): {len(produced)}/{n} = {len(produced) / n:.0%}; clean only {len(clean) / n:.0%}")
    print(f"comparable with oracle: {len(cmp_)} of {len(produced)}; matching {len(matched)} = {len(matched) / max(1, len(cmp_)):.0%}")
    cm = [x for x in clean if x["match"] is not None]
    print(f"clean only: matching {sum(1 for x in cm if x['match'])}/{len(cm)}")
    print("failed without reason:", [x["id"] for x in failed if not x["reason"]])
    print("\nMISMATCHES / ERRORS")
    for x in produced:
        if x["match"] is False:
            print(f"  {x['id']} [{x['status']}] {x['detail']}")
    print("\nNOT COMPARABLE (oracle failed)")
    for x in produced:
        if x["match"] is None:
            print(f"  {x['id']}: {x['detail']}")
    print("\nFAILED TRANSLATION")
    for x in failed:
        print(f"  {x['id']} ({'expected' if x['expect'] == 'fail' else 'UNEXPECTED'}): {x['reason']}")


if __name__ == "__main__":
    main()
