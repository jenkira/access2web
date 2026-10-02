# Access2Web spike plan

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |
| Related | [Technical design document](TDD.md), Table 10, and the [decisions log](DECISIONS.md) |

## Summary

Four spikes test the assumptions that carry the most risk in the design. Each spike answers one question with a pass or fail result and a written report. The results decide whether the project continues as designed, changes scope, or stops.

Spike 1 comes first because it can remove form, report, and VBA conversion from scope. Spikes 2 and 3 can run in parallel after Spike 1 delivers its first extraction results. Spike 4 depends on the hand-translated handlers from Spike 3.

## Ground rules

These rules apply to all four spikes:

- Spikes produce knowledge, not product code. Prototype code lives in a `spikes/` directory and is not reused without review.
- Each spike has a time box. If a spike reaches its limit without a result, it reports what it learned and stops.
- Each spike writes a report that states the question, method, measurements, result, and recommendation.
- Source databases are copies. The team stores them in a restricted location and deletes them when the spikes end.
- The team does not send VBA source or data to a hosted AI service (decision D8). Spike 4 uses a local model.

## Sample databases

All four spikes use the same set of real databases. The application owner nominates three to five. Together, they must cover these cases:

- One small, simple database, as a baseline.
- One database with many forms and heavy VBA.
- One database with complex queries, including crosstab, parameter, and action queries.
- Both `.accdb` and `.mdb` formats.
- Multi-value fields, attachment fields, and calculated fields.
- A split database, where a front-end file links to tables in a back-end file.
- Optional: a password-protected file.

Split databases are not covered in the PRD or the technical design. Spike 1 must find out how common they are and how the extractor handles linked tables. The PRD might need a requirement for them.

## Spike 1: extraction and worker isolation

### Question

Can the system extract tables, forms, reports, macros, and VBA from real Access files, and can it do so safely?

### Time box

An estimate of 6 to 9 working days for one engineer. The estimate assumes the sample databases, the owner's existing PowerShell scripts, and a Windows Server machine with Microsoft Access are ready on day 1.

### Part 1a: native extraction

To test extraction without Access:

1. Run Jackcess, the primary tool, on each sample file, and list the tables, fields, relationships, indexes, and saved queries it returns.
2. Run mdbtools and one Python reader (pyaccdb or access-parser) on the same files, as cross-checks.
3. Export all rows from every table to CSV with each tool.
4. Compare the table, field, and row counts across the tools and with the counts that Access reports for the same file.
5. Record every object a tool fails to read, with the error, and the Access version of the file.
6. Record how each tool handles multi-value fields, attachments, calculated fields, and password-protected files.

### Part 1b: automation extraction

To test extraction with Access:

1. Start from the owner's existing PowerShell automation scripts. Adapt them to open each file in Access with macros force-disabled.
2. Export every form, report, macro, and module by using `SaveAsText`.
3. Record every export that fails, and the reason.
4. Check that no `AutoExec` macro or VBA ran, by using files that contain a harmless marker action, such as writing a file.
5. Parse five exported forms into a draft layout tree, to confirm that the text format holds enough detail to rebuild a form.
6. Run a stability test. Run the export unattended, with no signed-in session, for 200 consecutive jobs, and record every hang, crash, and dialog box. Microsoft does not support this mode, so the failure rate decides whether the design is workable.
7. Test the time limit. Confirm that the worker kills a hung Access process and that the next job starts clean.
8. Test whether the Access Runtime, which has a lower licence cost, can run `SaveAsText`, or whether full Access is required.

### Part 1c: native VBA extraction

Public write-ups describe compressed VBA streams inside `.accdb` files. This part tests whether VBA source can be recovered without Access. Limit it to one working day. To test it:

1. Find the compressed VBA streams in two sample files by using the published method and any maintained tool.
2. Decompress them, and compare the recovered source with the `SaveAsText` export from Part 1b.
3. Record whether the method works for every Access version in the samples, and whether the result includes the link from each procedure to its form or report.

If the method is reliable, VBA inventory and classification can run on Linux without Access. If it is not, the design keeps VBA extraction in the automation tier.

