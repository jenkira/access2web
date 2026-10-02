# Expression language specification

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |
| Used by | Form visibility rules, validation rules, and default values |
| Implementations | `backend/a2w/expr.py` (Python, the server) and `spikes/spike5-form-editor/src/model/expr.ts` (TypeScript, the browser) |
| Conformance tests | `spec/expression/vectors.json` and `spec/expression/forms.json` |

## Summary

The expression language lets an owner write a rule such as `status == 'shipped'` or `isnull(ship_date) || ship_date >= order_date` in a form. The browser evaluates the rule to show or hide a control and to warn the user. The server evaluates the same rule again for every save, because a check in the browser can be bypassed.

Two programs must therefore give the same answer to every expression. This document is the single description of the language. Where the two programs and this document disagree, this document is correct and the program is wrong.

The language is small on purpose. It has no assignment, loops, or user-defined functions, and it cannot read or write anything except the record it is given. An expression cannot run code.

## Values

An expression works with four kinds of value, listed in Table 1.

**Table 1. Value types**

| Type | Examples | Notes |
|---|---|---|
| Null | `null` | Also the value of a field that is missing or empty in the record |
| Boolean | `true`, `false` | Written in any case |
| Number | `0`, `2.5`, `1e3` | IEEE 754 double precision. A result that is not finite becomes null. |
| String | `'abc'`, `"abc"` | A sequence of Unicode code points |

A field in a record can hold a null, a boolean, a number, or a string. A list or an object counts as null.

Every number is a double, including whole numbers. The result of `9007199254740993 + 1` is `9007199254740992`, as in any double-precision system.

Dates are strings in the form `2026-03-01`. They compare correctly as strings, because the form puts the year first.

## Syntax

### Literals and names

- A **number** is one or more digits, optionally followed by a point and one or more digits, optionally followed by an exponent. `.5` and `007` are numbers. `1.` and `1e` are not.
- A **string** is enclosed in single or double quotes. A backslash makes the next character literal, so `'it\'s'` is `it's`. There are no other escapes: `'\n'` is the letter `n`.
- `true`, `false`, and `null` are literals, written in any case.
- A **name** starts with a letter or an underscore, and continues with letters, digits, and underscores. Only the letters A to Z and a to z count. Names are case sensitive, and a name refers to a field of the form's entity.
- Only the space, tab, carriage return, and line feed separate tokens. Other white space, such as a no-break space, is an error.

### Operators

Table 2 lists the operators from the loosest binding to the tightest. Binary operators group from the left.

**Table 2. Operators**

| Level | Operators | Meaning |
|---|---|---|
| 1 | `\|\|` | Or |
| 2 | `&&` | And |
| 3 | `==` `!=` | Equal and not equal |
| 4 | `<` `>` `<=` `>=` | Order |
| 5 | `+` `-` | Add or join, and subtract |
| 6 | `*` `/` | Multiply and divide |
| Prefix | `!` `-` | Not, and negate. These bind tighter than every binary operator. |

Parentheses group. A comma separates the arguments of a function.

### Functions

Table 3 lists the functions. A function name is written in any case. A call with the wrong number of arguments is an error.

**Table 3. Functions**

| Function | Arguments | Result |
|---|---|---|
| `isnull(x)` | 1 | `true` if x is null or the empty string, otherwise `false` |
| `len(x)` | 1 | The number of code points in a string. 0 for null. Null for any other type. |
| `coalesce(x, ...)` | 1 or more | The first argument that is not null and not the empty string, or null if there is none |
| `today()` | 0 | The UTC date of the event, such as `2026-03-01` |
| `lower(x)` | 1 | The string in lower case, using the full Unicode case mapping. Null for any other type. |
| `upper(x)` | 1 | The string in upper case, using the full Unicode case mapping. Null for any other type. |

A name that matches a function name but is not followed by `(` is an ordinary field name. A field can be called `len`.

