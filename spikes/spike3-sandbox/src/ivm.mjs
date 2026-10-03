// Comparison host: the same handler contract on V8 isolates (isolated-vm). Used only to compare with QuickJS.
import ivm from "isolated-vm";
import { DEFAULT_LIMITS, PRELUDE } from "./sandbox.mjs";
import { checkSql } from "./sqlguard.mjs";
import { applyUi } from "./ui.mjs";

const REJECTED = /quotes, semicolons|only select, insert|cannot call|params must|statement is too long|needs a string|result is too large/;

export async function runIvm({ js, input, client = null, limits = {}, unsafeNoSqlGuard = false }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const t0 = performance.now();
  const stats = { queries: 0, dbMs: 0 };
  const ui = [];
  const out = { status: "ok", value: null, ui, error: null, stats };
  const isolate = new ivm.Isolate({ memoryLimit: Math.max(8, Math.floor(L.memoryBytes / 1048576)) });
  const timer = setTimeout(() => { try { isolate.dispose(); } catch { /* already gone */ } }, L.timeMs + 500);
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set("__input", JSON.stringify(input));
    await jail.set("__ui", new ivm.Callback((op, a, b) => applyUi(ui, L, op, a, b)));
    await jail.set("__dbref", new ivm.Reference(async (sql, paramsJson) => {
      if (!client) throw new Error("this handler has no database access");
      if (++stats.queries > L.maxQueries) throw new Error(`more than ${L.maxQueries} queries in one run`);
      const params = JSON.parse(paramsJson);
      if (!unsafeNoSqlGuard) checkSql(sql, params);
      const s = performance.now();
      try {
        const r = await client.query({ text: sql, values: params });
        const text = JSON.stringify(r.rows ?? []);
        if (text.length > L.maxResultBytes) throw new Error("query result is too large");
        return text;
      } finally { stats.dbMs += performance.now() - s; }
    }));
    await context.eval(`(() => { const ref = __dbref; delete globalThis.__dbref; globalThis.__dbq = (s, p) => ref.applySyncPromise(undefined, [s, p]); })();`);
    await context.eval(PRELUDE);
    const script = await isolate.compileScript(`${js}\n;JSON.stringify((() => { const r = handler(); return r === undefined ? null : r; })())`);
    const text = await script.run(context, { timeout: L.timeMs });
    if (typeof text !== "string") throw new Error("handler result is not serialisable");
    if (text.length > L.maxResultBytes) throw Object.assign(new Error("handler result is too large"), { name: "ResultRejected" });
    out.value = JSON.parse(text);
  } catch (e) {
    const message = String(e?.message ?? e).slice(0, 300);
    out.error = { name: String(e?.name ?? "Error"), message };
    if (/timed out/i.test(message)) out.status = "time_limit";
    else if (/memory limit/i.test(message)) out.status = "memory_limit";
    else if (/call stack/i.test(message)) out.status = "stack_limit";
    else if (/disposed/i.test(message)) out.status = "time_limit";
    else if (REJECTED.test(message)) out.status = "rejected";
    else out.status = "error";
  } finally {
    clearTimeout(timer);
    try { isolate.dispose(); } catch { /* already disposed after a limit */ }
  }
  out.ms = performance.now() - t0;
  out.vmMs = out.ms - stats.dbMs;
  return out;
}
