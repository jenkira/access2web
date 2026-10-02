# Access2Web product requirements document

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.2 |

## Summary

Access2Web is a web-based system that reads Microsoft Access databases and generates each one as a web application. Published applications appear in the systems portal. Administrators control which users and groups can open each application, and what each person can do inside it.

The system removes the need to distribute `.accdb` and `.mdb` files, replaces file-share locking with a central multi-user database, and applies consistent security and audit controls.

## Problem statement

Teams build and maintain business applications in Microsoft Access. These applications create the following problems:

- Each application lives in a file that people copy, email, or store on a network share.
- Concurrent editing causes lock conflicts and file corruption.
- Access control is limited to file-share permissions, which cannot restrict individual forms, reports, or records.
- No central inventory exists, so the organisation cannot tell which applications are in use or who uses them.
- Applications cannot be used on mobile devices or outside the corporate network.
- Applications depend on desktop Access licences and runtime installations.

## Goals and non-goals

### Goals

The system must:

1. Import an Access database and produce a working web application without manual coding for common cases.
2. Publish each application as a tile in the systems portal.
3. Restrict each application to the users and groups an administrator selects.
4. Record who viewed or changed data and who changed permissions.
5. Report what it could not convert, so owners can decide on manual work.
6. Convert common Visual Basic for Applications (VBA) logic to server-side handlers, and route everything else to manual redesign with a clear explanation.
7. Let owners and designers change an application after migration, with drafts, version history, safe data changes, and rollback.

### Non-goals

The system does not:

- Guarantee that converted VBA behaves identically to the original. The application owner must review and approve each translated handler.
- Run uploaded VBA code on any server.
- Convert VBA that automates other desktop programs, calls Windows APIs, or uses the local file system. The system flags this code for manual redesign.
- Support Access Data Projects (`.adp`) or Access web apps (SharePoint-hosted).
- Replace the systems portal. It integrates with the portal.
- Provide offline use.
- Match the full design capability of Microsoft Access. Version 1 of the editor covers the changes owners make most often, as listed in the next section.

## Users and roles

Table 1 lists the roles the system supports and what each role does.

**Table 1. User roles**

| Role | Description | Main tasks |
|---|---|---|
| Platform administrator | Manages the whole system | Configure single sign-on (SSO), manage roles, view audit logs |
| Application owner | Owns one or more converted applications | Upload a database, review the conversion report, edit, publish, grant permissions |
| Application user | Uses a published application | Open the application from the portal, enter and view data |
| Auditor | Reviews activity | View audit logs and permission reports, read-only |

## Scope

### Import and analysis

The system must read these Access objects from an uploaded file:

- Tables, fields, data types, and default values.
- Relationships, primary keys, and indexes.
- Queries (select, action, parameter, and crosstab).
- Forms and subforms, including layout and control types.
- Reports, including grouping and sorting.
- Macros and VBA modules, including source code, procedure names, and the form, report, or control each procedure belongs to.

After analysis, the system produces a conversion report that classifies each object as converted, partly converted, or not converted, with a reason.

### Application generation

For each analysed database, the system must generate:

- A relational data store in a supported database engine, with migrated data.
- Create, read, update, and delete (CRUD) screens for each table.
- Web forms that reproduce Access forms, including subforms and combo boxes.
- Query views that users can run, filter, and export.
- Reports that users can view in the browser and export to PDF.
- Validation rules and required-field checks carried over from the source.
- Server-side handlers for VBA logic, as described in the next section.

### Changes after migration

Owners and designers must be able to change a migrated application without going back to Access. The system supports these changes:

- Forms: add, remove, and move controls, and change labels, visibility, defaults, and validation rules.
- Data: add a table or field, rename a table or field, and change a field's type or constraints.
- Queries and reports: change columns, filters, grouping, and sorting.
- Handlers: edit a translated handler or write a new one, under the same test and approval rules as translated handlers.

Requirements for changes:

- Edits happen in a draft copy. Users of the live application do not see a draft.
- Publishing a draft creates a new version. The system keeps every earlier version, and lets an authorised person compare two versions and roll back to an earlier one.
- The system classifies each data change as additive, compatible, or destructive. It applies additive changes automatically, applies compatible changes after a preview, and requires explicit confirmation, a preview of the affected rows, and a snapshot before it applies a destructive change.
- The permission to design an application is separate from the permission to publish it.
- Every change to an application's definition appears in the audit log with the difference.
- Once an owner publishes an edit, the web application is the system of record. Re-import from the original `.accdb` file is then not available for that application. This is decision D12 in the [decisions log](DECISIONS.md).

### VBA conversion

The system classifies every VBA procedure and macro, then handles each class differently. Table 2 lists the classes.

**Table 2. VBA classes and handling**

| Class | Examples | Handling |
|---|---|---|
| Standard pattern | Open form, requery, set a default, show or hide a control, run a saved query, show a message | Convert by fixed mapping to declarative rules. No AI translation. |
| Translatable logic | Calculations, conditional validation, record updates through DAO or ADO, loops over records | Translate to a server-side handler with an AI model. Generate tests. Require owner review. |
| Manual redesign | Automation of Excel or Outlook, Windows API calls, file system access, local printing, connections to other databases | Do not convert. Flag with the reason and a suggested alternative. |

