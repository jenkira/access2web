# Spike 5 report: form editor

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |
| Spike plan | [Spike 5](../SPIKE-PLAN.md) |
| Validation pack | [Spike 5 validation pack](spike-5-validation-pack.md) |
| Result | **Partial. Every measure that does not need people passes. Three measures need real users and are not measured.** |

## Summary

A prototype renderer, editor, and operation model passes the five measures that tests can decide, and the three measures that need people are not measured yet. As you decided, the work that needs real users waits until the end, and the [validation pack](spike-5-validation-pack.md) is ready for it.

What passes:

- **Operation log.** The log alone rebuilt the draft exactly in all 400 random edit sessions (10,581 applied edits).
- **Rename.** 17 of 17 rename cases kept the data, kept every saved query working with the same rows and column names, and left no broken reference in forms or rules. The handlers that mention the field were listed in 17 of 17 cases.
- **Speed.** A form with 100 controls rendered in a median of 16.5 ms, and in under 100 ms on a CPU slowed four times.
- **Accessibility.** An automated check found no critical and no serious violations on seven page states.
- **Draft workflow.** A person with Design can edit and save a draft but cannot publish. A form open from an earlier version is told to reload.

What is not measured: the share of tasks that users complete unaided, the median task time, and the owner's ratings of the rendered forms. The forms are synthetic, so a rating would mean little yet.

The spike changes the design in four ways:

1. **The expression language needs a server implementation, and now has one.** The server must check the same rules, and Phase 1's backend is Python. I wrote a Python evaluator and a written specification ([docs/EXPRESSIONS.md](../EXPRESSIONS.md)). Both evaluators pass the same 285 conformance cases, and agreed on 150,000 random expressions.
2. **Build the editor, and do not adopt one.** One candidate has a commercial licence and cannot be used without a purchase. The closest open candidate may need code in its conditions, which the design forbids, but I could not verify that. This is a judgement, and I did not test it.
3. **Edit by property panel first, and add drag and drop as an extra.** Every move works from buttons. Drag and drop works too, but it is the only part a keyboard cannot reach without the buttons.
4. **A rename is safe to undo only before publish.** The data change is meant to run at publish, so an undo before then costs nothing. After publish, the design already says that a rename needs a snapshot restore. Wiring the migration into publish is not done.

## Question

Can the runtime and the operation model support a visual form editor that lets owners make the common edits safely, and is it better to build the editor or adopt an existing one?

## Method

### What the plan asked for, and what the spike did

Table 1 compares the plan with what happened.

**Table 1. Method changes from the spike plan**

| Plan step | What the spike did | Reason |
|---|---|---|
| 1. Take five exported forms | Wrote five synthetic forms: a simple form, one with validation and defaults, one with a combo box, a subform, and conditional visibility, one with a combo and a cross-field rule, and one with conditional visibility on two fields | Spike 1 has not exported forms |
| 2. Build a renderer | Done, in the browser | As planned |
| 3. Owner rates fidelity | **Not done.** Screenshots and a rating sheet are ready. | Needs the owner and real forms |
| 4. Build an editor with undo and redo | Done: add, remove, move, label, visibility, validation, default, and rename | As planned |
| 5. Rebuild the draft from the log | Done, with randomised tests | As planned |
| 6. Test a rename | Done against PostgreSQL 16, with 17 cases | As planned |
| 7. Test the draft workflow | Done, in tests and in the browser | As planned |
| 8. Test permissions | Done | As planned |
| 9. Accessibility and keyboard | Done with axe-core and a keyboard-only session | A screen-reader test needs a person |
| 10. Compare build and adopt | Done from package metadata and licence files, with no integration test | Time box |
| 11. Usability session | **Not done.** A pack is ready. | Needs three users |

### Definition model

The model extends the application definition in the technical design. A form is a list of rows, and each row is a list of controls. A control has an identifier, and some have a bound field, a label, a visibility rule, validation rules, and a default. The rules and the default are expressions in a small declarative language.

The language has comparison, arithmetic, `&&`, `||`, `!`, and six functions: `isnull`, `len`, `coalesce`, `today`, `lower`, and `upper`. It has no assignment, loops, or calls to anything else. Comparisons with null are false and arithmetic with null is null, as in SQL. The browser and the test server use the same evaluator.

