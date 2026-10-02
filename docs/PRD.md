# Access2Web product requirements document

| Field | Value |
|---|---|
| Status | Draft for review |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |

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

### Non-goals

The first release does not:

- Convert VBA code automatically. The system flags it for manual review.
- Support Access Data Projects (`.adp`) or Access web apps (SharePoint-hosted).
- Replace the systems portal. It integrates with the portal.
- Provide offline use.

## Users and roles

Table 1 lists the roles the system supports and what each role does.

**Table 1. User roles**

| Role | Description | Main tasks |
|---|---|---|
| Platform administrator | Manages the whole system | Configure single sign-on (SSO), manage roles, view audit logs |
| Application owner | Owns one or more converted applications | Upload a database, review the conversion report, publish, grant permissions |
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
- Macros and VBA modules, for inventory only.

After analysis, the system produces a conversion report that classifies each object as converted, partly converted, or not converted, with a reason.

### Application generation

For each analysed database, the system must generate:

- A relational data store in a supported database engine, with migrated data.
- Create, read, update, and delete (CRUD) screens for each table.
- Web forms that reproduce Access forms, including subforms and combo boxes.
- Query views that users can run, filter, and export.
- Reports that users can view in the browser and export to PDF.
- Validation rules and required-field checks carried over from the source.

### Portal integration

The system must:

- Register each published application with the systems portal, with a name, description, icon, and owner.
- Show a user only the applications that user has permission to open.
- Use the portal's SSO so users sign in once.
- Return a clear "no permission" page when a user opens a link to an application they cannot use.

### Access control

The system must enforce permissions on the server, not only in the interface. Table 2 lists the permission levels.

**Table 2. Permission levels**

| Level | Applies to | Allows |
|---|---|---|
| Open application | Application | See the tile and open the application |
| View data | Table, form, report | Read records |
| Edit data | Table, form | Create and change records |
| Delete data | Table, form | Remove records |
| Run reports | Report | Run and export a report |
| Manage application | Application | Change settings, republish, and manage permissions |

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

Auditors can search and export the log. Logs are append-only.

## Functional requirements

Table 3 lists the requirements, in priority order within each area. Priority P0 is required for release, P1 is required soon after, and P2 is optional.

**Table 3. Functional requirements**

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
| FR-13 | Flag VBA and macros with a suggested manual approach | P1 |
| FR-14 | Bulk-assign permissions from a directory group | P1 |

## Non-functional requirements

- **Security:** Encrypt data in transit with TLS 1.2 or later and at rest. Scan uploaded files for malware. Never run VBA from an uploaded file.
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

Table 4 lists the measures that show whether the product meets its goals.

**Table 4. Success metrics**

| Metric | Target |
|---|---|
| Share of Access objects converted without manual work | 80% or more |
| Time from upload to published application, for a typical database | Under 1 day |
| Applications moved from file shares to the portal in the first year | 50 |
| Unauthorised access incidents | 0 |
| User satisfaction score for converted applications | 4 out of 5 or more |

## Assumptions and dependencies

- The systems portal exposes an API or integration point for registering applications and reading user identity.
- A directory service, such as Microsoft Entra ID or LDAP, provides users and groups.
- The organisation approves a target database engine, such as PostgreSQL.
- Source Access files are not password-protected, or the owner supplies the password at upload.

## Risks

Table 5 lists the main risks and how to reduce them.

**Table 5. Risks and mitigations**

| Risk | Impact | Mitigation |
|---|---|---|
| Business logic in VBA is lost | Converted application behaves differently | Flag all VBA, require owner sign-off, and offer a manual rebuild path |
| Complex forms do not convert faithfully | Users reject the application | Show a preview before publishing, and allow layout edits |
| Uploaded files contain malware | System compromise | Scan files, parse them in a sandbox, and never run embedded code |
| Sensitive data is copied into a less controlled place | Privacy breach | Classify data at upload, and require explicit permission settings before publish |
| Owners publish with permissive settings | Unintended exposure | Deny by default, and show a permissions summary at publish |

## Open questions

- Which portal and which SSO standard (SAML or OpenID Connect) does the organisation use?
- Which database engine does the platform team approve?
- Is a data classification policy needed before publication, and who enforces it?
- Who owns converted applications when the original author leaves?
- Does any source database hold personal or health information that needs a privacy review?

## Release plan

Table 6 lists the release phases and what each phase delivers.

**Table 6. Release phases**

| Phase | Content |
|---|---|
| Phase 1 | Upload, analysis, table and CRUD generation, application-level permissions, portal tile, audit log |
| Phase 2 | Form and report generation, object-level and row-level permissions, VBA flagging |
| Phase 3 | Re-import with diff, bulk permission tools, usage analytics |
