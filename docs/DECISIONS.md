# Access2Web decisions log

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |
| Related | [PRD](PRD.md), [Technical design document](TDD.md), [Spike plan](SPIKE-PLAN.md) |

## Summary

This log records decisions made on the open questions in the PRD and the technical design. Where the PRD or technical design disagrees with this log, this log is correct, and the other document needs an update.

## Decisions

Table 1 lists each decision, its status, and its source.

**Table 1. Decisions**

| ID | Decision | Status | Note |
|---|---|---|---|
| D1 | Run Microsoft Access on a Windows Server worker, driven by PowerShell, to extract forms, reports, macros, and VBA | Accepted | The owner accepted the risk. The owner has run this kind of automation on server operating systems. Spike 1 still measures stability. |
| D2 | Accept that Microsoft does not support unattended Automation of Office | Accepted | The owner accepted the risk on 2 October 2026. The design assumes Access can hang, and limits each job. |
| D3 | Use PostgreSQL as the application database | Accepted | Adopted from the technical design proposal. |
| D4 | Write handlers in TypeScript, run in a WebAssembly sandbox | Accepted | Adopted from the technical design proposal. Spike 3 tests the sandbox. |
| D5 | Use the spike pass thresholds as written in the spike plan | Accepted | Adopted from the spike plan proposals. The owner can revise them before the spikes start. |
| D6 | Classify the data in each application at upload, and block publishing until the owner confirms the classification | Accepted | Adds requirement FR-22 to the PRD. |
| D7 | Do not support explicit deny grants in version 1 | Accepted | Revisit if a real case needs them. Adding them later changes the permission rules. |
| D8 | Do not send VBA source or data to a hosted AI service during the spikes | Accepted | Applies to all spikes. |
| D9 | Plan for AI translation on a private, locally hosted model, and test one in Spike 4 | Accepted | A hosted service stays an option only if the data policy owner approves it later. |
| D10 | Use OpenID Connect for sign-in unless the portal requires another standard | Provisional | Depends on the portal. See item O1. |
| D11 | Include editing of migrated applications: drafts, version history, rollback, and safe data changes | Accepted | Added on 2 October 2026. Adds FR-23 to FR-31 to the PRD. |

## Open items

Table 2 lists the items that still need an answer, who can answer them, and when.

**Table 2. Open items**

| ID | Item | Who answers | Needed before |
|---|---|---|---|
| O1 | Which portal does the organisation use, and what registration and identity options does it offer? | Platform team | Design is final |
| O2 | Which three to five databases do the spikes use? Include a heavy-VBA file, a complex-query file, a split database, and both file formats. | Application owner | Spikes start |
| O3 | Does the organisation's Microsoft licensing cover Access on a Windows Server worker? The owner accepted the support risk, but the licence terms are a separate matter. | Licensing contact | Spikes start |
| O4 | Where must data live, and does any application hold personal or health information that needs a privacy review? | Privacy officer | Design is final |
| O5 | Is a GPU server available for Spike 4, and what is the budget for production hosting? | Platform team | Spike 4 starts |
| O6 | Who maintains handlers after publication, and who owns an application when its author leaves? | Application owner | Build starts |
| O7 | How does a re-import (FR-12) merge changes with an owner's edits to the definition? The proposal in O8 would remove the need to merge. | Design team | FR-12 is built (P2) |
| O8 | Does the web application become the system of record after the first published edit? Proposal: yes. Re-import then stays available only for unedited applications, and an owner who wants to re-import an edited application creates a separate application. | Application owner | Phase 2 design |
| O9 | Does a change to a published application need a second person to approve it? Proposal: not in version 1, but make the rule configurable for each application. | Application owner, security owner | Phase 2 design |

## Gaps found in review

Neither the PRD nor the technical design covered these items. Each needs a decision.

- **Cutover:** whether users stop using the `.accdb` file when the web version goes live, and how the system prevents two diverging copies of the data.
- **Linked tables:** how the system handles tables linked to SQL Server or other ODBC sources, and tables linked from a back-end `.accdb` file in a split database.
- **Row-level rules:** who writes the rules for each application, and how, because Access has no row-level security to convert.
- **Retention:** how long the system keeps uploaded files, audit logs, and exports.
- **Funding:** the cost of Access licences and of hosting a local model.
