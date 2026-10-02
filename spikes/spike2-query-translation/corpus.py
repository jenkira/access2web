"""Spike 2 query corpus. Each entry stands in for a saved query that Spike 1 would export from a real database.

Fields: id, group, sql, params (name -> value), kind (select or action), check (table to compare after an action),
expect ('fail' marks a query that the transpiler should refuse with a clear reason).
"""
from datetime import datetime

C = []


def q(id, group, sql, params=None, kind="select", check="", expect="ok", pivot_from_data=False, oracle=None):
    C.append(dict(id=id, group=group, sql=" ".join(sql.split()), params=params or {}, kind=kind, check=check,
                  expect=expect, pivot_from_data=pivot_from_data, oracle=oracle))


# ---- basic selection and filtering
q("a01", "select", "SELECT * FROM Customers")
q("a02", "select", "SELECT [Customer Name], City FROM Customers WHERE Active = True")
q("a03", "select", "SELECT [Customer Name] FROM Customers WHERE Active = -1")
q("a04", "select", "SELECT [Customer Name] FROM Customers WHERE Not Active")
q("a05", "select", "SELECT [Customer Name] FROM Customers WHERE City = 'london'")
q("a06", "select", "SELECT [Customer Name] FROM Customers WHERE City IN ('Leeds', 'Dublin')")
q("a07", "select", "SELECT [Customer Name] FROM Customers WHERE [Credit Limit] Between 1000 And 4000")
q("a08", "select", "SELECT [Customer Name] FROM Customers WHERE Region Is Null")
q("a09", "select", "SELECT [Customer Name] FROM Customers WHERE Region Is Not Null AND Active = True")
q("a10", "select", "SELECT [Customer Name], [Credit Limit] FROM Customers ORDER BY [Credit Limit] DESC")
q("a11", "select", "SELECT DISTINCT City FROM Customers")
q("a12", "select", "SELECT TOP 3 [Customer Name], [Credit Limit] FROM Customers ORDER BY [Credit Limit] DESC")
q("a13", "select", "SELECT TOP 2 [Product Name], Category FROM Products ORDER BY Category")
q("a14", "select", "SELECT [Customer Name] FROM Customers WHERE City Like 'L*'")
q("a15", "select", "SELECT [Customer Name] FROM Customers WHERE [Customer Name] Like '?e*'")
q("a16", "select", "SELECT [Customer Name] FROM Customers WHERE [Customer Name] Not Like 'A*'")
q("a17", "select", "SELECT [Customer Name] FROM Customers WHERE [Customer Name] > 'C' AND [Customer Name] < 'F'")
q("a18", "select", "SELECT [Customer Name] FROM Customers WHERE Joined >= #1/1/2025#")
q("a19", "select", "SELECT [Customer Name] FROM Customers WHERE Joined Between #1/1/2024# And #12/31/2024#")
q("a20", "select", "SELECT [Customer Name] FROM Customers WHERE [Customer Name] = 'O''Brien Ltd'")
q("a21", "select", "SELECT OrderID FROM Orders WHERE [Ship Date] Is Null")
q("a22", "select", "SELECT OrderID, Freight FROM Orders WHERE Freight > 3 OR (Freight < 1 AND CustomerID = 1)")

# ---- expressions and functions
q("b01", "expr", "SELECT [Customer Name], IIf([Credit Limit] > 2000, 'High', 'Low') AS Band FROM Customers")
q("b02", "expr", "SELECT [Customer Name], Nz([Credit Limit], 0) AS Credit FROM Customers")
q("b03", "expr", "SELECT [Customer Name], Nz(Region) AS Reg FROM Customers")
q("b04", "expr", "SELECT [Customer Name] & ' (' & City & ')' AS Label FROM Customers")
q("b05", "expr", "SELECT [Product Name] & ': ' & [Unit Price] AS Label FROM Products")
q("b06", "expr", "SELECT [Customer Name] & ', ' & Region AS Label FROM Customers")
q("b07", "expr", "SELECT Left([Customer Name], 3) AS L3, Right([Customer Name], 2) AS R2, Mid([Customer Name], 2, 3) AS M, Len([Customer Name]) AS N FROM Customers")
q("b08", "expr", "SELECT UCase(City) AS U, LCase(City) AS L, Trim('  x ') AS T FROM Customers")
q("b09", "expr", "SELECT OrderID, Round(Freight, 0) AS R0, Round(Freight, 1) AS R1, Round(Freight, 2) AS R2 FROM Orders")
q("b10", "expr", "SELECT OrderID, Int(-Freight) AS I, Fix(-Freight) AS F, Abs(-Freight) AS A, Sgn(-Freight) AS S FROM Orders",
  oracle="SELECT OrderID, Int(-Freight) AS I, Fix(-Freight) AS F, Abs(-Freight) AS A, IIf(Freight < 0, 1, IIf(Freight > 0, -1, 0)) AS S FROM Orders")
