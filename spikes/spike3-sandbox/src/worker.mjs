// Worker thread: runs handlers in QuickJS. The main thread can terminate this thread if a run ignores its limits.
import { parentPort } from "node:worker_threads";
import { ModulePool, runQuickJS } from "./sandbox.mjs";

const pool = new ModulePool(1);
const pending = new Map();
let seq = 0;

// Database calls go to the main thread, which owns the connection and the transaction.
const client = {
  query: ({ text, values }) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "db", id, text, values });
  }),
};

parentPort.on("message", async (m) => {
  if (m.type === "dbres") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
    else p.resolve({ rows: m.rows });
  } else if (m.type === "run") {
    const result = await runQuickJS({ pool, js: m.js, input: m.input, client: m.hasDb ? client : null, limits: m.limits, unsafeNoSqlGuard: m.unsafe });
    parentPort.postMessage({ type: "done", result });
  }
});
parentPort.postMessage({ type: "ready" });
