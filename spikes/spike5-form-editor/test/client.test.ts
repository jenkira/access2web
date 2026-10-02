// The backend client, with fetch stubbed: how each answer from the backend reaches the user.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { BackendClient, DraftLockedError, DraftLostError, DraftOutOfDateError } from "../src/backend/client.ts";
import type { Definition } from "../src/model/types.ts";
import type { Op } from "../src/model/ops.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Call { url: string; method: string; headers: Record<string, string>; body: any }
function stub(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}
const draft = (): Definition => ({ app: "shop", version: 1, entities: [], forms: [{ name: "F", title: "F", entity: "customers", rows: [] }], queries: [], handlers: [] });

test("a save goes to the form route with the version the page opened, and a development identity", async () => {
  const c = new BackendClient("shop", { user: "ed", groups: "g", roles: "r" });
  stub(200, { version: 4, form: { name: "F", title: "F", entity: "customers", rows: [] }, entity: { name: "customers", fields: [] } });
  await c.loadForm("F");
  const calls = stub(201, {});
  assert.deepEqual(await c.saveRecord("F", { a: 1 }), { saved: true, version: 4 });
  assert.equal(calls[0]!.url, "/api/apps/shop/forms/F/records"); assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, { version: 4, values: { a: 1 } });
  assert.deepEqual([calls[0]!.headers["x-a2w-user"], calls[0]!.headers["x-a2w-groups"], calls[0]!.headers["x-a2w-roles"]], ["ed", "g", "r"]);
});

test("without an identity no sign-in headers are sent, so the portal's own sign-in is used", async () => {
  const calls = stub(200, { version: 1, entities: [], forms: [] });
  await new BackendClient("shop").loadDefinition();
  assert.equal(Object.keys(calls[0]!.headers).some((k) => k.startsWith("x-a2w")), false);
});

test("each answer to a save becomes a message the user can act on", async () => {
  const c = new BackendClient("shop", { user: "ed" });
  const cases: [number, unknown, (r: any) => void][] = [
    [409, { error: "version_changed", current: 7 }, (r) => assert.equal(r.versionChanged, 7)],
    [422, { error: "validation", errors: [{ control: "a", message: "Too short" }, { control: "b", message: "Required" }] }, (r) => assert.equal(r.message, "Too short Required")],
    [422, { error: "unknown_fields", fields: ["x", "y"] }, (r) => assert.match(r.message, /does not have the fields x, y/)],
    [403, { detail: "no" }, (r) => assert.match(r.message, /do not have permission to save/)],
    [409, { error: "form_required", detail: "Use CustomerForm." }, (r) => assert.equal(r.message, "Use CustomerForm.")],
    [500, {}, (r) => assert.match(r.message, /Not saved \(500\)/)],
  ];
  for (const [status, body, check] of cases) {
    stub(status, body);
    const r = await c.saveRecord("F", {});
    assert.equal(r.saved, false, String(status));
    check(r);
  }
});

test("a publish sends the forms whole and only the renames from the log", async () => {
  const c = new BackendClient("shop", { user: "olive" });
  stub(200, { version: 3, entities: [], forms: [] });
  await c.loadDefinition();
  const calls = stub(200, { version: 4 });
  const log: Op[] = [{ t: "setLabel", form: "F", id: "x", label: "L" }, { t: "renameField", entity: "customers", from: "email", to: "mail" }];
  assert.match(await c.publish(log, draft()), /^Published as version 4\./);
  assert.equal(calls[0]!.url, "/api/apps/shop/versions");
  assert.deepEqual(calls[0]!.body, { base_version: 3, renames: [{ kind: "field", entity: "customers", from: "email", to: "mail" }], forms: draft().forms });
  assert.equal(c.currentVersion, 4, "the next publish builds on the new version");
});

test("each answer to a publish becomes a message, and a refused publish does not move the version", async () => {
  const c = new BackendClient("shop", { user: "olive" });
  stub(200, { version: 3, entities: [], forms: [] });
  await c.loadDefinition();
  const cases: [number, unknown, RegExp][] = [
    [403, { detail: "x" }, /do not have permission to publish/],
    [409, { error: "version_changed", current: 5 }, /now at version 5.*started from version 3.*Reload/],
    [409, { detail: "The application is in use. Try again in a moment." }, /in use/],
    [400, { detail: "invalid forms: form F: unknown entity zz" }, /invalid forms: form F: unknown entity zz/],
  ];
  for (const [status, body, re] of cases) {
    stub(status, body);
    await assert.rejects(c.publish([], draft()), re, String(status));
    assert.equal(c.currentVersion, 3);
  }
});

