// Comparison run: the non-database hostile cases on V8 isolates, one child process for each case.
// A child that aborts counts as NOT contained, because a handler must never take down the host.
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import { SUITE } from "../hostile/suite.mjs";
import { DEFAULT_LIMITS } from "./sandbox.mjs";
import { baseInput } from "./run.mjs";

const CANARY = "/var/tmp/spike3-canary.txt";
fs.writeFileSync(CANARY, "CANARY-FILE-CONTENT");
let hits = 0;
const server = net.createServer((s) => { hits++; s.destroy(); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

function child(payload) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL("./ivm-child.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => {});
    const timer = setTimeout(() => p.kill("SIGKILL"), 10000);
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      const m = out.split("@@RESULT@@")[1];
      if (m && code === 0) resolve({ crashed: false, result: JSON.parse(m) });
      else resolve({ crashed: true, code, signal });
    });
    p.stdin.end(JSON.stringify(payload));
  });
}

const rows = [];
for (const t of SUITE.filter((x) => !x.db)) {
  for (const [mode, useCheck] of [["A", true], ["B", false]]) {
    hits = 0;
    const src = t.src.replaceAll("{CANARY}", CANARY);
    const input = baseInput({ record: { port, ...(t.record ?? {}) } });
    const t0 = performance.now();
    const c = await child({ source: src, useCheck, input });
    let why = null, status;
    if (c.crashed) { status = "host_crash"; why = `host process aborted (exit ${c.code}, signal ${c.signal})`; }
    else {
      const r = c.result; status = r.status;
      const env = {
        mode, limits: DEFAULT_LIMITS, canaryHits: () => hits, pwned: () => false, hostPolluted: () => r.hostPolluted,
        victimDamaged: () => null, victimCount: () => 0, victimRows: 0,
        followUp: async (source, check) => {
          const f = await child({ source, useCheck: false, input: baseInput() });
          return f.crashed ? "follow-up crashed" : f.result.status === "ok" ? check(f.result.value) : `follow-up failed: ${f.result.status}`;
        },
      };
      try { why = await t.escaped(r, env); } catch (e) { why = `check crashed: ${e.message}`; }
    }
    rows.push({ id: t.id, title: t.title, mode, status, ms: Math.round(performance.now() - t0), escaped: why });
    console.log(`${t.id} ${mode} ${status.padEnd(16)} ${why ? "NOT CONTAINED: " + why : "contained"}`);
  }
}
server.close();
fs.rmSync(CANARY, { force: true });
fs.mkdirSync(new URL("../work", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../work/hostile-ivm.json", import.meta.url), JSON.stringify(rows, null, 1));
for (const m of ["A", "B"]) { const r = rows.filter((x) => x.mode === m); console.log(`V8 mode ${m}: ${r.filter((x) => !x.escaped).length}/${r.length} contained`); }
process.exit(0);