### Part 1d: worker isolation

The design proposes a disposable VM for each job. This part compares that choice with a container. Test these three configurations:

1. A Windows VM, restored from a snapshot for each job.
2. A Windows container with Hyper-V isolation.
3. A Windows container with process isolation.

For each configuration, check these points:

- Whether Microsoft Access installs and runs. Microsoft does not support unattended Automation of Office, and states that the practice might not be covered by the licence agreement. The owner's experience shows that it works on server operating systems, but the organisation must still confirm the licence terms and accept the lack of support before relying on any result.
- Whether the job can run without a signed-in desktop session.
- Start-up time for each job, and time to destroy the environment.
- Memory and CPU use for each job.
- Whether network access blocks fully.
- Whether a hostile file can reach the host or another job's data. Test with the marker file from Part 1b.

A process-isolated container shares the host kernel. For untrusted files this is a weaker boundary than a VM, so the team must not choose it unless the security owner accepts the risk. A Linux container cannot run Access, and running Access under a compatibility layer such as Wine is not a supported approach. Linux containers are suitable for the native tier only.

### Measures

Table 1 lists the measures and the pass conditions.

**Table 1. Spike 1 measures**

| Measure | Pass condition |
|---|---|
| Tables, fields, and row counts match Access | 100% match for all sample files |
| Share of all objects extracted without error | 90% or more in each of 3 databases |
| Forms with enough detail to draft a layout | 90% or more |
| Macros disabled during extraction | No marker file in any run |
| Native VBA extraction (Part 1c) | Recovered source matches the `SaveAsText` export for every sample, or a documented reason |
| Unattended stability over 200 consecutive jobs | 99% or more complete without a hang or crash, and every failure is recovered by the time limit |
| Isolation configuration | At least one configuration passes all isolation checks, with licence and support confirmed |
| Job start-up time | Under 60 seconds, as a proposal for the owner to confirm |

### Outputs

- Report with the results for each file and each isolation configuration.
- List of unsupported objects and file features.
- Comparison of the open source tools, with a recommendation for the native tier.
- Stability results for the automation tier, and the owner's scripts, adapted.
- Finding on native VBA extraction.
- Recommendation on the isolation configuration, with licence cost.
- Finding on split databases and linked tables.

### Decision

Table 2 lists what each outcome means.

**Table 2. Spike 1 outcomes**

| Outcome | Decision |
|---|---|
| Native and automation tiers both pass, and isolation is acceptable | Continue as designed |
| Native tier passes, but automation fails or is not allowed | If native VBA extraction passes, keep VBA inventory and classification. Remove form and report conversion from scope. Offer table, data, and query conversion, with forms rebuilt by hand in the runtime. Revise the PRD. |
| Automation works, but stability is below target | Redesign the worker with a larger pool and shorter jobs, or restrict automation to forms and reports. Re-run the stability test. |
| Native tier fails on common files | Stop and reconsider the product |

## Spike 2: query translation

### Question

Can a transpiler convert the organisation's Jet SQL queries to PostgreSQL, with matching results?

### Time box

An estimate of 5 to 8 working days for one engineer. The spike starts when Spike 1 has exported saved queries from at least three files. UCanAccess, which runs queries on Linux, can serve as a quick first check while the Access comparison is set up.

### Method

To measure translation:

1. Collect every saved query from the sample databases, and count the constructs each one uses. Use the list in the technical design as the starting point, and add any construct the files contain that the list lacks.
2. Load the migrated data into a test PostgreSQL schema.
3. Build a prototype transpiler. Evaluate two approaches and choose one: extend an existing SQL library with a Jet dialect, or write a purpose-built parser. Record the reason for the choice.
4. Translate every query, and mark each as translated, partly translated, or failed.
5. Run each original query in Access, and export the result to CSV. In this spike only, running queries in Access is acceptable because the files are trusted copies and a query is not VBA. Access is the source of truth. Optionally, run the same queries through UCanAccess on Linux, and record where UCanAccess differs from Access, to learn whether it is a usable test aid.
6. Run each translated query in PostgreSQL, and compare the result with the Access export. Compare row counts, column names, and values. Treat floating-point and date differences as defects until explained.
7. Group the failures by cause, and estimate the work to fix each group.