### Operations

An operation is one of nine edits: add, remove, and move a control, set a label, set a visibility rule, set validation rules, set a default, rename a field, and rename an entity. Table 2 gives the rules.

**Table 2. Operation rules**

| Rule | Reason |
|---|---|
| An operation either applies in full or is rejected with a reason. A rejected operation changes nothing. | A draft is always valid |
| Every expression must parse, and may refer only to fields of the form's entity | A rule cannot refer to something that does not exist |
| A move counts positions after the control leaves its row, and an emptied row disappears | One meaning for every move |
| Ids for new controls and rows come from the operation, not from a counter inside the model | Replaying a log gives the same draft |
| A rename updates forms, expressions, and saved queries. It never edits handlers. | Handler logic needs a person |

### Draft and history

A draft is a base definition, a log of operations, and a pointer. Undo and redo move the pointer. A new edit drops the redo tail. The log up to the pointer rebuilds the draft.

### Rename

A field rename does four things:

1. It changes the entity, and every control, rule, combo box, and subform that refers to the field.
2. It rewrites each saved query. The rewriter reads the query text as tokens, tracks table aliases, and renames only the column of the right table. When a bare column was a result name, the rewriter adds an alias with the old name, so that nothing downstream changes.
3. It lists each handler that mentions the old name, with the line numbers.
4. It generates the SQL for the data change, `alter table ... rename column`. The design applies the change at publish. In this prototype, the tests apply it directly, and the server's publish step does not run it yet.

A query that the rewriter cannot place with certainty is listed for review. It is never guessed.

## Environment

- Node.js 22.22, TypeScript 5.9, PostgreSQL 16.14, Chromium 141, Playwright 1.63, and axe-core 4.13.
- One Linux container. No screen reader, and no Access.
- Prototype: about 1,340 lines of source and about 790 lines of tests, in `spikes/spike5-form-editor/`.
- Run `npm test` for the 95 tests. Run `npm run serve` for a session.

## Measures

Table 3 shows the measures against the pass conditions.

**Table 3. Spike 5 measures**

| Measure | Pass condition | Measured | Met? |
|---|---|---|---|
| Common edit tasks completed unaided | 80% or more | Not measured | Needs users |
| Median time for one edit task | Under 3 minutes | Not measured | Needs users |
| Rendered forms rated 4 or 5 | At least 4 of 5 forms | Not measured | Needs the owner |
| Draft rebuilt exactly from the log | 100% of test drafts | 400 of 400 sessions, and 2,000 of 2,000 checks | Yes |
| Rename keeps data and updates every reference | 100% of test cases | 17 of 17 | Yes |
| Handlers that refer to a renamed field are listed | 100% of test cases | 17 of 17 | Yes |
| A form with 100 controls renders | Under 2 seconds | Median 16.5 ms, slowest 32 ms. On a 4 times slower CPU, slowest 98 ms. | Yes |
| Automated accessibility check | No critical violations | 0 critical and 0 serious, on 7 page states | Yes |

### Operation log

Each random session ran up to 40 steps: edits, rejected edits, undo, and redo. Across 400 sessions:

- 10,581 edits applied.
- 1,403 edits were rejected. About one generated edit in twelve was invalid on purpose, and the rest were rejected by the rules, such as a name that was already taken.
- 4,016 steps were an undo or a redo.
- 2,000 checks rebuilt the draft from the log, and every one matched exactly.
- Every draft along the way passed validation.

The check compares canonical JSON, so key order does not matter.

### Rename

Each case did the following against a PostgreSQL schema with sample data: ran the migration, and compared the data and every saved query before and after. Table 4 lists the 17 cases. The columns show what each rename had to change, as the prototype found it. Handlers are shown by their number from Spike 3.

**Table 4. Rename cases**

