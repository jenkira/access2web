// Permission levels, as in the Phase 1 authorisation code. Design edits a draft. Only Manage publishes.
export type Level = "open_application" | "view_data" | "edit_data" | "design_application" | "manage_application";

const IMPLIES: Record<string, Level[]> = {
  manage_application: ["design_application", "open_application"],
  design_application: ["open_application"],
  edit_data: ["view_data", "open_application"],
  view_data: ["open_application"],
};

export function covers(held: Level, needed: Level): boolean {
  return held === needed || (IMPLIES[held] ?? []).includes(needed);
}

export type Grants = Record<string, Level[]>;

/** Deny by default: a user with no grant can do nothing. */
export function can(grants: Grants, user: string | undefined, needed: Level): boolean {
  if (!user) return false;
  return (grants[user] ?? []).some((h) => covers(h, needed));
}
