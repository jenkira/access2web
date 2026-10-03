# Spike 3 report: handler sandbox

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |
| Spike plan | [Spike 3](../SPIKE-PLAN.md) |
| Result | **Partial. All six measures pass. Two method steps were not done.** |

## Summary

A WebAssembly sandbox built on QuickJS ran 10 hand-translated handlers in under 6 ms at the 95th percentile, and contained all 45 hostile handlers. It passes every measure in Table 4 of the spike plan.

The result is partial for two reasons. The 10 procedures are synthetic, because no sample databases exist yet. The plan's step 8, which runs the harness in a Kubernetes pod with CPU and memory limits, was not done, because the build environment has no cluster.

The spike changes the design in six ways:

1. **The sandbox must run in a thread or process that the host can kill.** A catastrophic regular expression ignored the interrupt handler and froze the whole host. Only terminating the worker thread stopped it.
2. **Each application needs its own database login.** A shared login that belongs to every application role lets SQL switch between applications. I confirmed this against PostgreSQL. It does not affect Phase 1, which runs no user SQL, but it affects every design that lets handler SQL reach a shared connection.
3. **The runtime SQL guard is load-bearing.** Four hostile cases succeed at the database level and fail only because of the guard. One of them changes the user identity setting that row-level rules would read.
4. **QuickJS in WebAssembly is the better choice than V8 isolates.** V8 isolates crashed the host process on two handlers and exposed the real date.
5. **The static check is only a filter.** The sandbox and the guard held when the check was skipped.
6. **The handler interface needs five changes**, listed under "Draft handler interface".

## Question

Can a WebAssembly sandbox run realistic handlers within limits, and does it contain hostile code?

## Method

### What the plan asked for, and what the spike did

Table 1 compares the plan with what happened.

**Table 1. Method changes from the spike plan**

| Plan step | What the spike did | Reason |
|---|---|---|
| 1. Select 10 real VBA procedures | Wrote 10 synthetic VBA procedures that match the plan's list: validation, a calculation, a record update through DAO, and a loop over records | The sample databases (open item O2) are not nominated |
| 2. Translate by hand to TypeScript | Done. All 10 type-check against the handler interface in strict mode. | As planned |
| 3. Build a harness on QuickJS in Wasm | Done, with a worker-thread pool | As planned. The pool was added after the regular-expression finding. |
| 4. Compare another approach | Built the same harness on V8 isolates (`isolated-vm`) and ran the same suite | As planned |
| 5. Run each handler 1,000 times | Done: 10,000 runs on each of three hosts | As planned |
| 6. Write at least 20 hostile handlers | Wrote 45 | As planned |
| 7. Confirm a failure rolls back the transaction | Done: five tests | As planned |
| 8. Run in a Kubernetes pod with limits | **Not done** | No cluster in the build environment |

### Handlers

The 10 handlers cover the cases in the plan. Each file in `spikes/spike3-sandbox/handlers/` holds the synthetic VBA in a comment, above the TypeScript. Table 2 lists them.

**Table 2. Handlers**

| Handler | Pattern | Database |
|---|---|---|
| 01 Validate price | Validation that cancels the event | No |
| 02 Line total | Calculation that sets a field | No |
| 03 Validate dates | Date comparison | No |
| 04 New order defaults | Defaults, and show or hide a control | No |
| 05 Credit check | Aggregate query, then a decision | Yes |
| 06 Update stock | Record update (DAO `Edit` and `Update`) | Yes |
| 07 Recalculate order total | Loop over records, then an update | Yes |
| 08 Full name | String formatting with null handling | No |
| 09 Status transition | Lookup in a rules table | Yes |
| 10 Archive old orders | Loop that updates each record, and a message | Yes |

### Sandbox design

The harness follows the technical design. Each call gets a clean QuickJS runtime and context, with these limits:

- 250 ms of wall-clock time, including database waits.
- 16 MB of memory and a 256 KB stack.
- At most 100 queries, 5,000 rows, and 256 KB of result for each run.
- At most 100 browser instructions.

The handler sees four globals: `ctx`, `db`, `ui`, and nothing else. The host removes the real clock and `Math.random`, and freezes `ctx`, `db`, and `ui`. The host checks every SQL statement before it runs, and runs it inside the request's transaction as the application's own database login.

### Hostile suite

The 45 cases cover every item in the plan's list, plus more. Table 3 groups them.

