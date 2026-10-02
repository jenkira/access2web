// Talks to the Python backend for the form editor and for running a form. The backend decides every permission,
// and the browser only shows what it is told.
import type { Definition, Form } from "../model/types.ts";
import type { Op } from "../model/ops.ts";
import type { Lookups, Rec } from "../ui/render.ts";
import { ruleWarnings } from "../model/lint.ts";
import { allControls } from "../model/types.ts";
import { AdapterError, entityFromNative, fromNative, renamesOf, type NativeDefinition, type NativeEntity } from "./adapter.ts";

export interface Identity { user: string; groups?: string; roles?: string }
export type SaveResult = { saved: true; version: number } | { saved: false; versionChanged?: number; message: string };

export class BackendClient {
  private slug: string;
  private who: Identity | undefined;
  private base: string;
  private version = 0;

  constructor(slug: string, who?: Identity, base = "") { this.slug = slug; this.who = who; this.base = base; }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // Development sign-in. The backend ignores these headers unless it runs with A2W_DEV_AUTH=1.
    if (this.who) { headers["x-a2w-user"] = this.who.user; headers["x-a2w-groups"] = this.who.groups ?? ""; headers["x-a2w-roles"] = this.who.roles ?? ""; }
    const r = await fetch(`${this.base}/api/apps/${this.slug}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  }

  /** The whole definition, for the editor. Needs design application. */
  async loadDefinition(): Promise<Definition> {
    const r = await this.call("GET", "/definition");
    if (r.status === 403) throw new Error("You do not have permission to edit this application.");
    if (r.status !== 200) throw new Error(`The application could not be loaded (${r.status}).`);
    this.version = r.body.version;
    return fromNative(this.slug, r.body as NativeDefinition);
  }

  /** One form, for running it. The definition holds only that form and its entity. */
  async loadForm(name: string): Promise<Definition> {
    const r = await this.call("GET", `/forms/${encodeURIComponent(name)}`);
    if (r.status === 403) throw new Error("You do not have permission to use this form.");
    if (r.status !== 200) throw new Error(`The form could not be loaded (${r.status}).`);
    this.version = r.body.version;
    const entity = entityFromNative(r.body.entity as NativeEntity);
    return { app: this.slug, version: r.body.version, entities: [entity], forms: [r.body.form as Form], queries: [], handlers: [] };
  }

  get currentVersion(): number { return this.version; }

  /** Rows for the combo boxes and subforms of some forms. A table that the person cannot read gives no rows. */
  async lookups(forms: Form[]): Promise<Lookups> {
    const wanted = new Set<string>();
    for (const form of forms) {
      for (const c of allControls(form)) {
        if (c.type === "combo") wanted.add(c.source.entity);
        if (c.type === "subform") wanted.add(c.child.entity);
      }
    }
    const out: Lookups = {};
    for (const entity of wanted) {
      const r = await this.call("GET", `/tables/${encodeURIComponent(entity)}/records?limit=500`);
      out[entity] = r.status === 200 ? (r.body.records as Rec[]) : [];
    }
    return out;
  }

  async saveRecord(form: string, values: Rec): Promise<SaveResult> {
    const r = await this.call("POST", `/forms/${encodeURIComponent(form)}/records`, { version: this.version, values });
    if (r.status === 201) return { saved: true, version: this.version };
    if (r.status === 409 && r.body.error === "version_changed") return { saved: false, versionChanged: r.body.current, message: "" };
    if (r.status === 422 && r.body.error === "validation") {
      return { saved: false, message: (r.body.errors as { message: string }[]).map((e) => e.message).join(" ") };
    }
    if (r.status === 422 && r.body.error === "unknown_fields") return { saved: false, message: `The form does not have the fields ${(r.body.fields as string[]).join(", ")}.` };
    if (r.status === 403) return { saved: false, message: "You do not have permission to save this form." };
    return { saved: false, message: r.body.detail ?? r.body.error ?? `Not saved (${r.status}).` };
  }

  /**
   * Publish the draft as a new version. The forms go whole, and the renames go as operations,
   * so the backend carries them to the data. Resolves with a message, and rejects with one.
   */
  async publish(log: Op[], draft: Definition): Promise<string> {
    let renames;
    try { renames = renamesOf(log); } catch (e) { if (e instanceof AdapterError) throw new Error(e.message); throw e; }
    const r = await this.call("POST", "/versions", { base_version: this.version, renames, forms: draft.forms });
    if (r.status === 200) {
      this.version = r.body.version;
      const n = ruleWarnings(draft).length;
      return `Published as version ${r.body.version}.${n ? ` ${n} rule warning${n === 1 ? "" : "s"} remain, so some optional fields cannot be left empty.` : ""}`;
    }
    if (r.status === 403) throw new Error("You can edit this draft, but you do not have permission to publish it.");
    if (r.status === 409 && r.body.error === "version_changed") {
      throw new Error(`Not published. The application is now at version ${r.body.current}, and this draft started from version ${this.version}. Reload the editor to start again from the new version.`);
    }
    if (r.status === 409) throw new Error(`Not published: ${r.body.detail ?? "the application is in use. Try again in a moment."}`);
    throw new Error(`Not published: ${r.body.detail ?? r.body.error ?? r.status}`);
  }
}
