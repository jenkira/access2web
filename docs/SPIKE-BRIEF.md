# Access2Web spike team brief

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |
| Audience | Engineers who run the five spikes |

## Summary

You run five time-boxed spikes that test the riskiest assumptions in the Access2Web design. Each spike produces a pass or fail result and a written report. The owner uses the results at two decision meetings to confirm the design, change its scope, or stop the project.

This brief tells you what to read, what is already decided, what you need before you start, and how to report. The [spike plan](SPIKE-PLAN.md) holds the full method for each spike.

## Read first

Read these documents in this order:

1. [Product requirements document](PRD.md): what the system must do.
2. [Technical design document](TDD.md): how the design works, and which assumptions each spike tests.
3. [Spike plan](SPIKE-PLAN.md): your method, measures, and pass conditions.
4. [Decisions log](DECISIONS.md): what the owner has already decided.

## What is decided

Do not reopen these decisions. If a spike finds evidence against one, report it and keep going.

- Access is automated on a Windows Server worker with PowerShell, and the owner accepted the support risk (D1, D2).
- The application database is PostgreSQL, and handlers are TypeScript in a WebAssembly sandbox (D3, D4).
- The spike pass thresholds in the spike plan stand (D5).
- No VBA source or data goes to a hosted AI service (D8). Spike 4 uses a local model on CPU (D9, D18).
- The platform is RKE2 with Calico, Windows Server 2022 nodes, no GPU nodes, a PostgreSQL container, S3-compatible storage, Passwordstate with the External Secrets Operator, and ProGet (D16, D17, D19).
- The platform team provisions a high-memory CPU node for Spike 4 (D20).
- Owners can edit migrated applications, and the web application becomes the system of record after the first published edit (D11, D12).

## Spikes at a glance

Table 1 lists the five spikes with their inputs and outputs. The leads are to be named by the owner.

**Table 1. Spike summary**

| Spike | Question | Needs from others | Output | Time box |
|---|---|---|---|---|
| 1. Extraction and worker isolation | Can the system extract tables, forms, reports, macros, and VBA from real files, safely and stably? | Sample databases, Windows Server 2022 machine with Access, the owner's PowerShell scripts | Report, adapted scripts, tool comparison, isolation recommendation | 6 to 9 days |
| 2. Query translation | Can a transpiler convert Jet SQL to PostgreSQL with matching results? | Saved queries from Spike 1 | Report, prototype transpiler, effort estimate | 5 to 8 days |
| 3. Handler sandbox | Can a WebAssembly sandbox run realistic handlers within limits and contain hostile code? | 10 VBA procedures from the sample databases | Report, hostile test suite, draft handler interface | 3 to 5 days |
| 4. Local translation model | Can a CPU-hosted model translate VBA to approvable handlers, and avoid translating manual-redesign code? | Hand-translated handlers from Spike 3, CPU node | Report with model comparison and hardware recommendation | 5 days |
| 5. Form editor | Can the runtime and operation model support a visual form editor for common edits? | Five exported forms from Spike 1, three test users | Report, prototype renderer and editor, build or adopt recommendation | 10 to 12 days |

## Before you start

You cannot start until these items exist. Items marked blocking stop all work if missing.

**Table 2. Prerequisites**

| Item | Blocking for | Provided by |
|---|---|---|
| Three to five sample databases (open item O2) | All spikes | Application owner |
| Confirmation that licensing covers Access on a worker (open item O3) | Spike 1 | Licensing contact |
| Windows Server 2022 machine or VM with licensed Access. Confirm that the Access edition runs on Server 2022. | Spike 1 | Platform team |
| The owner's existing PowerShell automation scripts | Spike 1 | Application owner |
| Access to the RKE2 cluster, with a namespace for the spikes and Windows node access | Spikes 1, 3, 4 | Platform team |
| High-memory CPU node, proposed at 16 or more cores and 64 GB of memory | Spike 4 | Platform team |
| Three representative users, half a day each | Spike 5 | Application owner |
| Repository access and a branch for each spike | All spikes | Owner |

Record the exact RKE2 version and the Windows Server build in your first report entry.

## Ground rules

These rules apply to all five spikes:

- **Spikes produce knowledge.** Prototype code lives in the `spikes/` directory. Do not reuse it in the product without a review.
- **Respect the time box.** If you reach the limit without a result, report what you learned and stop.
- **Handle data with care.** Work on copies of the databases, stored in a restricted location. Tell the owner before you open any file that holds personal or health information, and mask the data first. Delete all copies when the spikes end.
- **Use no hosted AI service.** This applies to VBA source and data, in every spike.
- **Never run uploaded VBA outside a disposable environment.** Open files with macros force-disabled, and use the isolated environments in Spike 1.
- **Measure, then conclude.** Report numbers against the pass conditions. Do not report a result you did not measure, and mark any figure you took from a source rather than measured.

## Stop and escalate

Stop work and tell the owner the same day if any of these happen:

- A hostile handler escapes the sandbox in Spike 3.
- A macro or VBA procedure runs during extraction in Spike 1.
- The licensing contact states that Access cannot run on a worker.
- A sample database holds data that the owner did not expect, such as personal or health information.
- Any spike cannot meet its pass condition, and you cannot find a cause within a day.

Raise anything that needs a change to a pass condition, the scope, or a decision in the decisions log with the owner. Do not change them yourself.

## Reporting

Each spike writes one report in `docs/spikes/`, named `spike-N-name.md`. Write it in the same style as the other documents. Each report contains:

1. The question.
2. The method, including any change from the spike plan and the reason.
3. The environment: versions, hardware, and files used.
4. The measures, in a table against each pass condition.
5. The result: pass, fail, or partial.
6. The failures, grouped by cause, with samples.
7. The recommendation and the effort estimate for the production build.
8. Questions that remain.

Post a short progress note at the end of each week. State what you finished, what blocks you, and whether you expect to meet the time box.

## Schedule and decisions

The spike plan holds the schedule. In outline:

- Weeks 1 to 3: Spikes 1, 2, and 3 run, with Spike 3 starting in week 1 and Spike 2 starting when Spike 1 has exported queries.
- Weeks 2 to 4: Spike 5 builds the renderer and editor, then runs the usability session in week 4.
- Weeks 3 to 4: Spike 4 runs the models and collects the owner's ratings.
- End of week 3: decision meeting on Spikes 1 to 3.
- End of week 4: decision meeting on Spikes 4 and 5.

Reports must be ready two working days before each meeting.

## Questions

Send questions to the owner, Clint Jenkinson. For platform questions, the owner puts you in touch with the platform team.
