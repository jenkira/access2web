// Draft handler interface for the Access2Web runtime (Spike 3). Revised from the technical design.
// A handler is a script that defines `function handler()`. It has no imports, no network, no file system,
// no clock, and no randomness beyond these four globals.
interface Row { [column: string]: unknown }
type Param = string | number | boolean | null;

interface Ctx {
  readonly user: { readonly id: string; readonly roles: readonly string[] };
  readonly event: string;
  /** The time of the event, as an ISO string. Date.now() and new Date() return this value. */
  readonly now: string;
  readonly record: { readonly old?: Row; readonly new?: Row };
}

declare const ctx: Ctx;

declare const db: {
  /**
   * Runs one select, insert, update, or delete in the application's schema, inside the request's transaction.
   * The SQL must be a literal. Values go in `params` ($1, $2, ...). Use `returning` to get rows back from a write.
   */
  query(sql: string, params?: ReadonlyArray<Param>): Row[];
};

declare const ui: {
  message(text: string): void;
  setVisible(control: string, visible: boolean): void;
  setValue(field: string, value: Param): void;
  /** Cancels the event and rolls back every change the handler made. */
  cancel(reason: string): void;
};