## Meaning

### Truth

A value is **false** if it is null, `false`, the number 0, or the empty string. Every other value is **true**, including the string `'0'`. The operators `!`, `&&`, and `||` use this rule, and they always give `true` or `false`.

### Equality

`==` and `!=` are strict. A value equals only a value of its own type. So `1 == '1'` is false, `true == 1` is false, and `null == 0` is false. Two nulls are equal. Strings are equal when their code points are equal, so case and accents matter.

### Order

`<`, `>`, `<=`, and `>=` order two numbers, or two strings. Strings are ordered by Unicode code point, so `'B' < 'a'` is true. Any other pair gives `false`, including a number and a string, two booleans, and any comparison with null.

### Arithmetic

Table 4 gives the result of each arithmetic operator. In every other case the result is null.

**Table 4. Arithmetic**

| Operator | Operands | Result |
|---|---|---|
| `+` | Two numbers | The sum |
| `+` | Two strings | The strings joined |
| `-` `*` | Two numbers | The difference or product |
| `/` | Two numbers, and the right is not 0 | The quotient |
| `-` (prefix) | A number | The negation |

A result that is not finite, such as `1e308 * 10`, is null. A number and a string never mix: `1 + 'a'` is null.

### Null

A comparison with null is false, and arithmetic with null is null, as in SQL. A field that is missing from the record is null.

This has a consequence for validation rules. A rule such as `discount >= 0` **fails when the field is empty**. For an optional field, write `isnull(discount) || discount >= 0`.

The form editor warns about this. It tries sample values, and warns when a rule is false whenever its own field is empty, yet is true for some filled value. The warning offers a button that rewrites the rule as `isnull(field) || (rule)`. The editor does not warn when:

- The field is required, because an empty required field is already an error.
- The rule already passes for an empty field, for example `isnull(x) || x > 0`.
- The rule passes for an empty field when another field has some value. A rule such as `status == 'open' || qty > 0` is not reported.
- No value satisfies the rule at all. That is a different problem, and the editor does not check for it.

The warning is advice. It never blocks an edit or a publish. The check is not part of the language, so the Python evaluator does not need it. A publish service written in Python would need its own copy to report warnings.

### Today

`today()` returns the UTC date of the time that the caller supplies. The server fixes one instant for each save and uses it for every rule in that save. The browser uses its own clock, so around midnight UTC a warning in the browser can differ from the server's answer. The server's answer decides.

## Limits

An expression that breaks a limit is an error before it runs. The limits stop an expression from using too much time or memory on the server.

- An expression has at most **500 code points**.
- Nesting is limited to **about 31 levels**: 31 pairs of parentheses, 31 nested function calls, or 62 prefix operators in a row. The right-hand operand of an operator counts as one more level.
- A number literal must be finite. `1e999` is an error.

## Errors

An invalid expression is an error, and nothing is evaluated. Both implementations reject the same expressions. The kinds of error are:

- An unexpected character or token, such as `a = 1`, `a & b`, or `a.b`.
- An unterminated string, or an unclosed parenthesis.
- An unknown function, or the wrong number of arguments.
- A number out of range, an expression that is too long, or an expression that is nested too deeply.

An expression that is valid never fails when it runs. A bad value gives null or false, as described above.

## Using the language

### Where a rule runs

Table 5 shows where each part of a form uses an expression.

**Table 5. Where expressions are used**

| Part | Example | Used for |
|---|---|---|
| Visibility rule | `status == 'shipped'` | Show or hide a control. A hidden control is not validated. |
| Validation rule | `qty > 0`, with a message | A save fails with the message when the rule is false |
| Default | `today()` | The starting value of a field in a new record |

An expression may refer only to fields of the form's entity. The editor refuses an expression that refers to anything else.

### Checking a record on the server

The backend applies the rules to every save that goes through a form. The routes are:

