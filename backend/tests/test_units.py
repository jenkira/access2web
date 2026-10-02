from a2w import authz, vba
from a2w.authz import Grant, Identity, decide, validate_grant
from a2w.importer import Extraction, analyse
from a2w.names import normalise, quote
from a2w.typemap import map_type
import pytest

from conftest import sample


def test_normalise_unique_and_safe():
    used: set[str] = set()
    assert normalise("Customer Name", used) == "customer_name"
    assert normalise("customer-name", used) == "customer_name_2"
    assert normalise("1st", used, "f").startswith("f_")
    assert normalise("!!!", used, "t") == "t"


def test_quote_rejects_injection():
    with pytest.raises(ValueError):
        quote('x"; drop table y; --')


def test_type_map():
    assert map_type("Short Text", 50).pg_type == "varchar(50)"
    assert map_type("Autonumber").identity
    assert map_type("Currency").pg_type == "numeric(19,4)"
    assert map_type("Byte").pg_type == "smallint"
    assert map_type("OLE Object").pg_type is None
    assert map_type("Weird").pg_type is None


def test_analyse_reports_gaps():
    a = analyse(Extraction.model_validate(sample()))
    by = {(i.object_type, i.name): i for i in a.items}
    assert by[("table", "Customers")].status == "partly_converted"  # Photo not migrated
    assert by[("field", "Customers.Photo")].status == "not_converted"
    assert by[("table", "Orders")].status == "partly_converted"  # unsupported default expression
    assert "default expression" in by[("table", "Orders")].reason
    assert by[("relationship", "Orders->Customers")].status == "converted"
    assert by[("query", "qryBig")].status == "not_converted"
    assert a.classification["suggested"] == "personal"  # Email and Customer Name
    orders = a.definition.entity("orders")
    assert orders.foreign_keys[0].ref_entity == "customers"


def test_vba_classification():
    procs = {p.name: p for p in vba.inventory(sample()["modules"])}
    assert procs["cmdHide_Click"].vba_class == vba.STANDARD
    assert procs["cmdHide_Click"].belongs_to == "cmdHide"
    assert procs["Discount"].vba_class == vba.TRANSLATABLE
    assert procs["cmdMail_Click"].vba_class == vba.MANUAL
    assert procs["cmdMail_Click"].suggestion


def test_vba_manual_rules():
    for code in ['Declare PtrSafe Function Foo Lib "user32" ()', 'Open "c:\\x.txt" For Output As #1',
                 'Set fso = CreateObject("Scripting.FileSystemObject")', 'DoCmd.OutputTo acOutputReport']:
        p = vba.classify(vba.Procedure("m", "p", "Sub", 1, f"Sub P()\n{code}\nEnd Sub"))
        assert p.vba_class == vba.MANUAL, code


# ---- authorisation ----
G = Grant


def test_default_deny():
    assert not decide([], Identity("u"), "table", "t", "view_data")


def test_levels_and_implication():
    g = [G("user", "u", "application", "", "edit_data")]
    me = Identity("u")
    assert decide(g, me, "table", "t", "edit_data")
    assert decide(g, me, "table", "t", "view_data")
    assert not decide(g, me, "table", "t", "delete_data")
    assert not decide(g, me, "application", "", "manage_application")
    assert not decide(g, Identity("other"), "table", "t", "view_data")


def test_design_does_not_publish():
    g = [G("user", "u", "application", "", "design_application")]
    assert decide(g, Identity("u"), "application", "", "design_application")
    assert not decide(g, Identity("u"), "application", "", "manage_application")


def test_groups_and_roles():
    g = [G("group", "sales", "application", "", "view_data"), G("role", "auditor", "application", "", "run_reports")]
    assert decide(g, Identity("u", groups=("sales",)), "table", "t", "view_data")
    assert decide(g, Identity("u", roles=("auditor",)), "report", "r", "run_reports")
    assert not decide(g, Identity("u", groups=("hr",)), "table", "t", "view_data")


def test_object_grant_overrides_application_grant():
    g = [G("user", "u", "application", "", "edit_data"), G("user", "u", "table", "secret", "view_data")]
    me = Identity("u")
    assert decide(g, me, "table", "other", "edit_data")
    assert decide(g, me, "table", "secret", "view_data")
    assert not decide(g, me, "table", "secret", "edit_data")  # the object grant replaces the app grant


def test_object_grant_for_someone_else_does_not_override():
    g = [G("user", "u", "application", "", "edit_data"), G("user", "v", "table", "secret", "view_data")]
    assert decide(g, Identity("u"), "table", "secret", "edit_data")


def test_validate_grant():
    validate_grant("user", "application", "", "view_data")
    for args in [("user", "application", "t", "view_data"), ("user", "table", "", "view_data"),
                 ("user", "table", "t", "manage_application"), ("team", "application", "", "view_data"),
                 ("user", "application", "", "root")]:
        with pytest.raises(ValueError):
            validate_grant(*args)