q("b11", "expr", "SELECT OrderID, CInt(Freight) AS CI, CLng(Freight * 2) AS CL FROM Orders")
q("b12", "expr", "SELECT LineID, Quantity Mod 3 AS M, Quantity \\ 3 AS D, Quantity / 3 AS Q, Quantity ^ 2 AS P FROM OrderLines",
  oracle="SELECT LineID, Quantity - 3 * Fix(Quantity / 3.0) AS M, Fix(Quantity / 3.0) AS D, Quantity / 3.0 AS Q, Quantity ^ 2 AS P FROM OrderLines")
q("b13", "expr", "SELECT LineID, Quantity / 2 AS Half FROM OrderLines")
q("b14", "expr", "SELECT OrderID, Year([Order Date]) AS Y, Month([Order Date]) AS M, Day([Order Date]) AS D FROM Orders")
q("b15", "expr", "SELECT OrderID, DateAdd('d', 7, [Order Date]) AS D7, DateAdd('m', 1, [Order Date]) AS M1, DateAdd('yyyy', -1, [Order Date]) AS Y1 FROM Orders")
q("b16", "expr", "SELECT OrderID, DateDiff('d', [Order Date], [Ship Date]) AS Days FROM Orders")
q("b17", "expr", "SELECT OrderID, DateDiff('m', [Order Date], #6/15/2026#) AS Mths, DateDiff('yyyy', [Order Date], #1/1/2027#) AS Yrs, DateDiff('q', [Order Date], #6/15/2026#) AS Qs FROM Orders")
q("b18", "expr", "SELECT OrderID, [Ship Date] - [Order Date] AS Gap, [Order Date] + 7 AS Due FROM Orders")
q("b19", "expr", "SELECT OrderID, Format([Order Date], 'yyyy-mm-dd') AS F1, Format([Order Date], 'mmm yyyy') AS F2, Format([Order Date], 'dddd') AS F3 FROM Orders")
q("b20", "expr", "SELECT OrderID, Format(Freight, '0.00') AS F1, Format(Freight, '#,##0.0') AS F2, Format(Freight * 1000, '#,##0') AS F3 FROM Orders")
q("b21", "expr", "SELECT OrderID, Weekday([Order Date]) AS W, DatePart('q', [Order Date]) AS Q, DatePart('m', [Order Date]) AS M FROM Orders")
q("b22", "expr", "SELECT LineID, Switch(Quantity < 4, 'S', Quantity < 8, 'M', True, 'L') AS Size FROM OrderLines")
q("b23", "expr", "SELECT LineID, Choose(ProductID, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h') AS C FROM OrderLines",
  oracle="SELECT LineID, Switch(ProductID = 1, 'a', ProductID = 2, 'b', ProductID = 3, 'c', ProductID = 4, 'd', ProductID = 5, 'e', ProductID = 6, 'f', ProductID = 7, 'g', ProductID = 8, 'h') AS C FROM OrderLines")
