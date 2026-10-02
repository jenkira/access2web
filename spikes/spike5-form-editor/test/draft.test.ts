// DraftSaver: when the page saves the draft, and what it never does.
import test from "node:test";
import assert from "node:assert/strict";
import { DraftSaver, type Saver } from "../src/backend/draft.ts";
import { DraftLostError } from "../src/backend/client.ts";
import type { Op } from "../src/model/ops.ts";

const op = (n: number): Op => ({ t: "setLabel", form: "F", id: "c", label: `L${n}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Fake implements Saver {
  saves: Op[][] = []; inFlight = 0; maxInFlight = 0; failWith: Error | null = null; holdMs = 0;
  async saveDraft(log: Op[]) {
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try { await sleep(this.holdMs); if (this.failWith) throw this.failWith; this.saves.push(structuredClone(log)); } finally { this.inFlight--; }
    return {};
  }
}
function make(opts: { delayMs?: number; heartbeatMs?: number; initial?: Op[] } = {}) {
  const fake = new Fake(); let log: Op[] = opts.initial ?? []; const states: string[] = [];
  const saver = new DraftSaver(fake, () => log, opts.initial ?? [], { delayMs: opts.delayMs ?? 20, heartbeatMs: opts.heartbeatMs ?? 100000, onState: (s) => states.push(s) });
  return { fake, saver, states, set: (l: Op[]) => { log = l; saver.schedule(); } };
}

test("a burst of edits is saved once, with the last log", async () => {
  const { fake, saver, set } = make();
  set([op(1)]); set([op(1), op(2)]); set([op(1), op(2), op(3)]);
  await sleep(80);
  assert.equal(fake.saves.length, 1); assert.equal(fake.saves[0]!.length, 3); assert.equal(saver.state, "saved");
  saver.stop();
});

test("the page counts as unsaved from the edit until the save, and nothing is saved when nothing changed", async () => {
  const { fake, saver, set } = make({ delayMs: 30 });
  assert.equal(saver.dirty, false);
  set([op(1)]);
  assert.equal(saver.state, "unsaved"); assert.equal(saver.dirty, true);
  await sleep(100);
  assert.equal(saver.dirty, false);
  await saver.saveNow();
  assert.equal(fake.saves.length, 1, "an unchanged log is not saved again");
  saver.stop();
});

test("saves never overlap, and an edit during a save is saved afterwards", async () => {
  const { fake, saver, set } = make({ delayMs: 5 });
  fake.holdMs = 60;
  set([op(1)]);
  await sleep(30);          // the first save is under way
  set([op(1), op(2)]);
  await sleep(250);
  assert.equal(fake.maxInFlight, 1);
  assert.deepEqual(fake.saves.map((l) => l.length), [1, 2]);
  assert.equal(saver.state, "saved");
  saver.stop();
});

test("saving now waits for a save under way and then saves the latest", async () => {
  const { fake, saver, set } = make({ delayMs: 1000 });
  fake.holdMs = 40;
  set([op(1)]);
  const first = saver.saveNow();
  set([op(1), op(2)]);
  await Promise.all([first, saver.saveNow()]);
  assert.equal(fake.maxInFlight, 1);
  assert.equal(fake.saves.at(-1)!.length, 2); assert.equal(saver.dirty, false);
  saver.stop();
});

test("the heartbeat saves even when nothing changed, so the lock does not lapse", async () => {
  const { fake, saver } = make({ heartbeatMs: 30, initial: [op(1)] });
  await sleep(110);
  assert.ok(fake.saves.length >= 2, `${fake.saves.length}`);
  saver.stop();
});

test("when the lock is lost the page says so, stops saving, and keeps counting the edits as unsaved", async () => {
  const { fake, saver, set, states } = make({ heartbeatMs: 30 });
  fake.failWith = new DraftLostError("dan has taken over the draft.");
  set([op(1)]);
  await sleep(100);
  assert.equal(saver.state, "lost"); assert.match(saver.message, /dan has taken over/);
  const calls = fake.saves.length;
  set([op(1), op(2)]);
  await sleep(120);
  assert.equal(fake.saves.length, calls, "no further save is tried"); assert.equal(saver.dirty, true);
  assert.ok(states.includes("lost"));
  saver.stop();
});

test("another failure is shown and tried again with the next edit", async () => {
  const { fake, saver, set } = make();
  fake.failWith = new Error("The draft was not saved: boom.");
  set([op(1)]);
  await sleep(80);
  assert.equal(saver.state, "error"); assert.match(saver.message, /boom/); assert.equal(saver.dirty, true);
  fake.failWith = null;
  set([op(1), op(2)]);
  await sleep(80);
  assert.equal(saver.state, "saved"); assert.equal(saver.dirty, false);
  saver.stop();
});

test("pause stops saving and waits for a save under way, and unpause saves what was missed", async () => {
  const { fake, saver, set } = make({ delayMs: 10 });
  fake.holdMs = 50;
  set([op(1)]);
  await sleep(25);                      // the save is under way
  await saver.pause();
  assert.equal(fake.saves.length, 1, "pause waited for it");
  set([op(1), op(2)]);                  // while paused
  await sleep(60);
  assert.equal(fake.saves.length, 1, "nothing is saved while paused");
  saver.unpause();
  await sleep(150);
  assert.equal(fake.saves.length, 2); assert.equal(saver.dirty, false);
  saver.stop();
});

test("resume after a new draft treats the server's log as the saved one", async () => {
  const { fake, saver, set } = make({ delayMs: 10 });
  await saver.pause();
  saver.resume([]);
  assert.equal(saver.dirty, false);
  set([op(9)]);
  await sleep(60);
  assert.deepEqual(fake.saves.map((l) => l.length), [1]);
  saver.stop();
});
