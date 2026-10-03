# Spike 1: does the Microsoft 365 Access Runtime allow the extraction we need?

The technical design has a Windows worker that exports forms, reports, macros, VBA, and queries by driving Access through COM.
The free Access Runtime would avoid an Access licence for that worker, but the Runtime removes design features, so it might not
allow `SaveAsText` and `LoadFromText`. This spike finds out.

The workflow `.github/workflows/spike1-access-runtime.yml` installs the Microsoft 365 Access Runtime on a Windows Server 2022
runner, builds a small sample database with ACE, and runs `probe.ps1`. Each probe reports ok or FAIL with the error message, and
the results appear in the job summary and in the `spike1-results` artifact.

| Probe | Question it answers |
|---|---|
| start `Access.Application` | Does COM automation work with the Runtime on an unattended runner? |
| runtime mode (`SysCmd 6`) | Is Access really running in runtime mode? |
| disable macros (`AutomationSecurity = 3`) | Can we stop `AutoExec` macros before opening an untrusted file? |
| open database, DAO enumeration | Can we read tables, fields, indexes, relationships, and queries? |
| `TransferText` | Can we export table data? |
| `LoadFromText` and `SaveAsText` for a form and a module | Are the design operations available in the Runtime? |

What it does not test yet: reports, macros, a password-protected file, a linked table, a `.mdb` file, an `AutoExec` macro that must
not run, and a real database. Add those when a real sample is available.

The workflow is informational. It does not fail when a probe fails, because a FAIL is a finding, not a defect.
