// Browser tests in Chromium: rendering, accessibility, keyboard editing, drag and drop, timing, and the draft workflow in the UI.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { demoFull } from "../fixtures/node.ts";
import { createServer, type Spike5Server } from "../src/server/server.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const GRANTS = { mia: ["manage_application"], dana: ["design_application"], ed: ["edit_data", "view_data"] } as never;
const FORMS = ["CustomerForm", "ProductForm", "OrderForm", "OrderLineForm", "CreditReviewForm"];
const AXE = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let srv: Spike5Server, base: string, browser: Browser;
const results: Record<string, unknown> = {};

before(async () => {
  srv = createServer({ base: demoFull(), grants: GRANTS, staticDir: ROOT });
  base = `http://127.0.0.1:${await srv.listen()}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  mkdirSync(`${ROOT}/work/screens`, { recursive: true });
});
after(async () => {
  writeFileSync(`${ROOT}/work/browser-results.json`, JSON.stringify(results, null, 1));
  await browser.close(); await srv.close();
});
beforeEach(() => { srv.state.versions.length = 1; srv.state.draft = null; srv.state.audit.length = 0; });

async function open(path: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on("pageerror", (e) => { throw e; });
  await page.goto(base + path);
  return page;
}

async function axe(page: Page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async (tags) => {
    // @ts-expect-error axe is injected into the page
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
    return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(" ") }));
  }, AXE_TAGS);
}

async function tabTo(page: Page, selector: string, max = 120) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return i;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${selector}`);
}
const status = async (page: Page, re: RegExp) => { await page.waitForFunction((s) => new RegExp(s).test(document.getElementById("status")?.textContent ?? ""), re.source, { timeout: 5000 }); return page.locator("#status").innerText(); };
const log = (page: Page) => page.evaluate(() => (window as any).__spike5.editor.history.log);
const rowsOf = (page: Page, form: string) => page.evaluate((f) => (window as any).__spike5.editor.history.current.forms.find((x: any) => x.name === f).rows.map((r: any) => r.controls.map((c: any) => c.id).join("+")), form);

test("every form renders, with a label on every control, and screenshots for the owner's comparison", async () => {
  const summary: Record<string, unknown> = {};
  for (const f of FORMS) {
    const page = await open(`/public/index.html?mode=run&form=${f}&user=ed`);
    await page.waitForSelector("form");
    const info = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll<HTMLInputElement>("form input, form select, form textarea")].filter((e) => !e.closest("[hidden]"));
      return { controls: inputs.length, unlabelled: inputs.filter((e) => !e.labels?.length).length, heading: document.querySelector("form h2")?.textContent };
    });
    assert.equal(info.unlabelled, 0, `${f}: every visible control has a label`);
    assert.ok(info.controls > 0 || f === "none");
    await page.screenshot({ path: `${ROOT}/work/screens/${f}.png`, fullPage: true });
    summary[f] = info;
    await page.context().close();
  }
  results.rendered = summary;
});

test("conditional visibility, validation messages, combo options, and the empty subform", async () => {
  const page = await open("/public/index.html?mode=run&form=OrderForm&user=ed");
  await page.waitForSelector("form");
  const ship = page.locator('[data-control="o_ship"]');
  assert.equal(await ship.isVisible(), false, "ship date is hidden while status is new");
  await page.fill("#ctl-OrderForm-o_status", "shipped");
  assert.equal(await ship.isVisible(), true, "ship date appears when status is shipped");
  await page.fill("#ctl-OrderForm-o_date", "2026-03-10");
  await page.fill("#ctl-OrderForm-o_ship", "2026-03-01");
  await page.locator("#ctl-OrderForm-o_ship").blur();
  assert.match(await page.locator("#ctl-OrderForm-o_ship-error").innerText(), /cannot be before the order date/);
  assert.equal(await page.locator("#ctl-OrderForm-o_ship").getAttribute("aria-invalid"), "true");
  assert.deepEqual(await page.locator("#ctl-OrderForm-o_cust option").allInnerTexts(), ["", "Acme", "Birch", "Cedar"]);
  assert.match(await page.locator('[data-control="o_lines"]').innerText(), /Save the record to add lines/);
  assert.equal(await page.locator("#ctl-OrderForm-o_status").inputValue(), "shipped");
  await page.context().close();
});