q("b24", "expr", "SELECT [Customer Name], IsNull(Region) AS NoRegion FROM Customers")
q("b25", "expr", "SELECT [Customer Name], Replace([Customer Name], 'a', 'X') AS Rep, InStr([Customer Name], 'e') AS Pos FROM Customers")
q("b26", "expr", "SELECT [Customer Name], Space(2) & 'x' AS S, String(3, 'z') AS Z, Asc('A') AS A, Chr(66) AS C FROM Customers")
q("b27", "expr", "SELECT OrderID, Year(Date()) - Year([Order Date]) AS Age FROM Orders")
q("b28", "expr", "SELECT OrderID, DateSerial(2026, 3, 1) AS D1 FROM Orders WHERE OrderID < 3")
q("b29", "expr", "SELECT LineID, Quantity * (1 - Discount) AS Net FROM OrderLines")
q("b30", "expr", "SELECT [Product Name], [Unit Price] * 1.2 AS Gross, CDbl([Unit Price]) AS D, CStr(ProductID) AS S FROM Products")
q("b31", "expr", "SELECT OrderID, Round(Freight * 3 / 2, 0) AS R FROM Orders")
q("b32", "expr", "SELECT Orders.OrderID, [Order Date] & '' AS D FROM Orders", expect="fail")  # & with a date depends on locale

# ---- aggregates and grouping
q("c01", "aggregate", "SELECT Count(*) AS N, Sum(Freight) AS S, Avg(Freight) AS A, Min(Freight) AS Lo, Max(Freight) AS Hi FROM Orders")
q("c02", "aggregate", "SELECT Region, Count(*) AS N FROM Customers GROUP BY Region")
q("c03", "aggregate", "SELECT City, Count(*) AS N FROM Customers GROUP BY City")
q("c04", "aggregate", "SELECT CustomerID, Sum(Freight) AS Total FROM Orders GROUP BY CustomerID HAVING Sum(Freight) > 10")
q("c05", "aggregate", "SELECT ProductID, Avg(Quantity) AS AvgQty, StDev(Quantity) AS SD, Var(Quantity) AS V FROM OrderLines GROUP BY ProductID")
q("c06", "aggregate", "SELECT Year([Order Date]) AS Y, Month([Order Date]) AS M, Count(*) AS N FROM Orders GROUP BY Year([Order Date]), Month([Order Date]) ORDER BY 1, 2")
q("c07", "aggregate", "SELECT Category, Sum(Quantity * [Unit Price]) AS Rev FROM OrderLines INNER JOIN Products ON OrderLines.ProductID = Products.ProductID GROUP BY Category")
q("c08", "aggregate", "SELECT Min([Customer Name]) AS First_, Max([Customer Name]) AS Last_ FROM Customers")
q("c09", "aggregate", "SELECT Count([Credit Limit]) AS Filled, Count(*) AS Total FROM Customers")
q("c10", "aggregate", "SELECT First([Customer Name]) AS F FROM Customers", expect="fail")
q("c11", "aggregate", "SELECT Sum(Freight) AS S FROM Orders WHERE CustomerID = 999")