The conversion process must:

1. Extract VBA source without running it.
2. Build an inventory that links each procedure to the object that calls it.
3. Classify each procedure and record the class in the conversion report.
4. Convert standard patterns and translate logic.
5. Run translated handlers in a sandbox with no network, file system, or database access beyond the application's own schema.
6. Generate tests from sample data, and show the results to the owner.
7. Block publication until the owner approves each translated handler or marks it as excluded.

Every translated handler must show the original VBA beside the generated code in the review screen.

### Portal integration

The system must:

- Register each published application with the systems portal, with a name, description, icon, and owner.
- Show a user only the applications that user has permission to open.
- Use the portal's SSO so users sign in once.
- Return a clear "no permission" page when a user opens a link to an application they cannot use.

### Access control

The system must enforce permissions on the server, not only in the interface. Table 3 lists the permission levels.

**Table 3. Permission levels**

| Level | Applies to | Allows |
|---|---|---|
| Open application | Application | See the tile and open the application |
| View data | Table, form, report | Read records |
| Edit data | Table, form | Create and change records |
| Delete data | Table, form | Remove records |
| Run reports | Report | Run and export a report |
| Design application | Application | Create drafts and edit forms, fields, queries, reports, and handlers, but not publish |
| Manage application | Application | Change settings, publish, and manage permissions |

Requirements for access control:

- Administrators can assign permissions to individual users, directory groups, or roles.
- Application owners can assign permissions only for their own applications.
- Permissions can be set at application level and overridden at table, form, and report level.
- Row-level rules can limit records by a field value, for example "own department only".
- The system denies access by default. A user has no permission until an administrator grants one.
- Changes to permissions take effect without requiring the user to sign in again.

### Audit and compliance

The system must record the following events, with the user, time, application, and object:

- Sign-in and sign-out.
- Record create, update, and delete, including old and new values.
- Report runs and data exports.
- Permission grants and revocations.
- Application upload, publish, and unpublish.
- Changes to an application's definition, with the difference between versions.

Auditors can search and export the log. Logs are append-only.

## Functional requirements

Table 4 lists the requirements, in priority order within each area. Priority P0 is required for release, P1 is required soon after, and P2 is optional.

**Table 4. Functional requirements**

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Upload an `.accdb` or `.mdb` file up to 2 GB | P0 |
| FR-2 | Analyse the file and produce a conversion report | P0 |
| FR-3 | Migrate tables and data to the central database | P0 |
| FR-4 | Generate CRUD screens for every table | P0 |
| FR-5 | Generate web forms from Access forms | P0 |
| FR-6 | Generate browser reports with PDF export | P1 |
| FR-7 | Publish an application to the systems portal | P0 |
| FR-8 | Enforce application-level permissions | P0 |
| FR-9 | Enforce object-level permissions | P1 |
| FR-10 | Enforce row-level rules | P1 |
| FR-11 | Record an audit log of data and permission events | P0 |
| FR-12 | Re-import an updated database and show a diff before applying | P2 |
| FR-13 | Extract VBA and macro source without running it, and build a procedure inventory | P0 |
| FR-14 | Bulk-assign permissions from a directory group | P1 |
| FR-15 | Classify each VBA procedure as standard pattern, translatable logic, or manual redesign | P0 |
| FR-16 | Convert standard VBA patterns to declarative rules by fixed mapping | P1 |
| FR-17 | Translate VBA logic to server-side handlers with an AI model | P1 |
| FR-18 | Run translated handlers in a sandbox | P1 |
| FR-19 | Generate tests for translated handlers and show the results to the owner | P1 |
| FR-20 | Show original VBA beside generated code, and block publication until the owner approves or excludes each handler | P1 |
| FR-21 | Flag manual-redesign procedures with the reason and a suggested alternative | P0 |
| FR-22 | Classify the data in each application at upload, and block publishing until the owner confirms the classification | P1 |
| FR-23 | Create a draft copy of a published application, with edits invisible to users until publication | P1 |
| FR-24 | Edit forms: controls, labels, visibility, defaults, and validation rules | P1 |
| FR-25 | Add, rename, and change tables and fields, and generate the data migration | P1 |
| FR-26 | Classify each data change as additive, compatible, or destructive, show a preview, and require confirmation and a snapshot for destructive changes | P1 |
| FR-27 | Keep version history, compare two versions, and roll back to an earlier version | P1 |
| FR-28 | Provide a separate Design application permission | P1 |
| FR-29 | Edit queries and reports | P2 |
| FR-30 | Edit handlers, with the same sandbox tests and approval as translated handlers | P2 |
| FR-31 | Record every definition change in the audit log, with the difference | P1 |
| FR-32 | Let an application require a second approver before a change is published, as a setting for each application | P2 |

