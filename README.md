# Access2Web

Access2Web reads Microsoft Access databases and generates each one as a web application that appears in the systems portal. Administrators control who can open each application and what each person can do in it.

This repository holds the design documents in `docs/` and the Phase 1 foundation of the system.

## Phase 1 status

Phase 1 covers upload, analysis, table and CRUD generation, application-level permissions, the portal tile, the audit log, and VBA inventory and classification. Table 1 shows how far each Phase 1 requirement from the [PRD](docs/PRD.md) is built.

**Table 1. Phase 1 requirements**

| Requirement | State | Notes |
|---|---|---|
| FR-1 Upload a file | Partial | The API accepts extracted metadata as JSON. Reading `.accdb` and `.mdb` files needs the extractors from Spike 1. |
| FR-2 Conversion report | Done | Classifies every table, field, relationship, index, query, form, report, macro, and procedure, with a reason. |
| FR-3 Migrate tables and data | Done | One schema for each application. Reconciles row counts. Reports orphan rows instead of dropping them. |
| FR-4 CRUD screens | Done | A generic web interface and an API for every table. |
| FR-7 Publish to the portal | Partial | The `PortalAdapter` interface and a development adapter exist. The real portal is open item O1. |
| FR-8 Application-level permissions | Done | Deny by default. Enforced on the server for every request. |
| FR-11 Audit log | Partial | Records changes to data, grants, revocations, uploads, publishing, and unpublishing. Sign-in and sign-out events wait for the sign-in standard (D10). |
| FR-13 VBA inventory | Partial | Builds the inventory from exported source text. Exporting the source needs Spike 1. |
| FR-15 VBA classification | Done | Rules only. A model for undecided cases is Phase 3. |
| FR-21 Manual-redesign flags | Done | Each flag carries the reason and a suggested alternative. |
| FR-22 Data classification | Done | Suggests a class from field names. Publishing needs the owner's confirmation. |
| Form rules (a preview of Phase 2) | Partial | Forms are accepted when an application is published, and checked. Every save through a form applies its validation rules on the server, and a table that has a form can be written only through the form. Editing a form after publish is not built. |
| Publish a new version (a preview of Phase 2) | Partial | Renames a field or an entity and replaces the forms, carrying the rename to the data in one transaction. Adding and removing fields, entities, and relationships is not built. |

Not built yet: queries (Spike 2), forms and reports (Phase 2), object-level and row-level permissions (FR-9, FR-10), binary and multi-value fields, and everything in Phases 2 to 4. The conversion report lists each gap for every database.

## Layout

| Path | Contents |
|---|---|
| `backend/a2w/` | Python backend: analyser, VBA classifier, DDL generator, publish, authorisation, runtime, audit, API, and the expression evaluator for form rules |
| `backend/tests/` | Unit tests and integration tests that run against PostgreSQL |
| `web/` | TypeScript front end, with no runtime dependencies |
| `spec/expression/` | Conformance cases that the Python and TypeScript expression evaluators must both pass. The language is described in [docs/EXPRESSIONS.md](docs/EXPRESSIONS.md). |
| `spikes/` | Prototype code for the spikes. Not product code. Reports are in `docs/spikes/`. |
| `deploy/helm/access2web/` | Helm chart |
| `backend/Dockerfile` | Backend image: the API on port 8000 |
| `web/Dockerfile` | Frontend image: nginx serves the built web files on port 8080 and proxies `/api/` to the backend |

## Run the tests

You need Python 3.11 or later and a PostgreSQL 16 server on which you can create databases and roles.

1. Install the backend:

   ```sh
   pip install -e "backend[test]"
   ```

2. Set the administrator connection that the tests use:

   ```sh
   export A2W_TEST_ADMIN_URL=postgresql://postgres:test@127.0.0.1:54329/postgres
   ```

3. Run the tests:

   ```sh
   cd backend && python -m pytest
   ```

Each test session creates a fresh database and drops it afterwards.

## Run the application for development

To run the API with the front end:

1. From the repository root, build the front end:

   ```sh
   (cd web && npm install && npm run build)
   ```