| Case | Controls or forms updated | Saved queries updated | Handlers listed |
|---|---|---|---|
| `Customer.name` | 3 | ActiveCustomers, BigCustomers, LondonCustomers | 08 |
| `Customer.credit_limit` | 3 | BigCustomers | 05 |
| `Customer.active` | 4 | ActiveCustomers | None |
| `Customer.customerid` | 1 | ActiveCustomers | None |
| `Customer.city` | 2 | ActiveCustomers, LondonCustomers | None |
| `Order.orderid` | 1 | OrderTotals, OpenOrders | None |
| `Order.status` | 3 | OpenOrders | 04, 05, 09 |
| `Order.order_date` | 2 | OpenOrders | 03, 04, 10 |
| `Order.customer_id` | 1 | OrderTotals | 05 |
| `OrderLine.qty` | 2 | OrderTotals | 02, 06 |
| `OrderLine.order_id` | 1 | OrderTotals | 07 |
| `OrderLine.product_id` | 2 | OrderTotals | 06 |
| `Product.unit_price` | 1 | OrderTotals | 01, 02 |
| `Product.productid` | 1 | OrderTotals | None |
| `Product.name` | 2 | None | 08 |
| Entity `Customer` to `Client`, table `customers` to `clients` | 3 | ActiveCustomers, BigCustomers, LondonCustomers | 05 |
| Entity `OrderLine` to `Line`, table `orderlines` to `order_lines` | 2 | OrderTotals | 07 |

The handler lists come from `grep -w` over the handler files, run independently of the code under test. In `Customer.name` and `Product.name`, handler 08 is listed only because it has a local variable called `name`.

Four checks ran in every case:

1. **Data survives.** Every table has the same rows after the migration.
2. **Queries keep working.** Every saved query runs, with the same rows and the same column names.
3. **References are valid.** Every form, expression, combo box, and subform refers only to fields that exist.
4. **Handlers are listed.** The list matches the result of `grep -w` over the handler files, and no handler is edited.

A **negative control** proves the queries needed the rewrite: after the migration, the unchanged query text fails in PostgreSQL. A **mutation check** proves the tests can fail. With the query rewrite switched off, 14 of 19 tests failed. With the combo-box rename switched off, 2 failed.

Primary and foreign keys survived a rename in a separate test.

**A limit on the handler list.** The scan finds the name as a word, so it reports a local variable called `name` in handler 08 for the renames of `Customer.name` and `Product.name`. That is a false positive in meaning, and it is the right answer for a list that people review. The scan cannot tell when a handler uses a field through a different name.

### Render time

The measure includes building the form, adding it to the page, forcing layout, and one paint. The form has 100 controls, each with a visibility rule and a validation rule. Ten runs gave a median of 16.5 ms and a slowest of 32.2 ms. With Chromium's CPU throttled four times, the median was 60.7 ms and the slowest 98.3 ms.

### Accessibility

axe-core ran with the tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, and `wcag22aa` on seven page states: the five forms, the editor, and the editor with a selected control, a rename preview, and an error message showing.

- The first run found one serious violation: the migration SQL box was a scrollable region that the keyboard could not reach. I fixed it with `tabindex`, a role, and a label, and the final run found none.
- The final run found no critical and no serious violations.

Automated checks find only part of the problems. A screen-reader test and a manual keyboard review by a person are still needed.

### Keyboard

A session with the keyboard alone selected a control, edited its label, moved it, undid and redid the move, set a visibility rule, and tried an invalid rule. It worked. Every move has a button, and undo and redo have `Ctrl+Z` and `Ctrl+Y`. An invalid rule is announced in an alert region.

The session needed 105 key presses, because there is no shortcut from the control list to the property panel. The usability session should watch for this.

## Draft workflow and permissions

Twelve server tests and four browser tests cover these rules:

- Without a grant, no one can touch a draft, and a view-only user cannot save a record.
- A person with Design can lock a draft, edit it, and save it. Publish returns 403, and nothing changes.
- A person with Manage can edit and publish.
- Only one draft is active. A second person gets "draft locked", and only the holder can use it.
- A tampered log is refused, and the draft keeps its last good log.
- A draft that was started from an old version cannot publish over a newer one.
- Publishing makes a new immutable version and records an audit event with the number of edits and the two version numbers.
- A form open from the earlier version gets a version-changed response when it saves. The browser shows an alert with a reload button, and the reloaded form shows the edit.
- The server checks every validation rule, refuses unknown fields, and does not check a hidden control.