# ---- joins, subqueries, set operations
q("d01", "join", "SELECT c.[Customer Name], o.OrderID FROM Customers AS c INNER JOIN Orders AS o ON c.CustomerID = o.CustomerID")
q("d02", "join", "SELECT c.[Customer Name], o.OrderID FROM Customers AS c LEFT JOIN Orders AS o ON c.CustomerID = o.CustomerID")
q("d03", "join", "SELECT o.OrderID, c.[Customer Name] FROM Customers AS c RIGHT JOIN Orders AS o ON c.CustomerID = o.CustomerID")
q("d04", "join", "SELECT c.[Customer Name], p.[Product Name], l.Quantity FROM ((Customers AS c INNER JOIN Orders AS o ON c.CustomerID = o.CustomerID) INNER JOIN OrderLines AS l ON o.OrderID = l.OrderID) INNER JOIN Products AS p ON l.ProductID = p.ProductID")
q("d05", "join", "SELECT a.[Customer Name] AS A, b.[Customer Name] AS B FROM Customers AS a INNER JOIN Customers AS b ON a.City = b.City WHERE a.CustomerID < b.CustomerID")
q("d06", "join", "SELECT Customers.[Customer Name], Orders.OrderID FROM Customers, Orders WHERE Customers.CustomerID = Orders.CustomerID AND Orders.Freight > 4")
q("d07", "join", "SELECT c.[Customer Name] FROM Customers AS c LEFT JOIN Orders AS o ON c.CustomerID = o.CustomerID WHERE o.OrderID Is Null")
q("d08", "join", "SELECT t.CustomerID, t.Total FROM (SELECT CustomerID, Sum(Freight) AS Total FROM Orders GROUP BY CustomerID) AS t WHERE t.Total > 5")
q("d09", "join", "SELECT [Customer Name] FROM Customers WHERE CustomerID IN (SELECT CustomerID FROM Orders WHERE Freight > 7)")
q("d10", "join", "SELECT [Customer Name] FROM Customers AS c WHERE EXISTS (SELECT 1 FROM Orders AS o WHERE o.CustomerID = c.CustomerID AND o.Freight > 7)")
q("d11", "join", "SELECT [Customer Name], (SELECT Count(*) FROM Orders WHERE Orders.CustomerID = Customers.CustomerID) AS N FROM Customers")
q("d12", "join", "SELECT City FROM Customers UNION SELECT Region FROM Customers")
q("d13", "join", "SELECT CustomerID FROM Orders UNION ALL SELECT CustomerID FROM Customers WHERE Active = True")
q("d14", "join", "SELECT [Customer Name] FROM Customers WHERE CustomerID NOT IN (SELECT CustomerID FROM Orders)")
q("d15", "join", "SELECT o.OrderID, Sum(l.Quantity) AS Qty FROM Orders AS o LEFT JOIN OrderLines AS l ON o.OrderID = l.OrderID GROUP BY o.OrderID HAVING Sum(l.Quantity) > 10 ORDER BY Sum(l.Quantity) DESC")

# ---- crosstab
q("e01", "crosstab", "TRANSFORM Sum(Quantity * [Unit Price]) AS Rev SELECT Category FROM ((Orders INNER JOIN OrderLines ON Orders.OrderID = OrderLines.OrderID) INNER JOIN Products ON OrderLines.ProductID = Products.ProductID) GROUP BY Category PIVOT Year([Order Date]) IN (2025, 2026)")
q("e02", "crosstab", "TRANSFORM Count(OrderID) AS N SELECT CustomerID FROM Orders GROUP BY CustomerID PIVOT Year([Order Date]) IN (2025, 2026)")
q("e03", "crosstab", "TRANSFORM Sum(Quantity) AS Q SELECT [Product Name] FROM OrderLines INNER JOIN Products ON OrderLines.ProductID = Products.ProductID GROUP BY [Product Name] PIVOT Category IN ('Books', 'Electrical', 'Hardware')")
q("e04", "crosstab", "TRANSFORM Sum(Freight) AS F SELECT Region FROM Customers INNER JOIN Orders ON Customers.CustomerID = Orders.CustomerID GROUP BY Region PIVOT Year([Order Date])", pivot_from_data=True)
q("e05", "crosstab", "TRANSFORM Sum(Freight) AS F SELECT Region FROM Customers INNER JOIN Orders ON Customers.CustomerID = Orders.CustomerID GROUP BY Region PIVOT Year([Order Date])", expect="fail")

# ---- domain aggregates
q("f01", "domain", "SELECT OrderID, DLookup('[Customer Name]', 'Customers', 'CustomerID=' & Orders.CustomerID) AS Cust FROM Orders")
q("f02", "domain", "SELECT [Customer Name], DCount('*', 'Orders', 'CustomerID=' & Customers.CustomerID) AS N FROM Customers")
q("f03", "domain", "SELECT [Customer Name], DSum('Freight', 'Orders', 'CustomerID=' & Customers.CustomerID) AS S FROM Customers")
q("f04", "domain", "SELECT DMax('Freight', 'Orders') AS Hi, DMin('Freight', 'Orders') AS Lo, DCount('*', 'Customers') AS N, DAvg('Freight', 'Orders') AS A")
q("f05", "domain", "SELECT [Product Name] FROM Products WHERE [Unit Price] > DAvg('[Unit Price]', 'Products')")
q("f06", "domain", "SELECT OrderID, DLookup('[Product Name]', 'Products', 'ProductID=3') AS P FROM Orders WHERE OrderID < 4")

