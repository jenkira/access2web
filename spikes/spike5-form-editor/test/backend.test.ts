// The editor against the real Python backend, in Chromium. Starts PostgreSQL's database, the backend with the editor mounted,
// and a browser. Each test publishes its own application, so tests do not share state.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import pg from "pg";
import { chromium, type Browser, type Page } from "playwright-core";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const BACKEND = new URL("../../../backend", import.meta.url).pathname.replace(/\/$/, "");
const ADMIN = process.env.A2W_SPIKE_ADMIN_URL ?? "postgresql://postgres:test@127.0.0.1:54329/postgres";
const DB = "a2w_editor_" + Math.random().toString(36).slice(2, 10);
const DB_URL = ADMIN.replace(/\/[^/]*$/, `/${DB}`);

let proc: ChildProcess, base: string, browser: Browser, admin: pg.Client, db: pg.Client;
let stderr = "";
const slugs: string[] = [];

const who = (user: string, roles = "") => ({ "content-type": "application/json", "x-a2w-user": user, "x-a2w-groups": "", "x-a2w-roles": roles });
const OWNER = who("olive", "app_owner");
async function api(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

const EXTRACTION = {
  tables: [
    { name: "Customers", primary_key: ["CustomerID"],
      fields: [{ name: "CustomerID", type: "AutoNumber" }, { name: "Customer Name", type: "Short Text", size: 50, required: true }, { name: "Email", type: "Short Text", size: 80 }],
      rows: [{ CustomerID: 1, "Customer Name": "Acme", Email: "a@x.test" }, { CustomerID: 2, "Customer Name": "Birch", Email: null }] },
  ],
  relationships: [], queries: [], forms: [], modules: [],
};
const FORMS = [{ name: "CustomerForm", title: "Customer", entity: "customers", rows: [
  { id: "r1", controls: [{ id: "c_name", type: "text", bind: "customer_name", label: "Name" }] },
  { id: "r2", controls: [{ id: "c_email", type: "text", bind: "email", label: "Email",
    validate: [{ expr: "isnull(email) || len(email) >= 5", message: "Email is too short" }] }] },
] }];
const grant = (user: string, level: string) => ({ subject_type: "user", subject_id: user, resource_type: "application", resource_id: "", level });

async function newApp(): Promise<string> {
  const slug = "ed_" + Math.random().toString(36).slice(2, 9);
  slugs.push(slug);
  const job = (await api("POST", "/api/authoring/import-jobs", OWNER, EXTRACTION)).body.job;
  const r = await api("POST", `/api/authoring/import-jobs/${job}/publish`, OWNER, {
    slug, name: slug, confirmed_classification: "personal", permissions_confirmed: true, forms: FORMS,
    grants: [grant("dana", "design_application"), grant("dan", "design_application"), grant("mia", "manage_application"), grant("ed", "edit_data"), grant("vic", "view_data")] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return slug;
}

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

before(async () => {
  admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
  await admin.query(`create database "${DB}"`);
  const env = { ...process.env, A2W_DATABASE_URL: DB_URL, A2W_DEV_AUTH: "1", A2W_EDITOR_DIR: ROOT };
  execFileSync("python3", ["-c", "from a2w import db; db.bootstrap()"], { cwd: BACKEND, env });
  const port = await freePort();
  proc = spawn("python3", ["-m", "uvicorn", "a2w.api:app", "--port", String(port), "--log-level", "warning"], { cwd: BACKEND, env });
  proc.stderr!.on("data", (d) => { stderr += d; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch { /* not up yet */ }
    if (i > 100) throw new Error(`the backend did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  db = new pg.Client({ connectionString: DB_URL }); await db.connect();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close(); await db?.end(); proc?.kill();
  await new Promise((r) => setTimeout(r, 300));
  if (admin) {
    await admin.query(`drop database if exists "${DB}" with (force)`);
    for (const s of slugs) await admin.query(`drop role if exists "app_${s}"`);
    await admin.end();
  }
});

async function open(path: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on("pageerror", (e) => { throw e; });
  await page.goto(base + path);
  return page;
}
const editor = (slug: string, user: string, form = "CustomerForm", extra = "") => `/editor/public/index.html?app=${slug}&mode=edit&form=${form}&user=${user}&autosave=100${extra}`;
const runner = (slug: string, user: string, form = "CustomerForm") => `/editor/public/index.html?app=${slug}&mode=run&form=${form}&user=${user}`;
const statusText = async (page: Page, re: RegExp) => { await page.waitForFunction((s) => new RegExp(s).test(document.getElementById("status")?.textContent ?? ""), re.source, { timeout: 8000 }); return page.locator("#status").innerText(); };
const columns = async (slug: string) => (await db.query("select column_name from information_schema.columns where table_schema = $1 and table_name = 'customers'", ["app_" + slug])).rows.map((r) => r.column_name);
const draftOf = async (slug: string, user: string) => (await api("GET", `/api/apps/${slug}/draft`, who(user))).body;
const lapse = (slug: string) => db.query("update a2w_control.drafts set expires_at = now() - interval '1 second' where app_id = (select id from a2w_control.applications where slug = $1)", [slug]);
const draftState = async (page: Page, re: RegExp) => { await page.waitForFunction((s) => new RegExp(s).test(document.getElementById("draft-state")?.textContent ?? ""), re.source, { timeout: 8000 }); return page.locator("#draft-state").innerText(); };
const setLabel = async (page: Page, id: string, text: string) => { await page.click(`[data-select="${id}"]`); await page.fill("#p-label", text); await page.locator("#p-label").blur(); };

test("the editor page is served by the backend, and loads the application's real forms", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "dana"));
  await page.waitForSelector("form");
  assert.deepEqual(await page.locator("#form-select option").allInnerTexts(), ["Customer"]);
  assert.equal(await page.locator('label[for="ctl-CustomerForm-c_name"]').innerText(), "Name");
  assert.equal(await page.locator('[data-fk="save"]').isDisabled(), false, "the draft is saved on the server");
  assert.equal(await page.locator('[data-fk="discard"]').count(), 1);
  assert.match(await page.locator("#draft-state").innerText(), /Draft saved/);
});

test("Design can edit but the backend refuses a publish, and nothing changes", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "dana"));
  await page.waitForSelector("form");
  await setLabel(page, "c_name", "Full name");
  await page.click('[data-fk="publish"]');
  assert.match(await statusText(page, /do not have permission to publish/), /do not have permission to publish/);
  const def = (await api("GET", `/api/apps/${slug}/definition`, who("olive"))).body;
  assert.equal(def.version, 1); assert.equal(def.forms[0].rows[0].controls[0].label, "Name");
});

test("Manage edits a label and renames a field, publishes, and the data and the running form follow", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "olive"));
  await page.waitForSelector("form");
  await setLabel(page, "c_name", "Full name");
  await page.selectOption("#rn-field", "email"); await page.fill("#rn-to", "mail");
  await page.click('[data-fk="rn-preview"]');
  assert.match(await page.locator("#rn-sql").innerText(), new RegExp(`"app_${slug}"."customers" rename column "email" to "mail"`), "the preview shows the statement the backend will run");
  await page.click('[data-fk="rn-apply"]');
  await page.click('[data-fk="publish"]');
  assert.match(await statusText(page, /Published as version 2/), /Published as version 2/);

  const cols = await columns(slug);
  assert.ok(cols.includes("mail") && !cols.includes("email"), cols.join(","));
  assert.equal((await db.query(`select email_test.mail from (select mail from "app_${slug}".customers order by customerid) email_test limit 1`)).rows[0].mail, "a@x.test", "the data came with the column");
  const def = (await api("GET", `/api/apps/${slug}/definition`, who("olive"))).body;
  assert.equal(def.version, 2);
  const [name, email] = def.forms[0].rows.map((r: any) => r.controls[0]);
  assert.equal(name.label, "Full name"); assert.equal(email.bind, "mail"); assert.match(email.validate[0].expr, /^isnull\(mail\)/);

  // The same page is ready for another edit from version 2, with nothing left over from the first.
  assert.equal(await page.evaluate(() => (window as any).__spike5.editor.unpublishedEdits), 0);
  await setLabel(page, "c_name", "Customer name");
  await page.click('[data-fk="publish"]');
  assert.match(await statusText(page, /Published as version 3/), /Published as version 3/);

  // A person who enters data sees the published form and saves under the new field name.
  const run = await open(runner(slug, "ed"));
  await run.waitForSelector("form");
  assert.match(await run.locator("body").innerText(), /Form version 3/);
  assert.equal(await run.locator('label[for="ctl-CustomerForm-c_name"]').innerText(), "Customer name");
  await run.fill("#ctl-CustomerForm-c_name", "Zed"); await run.fill("#ctl-CustomerForm-c_email", "zed@x.test");
  await run.click("#save");
  await run.waitForFunction(() => document.getElementById("result")?.textContent?.startsWith("Saved"));
  assert.match(await run.locator("#result").innerText(), /Saved with form version 3/);
  assert.equal((await db.query(`select mail from "app_${slug}".customers where customer_name = 'Zed'`)).rows[0].mail, "zed@x.test");
});

test("a draft that started from an older version is refused, with the way forward", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "olive"));
  await page.waitForSelector("form");
  await setLabel(page, "c_name", "Mine");
  await draftState(page, /Draft saved/);
  // The lock stops a second manager from publishing over an active draft.
  const forms = structuredClone(FORMS); forms[0]!.title = "Customer details";
  const blocked = await api("POST", `/api/apps/${slug}/versions`, who("mia"), { base_version: 1, forms });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, "draft_locked"); assert.equal(blocked.body.locked_by, "olive");
  // Once the lease has lapsed, they can, and the draft goes with it.
  await lapse(slug);
  assert.equal((await api("POST", `/api/apps/${slug}/versions`, who("mia"), { base_version: 1, forms })).status, 200);
  await page.click('[data-fk="publish"]');
  const msg = await statusText(page, /Not published/);
  assert.match(msg, /now at version 2/); assert.match(msg, /Reload the editor/);
  const def = (await api("GET", `/api/apps/${slug}/definition`, who("olive"))).body;
  assert.equal(def.version, 2); assert.equal(def.forms[0].rows[0].controls[0].label, "Name", "my edit was not published");
});

test("a person without permission gets a plain message, and the backend decides, not the page", async () => {
  const slug = await newApp();
  const nobody = await open(editor(slug, "stranger"));
  assert.match(await nobody.locator("#load-error").innerText(), /do not have permission to edit/);
  const noRun = await open(runner(slug, "stranger"));
  assert.match(await noRun.locator("#load-error").innerText(), /do not have permission to use this form/);
  // Someone who may read but not write sees the form, and the backend refuses the save.
  const vic = await open(runner(slug, "vic"));
  await vic.waitForSelector("form");
  await vic.fill("#ctl-CustomerForm-c_name", "Nope");
  await vic.click("#save");
  await vic.waitForFunction(() => document.getElementById("result")?.textContent?.length);
  assert.match(await vic.locator("#result").innerText(), /do not have permission to save/);
  assert.equal((await db.query(`select count(*)::int as n from "app_${slug}".customers`)).rows[0].n, 2);
});

test("an open form from the earlier version is told to reload after a publish", async () => {
  const slug = await newApp();
  const page = await open(runner(slug, "ed"));
  await page.waitForSelector("form");
  await page.fill("#ctl-CustomerForm-c_name", "Late");
  const forms = structuredClone(FORMS); forms[0]!.rows[0]!.controls[0]!.label = "Client";
  assert.equal((await api("POST", `/api/apps/${slug}/versions`, who("olive"), { base_version: 1, forms })).status, 200);
  await page.click("#save");
  const banner = page.locator("#version-banner");
  await banner.waitFor();
  assert.match(await banner.innerText(), /now version 2/);
  assert.equal((await db.query(`select count(*)::int as n from "app_${slug}".customers`)).rows[0].n, 2, "nothing was saved");
  await page.click("#reload"); await page.waitForSelector("form");
  assert.match(await page.locator("body").innerText(), /Form version 2/);
  assert.equal(await page.locator('label[for="ctl-CustomerForm-c_name"]').innerText(), "Client");
});

test("an edit is saved to the server by itself, and the draft comes back after a reload", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "dana"));
  await page.waitForSelector("form");
  assert.equal((await draftOf(slug, "dana")).draft.log.length, 0, "the lock was taken when the page opened");
  await setLabel(page, "c_name", "Full name");
  await draftState(page, /Draft saved/);
  const saved = (await draftOf(slug, "dana")).draft;
  assert.equal(saved.mine, true); assert.deepEqual(saved.log.map((o: any) => [o.t, o.id, o.label]), [["setLabel", "c_name", "Full name"]]);
  assert.equal((await api("GET", `/api/apps/${slug}/definition`, who("olive"))).body.version, 1, "nothing was published");

  await page.reload(); await page.waitForSelector("form");
  assert.match(await statusText(page, /Resumed/), /Resumed your saved draft with 1 edit/);
  assert.equal(await page.locator('label[for="ctl-CustomerForm-c_name"]').innerText(), "Full name");
  await page.click('[data-fk="undo"]');  // the resumed edit can be undone like any other
  assert.equal(await page.locator('label[for="ctl-CustomerForm-c_name"]').innerText(), "Name");
  await draftState(page, /Draft saved/);
  await page.waitForFunction(() => (window as any).__spike5.saver.state === "saved");
  assert.equal((await draftOf(slug, "dana")).draft.log.length, 0, "the undo was saved too");
});

test("the Save draft button saves now", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "dana", "CustomerForm", "&autosave=60000"));  // no autosave within the test
  await page.waitForSelector("form");
  await setLabel(page, "c_name", "Saved by hand");
  assert.equal((await draftOf(slug, "dana")).draft.log.length, 0, "not saved yet");
  await page.click('[data-fk="save"]');
  assert.match(await statusText(page, /Draft saved with 1 edit/), /Draft saved with 1 edit\./);
  assert.equal((await draftOf(slug, "dana")).draft.log[0].label, "Saved by hand");
});

test("a second designer is told who holds the draft and cannot take it, but a manager can", async () => {
  const slug = await newApp();
  const dana = await open(editor(slug, "dana"));
  await dana.waitForSelector("form");
  await setLabel(dana, "c_name", "Dana's edit");
  await draftState(dana, /Draft saved/);

  const dan = await open(editor(slug, "dan"));
  await dan.waitForSelector("#load-error");
  assert.match(await dan.locator("#load-error").innerText(), /dana is editing a draft/);
  assert.equal(await dan.locator("form").count(), 0, "the editor does not open");
  await dan.click("#take-over");
  await dan.waitForFunction(() => /dana is editing/.test(document.getElementById("load-error")?.textContent ?? ""));
  assert.equal((await draftOf(slug, "dana")).draft.log.length, 1, "a designer cannot discard another's draft");

  const olive = await open(editor(slug, "olive"));
  await olive.waitForSelector("#take-over");
  await olive.click("#take-over");
  await olive.waitForSelector("form");           // the page reloads and now holds the draft
  const mine = (await draftOf(slug, "olive")).draft;
  assert.equal(mine.locked_by, "olive"); assert.equal(mine.log.length, 0);
  assert.equal(await olive.locator('label[for="ctl-CustomerForm-c_name"]').innerText(), "Name", "dana's edit is not in the draft");

  await setLabel(dana, "c_email", "Mail");        // dana's page does not know yet
  await draftState(dana, /olive has taken over/);
  assert.equal((await draftOf(slug, "olive")).draft.log.length, 0, "dana's late edit did not reach olive's draft");
  assert.equal(await dana.evaluate(() => (window as any).__spike5.saver.dirty), true, "dana's page still counts the edit as unsaved");
});

test("a lock that has lapsed can be taken by another designer", async () => {
  const slug = await newApp();
  const dana = await open(editor(slug, "dana"));
  await dana.waitForSelector("form");
  await lapse(slug);
  const dan = await open(editor(slug, "dan"));
  await dan.waitForSelector("form");
  assert.equal((await draftOf(slug, "dan")).draft.locked_by, "dan");
});

test("the page keeps the lock while it is open", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "dana", "CustomerForm", "&heartbeat=300"));
  await page.waitForSelector("form");
  await db.query("update a2w_control.drafts set expires_at = now() + interval '5 seconds' where app_id = (select id from a2w_control.applications where slug = $1)", [slug]);
  await page.waitForTimeout(1200);  // several heartbeats, with no edit
  const r = await db.query("select expires_at > now() + interval '10 minutes' as long from a2w_control.drafts where app_id = (select id from a2w_control.applications where slug = $1)", [slug]);
  assert.equal(r.rows[0].long, true);
});

test("publishing ends the draft, and the page starts the next one from the new version", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "olive"));
  await page.waitForSelector("form");
  await setLabel(page, "c_name", "Published name");
  await page.click('[data-fk="publish"]');
  await statusText(page, /Published as version 2/);
  const next = (await draftOf(slug, "olive")).draft;
  assert.equal(next.mine, true); assert.equal(next.base_version, 2); assert.equal(next.log.length, 0);
  // Nobody else can publish over the new draft, and an edit goes into it.
  await setLabel(page, "c_name", "Second name");
  await draftState(page, /Draft saved/);
  assert.equal((await draftOf(slug, "olive")).draft.log[0].label, "Second name");
  const forms = structuredClone(FORMS);
  assert.equal((await api("POST", `/api/apps/${slug}/versions`, who("mia"), { base_version: 2, forms })).status, 409);
});

test("Discard draft throws the edits away after a confirmation", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "dana"));
  await page.waitForSelector("form");
  await setLabel(page, "c_name", "Gone");
  await draftState(page, /Draft saved/);
  page.once("dialog", (d) => d.dismiss());
  await page.click('[data-fk="discard"]');
  assert.match(await statusText(page, /Kept your draft/), /Kept your draft/);
  assert.equal((await draftOf(slug, "dana")).draft.log.length, 1);
  page.once("dialog", (d) => d.accept());
  await page.click('[data-fk="discard"]');
  assert.match(await statusText(page, /Discarded your draft/), /Discarded/);
  assert.equal(await page.locator('label[for="ctl-CustomerForm-c_name"]').innerText(), "Name");
  const after = (await draftOf(slug, "dana")).draft;
  assert.equal(after.mine, true); assert.equal(after.log.length, 0, "a fresh draft, still held by dana");
});

test("a saved draft that does not replay is not opened, and can be discarded", async () => {
  const slug = await newApp();
  assert.equal((await api("POST", `/api/apps/${slug}/draft/lock`, who("dana"))).status, 200);
  assert.equal((await api("PUT", `/api/apps/${slug}/draft`, who("dana"), { log: [{ t: "setLabel", form: "CustomerForm", id: "no_such_control", label: "x" }] })).status, 200);
  const page = await open(editor(slug, "dana"));
  await page.waitForSelector("#load-error");
  assert.match(await page.locator("#load-error").innerText(), /cannot be replayed/);
  await page.click("#discard-broken");
  await page.waitForSelector("form");
  assert.equal((await draftOf(slug, "dana")).draft.log.length, 0);
});

test("the editor renames an entity and its table, and the backend carries it to the data", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "olive"));
  await page.waitForSelector("form");
  assert.equal(await page.locator("#en-table").count(), 0, "an entity has the name of its table here, so no table name is asked for");
  await page.fill("#en-to", "Clients");
  await page.click('[data-fk="en-preview"]');
  assert.match(await statusText(page, /Not changed/), /lower-case letters, digits, and underscores/);
  await page.fill("#en-to", "clients");
  await page.click('[data-fk="en-preview"]');
  assert.match(await page.locator("#en-sql").innerText(), new RegExp(`alter table "app_${slug}"."customers" rename to "clients"`), "the preview shows the statement the backend will run");
  assert.ok((await page.locator("#en-updated li").allInnerTexts()).includes("form CustomerForm"));
  await page.click('[data-fk="en-apply"]');
  await draftState(page, /Draft saved/);
  assert.equal((await draftOf(slug, "olive")).draft.log[0].t, "renameEntity", "the draft holds the rename");
  await page.click('[data-fk="publish"]');
  assert.match(await statusText(page, /Published as version 2/), /Published as version 2/);

  const tables = (await db.query("select table_name from information_schema.tables where table_schema = $1", ["app_" + slug])).rows.map((r) => r.table_name);
  assert.ok(tables.includes("clients") && !tables.includes("customers"), tables.join(","));
  assert.equal((await db.query(`select count(*)::int as n from "app_${slug}".clients`)).rows[0].n, 2, "the rows came with the table");
  const def = (await api("GET", `/api/apps/${slug}/definition`, who("olive"))).body;
  assert.deepEqual(def.entities.map((e: any) => e.name), ["clients"]); assert.equal(def.forms[0].entity, "clients");

  // The page carries on from version 2, and a person who enters data saves into the renamed table.
  assert.ok((await page.locator('[data-fk="en-entity"] option').allInnerTexts()).includes("clients"));
  const run = await open(runner(slug, "ed"));
  await run.waitForSelector("form");
  await run.fill("#ctl-CustomerForm-c_name", "Zed"); await run.fill("#ctl-CustomerForm-c_email", "zed@x.test");
  await run.click("#save");
  await run.waitForFunction(() => document.getElementById("result")?.textContent?.startsWith("Saved"));
  assert.equal((await db.query(`select email from "app_${slug}".clients where customer_name = 'Zed'`)).rows[0].email, "zed@x.test");
});

test("an entity rename in a saved draft comes back after a reload, and can be undone", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "dana"));
  await page.waitForSelector("form");
  await page.fill("#en-to", "clients"); await page.click('[data-fk="en-preview"]'); await page.click('[data-fk="en-apply"]');
  await draftState(page, /Draft saved/);
  await page.waitForFunction(() => (window as any).__spike5.saver.state === "saved");
  await page.reload(); await page.waitForSelector("form");
  assert.ok((await page.locator('[data-fk="en-entity"] option').allInnerTexts()).includes("clients"));
  await page.click('[data-fk="undo"]');
  assert.ok((await page.locator('[data-fk="en-entity"] option').allInnerTexts()).includes("customers"));
});