2. Start the API:

   ```sh
   export A2W_DATABASE_URL=postgresql://postgres:test@127.0.0.1:54329/postgres
   export A2W_DEV_AUTH=1 A2W_WEB_DIR=$PWD/web/dist
   cd backend
   python -c "from a2w import db; db.bootstrap()"
   python -m uvicorn a2w.api:app --port 8000
   ```

`A2W_DEV_AUTH=1` reads the user from the `x-a2w-user`, `x-a2w-groups`, and `x-a2w-roles` request headers. Use it only on a development machine. Without it, every request returns 401 until a real portal adapter is configured.

## Publish a new version

A person with manage application can publish a new version of a published application with `POST /api/apps/{slug}/versions`. The body has three parts:

- `base_version`: the version that the editor started from. If the application has moved on, the answer is 409 `version_changed`.
- `renames`: a list of `{"kind": "field", "entity": "customers", "from": "email", "to": "mail"}` or `{"kind": "entity", "from": "customers", "to": "clients"}`. Each rename is checked against the result of the one before it.
- `forms`: the forms the new version should have. Leave it out to keep the current forms.

The server builds the SQL from the rename. It never accepts SQL from the browser, and every name must be a lower-case identifier. A rename keeps the data, because PostgreSQL renames the column or table in place. In one transaction the server renames the column or table, updates the keys, indexes, and relationships in the stored definition, moves table grants to the new name, checks the forms against the renamed entities, and records the new version and an audit event. If any step fails, nothing changes.

The forms you send must already use the new names. A rename that leaves a form pointing at the old name is refused with the reason, so a rename is never half applied.

Table 2 lists the answers the route gives.

**Table 2. Answers from the versions route**

| Status | Meaning |
|---|---|
| 200 | The new version is live. The body gives the version and the SQL that ran. |
| 400 | A rename or form is invalid, nothing changed, or the version would change nothing. |
| 403 | The person does not have manage application, or the application does not exist. |
| 409 `version_changed` | The base version is out of date. Reload and try again. |
| 409 `draft_locked` | Someone else holds an active draft. Nothing changed. |
| 409 | The application was in use and did not become free within 5 seconds. Nothing changed. Try again. |

Every request now takes a share lock on the application's row for the length of its transaction. A new version takes the row for update, so it waits for requests in flight, and a request that starts during the change waits and reads the new version. This stops a request from running with a definition that does not match the tables.

## Edit forms in the browser

The Spike 5 form editor can edit and publish a form of a published application, and run it. The backend serves the editor when `A2W_EDITOR_DIR` names the editor's folder.

To try it:

1. Build the editor:

   ```sh
   (cd spikes/spike5-form-editor && npm install && npm run build)
   ```

2. Start the API with the editor folder set:

   ```sh
   export A2W_EDITOR_DIR=$PWD/spikes/spike5-form-editor
   ```

   Then start the API as in "Run the application for development".

3. Open the editor at `/editor/public/index.html?app=<slug>&mode=edit&form=<form>&user=<user>`. Use `mode=run` to fill in the form. With `A2W_DEV_AUTH=1`, the page signs in as `user`, and as `groups` and `roles` if you pass them.

Table 3 shows what the page asks of the backend.

**Table 3. Routes the editor uses**

| Page | Route | Needs |
|---|---|---|
| Edit | `GET /api/apps/{slug}/definition` | Design application |
| Edit, on opening | `POST /api/apps/{slug}/draft/lock` | Design application |
| Edit, autosave and Save draft | `PUT /api/apps/{slug}/draft` | Design application, and the lock |
| Edit, Discard draft | `DELETE /api/apps/{slug}/draft` | The lock, or manage application |
| Edit, Publish | `POST /api/apps/{slug}/versions` | Manage application |
| Run | `GET /api/apps/{slug}/forms/{form}` | View data on the form |
| Run, Save | `POST /api/apps/{slug}/forms/{form}/records` | Edit data on the form |
| Run, combo boxes and subforms | `GET /api/apps/{slug}/tables/{table}/records` | View data on the table |

### Renaming in the editor

The editor has a panel for a field rename and a panel for an entity rename. Each shows a preview before it applies: what changes in the forms, the data migration, and the handlers to review. In the backend an entity has the name of its table, so the entity panel asks for no table name, and it checks the new name as a table name: lower-case letters, digits, and underscores, at most 63 characters. A rename is an edit in the draft, so it can be undone, and it takes effect when the draft is published.

