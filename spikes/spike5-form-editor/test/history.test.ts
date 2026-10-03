// Property test: for many random edit sessions, the log alone rebuilds the draft exactly,
// and every draft along the way is valid.
import test from "node:test";
import assert from "node:assert/strict";
import { demoDefinition } from "../fixtures/demo.ts";
import { History } from "../src/model/history.ts";
import { OpError, validateDefinition } from "../src/model/validate.ts";
import { allControls, canonical, type Control, type Definition } from "../src/model/types.ts";
import type { Op } from "../src/model/ops.ts";

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function randomOp(def: Definition, r: () => number, counter: { n: number }): Op {
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const form = pick(def.forms);
  const ent = def.entities.find((e) => e.name === form.entity)!;
  const controls = allControls(form);
  const place = () => (r() < 0.3 || form.rows.length === 0 ? { newRowAt: Math.floor(r() * (form.rows.length + 1)), newRowId: `rn${counter.n++}` } : { row: Math.floor(r() * form.rows.length) });
  const exprs = ent.fields.map((f) => f.name).slice(0, 3);
  const e = () => `${pick(exprs)} ${pick([">", "<", "==", "!="])} ${Math.floor(r() * 10)}`;
  const kind = Math.floor(r() * 12);
  switch (kind) {
    case 0: case 1: {
      const f = pick(ent.fields);
      const c: Control = { id: `n${counter.n++}`, type: pick(["text", "number", "date", "checkbox", "textarea"] as const), bind: f.name, label: `L${counter.n}` };
      return { t: "addControl", form: form.name, place: place(), control: c };
    }
    case 2: return { t: "removeControl", form: form.name, id: controls.length ? pick(controls).id : "none" };
    case 3: case 4: return { t: "moveControl", form: form.name, id: controls.length ? pick(controls).id : "none", place: place(), index: r() < 0.5 ? 0 : undefined };
    case 5: return { t: "setLabel", form: form.name, id: controls.length ? pick(controls).id : "none", label: `Label ${counter.n++}` };
    case 6: return { t: "setVisible", form: form.name, id: controls.length ? pick(controls).id : "none", expr: r() < 0.2 ? null : e() };
    case 7: return { t: "setValidation", form: form.name, id: controls.length ? pick(controls).id : "none", rules: r() < 0.2 ? [] : [{ expr: e(), message: "m" }] };
    case 8: return { t: "setDefault", form: form.name, id: controls.length ? pick(controls).id : "none", expr: r() < 0.3 ? null : String(Math.floor(r() * 5)) };
    case 9: { const ee = pick(def.entities); return { t: "renameField", entity: ee.name, from: pick(ee.fields).name, to: `f${counter.n++}` }; }
    case 10: { const ee = pick(def.entities); return { t: "renameEntity", from: ee.name, to: `E${counter.n++}`, table: r() < 0.5 ? `t${counter.n}` : undefined }; }
    default: return { t: "setVisible", form: form.name, id: "ghost", expr: "x" };  // always rejected
  }
}

test("the log rebuilds the draft exactly, in every random session", () => {
  const SESSIONS = 400, STEPS = 40;
  let ops = 0, rejected = 0, undos = 0, checks = 0;
  for (let s = 0; s < SESSIONS; s++) {
    const r = rng(1000 + s);
    const h = new History(demoDefinition());
    const counter = { n: 0 };
    for (let i = 0; i < STEPS; i++) {
      const roll = r();
      if (roll < 0.15) { h.undo(); undos++; }
      else if (roll < 0.25) { h.redo(); undos++; }
      else {
        const op = randomOp(h.current, r, counter);
        try { h.do(op); ops++; } catch (e) { if (e instanceof OpError) rejected++; else throw e; }
      }
      assert.deepEqual(validateDefinition(h.current), [], `session ${s} step ${i}: the draft is invalid`);
      if (i % 8 === 7 || i === STEPS - 1) { assert.ok(h.verify(), `session ${s} step ${i}: log does not rebuild the draft`); checks++; }
    }
    assert.equal(canonical(History.rebuild(h.base, h.log)), canonical(h.current));
  }
  console.log(`# sessions ${SESSIONS}, applied ${ops}, rejected ${rejected}, undo or redo ${undos}, rebuild checks ${checks}`);
  assert.ok(ops > 4000 && rejected > 500);
});

test("replaying the full log, with redo, reaches the latest draft", () => {
  const h = new History(demoDefinition());
  const r = rng(7), counter = { n: 0 };
  for (let i = 0; i < 30; i++) { try { h.do(randomOp(h.current, r, counter)); } catch { /* rejected edits are fine */ } }
  const latest = canonical(h.current);
  while (h.canUndo) h.undo();
  while (h.canRedo) h.redo();
  assert.equal(canonical(h.current), latest);
  assert.equal(canonical(History.rebuild(h.base, h.fullLog)), latest);
});