test("a default is applied to a new record, and a hidden control is not checked", async () => {
  const page = await open("/public/index.html?mode=run&form=ProductForm&user=ed");
  await page.waitForSelector("form");
  assert.equal(await page.locator("#ctl-ProductForm-p_price").inputValue(), "0");
  assert.equal(await page.locator("#ctl-ProductForm-p_disc").isChecked(), false);
  const review = await open("/public/index.html?mode=run&form=CreditReviewForm&user=ed");
  await review.waitForSelector("form");
  assert.equal(await review.locator('[data-control="v_credit"]').isVisible(), false);
  await review.check("#ctl-CreditReviewForm-v_active");
  assert.equal(await review.locator('[data-control="v_credit"]').isVisible(), true);
  assert.equal(await review.locator('[data-control="v_city"]').isVisible(), false, "city needs credit above 1000 as well");
  await review.fill("#ctl-CreditReviewForm-v_credit", "5000");
  assert.equal(await review.locator('[data-control="v_city"]').isVisible(), true);
});

test("saving: the server's rules reach the user, and a valid record saves", async () => {
  const page = await open("/public/index.html?mode=run&form=ProductForm&user=ed");
  await page.waitForSelector("form");
  await page.fill("#ctl-ProductForm-p_name", "Widget");
  await page.fill("#ctl-ProductForm-p_price", "-5");
  await page.click("#save");
  assert.match(await page.locator("#result").innerText(), /Price must not be negative/);
  await page.fill("#ctl-ProductForm-p_price", "5");
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("result")?.textContent?.startsWith("Saved"));
  assert.match(await page.locator("#result").innerText(), /Saved with form version 1/);
});

test("an open form from the earlier version is told to reload after a publish", async () => {
  const page = await open("/public/index.html?mode=run&form=OrderForm&user=ed");
  await page.waitForSelector("form");
  await page.selectOption("#ctl-OrderForm-o_cust", "1");
  // Another person publishes a new version while this form is open.
  const h = { "content-type": "application/json", "x-user": "mia" };
  await fetch(base + "/api/draft/lock", { method: "POST", headers: h });
  await fetch(base + "/api/draft/ops", { method: "POST", headers: h, body: JSON.stringify({ log: [{ t: "setLabel", form: "OrderForm", id: "o_cust", label: "Client" }] }) });
  assert.equal((await fetch(base + "/api/draft/publish", { method: "POST", headers: h })).status, 200);
  await page.click("#save");
  const banner = page.locator("#version-banner");
  await banner.waitFor();
  assert.equal(await banner.getAttribute("role"), "alert");
  assert.match(await banner.innerText(), /This form has changed/);
  assert.equal(await page.locator("#result").innerText(), "", "nothing was saved");
  await page.click("#reload");
  await page.waitForSelector("form");
  assert.match(await page.locator("body").innerText(), /Form version 2/);
  assert.equal(await page.locator('label[for="ctl-OrderForm-o_cust"]').innerText(), "Client", "the reloaded form shows the edit");
});

test("render time for a form with 100 controls", async () => {
  const page = await open("/public/index.html?mode=run&form=CustomerForm&user=ed");
  await page.waitForSelector("form");
  const measure = async () => page.evaluate(async () => {
    const renderUrl = "/dist/src/ui/render.js", demoUrl = "/dist/fixtures/demo.js";
    const { renderForm } = await import(renderUrl);
    const { demoDefinition, bigForm } = await import(demoUrl);
    const def = demoDefinition(); def.forms.push(bigForm(100));
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      document.getElementById("big")?.remove();
      const t0 = performance.now();
      const view = renderForm(def, "BigForm", { isNew: true, lookups: {} });
      const host = document.createElement("div"); host.id = "big"; host.append(view.el); document.body.append(host);
      host.getBoundingClientRect();  // force layout, so the time includes it
      await new Promise((r) => requestAnimationFrame(() => r(null)));  // and one paint
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: times[5]!, max: times[9]!, controls: document.querySelectorAll("#big .field").length };
  });
  const normal = await measure();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const slow = await measure();
  assert.equal(normal.controls, 100);
  results.render100 = { normal, cpuThrottled4x: slow };
  assert.ok(normal.max < 2000, `100 controls render in ${normal.max} ms`);
  assert.ok(slow.max < 2000, `100 controls render in ${slow.max} ms with a 4x slower CPU`);
});

