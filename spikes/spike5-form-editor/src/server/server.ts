// Draft workflow for Spike 5: lock a draft, edit it as operations, publish it as a new immutable version,
// and tell an open form from an earlier version that it is out of date.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { History } from "../model/history.ts";
import type { Op } from "../model/ops.ts";
import { OpError, validateDefinition } from "../model/validate.ts";
import { canonical, type Definition } from "../model/types.ts";
import { failedRules, unknownFields, type Rec } from "../ui/render.ts";
import { can, type Grants } from "./permissions.ts";

interface Draft { baseVersion: number; lockedBy: string; log: Op[] }
export interface AuditEvent { seq: number; actor: string; action: string; detail: Record<string, unknown> }

export interface Spike5Server {
  http: http.Server;
  state: { versions: Definition[]; draft: Draft | null; audit: AuditEvent[]; grants: Grants };
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createServer(opts: { base: Definition; grants: Grants; staticDir?: string }): Spike5Server {
  const state = { versions: [structuredClone(opts.base)], draft: null as Draft | null, audit: [] as AuditEvent[], grants: opts.grants };
  const current = () => state.versions[state.versions.length - 1]!;
  const log = (actor: string, action: string, detail: Record<string, unknown> = {}) => state.audit.push({ seq: state.audit.length + 1, actor, action, detail });

  const send = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve, reject) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("bad json")); } });
  });
  const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const user = (req.headers["x-user"] as string | undefined)?.trim() || undefined;
    try {
      if (url.pathname.startsWith("/api/")) {
        const body = req.method === "POST" ? await readBody(req) : {};
        return await route(req.method ?? "GET", url.pathname, user, body, res);
      }
      if (opts.staticDir) {
        let rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
        if (rel === "/" || rel === "") rel = "/public/index.html";
        const file = join(opts.staticDir, rel);
        const allowed = rel.startsWith("/public/") || rel.startsWith("/dist/");  // nothing else is served
        if (allowed && file.startsWith(opts.staticDir) && existsSync(file)) { res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); return res.end(readFileSync(file)); }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });

  async function route(method: string, path: string, user: string | undefined, body: any, res: http.ServerResponse) {
    const deny = () => send(res, 403, { error: "You do not have permission to do this." });
    if (method === "GET" && path === "/api/definition") return send(res, 200, { version: current().version, definition: current() });
    if (method === "POST" && path === "/api/records") {
      if (!can(state.grants, user, "edit_data")) return deny();
      // The runtime checks every request against the current version. A form from an earlier version must reload.
      if (body.version !== current().version) return send(res, 409, { error: "version_changed", current: current().version });
      const form = current().forms.find((f) => f.name === body.form);
      if (!form) return send(res, 404, { error: "unknown form" });
      const unknown = unknownFields(form, body.record ?? {});
      if (unknown.length) return send(res, 422, { error: "unknown fields", fields: unknown });
      const errors = failedRules(current(), form, body.record as Rec);
      if (errors.length) return send(res, 422, { error: "validation", errors });
      log(user!, "record_saved", { form: form.name });
      return send(res, 200, { saved: true, version: current().version });
    }
    if (method === "GET" && path === "/api/audit") { if (!can(state.grants, user, "manage_application")) return deny(); return send(res, 200, state.audit); }
    if (!path.startsWith("/api/draft")) return send(res, 404, { error: "not found" });

    // Everything under /api/draft needs the Design level.
    if (!can(state.grants, user, "design_application")) return deny();
    if (method === "POST" && path === "/api/draft/lock") {
      if (state.draft && state.draft.lockedBy !== user) return send(res, 409, { error: "draft_locked", lockedBy: state.draft.lockedBy });
      state.draft ??= { baseVersion: current().version, lockedBy: user!, log: [] };
      log(user!, "draft_locked", { baseVersion: state.draft.baseVersion });
      return send(res, 200, { baseVersion: state.draft.baseVersion, log: state.draft.log });
    }
    if (!state.draft) return send(res, 409, { error: "no_draft" });
    if (state.draft.lockedBy !== user) return send(res, 409, { error: "draft_locked", lockedBy: state.draft.lockedBy });
    const base = state.versions[state.draft.baseVersion - 1]!;
    if (method === "POST" && path === "/api/draft/ops") {
      try { History.rebuild(base, body.log as Op[]); } catch (e) { if (e instanceof OpError) return send(res, 422, { error: "invalid_ops", message: e.message }); throw e; }
      state.draft.log = body.log;
      return send(res, 200, { saved: body.log.length });
    }
    if (method === "POST" && path === "/api/draft/unlock") { state.draft = null; log(user!, "draft_discarded"); return send(res, 200, { unlocked: true }); }
    if (method === "POST" && path === "/api/draft/publish") {
      if (!can(state.grants, user, "manage_application")) return deny();  // Design can edit but not publish
      if (state.draft.baseVersion !== current().version) return send(res, 409, { error: "draft_out_of_date", base: state.draft.baseVersion, current: current().version });
      let next: Definition;
      try { next = History.rebuild(base, state.draft.log); } catch (e) { if (e instanceof OpError) return send(res, 422, { error: "invalid_ops", message: e.message }); throw e; }
      const problems = validateDefinition(next);
      if (problems.length) return send(res, 422, { error: "invalid_definition", problems });
      next.version = current().version + 1;
      const diff = { ops: state.draft.log.length, from: current().version, to: next.version, changed: canonical(next) !== canonical(base) };
      state.versions.push(next);
      state.draft = null;
      log(user!, "publish", diff);
      return send(res, 200, { version: next.version });
    }
    return send(res, 404, { error: "not found" });
  }

  return {
    http: server, state,
    listen: (port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