### Measures

Table 3 lists the measures and the pass conditions.

**Table 3. Spike 2 measures**

| Measure | Pass condition |
|---|---|
| Queries translated without manual edits | 80% or more |
| Translated queries with matching results | 95% or more of those translated |
| Queries that fail with a clear reason | 100% of those not translated |
| Crosstab queries | Result matches for every crosstab in the samples, or a documented reason |
| Domain aggregate functions (`DLookup` and similar) | Result matches for every use in the samples, or a documented reason |

The 95% matching condition is stricter than the translation rate because a query that translates but returns wrong results is worse than a query that fails visibly.

### Outputs

- Table of constructs, with counts and translation results.
- Prototype transpiler and its test cases.
- Decision on library or purpose-built parser, with the reason.
- Estimate of the work to reach the production target.

### Decision

- If both targets pass, continue and size the production transpiler from the estimate.
- If translation passes but matching results fail, fix the cause before any build, because wrong results are the main danger.
- If the translation rate is below target, list the constructs that cause failures. Decide whether to support them, or report them as not converted and accept a lower conversion rate.

## Spike 3: handler sandbox

### Question

Can a WebAssembly (Wasm) sandbox run realistic handlers within limits, and does it contain hostile code?

### Time box

An estimate of 3 to 5 working days for one engineer. This spike does not depend on Spike 1, because handlers for the test are written by hand.

### Method

To measure the sandbox:

1. Select 10 real VBA procedures from the sample databases. Include simple validation, a calculation, a record update through DAO or ADO, and a loop over records.
2. Translate the 10 procedures to TypeScript by hand, against the handler interface in the technical design.
3. Build a harness that runs a handler in QuickJS compiled to Wasm, and provides the host functions: `ctx`, `db.query`, and `ui`.
4. Compare at least one other approach, such as V8 isolates, and record the differences in isolation, speed, and memory.
5. Run each handler 1,000 times with sample inputs, and record the time and memory use for each run.
6. Write a suite of at least 20 hostile handlers, and run each one.
7. Confirm that a handler failure rolls back the database transaction.

The hostile suite must try to:

- Make a network request.
- Read or write a file.
- Import a module outside the host interface.
- Run forever.
- Allocate memory until it fails.
- Read another application's schema through `db.query`.
- Run SQL assembled from strings, to test the injection check.
- Return data that breaks the browser instruction format.
- Read the clock or random numbers directly.
- Cause a stack overflow.

### Measures

Table 4 lists the measures and the pass conditions.

**Table 4. Spike 3 measures**

| Measure | Pass condition |
|---|---|
| Hostile handlers contained | 100% fail safely, with no effect outside the sandbox |
| Normal handler run time | Under 100 ms at the 95th percentile, including start-up |
| Run-time limit | A handler that runs forever stops within its limit |
| Memory limit | A handler that over-allocates stops without affecting other requests |
| Transaction rollback | A failed handler leaves no partial change |
| Host interface coverage | All 10 handlers run with the interface as designed, or the report lists the missing functions |

### Translation signal

This spike does not test AI translation. Spike 4 tests it with a local model and reuses the 10 hand-translated handlers from this spike as reference answers.

### Outputs

- Report on the sandbox options, with a recommendation.
- Hostile suite and results.
- Draft of the handler interface, revised from the findings.

### Decision

- If all measures pass, continue with the chosen sandbox.
- If a hostile handler escapes, stop and change the isolation approach before any other work on handlers.
- If speed fails, test a warm instance pool, and review the clean-instance rule in the technical design.

## Spike 4: local translation model

### Question

Can a locally hosted model translate VBA procedures to TypeScript handlers that the owner can approve with little editing, and can it avoid translating procedures that must go to manual redesign?

### Time box

An estimate of 5 working days for one engineer, after Spike 3 delivers its hand-translated handlers. The spike also needs a GPU server (open item O5).

### Method

To evaluate the model:

1. Build an evaluation set of 30 or more VBA procedures from the sample databases. Include the 10 procedures from Spike 3, which have hand-written reference handlers. Include at least 10 procedures that belong in manual redesign, such as automation of Excel or Outlook, Windows API calls, and file access.
2. Choose two or three candidate models. Cover a mid-size class of about 14 billion parameters, a class of about 30 billion parameters, and a larger class if the hardware allows it. Candidates include models in the Qwen3-Coder family. Confirm the licence and availability of each model on the first day.
3. Serve the models locally with Ollama or llama.cpp. Record the hardware, quantisation level, and context length.
4. Build the translation prompt from the technical design: the procedure, the entity and field definitions, and the handler interface.
5. Run each model on the full set. Parse each result, and reject any output that uses anything outside the handler interface.
6. Add the bounded repair loop with up to three attempts. Return the parse errors and failed tests to the model.
7. Add retrieved examples of approved translations to the prompt, and run the set again. Record whether examples change the result.
8. Run the generated handlers in the Spike 3 sandbox against tests, and compare the outputs with the reference handlers.
9. Ask the application owner to rate a sample of 15 results as approvable as is, approvable with minor edits, or not approvable.
10. Record the time and memory use for each model.

### Measures

Table 5 lists the measures and the pass conditions.

**Table 5. Spike 4 measures**

| Measure | Pass condition |
|---|---|
| Output parses and uses only the handler interface, after up to 3 repair attempts | 95% or more |
| Translatable procedures that pass their tests without edits | 50% or more |
| Translatable procedures rated approvable with minor edits or better | 75% or more |
| Manual-redesign procedures that receive a translation | 5% or fewer |
| Time to translate one procedure | Under 5 minutes, as a proposal for the owner to confirm |

The 5% limit on manual-redesign procedures is strict because a confident but wrong translation of code that automates Outlook, for example, is a hazard that the owner might approve without noticing.

### Outputs

- Report comparing the models on each measure, with hardware and cost.
- Effect of the repair loop and of examples.
- Failure categories, with samples.
- Recommendation on the model, the serving software, and the hardware for production.

### Decision

- If the measures pass, choose the model and size the hardware.
- If the model passes on translatable procedures but translates manual-redesign procedures, strengthen the classifier and test again before any build.
- If no model passes, rely on fixed mappings and manual redesign, and ask the data policy owner whether a hosted service can be used for a defined class of procedure.

## Schedule and dependencies

Table 6 shows the order of work. The durations are estimates, and the owner must confirm them against available people.

**Table 6. Schedule**

| Week | Spike 1 | Spike 2 | Spike 3 | Spike 4 |
|---|---|---|---|---|
| Before week 1 | Nominate databases, confirm Access licence and a Windows test machine | | | Arrange a GPU server |
| 1 | Parts 1a and 1b | | Harness and 10 handlers | |
| 2 | Parts 1c and 1d, and report | Collect queries, build the prototype | Hostile suite and report | Prepare the evaluation set |
| 3 | | Compare results and report | | Run models |
| 4 | | | | Owner rating and report |
| End of week 3 | Decision meeting on Spikes 1 to 3 | | | |
| End of week 4 | | | | Decision meeting on Spike 4 |

## Prerequisites

The spikes cannot start until these items exist:

- Three to five sample databases, nominated by the application owner and copied to a restricted location.
- The owner's existing PowerShell automation scripts for Access.
- A Windows Server machine or VM with a licensed copy of Microsoft Access.
- A GPU server for Spike 4, or a decision on how to obtain one.
- Someone to confirm the licence and support position for Access on a server or in a container.

## Risks

- The sample databases might not represent the organisation's range. A skewed sample gives results that look better or worse than reality, so the owner must choose files that include the difficult cases.
- Pass thresholds are proposals. If the owner does not confirm them before the spikes start, the results can be argued either way.
- Licence terms might rule out the automation tier regardless of the technical result. Check this in the first days, before the team invests in the rest of Part 1.
- Microsoft does not support unattended Automation of Office. The automation tier can work in tests and still fail under production load, so the stability test must run long enough to show hangs.