test("automated accessibility check: forms and editor", async () => {
  const report: Record<string, unknown> = {};
  const pages: [string, string][] = FORMS.map((f) => [f, `/public/index.html?mode=run&form=${f}&user=ed`]);
  pages.push(["editor", "/public/index.html?mode=edit&form=OrderForm&user=dana"]);
  let critical = 0, serious = 0;
  for (const [name, url] of pages) {
    const page = await open(url);
    await page.waitForSelector("form");
    if (name === "editor") { await page.click('[data-select="o_ship"]'); }
    const v = await axe(page);
    report[name] = v;
    critical += v.filter((x: any) => x.impact === "critical").length;
    serious += v.filter((x: any) => x.impact === "serious").length;
    await page.context().close();
  }
  // the editor with a selection, a rename preview, and an error message showing
  const page = await open("/public/index.html?mode=edit&form=OrderForm&user=dana");
  await page.waitForSelector("form");
  await page.click('[data-select="o_status"]');
  await page.selectOption("#rn-field", "status"); await page.fill("#rn-to", "state"); await page.click('[data-fk="rn-preview"]');
  await page.fill("#p-visible", "nope > 1"); await page.locator("#p-visible").blur();
  const v = await axe(page);
  report["editor with preview and error"] = v;
  critical += v.filter((x: any) => x.impact === "critical").length;
  serious += v.filter((x: any) => x.impact === "serious").length;
  // the editor with a warning, and the warning list, on screen
  const warn = await open("/public/index.html?mode=edit&form=OrderLineForm&user=dana");
  await warn.waitForSelector("form");
  await warn.click('[data-select="l_disc"]');
  await warn.waitForSelector("#rule-warn-0");
  const vw = await axe(warn);
  report["editor with a rule warning"] = vw;
  critical += vw.filter((x: any) => x.impact === "critical").length;
  serious += vw.filter((x: any) => x.impact === "serious").length;
  results.accessibility = { tags: AXE_TAGS, pages: Object.keys(report).length, critical, serious, violations: report };
  assert.equal(critical, 0, JSON.stringify(report));
  assert.equal(serious, 0, JSON.stringify(report));
});

test("keyboard only: select, edit a label, move, undo, redo, set a rule, and see a rejected rule", async () => {
  const page = await open("/public/index.html?mode=edit&form=CustomerForm&user=dana");
  await page.waitForSelector("form");
  let keys = 0;
  const press = async (k: string) => { keys++; await page.keyboard.press(k); };
  const tab = async (sel: string) => { keys += await tabTo(page, sel); };
  await tab('[data-select="c_city"]'); await press("Enter");
  assert.equal(await page.locator('[data-select="c_city"]').getAttribute("aria-pressed"), "true");

  await tab("#p-label");
  await press("Control+A"); await page.keyboard.type("Town"); keys += 4; await press("Tab");  // the change event fires on leaving the field
  assert.equal((await log(page)).at(-1).label, "Town");

  await tab('[data-fk="m-later"]'); await press("Enter");
  assert.deepEqual((await rowsOf(page, "CustomerForm"))[1], "c_joined+c_city");
  assert.match(await page.locator("#status").innerText(), /Moved c_city later in the row/);

  await press("Control+Z");  // focus is on a button, so the editor's undo applies
  assert.deepEqual((await rowsOf(page, "CustomerForm"))[1], "c_city+c_joined");
  await press("Control+Y");
  assert.deepEqual((await rowsOf(page, "CustomerForm"))[1], "c_joined+c_city");

  await tab("#p-visible"); await page.keyboard.type("active && credit_limit > 100"); keys += 28; await press("Tab");
  assert.equal((await log(page)).at(-1).t, "setVisible");
  await tab("#p-visible"); await press("Control+A"); await page.keyboard.type("nope > 1"); keys += 8; await press("Tab");
  assert.match(await page.locator("#status").innerText(), /Not changed: visibility rule: unknown field nope/);
  assert.equal(await page.locator("#status").getAttribute("role"), "alert");

  assert.equal(await page.evaluate(() => (window as any).__spike5.editor.history.verify()), true, "the log rebuilds the draft");
  results.keyboard = { keysPressed: keys, operations: (await log(page)).length };
});