The permission rule is the one from Phase 1: Manage covers Design, and Design does not cover Manage.

## Findings and design implications

### The expression language has two implementations that agree

The server must check the rules, because a browser check can be bypassed. The prototype's server is TypeScript, but the product's backend is Python. I chose the first of two options and built it:

- **Chosen:** write the evaluator twice, in TypeScript and in Python, with a written specification and a shared set of test cases that both must pass.
- **Not chosen:** run server-side checks through the Spike 3 sandbox. This costs time on every save.

What was built:

- **A specification** in [docs/EXPRESSIONS.md](../EXPRESSIONS.md). The TypeScript evaluator from the spike was too loose to copy. It inherited JavaScript's habit of turning a string into a number, and it formatted numbers in a way that Python formats differently. I tightened the language: equality is strict, only two numbers or two strings have an order, a number and a string never mix, and every function has a fixed number of arguments. I also added limits on length and nesting.
- **A Python evaluator and form checker** in `backend/a2w/expr.py` and `backend/a2w/formrules.py`.
- **Shared test cases** in `spec/expression/`: 233 expression cases, 15 rename cases, 9 reference cases, and 28 form cases. I worked out the expected results by hand from the specification, not by running either program.
- **A differential test** that sends random expressions, valid and damaged, through both evaluators.

Table 5 shows the results.

**Table 5. Agreement between the two evaluators**

| Check | Result |
|---|---|
| Shared cases, TypeScript | All pass |
| Shared cases, Python | All pass |
| Random expressions in the committed test | 10,000 cases in 4 runs, with no differences |
| A one-off larger run | 150,000 cases, of which 99,249 were valid, with no differences |
| Planted bugs, in the cases | 3 of 3 caught |
| Planted bugs, in the random test | 3 of 3 caught |

The shared cases found one problem before Python existed: I had assumed `1.` was a valid number, but the tokenizer never accepted it. I changed the specification to match.

The random test checks four things for every case: whether the expression is valid, its value, the fields it refers to, and the result of a rename. The generator covers Unicode text, large numbers, odd records, and a third of the cases are damaged on purpose. One planted bug, a length that counted UTF-16 units, showed up in only one or two cases per run, so rare paths are thinly covered. The shared cases cover them directly.

What is not done:

- The server does not call the Python checker yet. The Phase 1 backend has no forms, so there is nowhere to call it from. Phase 2 adds forms.
- `today()` uses whatever time the caller passes. The browser and the server do not yet share one event time.

### Build the editor

Table 6 compares the candidates. Licences come from the npm registry and from the licence files in the packages. I did not integrate any candidate, so the fit column is my judgement.

**Table 6. Build or adopt**

| Candidate | Licence | What it is | Fit with the definition model |
|---|---|---|---|
| This prototype (custom build) | The organisation's | Renderer, editor, and operations on the definition | Exact, because it is the definition |
| `@formio/js` 5.6.1 | MIT | A form renderer and builder | Uses its own JSON schema, and as far as I know it supports conditions written as code. The design forbids code in a definition. Not verified. |
| `survey-creator-core` 3.1.2 | **Commercial licence** (Devsoft Baltic) | A form builder | Cannot be used without buying a licence. The renderer `survey-core` is MIT. |
| `@bpmn-io/form-js` 2.1.1 | MIT-style, with a condition: the bpmn.io watermark in the rendered form must stay visible | A form viewer and editor | The watermark would appear in every owner's application. The owner must decide whether that is acceptable. |
| `@jsonforms/core` 3.8.0, `@rjsf/core` 6.11.0 | MIT, Apache-2.0 | Renderers from a schema | No editor. They cover only the renderer. |
| `@designable/core` 1.0.0-beta.45 | MIT | A design framework | The last release was in April 2022 and it is still a beta |
| GrapesJS 0.23.6 | BSD-3-Clause | A web page builder | Built for pages, not for forms that bind to data |
| `@dnd-kit/core` 6.3.1, `sortablejs` 1.15.7, `gridstack` 14.0.0, `react-grid-layout` 2.2.4, `interactjs` 1.10.28 | MIT | Drag and drop and layout libraries | Libraries to build with. All five could serve a custom build. |

