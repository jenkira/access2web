// Hostile handler suite. Each case tries to break out of the sandbox or to harm the host.
// `escaped(r, env)` returns a reason string if anything happened OUTSIDE the sandbox, else null.
// Crashing the handler, or having the host refuse it, counts as contained.

const SECRET = "TOP SECRET OF APP B";
const CANARY_FILE_TEXT = "CANARY-FILE-CONTENT";
const NOW = "2026-03-01T09:00:00.000Z";

const leaks = (r, ...needles) => {
  const text = JSON.stringify([r.value, r.ui, r.error]);
  return needles.find((n) => text.includes(n)) ? `result contains ${needles.find((n) => text.includes(n))}` : null;
};

export const SUITE = [
  // ---- network, process, file system, modules
  { id: "H01", cat: "network", title: "fetch to a local listener", src: `function handler() { return fetch("http://127.0.0.1:" + ctx.record.port).then(r => r.text()); }`,
    escaped: (r, env) => (env.canaryHits() > 0 ? "a connection reached the listener" : null) },
  { id: "H02", cat: "network", title: "XMLHttpRequest to a local listener", src: `function handler() { const x = new XMLHttpRequest(); x.open("GET", "http://127.0.0.1:" + ctx.record.port); x.send(); return 1; }`,
    escaped: (r, env) => (env.canaryHits() > 0 ? "a connection reached the listener" : null) },
  { id: "H03", cat: "network", title: "WebSocket", src: `function handler() { return new WebSocket("ws://127.0.0.1:" + ctx.record.port); }`,
    escaped: (r, env) => (env.canaryHits() > 0 ? "a connection reached the listener" : null) },
  { id: "H04", cat: "module", title: "dynamic import of node:fs", src: `function handler() { return import("node:fs").then(m => m.readFileSync("${"{CANARY}"}", "utf8")); }`,
    escaped: (r) => leaks(r, CANARY_FILE_TEXT) },
  { id: "H05", cat: "module", title: "require('fs')", src: `function handler() { return require("fs").readFileSync("{CANARY}", "utf8"); }`,
    escaped: (r) => leaks(r, CANARY_FILE_TEXT) },
  { id: "H06", cat: "process", title: "process, env, and exit", src: `function handler() { return [typeof process, typeof process !== "undefined" ? process.env : null]; }`,
    escaped: (r) => (r.value && r.value[0] !== "undefined" ? "process is visible" : null) },
  { id: "H07", cat: "module", title: "QuickJS std and os modules", src: `function handler() { return [typeof std, typeof os, typeof scriptArgs, typeof print]; }`,
    escaped: (r) => (r.value && r.value.some((t) => t !== "undefined") ? `visible globals: ${r.value}` : null) },
  { id: "H08", cat: "module", title: "WebAssembly object", src: `function handler() { return typeof WebAssembly; }`,
    escaped: (r) => (r.value === "undefined" || r.status !== "ok" ? null : "WebAssembly is available") },
  { id: "H09", cat: "file", title: "read a file through std.loadFile", src: `function handler() { return std.loadFile("{CANARY}"); }`,
    escaped: (r) => leaks(r, CANARY_FILE_TEXT) },
  { id: "H10", cat: "process", title: "reach the real global through the Function constructor", src: `function handler() { return [typeof (function(){}).constructor("return typeof process")(), (function(){}).constructor("return typeof require")(), (0, eval)("typeof process")]; }`,
    escaped: (r) => (r.value && (r.value[1] !== "undefined" || r.value[2] !== "undefined") ? `reachable: ${r.value}` : null) },
  { id: "H11", cat: "process", title: "read host objects through error stack and prototypes", src: `function handler() { try { null.x; } catch (e) { return [String(e.stack).slice(0, 200), Object.getOwnPropertyNames(globalThis).filter(n => /host|node|process|require|__/.test(n))]; } }`,
    escaped: (r) => (r.value && r.value[1].length ? `host-looking globals: ${r.value[1]}` : null) },

  // ---- resources
  { id: "H12", cat: "resource", title: "infinite loop", src: `function handler() { while (true) {} }`,
    escaped: (r, env) => (r.status === "time_limit" && r.ms < env.limits.timeMs + 400 ? null : `status ${r.status} after ${Math.round(r.ms)} ms`) },
  { id: "H13", cat: "resource", title: "infinite loop that allocates", src: `function handler() { const a = []; for (;;) a.push({ x: a.length, s: "y".repeat(100) }); }`,
    escaped: (r, env) => (["time_limit", "memory_limit"].includes(r.status) && r.ms < env.limits.timeMs + 400 ? null : `status ${r.status} after ${Math.round(r.ms)} ms`) },
  { id: "H14", cat: "resource", title: "memory bomb: huge array", src: `function handler() { return new Array(2e9).fill(0).length; }`,
    escaped: (r) => (["memory_limit", "error", "time_limit"].includes(r.status) ? null : `status ${r.status}`) },
  { id: "H15", cat: "resource", title: "memory bomb: doubling string", src: `function handler() { let s = "x"; for (;;) s += s; }`,
    escaped: (r) => (["memory_limit", "error", "time_limit"].includes(r.status) ? null : `status ${r.status}`) },
  { id: "H16", cat: "resource", title: "stack overflow", src: `function handler() { const f = (n) => f(n + 1) + 1; return f(0); }`,
    escaped: (r) => (["stack_limit", "error"].includes(r.status) ? null : `status ${r.status}`) },
  { id: "H17", cat: "resource", title: "catastrophic regular expression", src: `function handler() { return /^(a+)+$/.test("a".repeat(45) + "b"); }`,
    note: "QuickJS regular expressions ignore the interrupt handler, so only terminating the worker thread stops this.",
    escaped: (r, env) => (["time_limit", "watchdog"].includes(r.status) && r.ms < env.limits.timeMs + 1000 ? null : `status ${r.status} after ${Math.round(r.ms)} ms`) },
  { id: "H18", cat: "resource", title: "a million database calls", db: true, src: `function handler() { let n = 0; for (let i = 0; i < 1e6; i++) { db.query("select 1 as x", []); n++; } return n; }`,
    escaped: (r, env) => (r.stats.queries <= env.limits.maxQueries + 1 && r.status !== "ok" ? null : `ran ${r.stats.queries} queries, status ${r.status}`) },

  // ---- database
  { id: "H20", cat: "database", title: "read another application's schema", db: true, src: `function handler() { return db.query("select value from app_b.secrets", []); }`,
    escaped: (r) => leaks(r, SECRET) },
  { id: "H21", cat: "database", title: "change search_path", db: true, src: `function handler() { db.query("set search_path = app_b", []); return db.query("select value from secrets", []); }`,
    escaped: (r) => leaks(r, SECRET) },
  { id: "H22", cat: "database", title: "switch role with set_config", db: true, src: `function handler() { db.query("select set_config($1, $2, true)", ["role", "app_b_login"]); return db.query("select value from app_b.secrets", []); }`,
    escaped: (r) => leaks(r, SECRET) },
  { id: "H23", cat: "database", title: "SQL built from a string (injection)", db: true, record: { name: "x' or '1'='1" },
    src: `function handler() { return db.query("select name from customers where name = '" + ctx.record.name + "'", []); }`,
    escapedNote: "Reads rows the handler could read anyway, so it is not a breakout. Mode C shows that the guard is what stops string-built SQL.",
    escaped: (r, env) => (r.status === "ok" && Array.isArray(r.value) && r.value.length > 0 && env.mode !== "C" ? "injected SQL ran" : null) },
  { id: "H24", cat: "database", title: "second statement after a semicolon", db: true, src: `function handler() { return db.query("select 1 as a; delete from victim", []); }`,
    note: "Mode C: the delete only touches the handler's own schema, which db.query may already change, so it is guard-dependent, not a breakout.",
    escaped: (r, env) => (env.mode === "C" ? null : env.victimDamaged()) },
  { id: "H25", cat: "database", title: "comment to cut off a condition", db: true, src: `function handler() { return db.query("select id from customers where id = $1 -- and credit_limit > 0", [1]); }`,
    escaped: (r, env) => (env.mode !== "C" && r.status === "ok" ? "comment accepted" : null) },
  { id: "H26", cat: "database", title: "drop a table", db: true, src: `function handler() { return db.query("drop table victim", []); }`,
    escaped: (r, env) => env.victimDamaged() },
  { id: "H27", cat: "database", title: "hold a connection with pg_sleep", db: true, src: `function handler() { return db.query("select pg_sleep(5)", []); }`,
    escaped: (r) => (r.ms < 2000 ? null : `ran for ${Math.round(r.ms)} ms`) },
  { id: "H28", cat: "database", title: "read a server file", db: true, src: `function handler() { return db.query("select pg_read_file($1)", ["/etc/passwd"]); }`,
    escaped: (r) => leaks(r, "root:") },
  { id: "H29", cat: "database", title: "copy to a program", db: true, src: `function handler() { return db.query("copy (select 1) to program 'touch /var/tmp/spike3-pwned'", []); }`,
    escaped: (r, env) => (env.pwned() ? "a command ran on the server" : null) },
  { id: "H30", cat: "database", title: "expensive query", db: true, src: `function handler() { return db.query("select count(*) from generate_series(1, 2000000000)", []); }`,
    escaped: (r) => (r.ms < 2000 ? null : `ran for ${Math.round(r.ms)} ms`) },
  { id: "H31", cat: "database", title: "very large write", db: true, src: `function handler() { return db.query("insert into victim select g from generate_series(1, 200000000) g returning id", []); }`,
    escaped: (r, env) => (env.victimCount() === env.victimRows ? null : "rows were added") },
  { id: "H32", cat: "database", title: "change the user identity setting used for row-level rules", db: true,
    src: `function handler() { return db.query("select set_config($1, $2, true)", ["a2w.user", "admin"]); }`,
    escapedNote: "Mode C shows the database alone does not stop this. The SQL guard is load-bearing for any row-level rule that reads a setting.",
    escaped: (r, env) => (env.mode === "C" ? null : r.status === "ok" ? "identity setting changed" : null) },

  // ---- clock, randomness, state
  { id: "H40", cat: "determinism", title: "read the real clock", src: `function handler() { return [Date.now(), new Date().toISOString(), Date(), new (Object.getPrototypeOf(new Date()).constructor)().toISOString(), Reflect.construct(Date, []).toISOString()]; }`,
    escaped: (r) => {
      if (r.status !== "ok") return null;
      const frozen = (v) => String(v).includes("2026-03-01") || String(v).includes("Mar 01 2026 09:00:00") || v === Date.parse("2026-03-01T09:00:00.000Z");
      const bad = r.value.filter((v) => !frozen(v));
      return bad.length ? `real time visible: ${bad}` : null;
    } },
  { id: "H45", cat: "determinism", title: "read the real date through Intl", src: `function handler() { return new Intl.DateTimeFormat("en-US", { dateStyle: "short" }).format(); }`,
    escaped: (r) => (r.status === "ok" && !String(r.value).includes("3/1/26") ? `real date visible: ${r.value}` : null) },
  { id: "H41", cat: "determinism", title: "read random numbers", src: `function handler() { return [Math.random(), typeof crypto, typeof crypto !== "undefined" ? crypto.getRandomValues(new Uint8Array(4)) : null]; }`,
    escaped: (r) => (r.status === "ok" ? "random values readable" : null) },
  { id: "H42", cat: "state", title: "leave state for the next run", src: `function handler() { globalThis.leaked = 1; Object.prototype.polluted = 1; Array.prototype.polluted = 1; return 1; }`,
    escaped: (r, env) => env.followUp(`function handler() { return [typeof leaked, typeof ({}).polluted, typeof [].polluted]; }`, (v) => (v.every((t) => t === "undefined") ? null : `state carried over: ${v}`)) },
  { id: "H43", cat: "state", title: "change ctx", src: `function handler() { try { ctx.user.id = "root"; ctx.record.x = 1; } catch (e) {} return [ctx.user.id, ctx.record.x]; }`,
    escaped: (r) => (r.value && (r.value[0] !== "u1" || r.value[1] !== null) ? `ctx changed: ${JSON.stringify(r.value)}` : null) },
  { id: "H44", cat: "state", title: "replace db and ui", src: `function handler() { try { db = { query: () => [{ forged: 1 }] }; ui = null; } catch (e) {} return typeof db.query === "function" && db.query === undefined ? 0 : [typeof ui, typeof db]; }`,
    escaped: (r) => (r.value && (r.value[0] !== "object" || r.value[1] !== "object") ? `globals replaced: ${r.value}` : null) },

  // ---- result and instruction format
  { id: "H50", cat: "format", title: "return a 10 MB string", src: `function handler() { return "x".repeat(10 * 1024 * 1024); }`,
    escaped: (r) => (r.status === "ok" ? "oversized result accepted" : null) },
  { id: "H51", cat: "format", title: "return a circular object", src: `function handler() { const a = {}; a.self = a; return a; }`,
    escaped: (r) => (r.status === "ok" ? "circular result accepted" : null) },
  { id: "H52", cat: "format", title: "return a function, a symbol, and a bigint", src: `function handler() { return [() => 1, Symbol("s"), 10n]; }`,
    escaped: (r) => (r.status === "ok" && JSON.stringify(r.value).includes("function") ? "function leaked into result" : null) },
  { id: "H53", cat: "format", title: "return an object with a __proto__ key", src: `function handler() { return JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'); }`,
    escaped: (r, env) => (env.hostPolluted() ? "host Object.prototype polluted" : null) },
  { id: "H54", cat: "format", title: "a 100 KB ui message", src: `function handler() { ui.message("x".repeat(100000)); }`,
    escaped: (r) => (r.status === "ok" ? "oversized message accepted" : null) },
  { id: "H55", cat: "format", title: "ui calls with bad control names and values", src: `function handler() { const out = []; for (const f of [() => ui.setVisible("a b", true), () => ui.setVisible("x", "yes"), () => ui.setValue("f", { a: 1 }), () => ui.setValue("../f", 1), () => ui.message(5)]) { try { f(); out.push("accepted"); } catch (e) { out.push("rejected"); } } return out; }`,
    escaped: (r) => (r.value && r.value.includes("accepted") ? `accepted: ${r.value}` : null) },
  { id: "H56", cat: "format", title: "a thousand ui instructions", src: `function handler() { for (let i = 0; i < 1000; i++) ui.message("m" + i); }`,
    escaped: (r) => (r.ui.length > 100 ? `${r.ui.length} instructions accepted` : null) },
  { id: "H57", cat: "format", title: "ui message that holds HTML", src: `function handler() { ui.message("<img src=x onerror=alert(1)>"); return 1; }`,
    note: "The host passes this through as plain text. The browser client must render messages as text, never as HTML.",
    escaped: (r) => (r.ui.length && r.ui[0].text.startsWith("<img") ? null : null) },
];

export const CONSTANTS = { SECRET, CANARY_FILE_TEXT, NOW };
