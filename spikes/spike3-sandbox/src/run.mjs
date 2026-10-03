// Runs a handler inside a database transaction. A handler that fails, hits a limit, or cancels leaves no change.
import { pool as dbPool } from "./db.mjs";
import { runQuickJS } from "./sandbox.mjs";
import { checkHandler, transpile } from "./check.mjs";

export function baseInput(extra = {}) {
  return { user: { id: "u1", roles: ["staff"] }, event: "test", now: "2026-03-01T09:00:00.000Z", record: {}, ...extra };
}

/**
 * @param app      "app_a" or "app_b": which application's login role the handler connects as
 * @param source   handler source in TypeScript
 * @param commit   commit on success. Use false in measurements, to keep the data stable.
 * @param useCheck run the static check first. The hostile suite also runs with false.
 */
export async function runHandlerTx({ modulePool, runner, app = "app_a", source, input = baseInput(), commit = false, limits, useCheck = true, noDb = false, unsafeNoSqlGuard = false }) {
  if (useCheck) {
    const problems = checkHandler(source);
    if (problems.length) return { status: "rejected_by_check", error: { name: "CheckFailed", message: problems.join("; ") }, ui: [], ms: 0, vmMs: 0, stats: { queries: 0, dbMs: 0 } };
  }
  const js = transpile(source);
  const exec = runner ?? ((o) => runQuickJS({ pool: modulePool, ...o }));
  if (noDb) return exec({ js, input, client: null, limits, unsafeNoSqlGuard });
  const client = await dbPool(app).connect();
  try {
    await client.query("BEGIN");
    const r = await exec({ js, input, client, limits, unsafeNoSqlGuard });
    const cancelled = r.ui.some((u) => u.op === "cancel");
    if (r.status === "ok" && !cancelled && commit) { await client.query("COMMIT"); r.committed = true; }
    else { await client.query("ROLLBACK"); r.committed = false; }
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