### The saved draft and its lock

An editor opens a draft of the next version, and the backend holds it. Only one person holds the draft of an application at a time. Table 4 describes how it behaves.

**Table 4. The saved draft**

| Situation | What happens |
|---|---|
| A designer opens the editor | The page takes the lock. If the person already holds a draft, the page replays it, so they carry on where they stopped. |
| The designer edits | The page saves the draft about 1.5 seconds after the last edit. Undo and redo are saved too. |
| The page stays open | It saves every 5 minutes, even with no edit, to keep the lock. |
| Another designer opens the editor | They see who holds the draft and until when. They cannot edit. |
| A person with manage application clicks "Take over the draft" | The draft is discarded, and the page opens a new one for them. |
| The lock is not renewed for 30 minutes | The lock lapses. Another designer can take the draft, and the earlier holder's edits are dropped. |
| The holder's lock was taken | The holder's next save is refused, and the page says who has the draft. The edits stay on screen but are not saved. |
| The holder publishes | The new version is live, the draft is deleted, and the page opens the next draft from the new version. |
| Someone else tries to publish a version | Refused with 409 `draft_locked` while another person holds an active draft. A lapsed draft does not stop it, and the new version deletes it. |
| Discard draft | After a confirmation, the draft is deleted and a new one opens from the live version. |

The backend stores the edit log as the editor wrote it. It checks the shape and the size (at most 5,000 edits and 1 MB), but it cannot replay the log, because the operations are defined in the editor. The editor replays the log when it opens, and offers to discard a draft that does not replay. Publishing checks the result in full, so a bad log cannot produce a bad version.

Locking, taking over, and discarding are recorded in the audit log. Saves are not.

The backend decides every permission. The page shows what it is told, so a person who may not publish sees the refusal as a message. After a publish, the page starts again from the new version. A draft that started from an older version is refused, with the version it needs to reload.

Without `app=` in the address, the page uses the prototype's own server, as in the Spike 5 report.

## Continuous integration

GitHub Actions runs the checks in Table 5 on every pull request. The workflows are in `.github/workflows/`, and follow the pattern of the `jenkira/eidon` repository.

**Table 5. Workflows**

| Workflow | What it checks | When it runs |
|---|---|---|
| Backend Tests | The backend's pytest suite against PostgreSQL 16, including the differential test of the Python and TypeScript evaluators. CI makes a missing Node a failure and not a skip. | Pull request |
| Frontend Tests | Type-check and build of `web/`. The form editor's tests, in Chrome, against the prototype server and against the real backend with PostgreSQL. | Pull request |
| Spike Tests | The Spike 2 transpiler tests and the Spike 3 sandbox tests. | Pull request |
| Build and Push to GHCR | Builds the backend and frontend images, starts them with PostgreSQL as the Helm chart runs them (non-root, read-only file system, no capabilities), publishes an application through the frontend, and scans both images with Trivy. It fails on a fixable critical finding. It pushes `access2web-backend` and `access2web-frontend` to GHCR on pushes to `main` and on `v*` tags. | Pull request, push to `main`, tag |
| Verify Helm Chart | Lints the chart, renders it five ways, checks that development sign-in is off by default, validates the manifests with kubeconform, checks that `VERSION`, the chart, the two image tags, and `pyproject.toml` agree, and packages the chart. | Pull request and push, for chart changes |
| Security Scan | `pip-audit` and `npm audit` (fail on a high finding), Trivy for the files and configuration, and gitleaks for secrets. | Pull request, and Mondays |
| Semgrep | Security rules for Python, FastAPI, JavaScript, and TypeScript, at a pinned rules commit. It reports and does not fail yet. | Pull request, and Mondays |
| SBOM | CycloneDX bills of materials for the backend, the web front end, and the editor, attached to a release on a tag. | Pull request and tag |
| Tag release on VERSION change | Pushes `v<VERSION>` when `VERSION` changes on `main`. | Push to `main` |

Every job has a timeout (5 to 30 minutes), so a step that hangs fails the run and does not hold the checks open.

Dependabot opens weekly update pull requests for the Python and npm dependencies, the Dockerfiles, and the workflows.

