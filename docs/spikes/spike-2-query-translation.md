# Spike 2 report: query translation

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |
| Spike plan | [Spike 2](../SPIKE-PLAN.md) |
| Result | **Partial. The pass conditions cannot be judged yet.** |

## Summary

A prototype transpiler translates Jet SQL to PostgreSQL. It handles 102 of 114 test queries, and it refuses the other 12 with a clear reason. On the 96 translated queries that another engine could also run, 82 returned the same result.

This report does not claim a pass or a fail against the thresholds in Table 3 of the spike plan. The spike ran without the three inputs that make the thresholds meaningful:

- **No real queries.** The 114 queries are hand-written. The spike author chose them, and chose 12 of them to fail. The 89% translation rate says nothing about the organisation's queries.
- **No Access.** The comparison used UCanAccess as the reference engine. UCanAccess is not Microsoft Access, and 10 of the 14 differences it showed depend on Access behaviour that nobody has confirmed.
- **No real data.** The test database is synthetic.

The spike did produce results that hold regardless of those gaps:

1. A purpose-built parser is the right choice. A general SQL library parsed 88% of the queries and silently gave some of them the wrong meaning.
2. Access ignores case in text comparison, grouping, sorting, and duplicate removal. Storing text columns as `citext` removed 4 of the 14 differences and removes the need for most case workarounds. This changes the type mapping in the technical design and needs a decision.
3. The comparison found 5 defects in the transpiler, including one that returned wrong results without an error. All are fixed and have tests.

## Question

Can a transpiler convert the organisation's Jet SQL queries to PostgreSQL, with matching results?

## Method

### What the plan asked for, and what the spike did

Table 1 compares the plan with what happened.

**Table 1. Method changes from the spike plan**

| Plan step | What the spike did | Reason |
|---|---|---|
| Collect every saved query from the sample databases | Wrote 114 queries by hand, in groups that cover the constructs in the technical design | Spike 1 has not run, and the sample databases (open item O2) are not nominated |
| Load migrated data into a test PostgreSQL schema | Loaded a synthetic database with 4 tables and about 100 rows | No real data |
| Evaluate a library and a purpose-built parser | Measured `sqlglot` on the corpus, then built a purpose-built parser | Required by the plan |
| Run each original query in Access and export to CSV | Ran each query through UCanAccess 5.0.1 and compared the rows. Wrote independent Python results for the 4 crosstabs. | No Access and no Windows machine. UCanAccess cannot run `TRANSFORM`. |
| Compare row counts, column names, and values | Compared them as described under "Comparison rules" | As planned |
| Group failures by cause and estimate the work | Done in this report | As planned |

### Test database

The synthetic database has four tables: `Customers`, `Products`, `Orders`, and `OrderLines`. The data is small and awkward on purpose:

- The `City` column holds `London`, `london`, and `LONDON`, to test case rules.
- Some rows hold nulls in text, currency, and date columns.
- Freight values include halves, such as `2.50` and `3.50`, to test rounding.
- One customer has no orders, to test outer joins.

### Query corpus

Table 2 lists the 114 queries by group.

**Table 2. Query corpus**

| Group | Queries | Examples |
|---|---|---|
| Selection and filtering | 22 | `Like`, `Between`, `Is Null`, `TOP n`, date literals |
| Expressions and functions | 32 | `IIf`, `Nz`, `&`, `Round`, `DateAdd`, `Format`, `Switch` |
| Aggregates and grouping | 11 | `GROUP BY`, `HAVING`, `StDev`, `First` |
| Joins, subqueries, and set operations | 15 | Nested joins, `EXISTS`, `UNION` |
| Crosstab | 5 | `TRANSFORM` and `PIVOT`, with and without an `IN` list |
| Domain aggregates | 9 | `DLookup`, `DCount`, `DSum`, `DMax` |
| Parameters | 5 | Prompts, a `PARAMETERS` clause |
| Action queries | 6 | `INSERT`, `UPDATE` with a join, `DELETE` |
| Constructs that must fail | 9 | `TOP n PERCENT`, `Forms!` references, `SELECT INTO`, a user-defined function |

Three more queries that must fail sit in other groups: `First()`, a crosstab with no pivot values, and `&` with a date.

