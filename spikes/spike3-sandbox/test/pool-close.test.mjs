// Closing the worker pool must end every worker, busy ones included, or the process cannot exit.
// A subprocess runs the check, because a process that hangs cannot report that it hung.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POOL = new URL("../src/workerpool.mjs", import.meta.url).href;

// A script that never exits is killed after 20 s, and spawnSync reports that in `error`.
function run(script) {
  const dir = mkdtempSync(join(tmpdir(), "pool-close-"));
  const file = join(dir, "check.mjs");
  writeFileSync(file, script);
  try { return spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 20000 }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the process exits after the pool is closed while a worker is busy", () => {
  // The regular expression ignores the interrupt handler, so the worker stays busy until the hard limit, far later.
  const r = run(`
    import { WorkerPool } from ${JSON.stringify(POOL)};
    const pool = new WorkerPool(2);
    const source = 'function handler() { return /^(a+)+$/.test("a".repeat(45) + "b"); }';
    pool.run({ js: source, input: {}, limits: { hardMs: 60000, timeMs: 60000 } });  // never awaited: it is busy when close() runs
    await new Promise((res) => setTimeout(res, 300));  // the worker is busy now
    await pool.close();
    console.log("closed");  // a worker thread that is still alive keeps the process from exiting after this line
  `);
  assert.equal(r.error, undefined, `the process did not exit in time: ${r.error?.message}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /closed/);
});

test("the process exits after the pool is closed, after a worker was killed and replaced", () => {
  const r = run(`
    import { WorkerPool } from ${JSON.stringify(POOL)};
    const pool = new WorkerPool(1);
    const source = 'function handler() { return /^(a+)+$/.test("a".repeat(45) + "b"); }';
    const fast = 'function handler() { return 1; }';
    // The first run is killed by the watchdog. The second waits for the only worker, so a replacement is spawned for it.
    const first = pool.run({ js: source, input: {}, limits: { timeMs: 100, hardMs: 300 } });
    const second = pool.run({ js: fast, input: {}, limits: {} });
    const [a, b] = await Promise.all([first, second]);
    await pool.close();
    console.log(a.status + " " + b.status);
  `);
  assert.equal(r.error, undefined, `the process did not exit in time: ${r.error?.message}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /watchdog ok/);
});