test("pointer: drag a control before another", async () => {
  const page = await open("/public/index.html?mode=edit&form=CustomerForm&user=dana");
  await page.waitForSelector("form");
  await page.dragAndDrop('[data-control="c_credit"]', '[data-control="c_name"]');
  assert.deepEqual((await rowsOf(page, "CustomerForm")).slice(0, 2), ["c_credit+c_name", "c_city+c_joined"]);
  assert.equal((await log(page)).at(-1).t, "moveControl");
});

test("add and remove with undo, in the UI", async () => {
  const page = await open("/public/index.html?mode=edit&form=CustomerForm&user=dana");
  await page.waitForSelector("form");
  await page.selectOption("#add-type", "date"); await page.selectOption("#add-field", "joined");
  await page.click('[data-fk="add"]');
  assert.equal((await rowsOf(page, "CustomerForm")).length, 5);
  await page.click('[data-fk="remove"]');
  assert.equal((await rowsOf(page, "CustomerForm")).length, 4);
  await page.click('[data-fk="undo"]'); await page.click('[data-fk="undo"]');
  assert.equal((await rowsOf(page, "CustomerForm")).length, 4);
  assert.equal(await page.locator('[data-fk="undo"]').isDisabled(), true);
  assert.equal(await page.locator('[data-fk="redo"]').isDisabled(), false);
});

test("rename in the UI lists what changes and which handlers need review", async () => {
  const page = await open("/public/index.html?mode=edit&form=OrderLineForm&user=dana");
  await page.waitForSelector("form");
  await page.selectOption("#rn-field", "qty"); await page.fill("#rn-to", "quantity");
  await page.click('[data-fk="rn-preview"]');
  const updated = await page.locator("#rn-updated li").allInnerTexts();
  assert.ok(updated.includes("form OrderLineForm, control l_qty") && updated.includes("query OrderTotals"), updated.join("; "));
  assert.deepEqual((await page.locator("#rn-handlers li").allInnerTexts()).map((t) => t.split(",")[0]), ["02-line-total", "06-update-stock"]);
  assert.match(await page.locator("#rn-sql").innerText(), /rename column "qty" to "quantity"/);
  await page.click('[data-fk="rn-apply"]');
  assert.equal(await page.locator('label[for="ctl-OrderLineForm-l_qty"]').innerText(), "Quantity", "the label is not renamed, only the field");
  assert.ok((await page.locator('[data-fk="rn-field"] option').allInnerTexts()).includes("quantity"));
  await page.fill("#rn-to", "x");
  assert.equal(await page.locator("#rn-to").inputValue(), "x");
});

test("Design can save a draft but not publish. Manage can publish.", async () => {
  const design = await open("/public/index.html?mode=edit&form=CustomerForm&user=dana");
  await design.waitForSelector("form");
  await design.click('[data-select="c_name"]'); await design.fill("#p-label", "Full name"); await design.locator("#p-label").blur();
  await design.click('[data-fk="save"]');
  assert.match(await status(design, /Draft saved with 1 edits/), /Draft saved with 1 edits/);
  await design.click('[data-fk="publish"]');
  assert.match(await status(design, /do not have permission to publish/), /do not have permission to publish/);
  assert.equal(srv.state.versions.length, 1);
  srv.state.draft = null;
  const manage = await open("/public/index.html?mode=edit&form=CustomerForm&user=mia");
  await manage.waitForSelector("form");
  await manage.click('[data-select="c_name"]'); await manage.fill("#p-label", "Full name"); await manage.locator("#p-label").blur();
  await manage.click('[data-fk="publish"]');
  assert.match(await status(manage, /Published as version 2/), /Published as version 2/);
  assert.equal(srv.state.versions.length, 2);
});

