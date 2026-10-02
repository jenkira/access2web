import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { demoDefinition } from "../fixtures/demo.ts";
import { createServer, type Spike5Server } from "../src/server/server.ts";
import { can } from "../src/server/permissions.ts";
import type { Op } from "../src/model/ops.ts";

let srv: Spike5Server, base: string;
const GRANTS = {
  dana: ["design_application"], mia: ["manage_application"], ed: ["edit_data"], vic: ["view_data"], both: ["design_application", "edit_data"],
} as const;

before(async () => { srv = createServer({ base: demoDefinition(), grants: structuredClone(GRANTS) as never }); base = `http://127.0.0.1:${await srv.listen()}`; });
after(async () => { await srv.close(); });
beforeEach(() => { srv.state.versions.length = 1; srv.state.draft = null; srv.state.audit.length = 0; });

async function call(method: string, path: string, user?: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const label = (text: string): Op => ({ t: "setLabel", form: "CustomerForm", id: "c_name", label: text });

test("permission rules: deny by default, manage covers design, design does not cover manage", () => {
  const g = GRANTS as never;
  assert.equal(can(g, undefined, "design_application"), false);
  assert.equal(can(g, "nobody", "open_application"), false);
  assert.equal(can(g, "dana", "design_application"), true);
  assert.equal(can(g, "dana", "manage_application"), false);
  assert.equal(can(g, "mia", "design_application"), true);
  assert.equal(can(g, "ed", "view_data"), true);
  assert.equal(can(g, "ed", "design_application"), false);
});

test("a person with Design can lock and edit a draft but cannot publish it", async () => {
  assert.equal((await call("POST", "/api/draft/lock", "dana")).status, 200);
  assert.equal((await call("POST", "/api/draft/ops", "dana", { log: [label("Full name")] })).status, 200);
  const pub = await call("POST", "/api/draft/publish", "dana");
  assert.equal(pub.status, 403);
  assert.equal(srv.state.versions.length, 1, "nothing was published");
  assert.ok(srv.state.draft, "the draft is still there");
});

test("a person with Manage can edit and publish", async () => {
  await call("POST", "/api/draft/lock", "mia");
  await call("POST", "/api/draft/ops", "mia", { log: [label("Full name")] });
  const pub = await call("POST", "/api/draft/publish", "mia");
  assert.deepEqual(pub.body, { version: 2 });
  assert.equal(srv.state.versions.length, 2);
});

test("people without Design cannot touch a draft, and unknown users cannot do anything", async () => {
  for (const user of ["ed", "vic", "nobody", undefined]) {
    for (const [m, p] of [["POST", "/api/draft/lock"], ["POST", "/api/draft/ops"], ["POST", "/api/draft/publish"], ["POST", "/api/draft/unlock"]] as const) {
      assert.equal((await call(m, p, user, { log: [] })).status, 403, `${user} ${p}`);
    }
  }
  assert.equal((await call("GET", "/api/audit", "dana")).status, 403, "Design cannot read the audit log");
  assert.equal((await call("GET", "/api/audit", "mia")).status, 200);
});

test("only one draft is active, and only its holder can use it", async () => {
  assert.equal((await call("POST", "/api/draft/lock", "dana")).status, 200);
  const second = await call("POST", "/api/draft/lock", "mia");
  assert.equal(second.status, 409); assert.equal(second.body.error, "draft_locked"); assert.equal(second.body.lockedBy, "dana");
  assert.equal((await call("POST", "/api/draft/ops", "mia", { log: [] })).status, 409);
  assert.equal((await call("POST", "/api/draft/publish", "mia")).status, 409);
  assert.equal((await call("POST", "/api/draft/lock", "dana")).status, 200, "the holder can lock again");
  await call("POST", "/api/draft/unlock", "dana");
  assert.equal((await call("POST", "/api/draft/lock", "mia")).status, 200);
});

test("an open form from the earlier version gets the version-changed response", async () => {
  const v1 = (await call("GET", "/api/definition", "ed")).body.version;
  const rec = { name: "Ada", credit_limit: 10, active: true };
  assert.equal((await call("POST", "/api/records", "ed", { version: v1, form: "CustomerForm", record: rec })).status, 200);
  await call("POST", "/api/draft/lock", "mia");
  await call("POST", "/api/draft/ops", "mia", { log: [label("Customer name")] });
  assert.equal((await call("POST", "/api/draft/publish", "mia")).body.version, 2);
  const stale = await call("POST", "/api/records", "ed", { version: v1, form: "CustomerForm", record: rec });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, "version_changed"); assert.equal(stale.body.current, 2);
  assert.equal((await call("POST", "/api/records", "ed", { version: 2, form: "CustomerForm", record: rec })).status, 200, "the reloaded form works");
});

