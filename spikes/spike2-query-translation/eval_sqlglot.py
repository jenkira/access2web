"""Evaluate sqlglot as a base for the transpiler. It has no Jet dialect, so try the nearest ones.

Counts how many corpus queries each dialect parses, and how many of those it parses into something
whose meaning matches Jet. A parse that succeeds with the wrong meaning is the dangerous case.
"""
import collections
import sqlglot
from sqlglot import exp
import corpus

res = collections.defaultdict(lambda: [0, 0])
fails = collections.defaultdict(list)
for dialect in ("tsql", "mysql", "postgres"):
    for e in corpus.C:
        if e["kind"] != "select":
            continue
        sql = e["oracle"] or e["sql"]
        res[dialect][1] += 1
        try:
            sqlglot.parse_one(e["sql"], read=dialect)
            res[dialect][0] += 1
        except Exception as ex:
            fails[dialect].append(e["id"])
for d, (ok, n) in res.items():
    print(f"{d}: parsed {ok}/{n}")

# Silent mis-parses: parses without error but keeps Jet syntax that has another meaning elsewhere.
probes = {
    "& concatenation": "SELECT a & b FROM t",
    "backslash integer division": "SELECT a \\ b FROM t",
    "date literal": "SELECT * FROM t WHERE d > #1/2/2026#",
    "Like with *": "SELECT * FROM t WHERE a LIKE 'x*'",
    "Mod operator": "SELECT a MOD b FROM t",
    "double-quoted string": 'SELECT * FROM t WHERE a = "x"',
}
print()
for name, s in probes.items():
    for d in ("tsql", "mysql"):
        try:
            tree = sqlglot.parse_one(s, read=d)
            print(f"{name:28s} {d:6s} parses -> {tree.sql(dialect='postgres')}")
        except Exception as ex:
            print(f"{name:28s} {d:6s} error  -> {str(ex).splitlines()[0][:70]}")