## Non-functional requirements

- **Security:** Encrypt data in transit with TLS 1.2 or later and at rest. Scan uploaded files for malware. Never run VBA from an uploaded file. Run generated handlers in a sandbox with no network or file system access, and a limit on run time and memory.
- **Performance:** Open a form with up to 1,000 records in under 2 seconds at the 95th percentile.
- **Scale:** Support at least 200 published applications and 2,000 concurrent users.
- **Availability:** 99.5% monthly availability during business hours.
- **Compatibility:** Support current versions of Chrome, Edge, Firefox, and Safari. Meet WCAG 2.2 level AA.
- **Isolation:** Store each application's data in a separate schema so a fault or breach in one application does not affect another.
- **Backup:** Back up data daily and test restores every quarter.

## User flows

### Publish an application

To publish an application:

1. Sign in to Access2Web as an application owner.
2. Select **Upload database**, and choose the Access file.
3. Review the conversion report.
4. Resolve or accept each item marked partly converted or not converted.
5. Enter the application name, description, and icon.
6. Select the users and groups that can open the application.
7. Select **Publish**.

The application appears in the portal for the selected users.

### Open an application

To open an application:

1. Sign in to the systems portal.
2. Select the application tile.

If you do not see a tile, you do not have permission. Contact the application owner.

## Success metrics

Table 5 lists the measures that show whether the product meets its goals.

**Table 5. Success metrics**

| Metric | Target |
|---|---|
| Share of Access objects converted without manual work | 80% or more |
| Time from upload to published application, for a typical database | Under 1 day |
| Share of VBA procedures converted by fixed mapping or translation, measured in the pilot | To be set after the pilot |
| Share of translated handlers that pass owner review without edits | To be set after the pilot |
| Applications moved from file shares to the portal in the first year | 50 |
| Unauthorised access incidents | 0 |
| User satisfaction score for converted applications | 4 out of 5 or more |

## Assumptions and dependencies

- The systems portal exposes an API or integration point for registering applications and reading user identity.
- A directory service, such as Microsoft Entra ID or LDAP, provides users and groups.
- PostgreSQL is the target database engine (decision D3 in the [decisions log](DECISIONS.md)).
- Source Access files are not password-protected, or the owner supplies the password at upload.

## Risks

Table 6 lists the main risks and how to reduce them.

**Table 6. Risks and mitigations**

| Risk | Impact | Mitigation |
|---|---|---|
| Translated VBA behaves differently from the original | Wrong data or decisions in a published application | Generate tests, show original and generated code side by side, and require owner approval before publishing |
| Generated handler is unsafe or runs unbounded | Data leak or loss of service | Run handlers in a sandbox with no network or file system access, with limits on time and memory, and review the code |
| VBA that cannot convert is more common than expected | Low conversion rate and owner frustration | Run a pilot on real databases before setting targets, and report the manual share per database |
| Complex forms do not convert faithfully | Users reject the application | Show a preview before publishing, and allow layout edits |
| Uploaded files contain malware | System compromise | Scan files, parse them in a sandbox, and never run embedded code |
| Sensitive data is copied into a less controlled place | Privacy breach | Classify data at upload, and require explicit permission settings before publish |
| Owners publish with permissive settings | Unintended exposure | Deny by default, and show a permissions summary at publish |
| An edit breaks a live application | Users lose work or access | Edit in drafts, validate before publication, keep version history, and allow rollback |
| A destructive data change loses data | Permanent loss of records | Preview affected rows, require confirmation, and take a snapshot before applying |
| Several designers change one application | Conflicting or lost edits | Allow one active draft for each application |

## Open questions

The [decisions log](DECISIONS.md) records decisions and open items. The items that need an answer are:

- Which portal and sign-in standard does the organisation use?
- Where must data live, and does any source database hold personal or health information that needs a privacy review?
- Who maintains handlers after publication, and who owns an application when its author leaves?
- Which three to five real databases do the pilot and the spikes use?
- Is a GPU server available to host the translation model, and what is the budget?
- When the web version goes live, do users stop using the `.accdb` file, and how does the system prevent two diverging copies of the data?
- How does the system handle tables linked to SQL Server or other ODBC sources, and tables linked from a back-end file in a split database?
- Who writes row-level rules for each application, and how?
- How long does the system keep uploaded files, audit logs, and exports?

## Release plan

Table 7 lists the release phases and what each phase delivers.

**Table 7. Release phases**

| Phase | Content |
|---|---|
| Phase 1 | Upload, analysis, table and CRUD generation, application-level permissions, portal tile, audit log, VBA extraction, inventory, and classification |
| Phase 2 | Form and report generation, object-level and row-level permissions, VBA pilot on sample databases, fixed-mapping conversion of standard patterns, drafts, version history, rollback, and editing of forms, fields, and rules |
| Phase 3 | AI translation of VBA logic with sandbox, tests, and owner approval, based on pilot results. Editing of queries, reports, and handlers. |
| Phase 4 | Re-import with diff, bulk permission tools, usage analytics |