test("a rename the backend cannot carry out is refused before anything is sent", async () => {
  const c = new BackendClient("shop", { user: "olive" });
  const calls = stub(200, {});
  await assert.rejects(c.publish([{ t: "renameEntity", from: "a", to: "b", table: "c" }], draft()), /cannot be renamed/);
  assert.equal(calls.length, 0);
});

test("combo and subform tables are read for lookups, and a table that cannot be read gives no rows", async () => {
  const c = new BackendClient("shop", { user: "ed" });
  const forms = [{ name: "F", title: "F", entity: "orders", rows: [{ id: "r", controls: [
    { id: "a", type: "combo", bind: "customerid", label: "C", source: { entity: "customers", value: "id", display: "name" } },
    { id: "b", type: "subform", label: "Lines", child: { entity: "lines", link: "oid", parentKey: "id" }, columns: [] } ] }] }] as never;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => { seen.push(url); return url.includes("/customers/") ? new Response(JSON.stringify({ records: [{ id: 1, name: "Acme" }] })) : new Response("{}", { status: 403 }); }) as typeof fetch;
  const out = await c.lookups(forms);
  assert.deepEqual(out, { customers: [{ id: 1, name: "Acme" }], lines: [] });
  assert.deepEqual(seen.sort(), ["/api/apps/shop/tables/customers/records?limit=500", "/api/apps/shop/tables/lines/records?limit=500"]);
});

test("taking the draft returns the saved log, and each refusal is its own kind of error", async () => {
  const c = new BackendClient("shop", { user: "dee" });
  const log = [{ t: "setLabel", form: "F", id: "x", label: "L" }];
  const calls = stub(200, { base_version: 2, log, expires_at: "2026-10-02T10:30:00+00:00" });
  assert.deepEqual(await c.lockDraft(), { baseVersion: 2, log, expiresAt: "2026-10-02T10:30:00+00:00" });
  assert.deepEqual([calls[0]!.method, calls[0]!.url], ["POST", "/api/apps/shop/draft/lock"]);
  stub(409, { error: "draft_locked", locked_by: "dan", expires_at: "2026-10-02T11:00:00+00:00" });
  await assert.rejects(c.lockDraft(), (e: unknown) => e instanceof DraftLockedError && e.lockedBy === "dan" && e.expiresAt.startsWith("2026"));
  stub(409, { error: "draft_out_of_date", base: 1, current: 3 });
  await assert.rejects(c.lockDraft(), (e: unknown) => e instanceof DraftOutOfDateError && e.base === 1 && e.current === 3);
  stub(403, {});
  await assert.rejects(c.lockDraft(), /do not have permission to edit/);
});

test("a save sends the log, and a lost lock is said plainly", async () => {
  const c = new BackendClient("shop", { user: "dee" });
  const log = [{ t: "setLabel", form: "F", id: "x", label: "L" }] as never;
  const calls = stub(200, { saved: 1, expires_at: "later" });
  assert.deepEqual(await c.saveDraft(log), { saved: 1, expiresAt: "later" });
  assert.deepEqual([calls[0]!.method, calls[0]!.url, calls[0]!.body], ["PUT", "/api/apps/shop/draft", { log }]);
  stub(409, { error: "draft_locked", locked_by: "dan" });
  await assert.rejects(c.saveDraft(log), (e: unknown) => e instanceof DraftLostError && /dan has taken over/.test(e.message));
  stub(409, { error: "no_draft" });
  await assert.rejects(c.saveDraft(log), (e: unknown) => e instanceof DraftLostError && /lock on the draft has ended/.test(e.message));
  stub(400, { detail: "the draft is too large" });
  await assert.rejects(c.saveDraft(log), /the draft is too large/);
});

test("discarding sends a delete, and someone else's active draft is a lock error", async () => {
  const c = new BackendClient("shop", { user: "dee" });
  const calls = stub(200, { discarded: true });
  await c.discardDraft();
  assert.deepEqual([calls[0]!.method, calls[0]!.url], ["DELETE", "/api/apps/shop/draft"]);
  stub(409, { error: "draft_locked", locked_by: "dan", expires_at: "x" });
  await assert.rejects(c.discardDraft(), DraftLockedError);
  stub(403, {});
  await assert.rejects(c.discardDraft(), /do not have permission to discard/);
});

test("a publish that meets someone else's draft says whose", async () => {
  const c = new BackendClient("shop", { user: "mia" });
  stub(409, { error: "draft_locked", locked_by: "dan" });
  await assert.rejects(c.publish([], draft()), /dan is editing a draft/);
});