### Comparison rules

For each translated query the harness ran the PostgreSQL result and the reference result, and compared:

- The column count and the column names, ignoring case.
- The row count.
- The rows as an unordered set, with numbers rounded to six decimal places and dates normalised.

The comparison does not check row order. Order is untested.

For action queries, the harness ran the statement, read the whole table, and rolled back, in both engines.

### Reference engines

- **UCanAccess 5.0.1** (Jackcess 3.0.1 and HSQLDB 2.5.0), loaded with the same data in a generated `.accdb` file. It ran 105 queries as written.
- **Rewritten queries.** UCanAccess cannot run `Sgn`, `Choose`, the `\` and `Mod` operators, `UPDATE ... INNER JOIN`, or a `Like` pattern joined with `&`. For 5 queries, the corpus holds an equivalent rewrite. Four of the rewrites run (`b10`, `b23`, `g03`, `h04`), and the rewrite for `b12` still fails. A reader can check each one in `corpus.py`.
- **Python reference.** The 4 translated crosstabs were compared with results computed in Python straight from the raw data, with no SQL.
- **Not comparable.** 6 queries could not run in UCanAccess, so they have no reference result: 5 domain aggregates (`f01`, `f04`, `f05`, `f06`, `f09`) and `b12`, which uses `Mod`, `\`, and `^`.

## Environment

- PostgreSQL 16.14 on Ubuntu 24.04, in a single container.
- Python 3.11, psycopg 3.3.6, sqlglot 30.21.0.
- OpenJDK 21.0.11, UCanAccess 5.0.1.
- No Windows host, no Microsoft Access, no Kubernetes cluster.
- Prototype: about 1,460 lines of Python in `spikes/spike2-query-translation/jet2pg/`.
- Run `python run_spike.py` to repeat the measurement, and add `--citext` for the `citext` variant.

## Measures

Table 3 shows the measures against the pass conditions. The last column says whether the numbers can decide the condition.

**Table 3. Spike 2 measures**

| Measure | Pass condition | Measured | Can it decide? |
|---|---|---|---|
| Queries translated without manual edits | 80% or more | 102 of 114 (89%). 91 translated cleanly (80%), and 11 translated with warnings. | No. The author wrote the corpus and designed 12 failures. |
| Translated queries with matching results | 95% or more | 82 of 96 comparable (85%) | No. 14 differences, and none is a confirmed transpiler defect. See Table 5. |
| Queries that fail with a clear reason | 100% of those not translated | 12 of 12 | Yes for this corpus. All 12 were designed to fail. |
| Crosstab queries | Match, or a documented reason | 4 of 4 translated crosstabs match the Python reference. 1 refused with a reason. | Partly. The reference is not Access, and the sample is small. |
| Domain aggregate functions | Match, or a documented reason | 9 translated. 4 match, and 5 could not run in UCanAccess. | No. 5 are unverified. |

### Variant: `citext` text columns

The harness repeated the run with text columns stored as `citext`, which compares text without regard to case. The transpiler then needs no `lower()` wrappers, and no `ILIKE`.

**Table 4. Default and `citext` variants**

| Measure | Default | `citext` |
|---|---|---|
| Translated cleanly | 91 | 97 |
| Translated with warnings | 11 | 5 |
| Failed with a reason | 12 | 12 |
| Matching results, of 96 comparable | 82 | 86 |

## Result

**Partial.** The prototype works, and the method is sound. The numbers cannot decide the pass conditions until the spike runs on real queries with Access as the reference. Spike 1 has to deliver the queries first.

## Failures grouped by cause

### Differences from the reference engine

Table 5 groups the 14 queries that translated but returned different results in the default variant. No difference is confirmed as a transpiler defect, and none is confirmed as a reference defect. Each needs a check in Access.

**Table 5. Result differences by cause**

| Cause | Queries | What differs | Status |
|---|---|---|---|
| Case-insensitive text | `a11`, `c03`, `c08`, `d12` | `DISTINCT`, `GROUP BY`, `Min`/`Max`, and `UNION` on text treat `London` and `london` as one value in UCanAccess. PostgreSQL treats them as two. | Fixed by `citext`. All four match in that variant. |
| `Replace` and `InStr` case rules | `b25` | UCanAccess ignores case in `InStr` and respects it in `Replace`. With `citext`, PostgreSQL's `replace()` ignores case, which does not match. | Unresolved. |
| Rounding of halves | `b09`, `b11`, `b31` | The transpiler rounds a half to the even digit, so `Round(1.25, 1)` gives 1.2 and `CInt(2.5)` gives 2. UCanAccess rounds the half up. | Unresolved. The transpiler follows my understanding of Access behaviour. I could not confirm it, because the Microsoft documentation was not reachable from the build environment. |
| Division of integers | `b13`, `c05` | UCanAccess truncates `Quantity / 2` and `Avg(Quantity)` to whole numbers. The transpiler returns a fraction. | Unresolved. I believe Access returns a floating-point result. |
| `Avg` of a currency column | `c01` | UCanAccess returns 5.2554. The transpiler returns 5.255417. | Unresolved. The result type of `Avg` on currency is not known. |
| `DateDiff` in quarters | `b17` | The transpiler counts quarter boundaries, so October 2025 to June 2026 gives 2. UCanAccess gives 3. | Unresolved. The transpiler matches the definition of the function. |
| Representation | `b05`, `b18` | UCanAccess returns `3.5000` for a currency joined to text, and `7 00:00:00` for a date difference. The transpiler returns `3.5` and `7`. | Unresolved. These look like how the Java driver shows values, but only Access can settle it. |

### Constructs the transpiler refuses

The transpiler refuses 12 constructs and states the reason for each. Table 6 lists them.

**Table 6. Refused constructs**

| Construct | Reason shown |
|---|---|
| `TOP n PERCENT` | Not translated |
| `Forms!frmFilter!txtCity` | Reference to a form control. Map it to a parameter. |
| `SELECT ... INTO` | Make-table queries are not translated |
| `Rnd()` | Not translated |
| A user-defined VBA function | Not translated |
| `Like '[A-C]*'` and `Like '#1'` | Character classes and `#` matching are not translated |
| `DateDiff("ww", ...)` | Interval not translated |
| `Format` with a currency or section pattern | Not translated |
| A table in another database | Not translated |
| `First()` | Depends on physical record order, which PostgreSQL does not keep |
| `&` joined to a date | Conversion depends on locale. Wrap the date in `Format()`. |
| A crosstab with no `IN` list and no data to read | Pivot values are needed first |