test("a person with no grant cannot edit at all", async () => {
  const page = await open("/public/index.html?mode=edit&form=CustomerForm&user=ed");
  await page.waitForSelector("form");
  await page.click('[data-fk="save"]');
  assert.match(await status(page, /do not have permission to edit/), /do not have permission to edit/);
});

test("a rule that rejects an empty optional field gets a warning with a fix, and undo brings the warning back", async () => {
  const page = await open("/public/index.html?mode=edit&form=OrderLineForm&user=dana");
  await page.waitForSelector("form");
  assert.equal(await page.locator("#rule-warn-0").count(), 0, "nothing is selected yet");
  assert.match(await page.locator("#warning-list").innerText(), /Rule 1 is false when Discount is empty/, "the draft panel lists it before anything is selected");
  await page.click('[data-select="l_disc"]');
  const note = page.locator("#rule-warn-0");
  assert.equal(await note.getAttribute("role"), "note");
  assert.match(await note.innerText(), /Warning: Rule 1 is false when Discount is empty, so Discount cannot be left empty/);
  assert.equal(await page.locator('[data-fk="rule-e-0"]').getAttribute("aria-describedby"), "rule-warn-0", "the rule field points at its warning");

  await page.click('[data-fk="rule-fix-0"]');
  assert.equal(await page.locator("#rule-warn-0").count(), 0, "the warning is gone");
  assert.equal(await page.locator('[data-fk="rule-e-0"]').inputValue(), "isnull(discount) || (discount >= 0 && discount <= 1)");
  assert.match(await page.locator("#status").innerText(), /Rule 1 now allows an empty value/);
  assert.equal(await page.locator("#warn-h").innerText(), "Warnings (1)", "the other demo warning remains");
  assert.doesNotMatch(await page.locator("#warning-list").innerText(), /Discount/);

  await page.click('[data-fk="undo"]');
  assert.equal(await page.locator("#rule-warn-0").count(), 1, "undo brings the warning back");
  assert.equal(await page.locator("#warn-h").innerText(), "Warnings (2)");
  assert.equal(await page.evaluate(() => (window as any).__spike5.editor.history.verify()), true);
  assert.equal((await log(page)).length, 0);
});

test("adding a rule that rejects empty says so in the status line", async () => {
  const page = await open("/public/index.html?mode=edit&form=CustomerForm&user=dana");
  await page.waitForSelector("form");
  await page.click('[data-select="c_credit"]');
  await page.fill("#rule-new-e", "credit_limit > 0");
  await page.fill("#rule-new-m", "Must be positive");
  await page.click('[data-fk="rule-add"]');
  const msg = await status(page, /Warning/);
  assert.match(msg, /Added the rule\. Warning: Rule 1 is false when Credit limit is empty/);
  assert.match(await page.locator("#warning-list").innerText(), /Credit limit is empty/);
});

test("keyboard only: reach the fix button and use it", async () => {
  const page = await open("/public/index.html?mode=edit&form=OrderLineForm&user=dana");
  await page.waitForSelector("form");
  await tabTo(page, '[data-select="l_disc"]');
  await page.keyboard.press("Enter");
  await tabTo(page, '[data-fk="rule-fix-0"]');
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#rule-warn-0").count(), 0);
  assert.equal((await log(page)).at(-1).t, "setValidation");
});

test("the warning list can take you to the control", async () => {
  const page = await open("/public/index.html?mode=edit&form=CustomerForm&user=dana");
  await page.waitForSelector("form");
  assert.match(await page.locator("#warning-list").innerText(), /Credit review/);
  await page.click('[data-fk="warn-show-v_credit-0"]');
  assert.equal(await page.locator("#form-select").inputValue(), "CreditReviewForm");
  assert.equal(await page.locator('[data-select="v_credit"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#rule-warn-0").count(), 1);
});

test("publishing with a warning works and says how many warnings remain", async () => {
  const page = await open("/public/index.html?mode=edit&form=CustomerForm&user=mia");
  await page.waitForSelector("form");
  await page.click('[data-select="c_name"]'); await page.fill("#p-label", "Full name"); await page.locator("#p-label").blur();
  await page.click('[data-fk="publish"]');
  assert.match(await status(page, /Published as version 2/), /Published as version 2\. 2 rule warnings remain/);
});
