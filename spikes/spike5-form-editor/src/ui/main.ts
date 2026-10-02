import { sampleLookups } from "../../fixtures/demo.ts";
import type { Definition } from "../model/types.ts";
import type { Op } from "../model/ops.ts";
import { Editor } from "./editor.ts";
import { h } from "./dom.ts";
import { renderForm } from "./render.ts";

const q = new URLSearchParams(location.search);
const mode = q.get("mode") ?? "run";
const user = q.get("user") ?? "mia";
const formName = q.get("form") ?? "OrderForm";
const editForm = q.get("form") ?? undefined;
const app = document.getElementById("app")!;
const headers = { "content-type": "application/json", "x-user": user };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

async function run() {
  const { body } = await api("GET", "/api/definition");
  const def = body.definition as Definition;
  const version = body.version as number;
  const view = renderForm(def, formName, { lookups: sampleLookups, isNew: true });
  const banner = h("div", { id: "banner-host" });
  const status = h("div", { id: "result", role: "status" });
  const save = h("button", { type: "button", id: "save" }, "Save");
  save.addEventListener("click", async () => {
    banner.replaceChildren(); status.textContent = "";
    const errors = view.errors();
    if (errors.length) { view.el.requestSubmit(); status.textContent = `Not saved. ${errors.map((e) => e.message).join(" ")}`; return; }
    const r = await api("POST", "/api/records", { version, form: formName, record: view.getRecord() });
    if (r.status === 409 && r.body.error === "version_changed") {
      const reload = h("button", { type: "button", id: "reload" }, "Reload the form");
      reload.addEventListener("click", () => location.reload());
      banner.replaceChildren(h("div", { class: "banner", role: "alert", id: "version-banner" }, `This form has changed since you opened it (now version ${r.body.current}). Reload it to continue. `, reload));
    } else if (r.status === 200) status.textContent = `Saved with form version ${r.body.version}.`;
    else status.textContent = `Not saved: ${r.body.error}`;
  });
  app.replaceChildren(h("p", {}, `Form version ${version}. Signed in as ${user}.`), banner, view.el, h("p", {}, save), status);
}

async function edit() {
  const { body } = await api("GET", "/api/definition");
  let locked = false;
  const ed: Editor = new Editor(app, body.definition as Definition, sampleLookups, {
    async saveDraft(log: Op[]) {
      if (!locked) { const l = await api("POST", "/api/draft/lock"); if (l.status !== 200) throw new Error(l.body.error === "draft_locked" ? `The draft is locked by ${l.body.lockedBy}.` : "You do not have permission to edit this application."); locked = true; }
      const r = await api("POST", "/api/draft/ops", { log });
      if (r.status !== 200) throw new Error(`Draft not saved: ${r.body.message ?? r.body.error}`);
      return `Draft saved with ${r.body.saved} edits.`;
    },
    async publish() {
      await ed.hooks_saveForPublish();
      const r = await api("POST", "/api/draft/publish");
      if (r.status === 403) throw new Error("You can edit this draft, but you do not have permission to publish it.");
      if (r.status !== 200) throw new Error(`Not published: ${r.body.message ?? r.body.error}`);
      return `Published as version ${r.body.version}.`;
    },
  }, editForm);
  (window as unknown as { __spike5: unknown }).__spike5 = { editor: ed };
}

if (mode === "edit") void edit(); else void run();