### Defects found and fixed in the prototype

Running the comparison found these defects in the transpiler. Each is fixed and has a unit test.

1. `Left(`, `Right(`, and `Asc(` failed to parse, because the parser treated `LEFT`, `RIGHT`, and `ASC` as keywords.
2. The `IN` list after `PIVOT` was read as an ordinary `IN` predicate, so every crosstab with an `IN` list failed.
3. `Format(x, "#,##0.0")` was missing from the format table.
4. `UNION` on text gave no warning about case-sensitive duplicate removal.
5. A domain aggregate on the same table as its query gave the inner table the same alias as the outer one. A value taken from the outer row then bound to the inner table, and the query returned wrong results with no error. Each domain aggregate now gets a unique alias.

Defect 5 is the one to remember. A wrong answer with no error is the failure the 95% condition exists to catch, and only a comparison against a second engine found it.

## Findings that change the design

### Store text as `citext`

Access ignores case when it compares, groups, sorts, and removes duplicates from text. PostgreSQL does not. Without a change, every comparison needs a `lower()` wrapper, which stops index use, and `GROUP BY`, `DISTINCT`, and `UNION` cannot be corrected at all.

Storing Short Text and Long Text columns as `citext` handled all of these in the `citext` variant. The cost is a change to Table 4 of the [technical design](../TDD.md), which maps Short Text to `varchar(n)`. It also has two traps:

- `citext` overloads `replace()` and `strpos()` to ignore case. That may not match Access, as `b25` shows.
- The `citext` extension must be available in the PostgreSQL container, and the operator must allow it.

**The owner decided to store text as `citext` on 3 October 2026 (decision D22).** The backend now does this. Spike 1 should still confirm Access's case rules on real data.

### Use a purpose-built parser