**Table 3. Hostile cases**

| Group | Cases | Examples |
|---|---|---|
| Network | 3 | `fetch`, `XMLHttpRequest`, `WebSocket` to a local listener |
| Modules, process, and files | 8 | `import()`, `require`, `process`, the `Function` constructor, reading a file |
| Resources | 7 | Infinite loop, memory bombs, stack overflow, catastrophic regular expression, a million queries |
| Database | 13 | Another application's schema, `set_config`, string-built SQL, `drop table`, `pg_sleep`, `pg_read_file`, `copy to program` |
| Clock, randomness, and state | 6 | `Date`, `Intl`, `Math.random`, state left for the next run, changing `ctx` |
| Result and instruction format | 8 | A 10 MB result, circular and non-serialisable values, a `__proto__` key, bad control names |

Each case ran in three modes, to show which layer stops it:

- **Mode A:** static check, SQL guard, sandbox, and database roles, as in production.
- **Mode B:** the static check is skipped.
- **Mode C:** the SQL guard is also off, so only the sandbox and the database roles remain.

The suite also checks for effects outside the sandbox, such as a connection to a listener, a file created on the server, rows removed from another table, or the host's `Object.prototype` changed.

## Environment

- Node.js 22.22, QuickJS compiled to Wasm through `quickjs-emscripten` 0.31.0, `isolated-vm` 6, and `pg` 8.
- PostgreSQL 16.14, with one login role for each application and no role membership between them.
- One Linux container with no resource limits. No Kubernetes cluster.
- Prototype code is in `spikes/spike3-sandbox/`.
- Run `npm test` for the 25 tests, `npm run hostile` for the hostile suite, and `npm run normal` for the measurements.

## Measures

Table 4 shows the measures against the pass conditions.

**Table 4. Spike 3 measures**

| Measure | Pass condition | Measured | Met? |
|---|---|---|---|
| Hostile handlers contained | 100% fail safely, with no effect outside the sandbox | 45 of 45 in each of the three modes | Yes, on this suite |
| Normal handler run time | Under 100 ms at the 95th percentile, including start-up | 4.65 ms for all 10,000 runs. The slowest handler was 5.58 ms. The slowest single run was 19.7 ms. | Yes |
| Run-time limit | A handler that runs forever stops within its limit | An infinite loop stopped at 253 ms against a 250 ms limit. A catastrophic regular expression needed the worker to be terminated, at 752 ms. | Yes, with the worker |
| Memory limit | A handler that over-allocates stops without affecting other requests | Memory bombs stopped in 11 to 64 ms. Twelve normal runs beside two memory bombs, a loop, and a regular expression all returned correct results. | Yes |
| Transaction rollback | A failed handler leaves no partial change | Five tests: a thrown error, a cancel, a time-limit stop after a write, the worker path, and a commit control | Yes |
| Host interface coverage | All 10 handlers run with the interface as designed, or the report lists the missing functions | All 10 run. Five interface changes are needed. | Yes, with changes |

The run times include a fresh QuickJS runtime for each run and the database round trips. They exclude the cost of starting a worker, which is a one-time cost of about 520 ms. They do not include pod CPU limits, because step 8 was not done.

### Run time by host

Table 5 compares the three hosts over 10,000 runs each.

**Table 5. Run time in milliseconds, including start-up and database time**

| Host | Median | 95th percentile | 99th percentile | Slowest |
|---|---|---|---|---|
| QuickJS in a worker thread | 2.10 | 4.65 | 6.62 | 19.73 |
| QuickJS in the main thread | 1.49 | 2.84 | 3.86 | 12.27 |
| V8 isolate | 4.57 | 7.81 | 10.73 | 23.49 |

The worker thread adds about 0.6 ms for each run, which buys the ability to terminate a stuck run. A V8 isolate is slower for these short handlers.

## Result

**Partial.** The sandbox passes all six measures on the evidence collected. The result is not final until the spike runs on real procedures and in a pod with resource limits. The hostile suite is a list that I wrote, so 45 of 45 shows that the sandbox holds against these attacks, and does not show that no attack exists.

## Failures and findings

### Defects found in the suite and the guard

Running the suite found these defects in my own work:

1. Three predicates in the first suite run gave false alarms. One misread the format of `Date()`, one misread `null` for `undefined`, and one tested `COPY ... TO PROGRAM` with a parameter. That is a syntax error, so the case never reached the database permission. I fixed all three.
2. The SQL guard's rule for backslashes did not work, because the backslash was lost in the regular expression. A unit test found it, and I fixed it. Quotes were already rejected, so the practical risk was low.

After the guard fix, I reran the whole hostile suite. The numbers in this report come from that rerun.

The static check also does not list `Intl`, which exposes the real date on V8 isolates. QuickJS has no `Intl`, so this does not affect the chosen sandbox.

### A catastrophic regular expression froze the host

The QuickJS regular-expression engine ignores the interrupt handler. WebAssembly runs on the same thread as the host, so the host's own timer could not fire, and the whole process stopped at 99% CPU.

The fix is to run the sandbox in a worker thread and terminate the thread from the main thread after a hard limit. With the fix, the same handler stopped at 752 ms and the pool replaced the worker. Any design that runs the sandbox in the same thread as the runtime API cannot enforce its time limit.

### The asyncified module allows one suspended call at a time

A handler's `db.query` must look synchronous to the handler, and the real query is asynchronous. The QuickJS asyncify build supports this, but each module instance can have only one suspended call. The harness therefore uses one module instance for each concurrent run, inside one worker for each run.

### A shared database login lets SQL switch applications

The technical design uses one role for each application, and the Phase 1 runtime runs `SET LOCAL ROLE` from a shared login that belongs to every application role. I tested this against PostgreSQL 16:

- With a shared login that belongs to `app_one` and `app_two`, SQL running as `app_one` ran `select set_config('role', 'app_two', true)` and then read the table of `app_two`.
- With a separate login for each application, the same statement failed with "permission denied to set role".

The spike's harness uses a separate login for each application. Phase 1 runs no user SQL, so it is not exposed today. Phase 3 handlers send SQL to the database, so the production runtime must connect as each application's own login, with its credentials in a separate secret. The technical design already says this about secrets. It should also say that the runtime does not use `SET ROLE` between applications.

### The SQL guard is load-bearing

Table 6 lists the four cases that run in mode C, with the guard off, and fail in mode B only because of the guard.

**Table 6. Cases that depend on the SQL guard**

| Case | What it does | What stops it in production |
|---|---|---|
| H23 | Builds SQL from a string (injection) | The guard rejects quotes |
| H24 | Adds a second statement after a semicolon | The guard rejects semicolons |
| H25 | Cuts off a condition with a comment | The guard rejects comments |
| H32 | Calls `set_config('a2w.user', 'admin', true)` | The guard rejects `set_config` |

H23, H24, and H25 only reach data that the handler may already read and change in its own schema, so they are not breakouts. H32 matters more. If row-level rules read the user from a setting such as `a2w.user`, any SQL that reaches the database can change it, and the rules stop protecting anything. The production design must keep the guard, set the identity from the host and never from the handler, and prefer a mechanism the handler's role cannot change.

Nine other database cases were stopped by the database roles alone in mode C: another schema, `set_config('role', ...)`, `drop table`, `pg_read_file`, `copy to program`, and the resource cases. A statement timeout set on the login role cancelled `pg_sleep`, an expensive query, and a very large write at 400 ms.

### V8 isolates are not a safe choice

Table 7 compares QuickJS in Wasm with V8 isolates on the 31 cases that need no database. Each V8 case ran in its own process, so a crash could not stop the run.

**Table 7. QuickJS in Wasm and V8 isolates**

| Case | QuickJS in Wasm | V8 isolate |
|---|---|---|
| Hostile cases contained, of 31 | 31 | 28 in mode A, 27 in mode B |
| Allocating loop (H13) | Memory limit error | Process crash (SIGSEGV) |
| Huge array (H14) | Memory limit error | Process abort (SIGABRT) |
| Real date through `Intl` (H45) | `Intl` does not exist | The real date is visible |
| `WebAssembly` (H08) | Does not exist | Available |
| Catastrophic regular expression (H17) | Contained only by terminating the worker | Contained by the isolate's timeout |
| Median run time | 1.49 ms (main thread) | 4.57 ms |

A handler that can crash the runtime process takes down every user of that process. The V8 allocating loop crashed in one run and returned a memory error in an earlier run, so the crash is not reliable, but a reliable handler crash is not needed to cause an outage. The V8 results show a weaker boundary for this threat model. The comparison does not show that V8 is unsafe everywhere.