test("the runtime enforces validation rules and refuses unknown fields on the server", async () => {
  const ok = { version: 1, form: "ProductForm" };
  const bad = await call("POST", "/api/records", "ed", { ...ok, record: { name: "Widget", unit_price: -5 } });
  assert.equal(bad.status, 422); assert.deepEqual(bad.body.errors.map((e: any) => e.message), ["Price must not be negative"]);
  const missing = await call("POST", "/api/records", "ed", { ...ok, record: { unit_price: 1 } });
  assert.equal(missing.status, 422); assert.match(missing.body.errors[0].message, /required/);
  assert.equal((await call("POST", "/api/records", "ed", { ...ok, record: { name: "x", unit_price: 1, hacker: 1 } })).status, 422);
  assert.equal((await call("POST", "/api/records", "vic", { ...ok, record: { name: "x", unit_price: 1 } })).status, 403, "view-only cannot save");
  assert.equal((await call("POST", "/api/records", "ed", { ...ok, record: { name: "Widget", unit_price: 5 } })).status, 200);
});

test("a rule that hides a control also stops it being checked", async () => {
  const f = { version: 1, form: "CreditReviewForm" };
  // credit_limit is only checked when active is true
  assert.equal((await call("POST", "/api/records", "ed", { ...f, record: { name: "A", active: false, credit_limit: 999999 } })).status, 200);
  assert.equal((await call("POST", "/api/records", "ed", { ...f, record: { name: "A", active: true, credit_limit: 999999 } })).status, 422);
});

test("a draft with a stale base cannot be published over a newer version", async () => {
  await call("POST", "/api/draft/lock", "mia");
  await call("POST", "/api/draft/ops", "mia", { log: [label("A")] });
  srv.state.versions.push({ ...structuredClone(srv.state.versions[0]!), version: 2 });  // another publish happened meanwhile
  const r = await call("POST", "/api/draft/publish", "mia");
  assert.equal(r.status, 409); assert.equal(r.body.error, "draft_out_of_date");
});

test("a tampered log is refused, and the draft keeps its last good log", async () => {
  await call("POST", "/api/draft/lock", "dana");
  await call("POST", "/api/draft/ops", "dana", { log: [label("Good")] });
  const bad = await call("POST", "/api/draft/ops", "dana", { log: [label("Good"), { t: "removeControl", form: "CustomerForm", id: "ghost" }] });
  assert.equal(bad.status, 422); assert.equal(bad.body.error, "invalid_ops");
  assert.equal(srv.state.draft!.log.length, 1);
});

test("publishing is audited with the number of edits and the versions", async () => {
  await call("POST", "/api/draft/lock", "mia");
  await call("POST", "/api/draft/ops", "mia", { log: [label("X"), { t: "renameField", entity: "Customer", from: "city", to: "town" }] });
  await call("POST", "/api/draft/publish", "mia");
  const audit = (await call("GET", "/api/audit", "mia")).body;
  assert.deepEqual(audit.map((e: any) => e.action), ["draft_locked", "publish"]);
  assert.deepEqual(audit[1].detail, { ops: 2, from: 1, to: 2, changed: true });
});

test("a published version is a snapshot: later drafts do not change it", async () => {
  await call("POST", "/api/draft/lock", "mia");
  await call("POST", "/api/draft/ops", "mia", { log: [label("V2")] });
  await call("POST", "/api/draft/publish", "mia");
  const v2Label = (srv.state.versions[1]!.forms[0]!.rows[0]!.controls[0] as { label: string }).label;
  await call("POST", "/api/draft/lock", "mia");
  await call("POST", "/api/draft/ops", "mia", { log: [label("V3")] });
  assert.equal((srv.state.versions[1]!.forms[0]!.rows[0]!.controls[0] as { label: string }).label, v2Label);
  assert.equal(srv.state.versions[0]!.forms[0]!.rows[0]!.controls[0] && (srv.state.versions[0]!.forms[0]!.rows[0]!.controls[0] as { label: string }).label, "Name");
});
