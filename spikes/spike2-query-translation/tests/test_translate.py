"""Unit tests for the Spike 2 transpiler. They need no database."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

import fixtures
from jet2pg import translate
from jet2pg.lexer import Unsupported, tokenize

CAT = fixtures.catalog()
CI = fixtures.catalog(citext=True)


def t(sql, cat=CAT, **kw):
    return translate(sql, cat, **kw)


def test_date_literal_us_format():
    assert [x.value for x in tokenize("#1/2/2026#")][0] == "2026-01-02 00:00:00"
    assert tokenize("#3/4/2026 2:30 PM#")[0].value == "2026-03-04 14:30:00"


def test_bad_date_literal_is_unsupported():
    with pytest.raises(Unsupported):
        tokenize("#yesterday#")


def test_string_quote_escaping():
    assert tokenize("'O''Brien'")[0].value == "O'Brien"
    r = t("SELECT [Customer Name] FROM Customers WHERE [Customer Name] = 'O''Brien Ltd'")
    assert "'O''Brien Ltd'" in r.sql


def test_names_map_to_pg_and_keep_access_output_names():
    r = t("SELECT [Customer Name], City FROM Customers")
    assert '"customers"."customer_name" AS "Customer Name"' in r.sql
    assert r.status == "translated"


def test_iif_nz_concat():
    r = t("SELECT IIf(Active, 'y', 'n') AS a, Nz(Region) AS b, [Customer Name] & ' ' & City AS c FROM Customers")
    assert "CASE WHEN" in r.sql and "COALESCE(" in r.sql and "concat(" in r.sql


def test_nz_without_default_needs_known_type():
    assert "COALESCE" in t("SELECT Nz(Region) FROM Customers").sql
    r = t("SELECT Nz(Mystery()) FROM Customers")
    assert r.status == "failed"


def test_bool_compared_with_minus_one():
    assert "= TRUE" in t("SELECT 1 FROM Customers WHERE Active = -1").sql
    assert "= FALSE" in t("SELECT 1 FROM Customers WHERE Active = 0").sql


def test_text_comparison_ignores_case_unless_citext():
    assert "lower(" in t("SELECT 1 FROM Customers WHERE City = 'x'").sql
    assert "lower(" not in t("SELECT 1 FROM Customers WHERE City = 'x'", CI).sql


def test_like_wildcards_and_escapes():
    assert "ILIKE 'a%b_'" in t("SELECT 1 FROM Customers WHERE City Like 'a*b?'").sql
    assert "ILIKE '50\\%%'" in t("SELECT 1 FROM Customers WHERE City Like '50%*'").sql
    assert t("SELECT 1 FROM Customers WHERE City Like '[a-c]*'").status == "failed"
    assert t("SELECT 1 FROM Customers WHERE City Like '#1'").status == "failed"


def test_like_pattern_from_parameter():
    r = t("SELECT 1 FROM Customers WHERE City Like [Name] & '*'")
    assert r.params == ["Name"] and "replace(replace(" in r.sql and r.status == "partly_translated"


def test_division_is_floating_and_integer_division_rounds():
    assert "::double precision" in t("SELECT Quantity / 2 FROM OrderLines").sql
    assert "jet_round" in t("SELECT Quantity \\ 2 FROM OrderLines").sql
    assert "jet_round" in t("SELECT Quantity Mod 2 FROM OrderLines").sql


def test_round_uses_helper():
    assert "a2w_jet.jet_round" in t("SELECT Round(Freight, 1) FROM Orders").sql


def test_top_includes_ties_with_order_by():
    assert "WITH TIES" in t("SELECT TOP 2 City FROM Customers ORDER BY City").sql
    r = t("SELECT TOP 2 City FROM Customers")
    assert "LIMIT 2" in r.sql and r.status == "partly_translated"


def test_group_by_text_warns_unless_citext():
    assert t("SELECT City, Count(*) FROM Customers GROUP BY City").status == "partly_translated"
    assert t("SELECT City, Count(*) FROM Customers GROUP BY City", CI).status == "translated"


def test_nested_joins():
    r = t("SELECT 1 FROM (Customers c INNER JOIN Orders o ON c.CustomerID = o.CustomerID) LEFT JOIN OrderLines l ON o.OrderID = l.OrderID")
    assert r.status == "translated" and "LEFT JOIN" in r.sql


def test_unqualified_ambiguous_column_fails():
    r = t("SELECT CustomerID FROM Customers c INNER JOIN Orders o ON c.CustomerID = o.CustomerID")
    assert r.status == "failed" and "ambiguous" in r.reason


def test_unknown_names_fail_with_reason():
    assert "unknown column" in t("SELECT Nope FROM Customers").reason
    assert "unknown table" in t("SELECT * FROM Nope").reason


def test_prompt_becomes_parameter_once():
    r = t("SELECT 1 FROM Orders WHERE Freight > [Limit] AND Freight < [Limit] * 2")
    assert r.params == ["Limit"] and r.sql.count("$1") == 2


def test_form_reference_is_refused():
    r = t("SELECT 1 FROM Orders WHERE OrderID = Forms!f!c")
    assert r.status == "failed" and "form or report control" in r.reason


def test_crosstab_with_in_list():
    r = t("TRANSFORM Sum(Freight) AS F SELECT CustomerID FROM Orders GROUP BY CustomerID PIVOT Year([Order Date]) IN (2025, 2026)")
    assert r.status == "translated" and r.sql.count("FILTER (WHERE") >= 4 and '"2025"' in r.sql


def test_crosstab_without_values_needs_a_provider():
    sql = "TRANSFORM Sum(Freight) AS F SELECT CustomerID FROM Orders GROUP BY CustomerID PIVOT Year([Order Date])"
    assert t(sql).status == "failed"
    r = t(sql, pivot_provider=lambda s: [2025, 2026])
    assert r.status == "partly_translated"


def test_domain_aggregate_splices_criteria():
    r = t("SELECT DLookup('City', 'Customers', 'CustomerID=' & Orders.CustomerID) FROM Orders")
    assert "LIMIT 1" in r.sql and '"orders"."customerid"' in r.sql


def test_domain_aggregate_does_not_capture_outer_row():
    # The criteria value comes from the outer Customers row, and the domain table is also Customers.
    # Jet escapes a quote by doubling it, so '''' is a string holding one quote character.
    r = t(r"SELECT DCount('*', 'Customers', 'City=''' & [Customer Name] & '''') FROM Customers")
    assert r.status == "translated"
    assert '"dom1"."city"' in r.sql          # inner column
    assert '"customers"."customer_name"' in r.sql  # outer column, not the inner alias
    assert 'AS "dom1"' in r.sql and r.sql.count('AS "customers"') == 1


def test_amp_with_date_is_refused():
    assert t("SELECT [Order Date] & 'x' FROM Orders").status == "failed"


def test_first_last_refused():
    assert t("SELECT First(City) FROM Customers").status == "failed"


def test_action_queries():
    assert t("DELETE * FROM Orders WHERE Freight < 1").sql.startswith('DELETE FROM "spike2"."orders"')
    assert "FROM" in t("UPDATE Orders INNER JOIN Customers ON Orders.CustomerID = Customers.CustomerID SET Orders.Freight = 1 WHERE Customers.Region = 'x'").sql


def test_every_failure_has_a_reason():
    for sql in ["SELECT FROM", "SELEKT 1", "SELECT 'unterminated", "SELECT 1 FROM Orders WHERE", "SELECT TOP 10 PERCENT City FROM Customers"]:
        r = t(sql)
        assert r.status == "failed" and r.reason, sql


def test_no_sql_injection_through_names():
    r = t('SELECT [Customer Name] AS [x"; drop table y; --] FROM Customers')
    assert '"x""; drop table y; --"' in r.sql  # the alias is quoted, so it stays an identifier