The spike measured `sqlglot`, which has no Jet dialect. Table 7 shows the result.

**Table 7. `sqlglot` on the corpus**

| Dialect | Queries parsed, of 108 | Notes |
|---|---|---|
| T-SQL | 95 | Closest to Jet |
| MySQL | 30 | Rejects bracketed names |
| PostgreSQL | 30 | Rejects bracketed names |

The T-SQL parse succeeds in cases where the meaning is wrong:

- `a & b` becomes a bitwise AND, not concatenation.
- `"x"` in a comparison becomes a column name, not a string.
- `Like 'x*'` passes through unchanged, so the `*` stays a literal character.
- Date literals such as `#1/2/2026#` and the `\` operator fail to parse.

A parse that succeeds with the wrong meaning is worse than a failure, so a library saves little. The decision is a purpose-built parser, with the semantic rules in one place.

### Other rules the production transpiler needs

The prototype settled these. Each has a test.

- `Round` and `CInt` round halves to even, through a helper function `a2w_jet.jet_round` that the platform installs. This is pending a check in Access.
- `TOP n` with `ORDER BY` becomes `FETCH FIRST n ROWS WITH TIES`, because Access includes ties.
- `/` always returns a floating-point value. `\` and `Mod` round their operands first.
- A Yes/No column compared with `-1` or `0` becomes a comparison with `TRUE` or `FALSE`.
- `date + number` and `date - number` add and subtract days. `date - date` returns days as a number.
- Date literals use the US format, `m/d/yyyy`.
- `&` treats null as an empty string. The transpiler uses `concat()`, and trims trailing zeros from currency.
- A crosstab needs its pivot values at translation time. They come from an `IN` list, or from a read of the data. The production design must decide who re-reads the data, because new values add columns.
- A saved query that selects from another saved query fails as an unknown table. The converter has to translate queries in dependency order, or the transpiler needs a view-aware catalogue.

## Recommendation

1. **Continue with a purpose-built parser**, and do not use a general SQL library as the base.
2. **Do not treat the pass conditions as met or failed.** Rerun this spike on the queries from Spike 1, with Microsoft Access as the reference. The harness is ready. It needs a second oracle that runs `.accdb` files through Access on the Windows worker, and the 5 UCanAccess rewrites can then be dropped.
3. **Decide on `citext`** before the production type mapping is fixed.
4. **Confirm six Access behaviours** with a small test in Access: rounding of halves, integer division with `/`, the result type of `Avg` on currency, `DateDiff` in quarters, `CStr` of a currency, and the case rules of `InStr` and `Replace`.

### Effort estimate

My estimate for a production transpiler is 4 to 6 engineer-weeks. This is a judgement, not a measurement. It rests on the prototype size (about 1,460 lines for the constructs in the corpus) and on the work the prototype skips:

- Complete grammar coverage, from the real query corpus.
- Saved queries that call other queries, and linked tables.
- Error messages an owner can act on.
- A regression run against the conversion corpus on every change.
- Performance checks on large queries.

The estimate excludes the Access comparison, which depends on Spike 1.

## Remaining questions

- Which saved queries in the real databases call user-defined VBA functions? The prototype refuses them, and the share decides how much conversion the VBA pipeline must carry.
- How many real queries reference form controls, such as `Forms!frm!txt`? The parameter mapping needs a design.
- Does ordering matter to owners? The comparison did not check row order, and Access and PostgreSQL sort text differently.
- Does Access's `LIKE` pattern `#` and `[]` syntax appear in real queries? The prototype refuses it.
- Are linked tables from SQL Server or ODBC sources used in queries? The prototype cannot see them.

## Files

All spike code is in `spikes/spike2-query-translation/`. It is prototype code and must not enter the product without a review.

| Path | Contents |
|---|---|
| `jet2pg/` | Lexer, parser, and emitter |
| `corpus.py` | The 114 queries |
| `fixtures.py` | Test database, for PostgreSQL and for Access |
| `oracle/Oracle.java` | Runs queries through UCanAccess |
| `reference.py` | Crosstab results computed without SQL |
| `run_spike.py` | The measurement harness |
| `eval_sqlglot.py` | The library evaluation |
| `tests/` | 28 unit tests for the transpiler |