`VERSION` holds the one version number. Change it, `backend/pyproject.toml`, `Chart.yaml`, and both image tags in `values.yaml` together, and the Helm workflow fails if they differ.

To require these checks before a merge, add their names to the branch protection rule for `main`. The workflows that run only for some paths (Verify Helm Chart) are not suitable as required checks. Uploads to code scanning are best effort, because a private repository needs GitHub Code Security for them.

## Configuration

Table 6 lists the environment variables.

**Table 6. Environment variables**

| Variable | Purpose |
|---|---|
| `A2W_DATABASE_URL` | Connection string for PostgreSQL. The user needs `CREATEROLE` and `CREATE` on the database. |
| `A2W_DEV_AUTH` | Set to `1` to trust identity headers. Development only. |
| `A2W_WEB_DIR` | Directory of the built front end. When set, the API serves it. |
| `A2W_EDITOR_DIR` | The form editor's folder, `spikes/spike5-form-editor`, with `npm run build` done. When set, the API serves the editor under `/editor/`. |

## How it works

- **Application definition.** The analyser turns extracted metadata into a JSON definition. The runtime reads the definition, so no code is generated for each application.
- **Isolation.** Each application has its own PostgreSQL schema and its own role. The runtime runs every request as that role, so one application cannot read another's data.
- **Permissions.** A grant gives a user, group, or role a level on an application or on one table. If a person has any grant on a table, only those grants apply to that table. Otherwise the application grants apply. With no grant, access is denied. The server reads grants on every request, so a change applies at once.
- **Text.** Text columns are `citext`, so comparing, grouping, sorting, and removing duplicates ignore case, as they do in Access. The size from Access is kept as a check, so a value that is too long is refused with a 400. The `citext` extension is created when the control database is set up, and the PostgreSQL operator must allow it.
- **Audit.** Database triggers write a row, with the old and new values, in the same transaction as each data change. The log is append-only, and each event stores the hash of the previous event. `GET /api/audit/verify` reports the first broken link.

## Known limits

- The API stores the extracted metadata, including rows, in the control database. Large databases need object storage, which is not built yet.
- The Dockerfiles were written without a Docker daemon, so the first build and the container run happen in CI. The Helm chart was linted and validated with kubeconform, but not installed in a cluster.
- The chart installs one PostgreSQL instance with the password in `values.yaml` (`access2web-dev-password`). The instance has no replica and no backup. Set `postgresql.auth.password`, or turn the bundled database off with `postgresql.enabled=false` and use `externalDatabase`. This is interim (D27).
- The runtime uses one shared database login for all applications. Per-application logins are planned for Phase 3 (D23).
- A table without a single-column primary key can be listed and created in, but not edited or deleted from.
- A table that has a form can be created in and updated only through the form, so edit data on the table alone no longer lets a person write. A save through the form needs edit data on the form and on the table. Deleting is not affected. Editing a form after publish is not built.
- A new version carries renames and form changes only. Adding or removing a field, an entity, or a relationship needs a design that handles existing data, and is not built.
- Closing the editor does not release the lock. It lapses after 30 minutes, or a person with manage application can take the draft over. Opening the editor again as the same person resumes the draft at once.
- The backend cannot replay a draft's edit log, so a corrupt log is found when the editor opens it, not when it is saved.
- A draft belongs to the application, not to a form. Two designers cannot edit different forms at the same time.
- The editor is a prototype from Spike 5. Its page does not use the portal's styling or sign-in.
- After an entity rename, earlier audit events keep the old table name, because the log is append-only. New events use the new name.
- A new version briefly blocks new requests to the application while it renames. A busy application can make the publish wait, and then fail with 409.
- The runtime connects with one shared database login and runs `SET LOCAL ROLE` for each request. That is safe while no SQL written by a user or a handler runs, which is true now. The technical design requires one login for each application before handler SQL runs (Phase 3), and this is not built.
- Audit tables are not partitioned by month yet.
- Permission results are not cached. This keeps changes immediate, and a cache with invalidation is a later optimisation.

## Documents

- [Product requirements document](docs/PRD.md)
- [Technical design document](docs/TDD.md)
- [Decisions log](docs/DECISIONS.md)
- [Spike plan](docs/SPIKE-PLAN.md) and [spike brief](docs/SPIKE-BRIEF.md)