# ---- parameters
q("g01", "parameter", "SELECT [Customer Name] FROM Customers WHERE City = [Enter city]", params={"Enter city": "LEEDS"})
q("g02", "parameter", "PARAMETERS [Start] DateTime, [End] DateTime; SELECT OrderID FROM Orders WHERE [Order Date] Between [Start] And [End]",
  params={"Start": datetime(2025, 3, 1), "End": datetime(2025, 6, 30)})
q("g03", "parameter", "SELECT [Customer Name] FROM Customers WHERE [Customer Name] Like [Name starts with] & '*'", params={"Name starts with": "b"},
  oracle="SELECT [Customer Name] FROM Customers WHERE [Customer Name] Like 'b*'")
q("g05", "parameter", "SELECT [Customer Name] FROM Customers WHERE [Customer Name] Like 'b*'")
q("g04", "parameter", "SELECT OrderID FROM Orders WHERE Freight > [Min freight] AND CustomerID = [Cust]", params={"Min freight": 2, "Cust": 1})

# ---- action queries
q("h01", "action", "INSERT INTO Customers (CustomerID, [Customer Name], City, Active) VALUES (99, 'New Co', 'Hull', True)", kind="action", check="Customers")
q("h02", "action", "INSERT INTO Products (ProductID, [Product Name], Category, [Unit Price], Discontinued) SELECT ProductID + 100, [Product Name], Category, [Unit Price] * 2, False FROM Products WHERE Category = 'Books'", kind="action", check="Products")
q("h03", "action", "UPDATE Products SET [Unit Price] = [Unit Price] * 1.1 WHERE Category = 'Hardware'", kind="action", check="Products")
q("h04", "action", "UPDATE Orders INNER JOIN Customers ON Orders.CustomerID = Customers.CustomerID SET Orders.Freight = Orders.Freight + 1 WHERE Customers.Region = 'South'", kind="action", check="Orders",
  oracle="UPDATE Orders SET Freight = Freight + 1 WHERE CustomerID IN (SELECT CustomerID FROM Customers WHERE Region = 'South')")
q("h05", "action", "DELETE FROM OrderLines WHERE Quantity < 3", kind="action", check="OrderLines")
q("h06", "action", "DELETE * FROM Orders WHERE [Ship Date] Is Null", kind="action", check="Orders")

# ---- constructs that must fail with a clear reason
q("x01", "fail", "SELECT TOP 10 PERCENT [Customer Name] FROM Customers ORDER BY [Credit Limit]", expect="fail")
q("x02", "fail", "SELECT [Customer Name] FROM Customers WHERE City = Forms!frmFilter!txtCity", expect="fail")
q("x03", "fail", "SELECT [Customer Name] INTO Backup FROM Customers", expect="fail")
q("x04", "fail", "SELECT [Customer Name], Rnd() AS R FROM Customers", expect="fail")
q("x05", "fail", "SELECT [Customer Name], MyVbaFunction([Customer Name]) AS X FROM Customers", expect="fail")
q("x06", "fail", "SELECT [Customer Name] FROM Customers WHERE [Customer Name] Like '[A-C]*'", expect="fail")
q("x07", "fail", "SELECT OrderID, DateDiff('ww', [Order Date], Date()) AS W FROM Orders", expect="fail")
q("f07", "domain", "SELECT OrderID, DLookup('City', 'Customers', 'CustomerID=' & Orders.CustomerID) AS City FROM Orders")
q("f08", "domain", "SELECT [Customer Name], DMax('Freight', 'Orders', 'CustomerID=' & Customers.CustomerID) AS Hi FROM Customers")
q("f09", "domain", "SELECT Nz(DLookup('Freight', 'Orders', 'OrderID=1')) AS X")
q("x09", "fail", "SELECT Format(Freight, '$#,##0.00;($#,##0.00)') AS F FROM Orders", expect="fail")
q("x10", "fail", "SELECT [Customer Name] FROM Customers INNER JOIN [C:\\data\\other.accdb].Orders ON 1=1", expect="fail")
