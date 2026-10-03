"""Independent expected results for crosstabs, computed in Python straight from the raw data.

UCanAccess does not run TRANSFORM, so these stand in for an Access export. They use no SQL at all.
Cells with no source rows are None, as in an Access crosstab.
"""
from collections import defaultdict

import fixtures


def f(x):
    return None if x is None else round(float(x), 6) + 0.0


def _tables():
    d = fixtures.data()
    return ({r[0]: r for r in d["Customers"]}, {r[0]: r for r in d["Products"]}, {r[0]: r for r in d["Orders"]}, d["OrderLines"])


def _cross(groups, rowkeys, pivots, label=str):
    cols = None
    rows = []
    for rk in rowkeys:
        row = list(rk) if isinstance(rk, tuple) else [rk]
        for pv in pivots:
            cell = groups.get((rk, pv))
            row.append(None if cell is None else f(cell))
        rows.append(row)
    return rows


def e01():
    cust, prod, orders, lines = _tables()
    g = defaultdict(float)
    for _, oid, pid, qty, _d in lines:
        key = (prod[pid][2], orders[oid][2].year)
        g[key] += qty * float(prod[pid][3])
    cats = sorted({k[0] for k in g})
    return ["Category", "2025", "2026"], _cross(g, cats, [2025, 2026])


def e02():
    _, _, orders, _ = _tables()
    g = defaultdict(int)
    for oid, cid, od, *_ in orders.values():
        g[(cid, od.year)] += 1
    ids = sorted({k[0] for k in g})
    return ["CustomerID", "2025", "2026"], _cross(g, ids, [2025, 2026])


def e03():
    _, prod, _, lines = _tables()
    g = defaultdict(int)
    for _, _o, pid, qty, _d in lines:
        g[(prod[pid][1], prod[pid][2])] += qty
    names = sorted({k[0] for k in g})
    return ["Product Name", "Books", "Electrical", "Hardware"], _cross(g, names, ["Books", "Electrical", "Hardware"])


def e04():
    cust, _, orders, _ = _tables()
    g = defaultdict(float)
    for oid, cid, od, sd, fr in orders.values():
        g[(cust[cid][3], od.year)] += float(fr)
    regions = sorted({k[0] for k in g}, key=lambda r: (r is None, r))
    years = sorted({k[1] for k in g})
    return ["Region"] + [str(y) for y in years], _cross(g, regions, years)


REFS = {"e01": e01, "e02": e02, "e03": e03, "e04": e04}