### Other results

- All five routes to the real clock returned the frozen event time: `Date.now()`, `new Date()`, `Date()`, the `Date` constructor through its prototype, and `Reflect.construct`. `Math.random` throws.
- Nothing carried over between runs. A handler that set a global and changed `Object.prototype` left no trace for the next run.
- `ctx`, `db`, and `ui` cannot be replaced or changed.
- Oversized results, circular values, `BigInt`, and 1,000 browser instructions were all refused, and a `__proto__` key in a result did not change the host.
- A handler can send HTML as a message. The host passes it through as plain text, so the browser client must render messages as text and never as HTML (H57).

## Draft handler interface

The file `spikes/spike3-sandbox/handlers/handler-api.d.ts` holds the revised interface. The changes from the technical design are:

1. **SQL is a literal, and values are parameters.** The text holds no quotes, comments, or second statement. Handlers use `$1`, `$2`, and so on.
2. **A write returns rows through `returning`.** There is no row count, so handlers 06, 07, and 10 use `returning id`.
3. **`ctx.now` is the time of the event.** `Date.now()` and `new Date()` return it, and nothing else tells the time.
4. **Numbers from PostgreSQL arrive as strings**, such as `"2.50"`, so handlers convert them with `Number()`. A decision is needed on whether the interface should do this for them.
5. **`ui.cancel` rolls back every change the handler made**, and the browser instructions are limited to `message`, `setVisible`, `setValue`, and `cancel`, with validated names and a size limit.

The interface has no asynchronous calls, no `import`, no timers, and no way to read the clock or random numbers.

## Recommendation

1. **Continue with QuickJS compiled to WebAssembly**, and do not use V8 isolates for handlers.
2. **Run the sandbox in a killable worker thread or process** with a hard time limit, as in this prototype.
3. **Give each application its own database login**, with no role membership, and do not use `SET ROLE` between applications.
4. **Keep the SQL guard**, set the user identity from the host, and review any row-level rule that reads a setting a handler's role can change.
5. **Finish the two missing steps**: rerun with real procedures, and run in a pod with CPU and memory limits to confirm that the sandbox limits and the pod limits both hold.
6. **Update the technical design** with the findings above. I have not changed it, because it records decisions that the owner makes.

### Effort estimate

My estimate for a production sandbox service is 3 to 5 engineer-weeks. This is a judgement, not a measurement. The prototype is about 700 lines of JavaScript. The production work that the prototype skips is:

- A process or pod boundary for each worker, with limits that the pod enforces.
- Row-level security wired to a setting the handler cannot change.
- Metrics, logs, and an audit record of every handler run.
- A policy for warm worker pools and for the worker start-up cost of about 520 ms.
- A reviewed handler API and a compatibility policy for it.

The estimate excludes the VBA translation pipeline, which Spike 4 covers.

## Remaining questions

- Do real procedures need more than the four host functions? The 10 synthetic ones did not, but the real set might use `DLookup`, forms, or reports in ways that the interface cannot express.
- How does the pod's CPU limit affect the 250 ms time limit? Under CPU throttling, a handler could stop early or late.
- Is a 520 ms worker start-up acceptable at the scale in the PRD (2,000 concurrent users)? The pool size and warm-up policy need a load test.
- Should the interface convert PostgreSQL numbers and dates for handlers? It affects how closely translated code can follow the VBA.
- Who reviews the guard's denylist when PostgreSQL adds new functions?

## Files

All spike code is in `spikes/spike3-sandbox/`. It is prototype code and must not enter the product without a review.

| Path | Contents |
|---|---|
| `src/sandbox.mjs` | QuickJS host, limits, and the prelude that locks the environment |
| `src/worker.mjs`, `src/workerpool.mjs` | Worker threads with hard termination |
| `src/sqlguard.mjs`, `src/check.mjs`, `src/ui.mjs` | SQL guard, static check, and instruction validation |
| `src/ivm.mjs` | The V8 isolate host used for the comparison |
| `src/run.mjs` | Runs a handler inside a transaction |
| `handlers/` | 10 handlers with their VBA, the interface, and sample inputs |
| `hostile/suite.mjs` | The 45 hostile cases |
| `src/run-hostile.mjs`, `src/run-hostile-ivm.mjs`, `src/run-normal.mjs` | The measurements |
| `test/` | 25 tests |