- `GET /api/apps/{slug}/forms/{form}` returns the form and the version of the application. The browser sends that version back when it saves.
- `POST /api/apps/{slug}/forms/{form}/records` creates a record.
- `PUT /api/apps/{slug}/forms/{form}/records/{key}` updates a record. The values are the whole form.

Each save is checked in this order, and the first failure stops it:

1. **Permission.** The form exists, and the user has edit data on the form and on the table that the form saves to. A missing form, a forbidden form, and a forbidden table give the same answer.
2. **Version.** The form is from the current version of the application. If not, the answer is 409 with `version_changed`, and the user must reload.
3. **Unknown fields.** The record holds only fields that a control on the form binds to. If not, the answer is 422 with the field names.
4. **Rules.** For each visible control that has validation rules, every rule is true. For each visible control whose field is required and not a key, the value is not null or the empty string. If not, the answer is 422 with `{control, message}` for each failure.

The errors from the rules come before the errors from required fields, and each group follows the order of the controls on the form. The checker is `failed_rules` in `backend/a2w/formrules.py`.

A save that passes goes through the same audited write as any other, so the audit log records the person and the old and new values.

### Checking a form when it is published

Publish refuses a form that cannot work, so a rule that cannot run is never stored. `validate_forms` in `backend/a2w/formrules.py` checks that every control is bound to a field that exists, that every expression parses and names only fields of the form's entity, that every rule has a message, and that combo boxes, subforms, and control ids are valid. The TypeScript editor has the same check, and `spec/expression/validation.json` holds the cases that both must agree on.

### Saving through a form is required

A table that has a form is written through the form. The table routes refuse to create or update a record in such a table, so a person cannot skip the rules by calling `POST` or `PUT` on `/api/apps/{slug}/tables/{table}/records`. The answer is 409 with `form_required` and the names of the forms. The permission check runs first, so a person without edit data gets the usual refusal and learns nothing about forms.

Table 6 shows what the rule covers.

**Table 6. Which routes the rule covers**

| Route | Table has a form | Table has no form |
|---|---|---|
| Create or update through the table routes | Refused with `form_required` | Allowed, with edit data |
| Create or update through a form | Checked against the rules | Not applicable |
| Read | Allowed, with view data | Allowed, with view data |
| Delete | Allowed, with delete data | Allowed, with delete data |

Two consequences to know about:

- **A save needs edit data on the form and on the table.** A grant on an object replaces the application grants for that object, so the two are decided separately. An application-level grant gives both. A grant on the table alone lets the person read and delete, and not write. A grant on the form alone does not let the person save either, because they also need the table.
- **A table can be made read-only for someone.** Give the person edit data on the application and view data on the table. Reading, and any form that saves to a different table, work as before, and a form that saves to the restricted table refuses them.
- **Delete is not covered.** A delete cannot leave a record that breaks a rule, and there is no form route for it.

## Changing the language

The language has two implementations, so a change needs three steps in this order:

1. Change this document.
2. Add or change cases in `spec/expression/vectors.json`, working out the expected result by hand from this document, not by running either program.
3. Change both implementations until both pass every case.

Run the checks with:

- `python -m pytest backend/tests/test_expr.py backend/tests/test_formrules.py` for the Python evaluator.
- `npm test` in `spikes/spike5-form-editor` for the TypeScript evaluator.
- `python -m pytest backend/tests/test_expr_differential.py` to send random expressions through both and compare the results.

The vectors prove that both programs agree on the cases someone thought of. The differential test looks for the cases that nobody thought of. It generates random valid and damaged expressions, with Unicode text, large numbers, and odd records, and fails on the first difference in validity, value, referenced fields, or rename.

## What is not covered

- **Date arithmetic.** There is no way to add days to a date. Dates are strings, and only comparison works.
- **Pattern matching.** There is no `like` or regular expression.
- **Calling other forms or queries.** An expression sees one record.
- **Locale.** Case mapping and ordering do not depend on the locale.
