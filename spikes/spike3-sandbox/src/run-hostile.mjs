// Runs the hostile suite in three modes and writes work/hostile.json.
//   A: static check, SQL guard, sandbox, database roles (as in production)
//   B: SQL guard, sandbox, database roles (the static check is skipped)
//   C: sandbox and database roles only (the guard is off too)
import net from "node:net";
import fs from "node:fs";
import pg from "pg";
import { setup, closePools, adminUrl } from "./db.mjs";
import { DEFAULT_LIMITS } from "./sandbox.mjs";
import { WorkerPool } from "./workerpool.mjs";
import { runIvm } from "./ivm.mjs";

const HOST = process.env.HOST ?? "quickjs";
import { runHandlerTx, baseInput } from "./run.mjs";
import { SUITE, CONSTANTS } from "../hostile/suite.mjs";

const CANARY = "/var/tmp/spike3-canary.txt";
const PWNED = "/var/tmp/spike3-pwned";
const MODES = { A: { useCheck: true, unsafeNoSqlGuard: false }, B: { useCheck: false, unsafeNoSqlGuard: false }, C: { useCheck: false, unsafeNoSqlGuard: true } };

const admin = async (sql) => { const c = new pg.Client({ connectionString: adminUrl() }); await c.connect(); try { return (await c.query(sql)).rows; } finally { await c.end(); } };

export async function runSuite({ log = true } = {}) {
  await setup();
  fs.writeFileSync(CANARY, CONSTANTS.CANARY_FILE_TEXT);
  let hits = 0;
  const server = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const pool = HOST === "ivm" ? { run: runIvm, close: async () => {} } : new WorkerPool(4);
  const rows = [];
  const VICTIM_ROWS = 3;

  for (const t of SUITE) {
    for (const [mode, opts] of Object.entries(MODES)) {
      await admin(`drop table if exists app_a.victim; create table app_a.victim (id int); insert into app_a.victim values (1),(2),(3); grant select, insert, update, delete on app_a.victim to app_a_login`);
      fs.rmSync(PWNED, { force: true });
      hits = 0;
      const hostPollutedBefore = Object.prototype.hasOwnProperty.call(Object.prototype, "polluted");
      const src = t.src.replaceAll("{CANARY}", CANARY);
      const input = baseInput({ record: { port, ...(t.record ?? {}) } });
      const rssBefore = process.memoryUsage().rss;
      const r = await runHandlerTx({ runner: (o) => pool.run(o), source: src, input, commit: true, noDb: !t.db, ...opts });
      const env = {
        mode,
        limits: DEFAULT_LIMITS,
        canaryHits: () => hits,
        pwned: () => fs.existsSync(PWNED),
        hostPolluted: () => (!hostPollutedBefore && Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")) || ({}).polluted !== undefined,
        victimCount: () => 0,
        victimRows: VICTIM_ROWS,
        victimDamaged: () => null,
        followUp: async (source, check) => {
          const f = await runHandlerTx({ runner: (o) => pool.run(o), source, input: baseInput(), noDb: true, useCheck: false });
          return f.status === "ok" ? check(f.value) : `follow-up run failed: ${f.status}`;
        },
      };
      // Victim table state is read after the run (admin connection, outside the sandbox).
      let count = null;
      try { count = Number((await admin("select count(*) as n from app_a.victim"))[0].n); } catch { count = "missing"; }
      env.victimCount = () => count;
      env.victimDamaged = () => (count === VICTIM_ROWS ? null : `victim table has ${count} rows`);
      let why = null;
      try { why = await t.escaped(r, env); } catch (e) { why = `check crashed: ${e.message}`; }
      const rssGrowthMb = Math.round((process.memoryUsage().rss - rssBefore) / 1048576);
      if (rssGrowthMb > 400) why ||= `host memory grew by ${rssGrowthMb} MB`;
      rows.push({ id: t.id, cat: t.cat, title: t.title, mode, status: r.status, error: r.error ? `${r.error.name}: ${r.error.message}`.slice(0, 140) : null, ms: Math.round(r.ms), escaped: why, note: t.note ?? t.escapedNote ?? null });
      if (log) console.log(`${t.id} ${mode} ${r.status.padEnd(16)} ${String(Math.round(r.ms)).padStart(5)} ms  ${why ? "ESCAPED: " + why : "contained"}`);
    }
  }
  await pool.close();
  server.close();
  fs.rmSync(CANARY, { force: true });
  await closePools();
  fs.mkdirSync(new URL("../work", import.meta.url), { recursive: true });
  fs.writeFileSync(new URL(`../work/hostile${HOST === "ivm" ? "-ivm" : ""}.json`, import.meta.url), JSON.stringify(rows, null, 1));
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await runSuite();
  // A case is guard-dependent when the SQL guard rejects it (mode B) but the database alone lets it run (mode C).
  for (const id of new Set(rows.map((x) => x.id))) {
    const b = rows.find((x) => x.id === id && x.mode === "B"), c = rows.find((x) => x.id === id && x.mode === "C");
    c.guardDependent = b.status === "rejected" && c.status === "ok";
  }
  fs.writeFileSync(new URL(`../work/hostile${HOST === "ivm" ? "-ivm" : ""}.json`, import.meta.url), JSON.stringify(rows, null, 1));
  console.log("guard-dependent cases:", rows.filter((x) => x.guardDependent).map((x) => x.id).join(", "));
  for (const m of Object.keys(MODES)) {
    const r = rows.filter((x) => x.mode === m);
    console.log(`mode ${m}: ${r.filter((x) => !x.escaped).length}/${r.length} contained`);
  }
  process.exit(0);
}
