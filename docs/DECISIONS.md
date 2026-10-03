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
| D12 | The web application becomes the system of record after the first published edit. Re-import stays available only for applications with no published edits. An owner who wants to re-import an edited application creates a separate application. | Accepted | Proposed in review, accepted 2 October 2026. |
| D13 | Do not require a second approver to publish a change in version 1, but make the rule configurable for each application | Accepted | Proposed in review, accepted 2 October 2026. Adds FR-32. |
| D14 | Deploy on Kubernetes, packaged as container images and a Helm chart, with no dependence on one cloud vendor | Accepted | Added on 2 October 2026. The Windows worker and the translation model can run in the cluster or outside it behind the same queue and storage interfaces. |
| D15 | Accept the proposals in the technical design's Kubernetes section: a PostgreSQL-backed job queue, PostgreSQL `LISTEN` and `NOTIFY` for permission cache invalidation, a Helm chart, secrets from the organisation's store, and the choice of Windows worker placement after Spike 1 | Accepted | Accepted on 2 October 2026. The platform facts arrived later and are in D16 and D17. |
| D16 | Target platform: RKE2 at the latest release, Calico for the network and network policy, Windows node pools available, and no GPU nodes | Accepted | Confirmed by the platform team on 2 October 2026. Windows nodes run Windows Server 2022. Record the exact RKE2 version when the spikes start. |
| D17 | PostgreSQL runs as its own container in the cluster. Object storage is S3-compatible. Passwordstate is the secrets repository. The container registry is an on-premises ProGet server. | Accepted | Confirmed by the platform team on 2 October 2026. The External Secrets Operator already syncs Passwordstate secrets into the cluster. |
| D18 | Host the translation model on high-memory CPU nodes in the cluster, using a mixture-of-experts model, and use an external GPU server only if Spike 4 shows it is needed | Accepted | Accepted on 2 October 2026. Follows from the lack of GPU nodes. |
| D19 | Storage for PostgreSQL volumes is NVMe SAN presented through the VMware Kubernetes connector. The cluster encrypts Kubernetes Secrets at rest. Windows nodes run Windows Server 2022 and can pull images from the internet. | Accepted | Confirmed by the platform team on 2 October 2026. |
| D20 | The platform team provisions a high-memory CPU node to specification for the translation model | Accepted | Confirmed by the platform team on 2 October 2026. Proposed starting specification: 16 or more cores and 64 GB of memory. Spike 4 confirms or revises it. |
| D21 | Microsoft licensing covers running Access on a Windows Server worker | Accepted | Confirmed by the owner on 2 October 2026. |
| D22 | Store Short Text, Long Text, and Hyperlink columns as `citext`, with the Access field size kept as a check | Accepted | Decided by the owner on 3 October 2026. Spike 2 found that this matches Access's case rules for comparison, grouping, sorting, and duplicates. Spike 1 still confirms Access's case rules on real data, and `Replace` needs a cast to `text`. |
| D23 | The technical design records two Spike 3 findings: each application has its own database login with no `SET ROLE` between applications, and the handler sandbox runs in a worker that the host can terminate | Accepted | Decided by the owner on 3 October 2026, and written into the technical design the same day. The Phase 1 runtime still uses one shared login. Changing it is a prerequisite for Phase 3. |
| D24 | A new version of a published application waits up to 5 seconds for requests in flight. If the application is still busy, the publish stops with 409 and changes nothing. | Accepted | Decided by the owner on 3 October 2026. Implemented in `publish.republish`. |
| D25 | The draft lock is a lease of 30 minutes from the last save, and each save extends it. A person with manage application can discard a draft at any time. | Accepted | Decided by the owner on 3 October 2026. Implemented in `drafts.py`. |
| D26 | Saving through a form needs edit data on the form and on the table that the form saves to | Accepted | Decided by the owner on 3 October 2026. A form-only grant no longer lets a person save, and a table can be made read-only for someone who has edit data on the application. Implemented in `runtime.save_form`. |
| D27 | The product ships as two images: a Python backend, and a generic nginx frontend that serves the built web files and proxies `/api/`. The Helm chart installs one PostgreSQL 16 instance, with its credentials in `values.yaml`. | Accepted | Decided by the owner on 3 October 2026. This is interim: the password is a development value, and the instance has no replica and no backup. Production uses the operator chosen under O8 (D17), and a secret. The single image and the old chart were deleted, because nothing was deployed. |

## Open items

Table 2 lists the items that still need an answer, who can answer them, and when.

**Table 2. Open items**

| ID | Item | Who answers | Needed before |
|---|---|---|---|
| O1 | Which portal does the organisation use, and what registration and identity options does it offer? | Platform team | Design is final |
| O2 | Which three to five databases do the spikes use? Include a heavy-VBA file, a complex-query file, a split database, and both file formats. | Application owner | Spikes start |
| O4 | Where must data live, and does any application hold personal or health information that needs a privacy review? | Privacy officer | Design is final |
| O6 | Who maintains handlers after publication, and who owns an application when its author leaves? | Application owner | Build starts |
| O7 | How does a re-import (FR-12) merge changes with an owner's edits to the definition? Decision D12 removes the need to merge for edited applications, so this item applies only to unedited ones. | Design team | FR-12 is built (P2) |
| O8 | Which PostgreSQL operator or backup method does the platform team prefer? Storage is decided in D19. | Platform team | Design is final |

## Gaps found in review

Neither the PRD nor the technical design covered these items. Each needs a decision.

- **Cutover:** whether users stop using the `.accdb` file when the web version goes live, and how the system prevents two diverging copies of the data.
- **Linked tables:** how the system handles tables linked to SQL Server or other ODBC sources, and tables linked from a back-end `.accdb` file in a split database.
- **Row-level rules:** who writes the rules for each application, and how, because Access has no row-level security to convert.
- **Retention:** how long the system keeps uploaded files, audit logs, and exports.
- **Funding:** the cost of Access licences and of hosting a local model.
