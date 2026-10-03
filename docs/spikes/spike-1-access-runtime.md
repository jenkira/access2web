# Spike 1 report: the Microsoft 365 Access Runtime for the Windows worker

Status: partial. Four runs on a GitHub-hosted Windows Server 2022 runner (`windows-2022`). Not yet run on a real database, in a
Windows container, or with full Access.

## Question

The technical design has a Windows worker that exports forms, reports, macros, and VBA source by driving Access through COM. Can the
free Microsoft 365 Access Runtime do that, so that the worker needs no Access licence?

## Findings

| Question | Result |
|---|---|
| Does the Runtime install unattended? | Yes. The Office Deployment Tool with product `AccessRuntimeRetail` installs version 16.0.20430.20140 in about 1 minute 50 seconds. |
| Does the ACE database engine come with it? | Yes. `Microsoft.ACE.OLEDB.16.0` and `DAO.DBEngine.120` (engine 16.0) work. |
| Does `MSACCESS.EXE` run? | Yes, when it is given a database. It starts and responds in an interactive session. |
| Can a script start Access through COM? | **No.** `New-Object -ComObject Access.Application` fails with `0x80080005` (`CO_E_SERVER_EXEC_FAILURE`), with and without the first-run registry values. |
| Can a script attach to a running instance? | **No.** `GetActiveObject` found nothing in 60 seconds with Access running and the database open. `GetObject` on the file fails with "Cannot create ActiveX component". |
| `SaveAsText`, `LoadFromText`, `TransferText` | **Not tested.** They need the Access application object, which the Runtime did not provide. |
| Tables, fields, types, keys, indexes, relationships, query SQL, typed rows through DAO and ACE | **Yes, without the Access application.** DAO gives type codes (for example 4 long, 10 text, 8 date, 1 yes/no, 5 currency), the autonumber flag, required, size, primary and unique flags, and relationship attributes. Rows come back typed (`Int32`, `String`, `DateTime`, `Boolean`, `Decimal`). |
| Names of forms, reports, macros, modules through DAO | **No.** `MSysObjects` is not readable ("no read permission"), and the `Forms`, `Reports`, `Scripts`, and `Modules` containers do not exist. The sample database had no such objects, so the containers result is not conclusive. |

## What it means

- Tables, queries, and data do not need the Windows tier. DAO on Windows can read them, and Jackcess or mdbtools can read them on Linux
  with no Access at all. That keeps the Windows tier to forms, reports, macros, and VBA source.
- Those four need `SaveAsText`, which needs the Access application object. With the Runtime alone, a script could not get one.
  Treat a full Access licence on the Windows worker as the likely cost, until one of the options below works.

## Options still open

1. **Full Access on the Windows worker.** Likely to work (this is what Kraken and similar tools use). Needs a licence and a support-policy
   decision, because Microsoft does not support unattended server-side Office automation.
2. **A launcher database run by the Runtime.** A small `.accdb` built in full Access, with startup VBA that calls `SaveAsText` from
   inside. The Runtime runs VBA, but it might refuse `SaveAsText`. Needs someone with full Access to build the launcher once.
3. **Do not extract those four.** Take only the inventory of names (Jackcess reads `MSysObjects` directly), and rebuild forms in the form
   editor. VBA would then need another route.

## Not covered

Reports, macros, a password-protected file, a linked table, a `.mdb` file, an `AutoExec` macro that must not run, a real database,
and a Windows container. The hosted runner is a full Windows Server 2022 desktop, not `servercore`.
