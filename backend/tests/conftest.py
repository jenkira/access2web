import os
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

ADMIN_URL = os.environ.get("A2W_TEST_ADMIN_URL", "postgresql://postgres:test@127.0.0.1:54329/postgres")


@pytest.fixture(scope="session")
def db_url():
    name = "a2w_test_" + uuid.uuid4().hex[:8]
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f'create database "{name}"')
    url = ADMIN_URL.rsplit("/", 1)[0] + "/" + name
    os.environ["A2W_DATABASE_URL"] = url
    os.environ["A2W_DEV_AUTH"] = "1"
    from a2w import db
    db.bootstrap(url)
    yield url
    with psycopg.connect(url) as c:  # roles are cluster-wide, so drop only the ones this database created
        roles = [f"app_{s}" for (s,) in c.execute("select slug from a2w_control.applications").fetchall()]
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f'drop database "{name}" with (force)')
        for role in roles:
            c.execute(f'drop role if exists "{role}"')


@pytest.fixture()
def client(db_url):
    from a2w.api import create_app
    return TestClient(create_app())


def hdr(user, groups="", roles=""):
    return {"x-a2w-user": user, "x-a2w-groups": groups, "x-a2w-roles": roles}


OWNER = hdr("olive", roles="app_owner")
ADMIN = hdr("ada", roles="platform_admin")
AUDITOR = hdr("aud", roles="auditor")


def sample(orphan=False):
    orders = [{"OrderID": 1, "CustomerID": 1, "Total": "10.50", "OrderDate": "2026-01-02 00:00:00"},
              {"OrderID": 7, "CustomerID": 2, "Total": "99.00", "OrderDate": "2026-01-03 00:00:00"}]
    if orphan:
        orders.append({"OrderID": 8, "CustomerID": 999, "Total": "1.00", "OrderDate": "2026-01-04 00:00:00"})
    return {
        "tables": [
            {"name": "Customers", "primary_key": ["CustomerID"],
             "fields": [{"name": "CustomerID", "type": "AutoNumber"},
                        {"name": "Customer Name", "type": "Short Text", "size": 50, "required": True},
                        {"name": "Email", "type": "Short Text", "size": 80},
                        {"name": "Photo", "type": "OLE Object"}],
             "indexes": [{"name": "ixName", "columns": ["Customer Name"], "unique": False}],
             "rows": [{"CustomerID": 1, "Customer Name": "Acme", "Email": "a@x.test"},
                      {"CustomerID": 2, "Customer Name": "Birch", "Email": None}]},
            {"name": "Orders", "primary_key": ["OrderID"],
             "fields": [{"name": "OrderID", "type": "AutoNumber"},
                        {"name": "CustomerID", "type": "Long Integer"},
                        {"name": "Total", "type": "Currency", "default": "0"},
                        {"name": "OrderDate", "type": "Date/Time", "default": "=Date()"},
                        {"name": "Margin", "type": "Double", "default": "=[Total]*0.1"}],
             "rows": orders},
        ],
        "relationships": [{"table": "Orders", "columns": ["CustomerID"], "ref_table": "Customers", "ref_columns": ["CustomerID"]}],
        "queries": [{"name": "qryBig"}],
        "forms": [{"name": "frmCustomer"}],
        "modules": [{"name": "Form_frmCustomer", "source": (
            'Private Sub cmdHide_Click()\n    Me.Email.Visible = False\n    MsgBox "Hidden"\nEnd Sub\n\n'
            'Private Function Discount(total As Currency) As Currency\n    If total > 100 Then\n        Discount = total * 0.1\n    End If\nEnd Function\n\n'
            'Private Sub cmdMail_Click()\n    Set o = CreateObject("Outlook.Application")\nEnd Sub\n')}],
    }
