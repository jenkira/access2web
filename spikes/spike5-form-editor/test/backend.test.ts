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
    grants: [grant("dana", "design_application"), grant("ed", "edit_data"), grant("vic", "view_data")] });
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
const editor = (slug: string, user: string, form = "CustomerForm") => `/editor/public/index.html?app=${slug}&mode=edit&form=${form}&user=${user}`;
const runner = (slug: string, user: string, form = "CustomerForm") => `/editor/public/index.html?app=${slug}&mode=run&form=${form}&user=${user}`;
const statusText = async (page: Page, re: RegExp) => { await page.waitForFunction((s) => new RegExp(s).test(document.getElementById("status")?.textContent ?? ""), re.source, { timeout: 8000 }); return page.locator("#status").innerText(); };
const columns = async (slug: string) => (await db.query("select column_name from information_schema.columns where table_schema = $1 and table_name = 'customers'", ["app_" + slug])).rows.map((r) => r.column_name);
const setLabel = async (page: Page, id: string, text: string) => { await page.click(`[data-select="${id}"]`); await page.fill("#p-label", text); await page.locator("#p-label").blur(); };

test("the editor page is served by the backend, and loads the application's real forms", async () => {
  const slug = await newApp();
  const page = await open(editor(slug, "dana"));
  await page.waitForSelector("form");
  assert.deepEqual(await page.locator("#form-select option").allInnerTexts(), ["Customer"]);
  assert.equal(await page.locator('label[for="ctl-CustomerForm-c_name"]').innerText(), "Name");
  assert.equal(await page.locator('[data-fk="save"]').isDisabled(), true, "there is no saved draft on the server yet");
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
  // Someone else publishes first.
  const forms = structuredClone(FORMS); forms[0]!.title = "Customer details";
  assert.equal((await api("POST", `/api/apps/${slug}/versions`, who("olive"), { base_version: 1, forms })).status, 200);
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
