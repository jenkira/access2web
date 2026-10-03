import * as api from "./api.js";
import { ApiError, type EntityInfo, type Row } from "./api.js";
import { el, errorBox, show } from "./dom.js";

const root = document.getElementById("app")!;

function message(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return "You do not have permission to use this. Contact the application owner.";
  if (e instanceof ApiError && e.status === 401) return "Sign in through the systems portal to continue.";
  return e instanceof Error ? e.message : "Something went wrong.";
}

async function home(): Promise<void> {
  const list = await api.tiles();
  if (list.length === 0) {
    show(root, el("h1", {}, "Applications"), el("p", {}, "You have no applications. If you expect one, contact its owner."));
    return;
  }
  const grid = el("div", { class: "tiles" });
  for (const t of list) {
    grid.append(el("a", { class: "tile", href: `#/apps/${encodeURIComponent(t.slug)}` },
      el("strong", {}, t.name), el("p", {}, t.description || "No description.")));
  }
  show(root, el("h1", {}, "Applications"), grid);
}

async function appPage(slug: string): Promise<void> {
  const info = await api.appInfo(slug);
  const links = el("ul");
  for (const e of info.entities) {
    links.append(el("li", {}, el("a", { href: `#/apps/${encodeURIComponent(slug)}/${encodeURIComponent(e.name)}` }, e.source_name)));
  }
  show(root, el("h1", {}, info.name), el("h2", {}, "Tables"), links);
}

function cell(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

async function tablePage(slug: string, table: string): Promise<void> {
  const info = await api.appInfo(slug);
  const ent: EntityInfo | undefined = info.entities.find((e) => e.name === table);
  if (!ent) throw new ApiError(403, "");
  const data = await api.records(slug, table);
  const key = ent.primary_key.length === 1 ? ent.primary_key[0]! : null;

  const head = el("tr", {}, ...ent.fields.map((f) => el("th", { scope: "col" }, f.source_name)), el("th", { scope: "col" }, "Actions"));
  const body = el("tbody");
  for (const row of data.records) {
    const tr = el("tr", {}, ...ent.fields.map((f) => el("td", {}, cell(row[f.name]))));
    const actions = el("td");
    if (key) {
      const del = el("button", { type: "button" }, "Delete");
      del.addEventListener("click", async () => {
        if (!confirm("Delete this record?")) return;
        try { await api.deleteRecord(slug, table, cell(row[key])); await route(); } catch (e) { show(root, errorBox(message(e))); }
      });
      actions.append(del);
    }
    tr.append(actions);
    body.append(tr);
  }

  const form = el("form");
  for (const f of ent.fields.filter((x) => !x.identity)) {
    const id = `f_${f.name}`;
    const input = el("input", { id, name: f.name, ...(f.required ? { required: "" } : {}) });
    form.append(el("label", { for: id }, f.source_name + (f.required ? " (required)" : "")), input);
  }
  form.append(el("p", {}, el("button", { type: "submit" }, "Add record")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const values: Row = {};
    for (const [k, v] of new FormData(form).entries()) if (v !== "") values[k] = v;
    try { await api.createRecord(slug, table, values); await route(); } catch (e) { show(root, errorBox(message(e)), el("p", {}, el("a", { href: location.hash }, "Back"))); }
  });

  show(root,
    el("p", {}, el("a", { href: `#/apps/${encodeURIComponent(slug)}` }, "Back to tables")),
    el("h1", {}, ent.source_name),
    el("table", {}, el("thead", {}, head), body),
    el("h2", {}, "Add a record"), form);
}

async function route(): Promise<void> {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent).filter(Boolean);
  try {
    if (parts[0] === "apps" && parts[1] && parts[2]) await tablePage(parts[1], parts[2]);
    else if (parts[0] === "apps" && parts[1]) await appPage(parts[1]);
    else await home();
  } catch (e) {
    show(root, errorBox(message(e)));
  }
}

window.addEventListener("hashchange", () => void route());
void route();
