"""Synthetic sample database for Spike 2. It stands in for the real databases the plan needs (open item O2).

The data is small and deliberately awkward: mixed-case text, nulls, rounding ties, a customer with no orders.
"""
import random
from datetime import datetime, timedelta

from jet2pg import Catalog, ColumnInfo, TableInfo

SCHEMA = "spike2"

# (access name, pg name, type letter, catalog type, Access DDL type, PG DDL type)
T = {
    "Customers": ("customers", [
        ("CustomerID", "customerid", "L", "int", "LONG", "integer"),
        ("Customer Name", "customer_name", "T", "text", "TEXT(50)", "varchar(50)"),
        ("City", "city", "T", "text", "TEXT(30)", "varchar(30)"),
        ("Region", "region", "T", "text", "TEXT(20)", "varchar(20)"),
        ("Joined", "joined", "D", "date", "DATETIME", "timestamp"),
        ("Credit Limit", "credit_limit", "C", "num", "CURRENCY", "numeric(19,4)"),
        ("Active", "active", "B", "bool", "YESNO", "boolean"),
    ]),
    "Products": ("products", [
        ("ProductID", "productid", "L", "int", "LONG", "integer"),
        ("Product Name", "product_name", "T", "text", "TEXT(50)", "varchar(50)"),
        ("Category", "category", "T", "text", "TEXT(30)", "varchar(30)"),
        ("Unit Price", "unit_price", "C", "num", "CURRENCY", "numeric(19,4)"),
        ("Discontinued", "discontinued", "B", "bool", "YESNO", "boolean"),
    ]),
    "Orders": ("orders", [
        ("OrderID", "orderid", "L", "int", "LONG", "integer"),
        ("CustomerID", "customerid", "L", "int", "LONG", "integer"),
        ("Order Date", "order_date", "D", "date", "DATETIME", "timestamp"),
        ("Ship Date", "ship_date", "D", "date", "DATETIME", "timestamp"),
        ("Freight", "freight", "C", "num", "CURRENCY", "numeric(19,4)"),
    ]),
    "OrderLines": ("orderlines", [
        ("LineID", "lineid", "L", "int", "LONG", "integer"),
        ("OrderID", "orderid", "L", "int", "LONG", "integer"),
        ("ProductID", "productid", "L", "int", "LONG", "integer"),
        ("Quantity", "quantity", "L", "int", "INTEGER", "smallint"),
        ("Discount", "discount", "F", "num", "DOUBLE", "double precision"),
    ]),
}


def catalog(citext: bool = False) -> Catalog:
    return Catalog(SCHEMA, [TableInfo(a, pg, [ColumnInfo(c[0], c[1], c[3]) for c in cols]) for a, (pg, cols) in T.items()], text_is_citext=citext)


def dt(s):
    return datetime.fromisoformat(s)


def data() -> dict[str, list[list]]:
    cust = [
        [1, "Acme Ltd", "London", "South", dt("2024-01-15"), "5000.00", True],
        [2, "Birch & Co", "london", "South", dt("2024-03-02"), "2500.50", True],
        [3, "Cedar Inc", "Leeds", "North", dt("2025-06-30"), "0", False],
        [4, "delta Works", "LONDON", "South", dt("2023-11-20"), None, True],
        [5, "Elm Partners", "Glasgow", None, dt("2025-01-01"), "1250.25", True],
        [6, "O'Brien Ltd", "Dublin", "West", dt("2026-02-14"), "3000.00", True],
        [7, "Fir Street", "Leeds", "North", dt("2024-07-04"), "750.1250", True],
        [8, "Gum Holdings", "Cardiff", "West", dt("2025-09-09"), "100.00", False],
    ]
    prod = [
        [1, "Widget", "Hardware", "2.50", False], [2, "Gadget", "Hardware", "10.00", False],
        [3, "Sprocket", "Hardware", "0.1250", False], [4, "Manual", "Books", "15.75", False],
        [5, "Guide", "Books", "22.00", True], [6, "Cable", "Electrical", "3.50", False],
        [7, "Fuse", "Electrical", "1.25", False], [8, "Lamp", "Electrical", "12.50", True],
    ]
    rnd = random.Random(7)
    orders, lines = [], []
    base = dt("2025-01-05")
    for oid in range(1, 25):
        cid = rnd.choice([1, 1, 2, 2, 3, 4, 5, 6, 7])  # customer 8 never orders
        od = base + timedelta(days=rnd.randint(0, 420))
        sd = None if oid % 5 == 0 else od + timedelta(days=rnd.randint(1, 9))
        freight = rnd.choice(["2.50", "3.50", "0.50", "12.3450", "7.00", "1.2500", "4.5000"])
        orders.append([oid, cid, od, sd, freight])
    lid = 1
    for oid in range(1, 25):
        for pid in rnd.sample(range(1, 9), rnd.randint(1, 4)):
            lines.append([lid, oid, pid, rnd.randint(1, 12), rnd.choice([0.0, 0.0, 0.05, 0.1, 0.25])])
            lid += 1
    return {"Customers": cust, "Products": prod, "Orders": orders, "OrderLines": lines}


def pg_ddl(citext: bool = False) -> str:
    out = [f'drop schema if exists {SCHEMA} cascade', f"create schema {SCHEMA}"]
    for a, (pg, cols) in T.items():
        def ty(c):
            return "citext" if citext and c[3] == "text" else c[5]
        out.append(f'create table {SCHEMA}.{pg} (' + ", ".join(f'"{c[1]}" {ty(c)}' for c in cols) + ")")
    return ";\n".join(out)


def access_ddl() -> list[str]:
    return [f"CREATE TABLE {a} (" + ", ".join(f"[{c[0]}] {c[4]}" for c in cols) + ")" for a, (pg, cols) in T.items()]


def tsv_data() -> str:
    """Data file for the Java oracle: a header line per table with column type letters, then rows."""
    def cell(v, letter):
        if v is None:
            return "\\N"
        if letter == "D":
            return v.strftime("%Y-%m-%d %H:%M:%S")
        if letter == "B":
            return "1" if v else "0"
        return str(v)
    lines = []
    for a, (pg, cols) in T.items():
        lines.append("#" + a + "\t" + "\t".join(c[2] for c in cols))
        for r in data()[a]:
            lines.append("\t".join(cell(v, c[2]) for v, c in zip(r, cols)))
    return "\n".join(lines) + "\n"
