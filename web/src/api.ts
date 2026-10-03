export interface Tile { slug: string; name: string; description: string; icon: string; owner_id: string; launch: string }
export interface FieldDef { name: string; source_name: string; type: string; required: boolean; identity: boolean }
export interface EntityInfo { name: string; source_name: string; fields: FieldDef[]; primary_key: string[] }
export interface AppInfo { slug: string; name: string; tables: string[]; entities: EntityInfo[] }
export type Row = Record<string, unknown>;

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// The portal supplies the sign-in token. Until the portal is chosen (open item O1), the page
// sends no credentials of its own and relies on the portal's session cookie.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: { "content-type": "application/json" }, ...init });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, typeof body.detail === "string" ? body.detail : res.statusText);
  return body as T;
}

const enc = encodeURIComponent;
export const tiles = () => call<Tile[]>("/api/portal/tiles");
export const appInfo = (slug: string) => call<AppInfo>(`/api/apps/${enc(slug)}`);
export const records = (slug: string, table: string, offset = 0) =>
  call<{ records: Row[]; limit: number; offset: number }>(`/api/apps/${enc(slug)}/tables/${enc(table)}/records?offset=${offset}`);
export const createRecord = (slug: string, table: string, values: Row) =>
  call<Row>(`/api/apps/${enc(slug)}/tables/${enc(table)}/records`, { method: "POST", body: JSON.stringify(values) });
export const deleteRecord = (slug: string, table: string, key: string) =>
  call<void>(`/api/apps/${enc(slug)}/tables/${enc(table)}/records/${enc(key)}`, { method: "DELETE" });
