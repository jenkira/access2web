import { sampleLookups } from "../../fixtures/demo.ts";
import type { Definition } from "../model/types.ts";
import type { Op } from "../model/ops.ts";
import { Editor } from "./editor.ts";
import { h } from "./dom.ts";
import { renderForm } from "./render.ts";
import { BackendClient, DraftLockedError, DraftOutOfDateError } from "../backend/client.ts";
import { DraftSaver } from "../backend/draft.ts";
import { History } from "../model/history.ts";

const q = new URLSearchParams(location.search);
const mode = q.get("mode") ?? "run";
const user = q.get("user") ?? "mia";
const formName = q.get("form") ?? "OrderForm";
// With ?app=<slug> the page talks to the Python backend. Without it, it talks to the prototype server.
const slug = q.get("app");
const backend = slug ? new BackendClient(slug, { user: q.get("user") ?? "", groups: q.get("groups") ?? "", roles: q.get("roles") ?? "" }) : null;
const editForm = q.get("form") ?? undefined;
const app = document.getElementById("app")!;
const headers = { "content-type": "application/json", "x-user": user };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

async function runBackend(be: BackendClient) {
  let def;
  try { def = await be.loadForm(formName); } catch (e) { app.replaceChildren(h("p", { role: "alert", id: "load-error" }, (e as Error).message)); return; }
  const form = def.forms[0]!;
  const view = renderForm(def, form.name, { lookups: await be.lookups([form]), isNew: true });
  const banner = h("div", { id: "banner-host" });
  const status = h("div", { id: "result", role: "status" });
  const save = h("button", { type: "button", id: "save" }, "Save");
  save.addEventListener("click", async () => {
    banner.replaceChildren(); status.textContent = "";
    const errors = view.errors();
    if (errors.length) { view.el.requestSubmit(); status.textContent = `Not saved. ${errors.map((e) => e.message).join(" ")}`; return; }
    const r = await be.saveRecord(form.name, view.getRecord());
    if (r.saved) status.textContent = `Saved with form version ${r.version}.`;
    else if (r.versionChanged !== undefined) {
      const reload = h("button", { type: "button", id: "reload" }, "Reload the form");
      reload.addEventListener("click", () => location.reload());
      banner.replaceChildren(h("div", { class: "banner", role: "alert", id: "version-banner" }, `This form has changed since you opened it (now version ${r.versionChanged}). Reload it to continue. `, reload));
    } else status.textContent = `Not saved. ${r.message}`;
  });
  app.replaceChildren(h("p", {}, `Form version ${def.version}. Signed in as ${q.get("user")}.`), banner, view.el, h("p", {}, save), status);
}

function showProblem(text: string, button?: { label: string; id: string; run: () => Promise<void> }) {
  const note = h("p", { role: "alert", id: "load-error" }, text);
  const extra = h("p", { id: "load-error-actions" });
  if (button) {
    const b = h("button", { type: "button", id: button.id }, button.label);
    b.addEventListener("click", async () => { try { await button.run(); location.reload(); } catch (e) { note.textContent = (e as Error).message; } });
    extra.append(b);
  }
  app.replaceChildren(note, extra);
}

const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function editBackend(be: BackendClient) {
  // The lock comes first: only one person edits a draft, and the draft the server holds is where this page starts.
  let lock;
  try { lock = await be.lockDraft(); }
  catch (e) {
    if (e instanceof DraftLockedError) {
      return showProblem(`${e.lockedBy} is editing a draft of this application, and holds it until ${when(e.expiresAt)} unless they stop. You can edit when they publish or discard it.`,
        { label: "Take over the draft (discards their edits)", id: "take-over", run: () => be.discardDraft() });
    }
    if (e instanceof DraftOutOfDateError) {
      return showProblem(`${e.message} Discard the saved draft to start again from the current version.`, { label: "Discard the saved draft", id: "discard-stale", run: () => be.discardDraft() });
    }
    return showProblem((e as Error).message);
  }
  let def;
  try { def = await be.loadDefinition(); } catch (e) { return showProblem((e as Error).message); }
  if (def.version !== lock.baseVersion) {  // someone published between the two calls
    return showProblem(`The application is now at version ${def.version}, and your saved draft started from version ${lock.baseVersion}.`, { label: "Discard the saved draft", id: "discard-stale", run: () => be.discardDraft() });
  }
  // A log that does not replay is not worth opening: say so, and offer to start again.
  try { History.rebuild(def, lock.log); }
  catch (e) {
    return showProblem(`Your saved draft cannot be replayed on this version (${(e as Error).message}).`, { label: "Discard the saved draft", id: "discard-broken", run: () => be.discardDraft() });
  }

  const autosaveMs = Number(q.get("autosave") ?? 1500), heartbeatMs = Number(q.get("heartbeat") ?? 5 * 60 * 1000);
  let ed!: Editor;
  const saver = new DraftSaver(be, () => ed.history.log, lock.log, { delayMs: autosaveMs, heartbeatMs, onState: (_s, m) => ed?.setDraftState(m) });
  ed = new Editor(app, def, await be.lookups(def.forms), {
    changed: () => saver.schedule(),
    async saveDraft() { await saver.saveNow(); if (saver.state !== "saved") throw new Error(saver.message); return `Draft saved with ${ed.history.log.length} edit${ed.history.log.length === 1 ? "" : "s"}.`; },
    async publish({ log, definition }) {
      await saver.pause();  // a publish ends the draft, so no save may arrive after it
      let message: string;
      try { message = await be.publish(log, definition); } catch (e) { saver.unpause(); throw e; }
      try {
        const fresh = await be.lockDraft();  // the next draft starts from the version that is now live
        ed.rebase(await be.loadDefinition(), message);
        saver.resume(fresh.log);
      } catch (e) {
        saver.stop();  // the version is live, but this page cannot carry on from it
        return `${message} The page could not start the next draft (${(e as Error).message}). Reload the editor to continue.`;
      }
      return message;
    },
    async discard() {
      if (!window.confirm("Discard your draft? Your unpublished edits will be lost.")) return "Kept your draft.";
      await saver.pause();
      try {
        await be.discardDraft();
        const fresh = await be.lockDraft();
        ed.rebase(await be.loadDefinition(), "Discarded your draft.");
        saver.resume(fresh.log);
        return "Discarded your draft.";
      } catch (e) { saver.unpause(); throw e; }
    },
  }, editForm);
  if (lock.log.length) ed.resume(lock.log);
  ed.setDraftState(saver.message || "Draft saved.");
  window.addEventListener("beforeunload", (e) => { if (saver.dirty) e.preventDefault(); });
  (window as unknown as { __spike5: unknown }).__spike5 = { editor: ed, saver };
}

async function run() {
  if (backend) return runBackend(backend);
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
  if (backend) return editBackend(backend);
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
      const n = (r.body.warnings as unknown[] | undefined)?.length ?? 0;
      return `Published as version ${r.body.version}.${n ? ` ${n} rule warning${n === 1 ? "" : "s"} remain, so some optional fields cannot be left empty.` : ""}`;
    },
  }, editForm);
  (window as unknown as { __spike5: unknown }).__spike5 = { editor: ed };
}

if (mode === "edit") void edit(); else void run();