The licence texts for SurveyJS Creator and form-js were read in full from the package files. The others are the registry's licence field only.

**Recommendation: build the editor on this operation model.** The model is the part that carries the safety: drafts, undo, the log, rename, and rules that cannot run code. An adopted builder would need a translation layer for all of that. The prototype did drag and drop with the browser's own events, plus a button for every move. A production build can add a drag library, such as one of the MIT libraries above, for touch and smoother dragging.

### Effort estimate

My estimate for a production Phase 2 editor is 8 to 12 engineer-weeks, and for adopting a builder with a translation layer, 5 to 8 engineer-weeks plus a continuing cost to keep the layer in step. Both figures are judgements, not measurements. The custom estimate rests on what the prototype covers (five control types, nine operations, and a property panel in about 1,340 lines) and on what it skips:

- Every control type that the converter can emit.
- A rule builder for owners who do not write expressions.
- Drag and drop on touch screens.
- Querying and editing saved queries and reports, which are P2 in the PRD.
- A screen-reader review, and fixes.

### Access form features that the renderer does not support

This list comes from my general knowledge of Access. It does not come from real forms. Spike 1 will give the true list.

- Tab controls, option groups, toggle buttons, and list boxes.
- Continuous forms, datasheet view, and split forms.
- Navigation controls, charts, the web browser control, and OLE and attachment controls.
- Images, lines, rectangles, and page breaks.
- Exact positions and overlapping controls. The prototype lays controls out in rows.
- Form header, footer, and section styling.
- Conditional formatting, input masks, and calculated controls.
- Record selectors, record navigation buttons, and the form's filter, sort, and "allow edits" properties.
- Form and control events. These go through the VBA pipeline as handlers.

### Other findings

- **Positions in a move.** Counting positions after the control leaves its row was the one rule that needed to be fixed in writing, because an emptied row shifts every index.
- **Strict rules help the second implementation.** A rule on an empty field fails, because a comparison with null is false. An owner must write `isnull(x) || x > 0` for an optional field. The specification says so, but the editor does not warn about it yet.
- **Preview state.** The first browser run found that clicking "Preview rename" reset the chosen field and the new name, so "Apply rename" used empty values. The editor now keeps the choice across redraws.
- **The log needs the ids.** New controls and rows get their ids when the edit is made, and the id is stored in the operation. Replaying the log then gives the same draft.
- **Handlers are never edited.** A handler is code, and a person must decide how a rename affects it.

## Remaining questions

- Do owners find text expressions workable, or do they need a rule builder? The validation pack asks this.
- Do real forms need exact positions? The prototype lays controls out in rows. The owner's ratings will show whether that is enough.
- Should a rename be allowed while a draft has other edits that refer to the field? The prototype allows it, and the log handles the order.
- Does the second approver (decision D13) change the publish flow? The prototype does not implement it.

## Not done

- The owner's ratings, the usability session, and a screen-reader test. These need people.
- Real forms. These need Spike 1.
- Running the data migration from the publish step, with a snapshot first. The tests apply the generated SQL directly.
- Editing of queries and reports, and of handlers (P2 in the PRD).

## Files

All spike code is in `spikes/spike5-form-editor/`. It is prototype code and must not enter the product without a review.

| Path | Contents |
|---|---|
| `src/model/` | Types, the expression language, operations, history, rename, and the SQL rewriter |
| `src/ui/` | Renderer, editor, and page entry point |
| `src/server/` | Draft workflow, permissions, and the session server |
| `fixtures/` | Five synthetic forms, queries, and sample data |
| `test/` | 95 tests: expressions, the shared vectors, operations, a randomised log test, rename against PostgreSQL, the workflow, and Chromium |
| `tools/` | A batch evaluator for the differential test, and the script that writes the form vectors |
| `../../backend/a2w/expr.py`, `formrules.py` | The Python evaluator and the server-side form checker |
| `../../spec/expression/` | The shared conformance cases |
| `public/` | Page and styles |
| `../../docs/spikes/spike-5-screens/` | Screenshots of the five rendered forms |
