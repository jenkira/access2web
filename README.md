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
| Form rules (a preview of Phase 2) | Partial | Forms are accepted when an application is published, and checked. Every save through a form applies its validation rules on the server. Editing a form after publish is not built. |

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
| `Dockerfile` | Image that serves the API and the built front end |

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

## Configuration

Table 2 lists the environment variables.

**Table 2. Environment variables**

| Variable | Purpose |
|---|---|
| `A2W_DATABASE_URL` | Connection string for PostgreSQL. The user needs `CREATEROLE` and `CREATE` on the database. |
| `A2W_DEV_AUTH` | Set to `1` to trust identity headers. Development only. |
| `A2W_WEB_DIR` | Directory of the built front end. When set, the API serves it. |

## How it works

- **Application definition.** The analyser turns extracted metadata into a JSON definition. The runtime reads the definition, so no code is generated for each application.
- **Isolation.** Each application has its own PostgreSQL schema and its own role. The runtime runs every request as that role, so one application cannot read another's data.
- **Permissions.** A grant gives a user, group, or role a level on an application or on one table. If a person has any grant on a table, only those grants apply to that table. Otherwise the application grants apply. With no grant, access is denied. The server reads grants on every request, so a change applies at once.
- **Audit.** Database triggers write a row, with the old and new values, in the same transaction as each data change. The log is append-only, and each event stores the hash of the previous event. `GET /api/audit/verify` reports the first broken link.

## Known limits

- The API stores the extracted metadata, including rows, in the control database. Large databases need object storage, which is not built yet.
- The container image and the Helm chart were written but not built or linted, because the build environment had no Docker daemon and no Helm.
- A table without a single-column primary key can be listed and created in, but not edited or deleted from.
- Form rules apply to saves through a form. The table routes do not apply them, so a person with edit data on a table can write a record that a form would refuse. The owner has to decide whether to accept this.
- Audit tables are not partitioned by month yet.
- Permission results are not cached. This keeps changes immediate, and a cache with invalidation is a later optimisation.

## Documents

- [Product requirements document](docs/PRD.md)
- [Technical design document](docs/TDD.md)
- [Decisions log](docs/DECISIONS.md)
- [Spike plan](docs/SPIKE-PLAN.md) and [spike brief](docs/SPIKE-BRIEF.md)
