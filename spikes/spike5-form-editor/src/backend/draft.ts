// Keeps the saved draft up to date: saves a moment after an edit, one save at a time, and saves again now and then
// to keep the lock. The editor never waits for a save, and a save never runs over another.
import type { Op } from "../model/ops.ts";
import { DraftLostError } from "./client.ts";

export type DraftState = "saved" | "saving" | "unsaved" | "lost" | "error";
export interface Saver { saveDraft(log: Op[]): Promise<unknown> }

export class DraftSaver {
  state: DraftState = "saved";
  message = "";
  private client: Saver;
  private getLog: () => Op[];
  private onState: (s: DraftState, message: string) => void;
  private delay: number;
  private heartbeat: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private paused = false;
  private lastSaved: string;

  /** `initial` is the log that the server already holds. */
  constructor(client: Saver, getLog: () => Op[], initial: Op[], opts: { delayMs: number; heartbeatMs: number; onState?: (s: DraftState, message: string) => void }) {
    this.client = client; this.getLog = getLog; this.lastSaved = JSON.stringify(initial);
    this.delay = opts.delayMs; this.heartbeat = opts.heartbeatMs; this.onState = opts.onState ?? (() => {});
    // The heartbeat saves even when nothing changed, because a save is what keeps the lock.
    this.beat = setInterval(() => { if (!this.paused && this.state !== "lost") void this.saveNow(true); }, this.heartbeat);
  }

  /** True when the page holds edits that the server does not. */
  get dirty(): boolean { return this.state === "lost" ? true : JSON.stringify(this.getLog()) !== this.lastSaved; }

  /** An edit was made. Save soon, and once for a burst of edits. */
  schedule(): void {
    if (this.paused || this.state === "lost") return;
    this.set("unsaved", "Not saved yet.");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.saveNow(), this.delay);
  }

  /** Save now, after any save already under way. Resolves when the draft is as saved as it can be. */
  async saveNow(force = false): Promise<void> {
    clearTimeout(this.timer);
    if (this.state === "lost") return;
    while (this.running) await this.running;
    const log = this.getLog(), text = JSON.stringify(log);
    if (!force && text === this.lastSaved && this.state === "saved") return;
    this.set("saving", "Saving…");
    this.running = (async () => {
      try {
        await this.client.saveDraft(log);
        this.lastSaved = text;
        this.set(JSON.stringify(this.getLog()) === text ? "saved" : "unsaved", JSON.stringify(this.getLog()) === text ? "Draft saved." : "Not saved yet.");
      } catch (e) {
        if (e instanceof DraftLostError) { this.set("lost", e.message); clearInterval(this.beat); }
        else this.set("error", (e as Error).message);
      }
    })();
    try { await this.running; } finally { this.running = null; }
    if (this.state === "unsaved" && !this.paused) this.schedule();  // an edit arrived during the save
  }

  /** Stop saving and wait for a save under way. For a publish, which ends the draft. */
  async pause(): Promise<void> {
    this.paused = true; clearTimeout(this.timer);
    while (this.running) await this.running;
  }

  /** Carry on after a pause that changed nothing on the server. Saves again if the page holds edits that the server does not. */
  unpause(): void { this.paused = false; if (this.state !== "lost" && this.dirty) this.schedule(); }

  /** Carry on after a pause that replaced the draft. `initial` is the log that the server now holds. */
  resume(initial: Op[]): void {
    this.lastSaved = JSON.stringify(initial); this.paused = false; this.state = "saved"; this.set("saved", "Draft saved.");
  }

  stop(): void { clearTimeout(this.timer); clearInterval(this.beat); this.paused = true; }

  private set(state: DraftState, message: string): void { this.state = state; this.message = message; this.onState(state, message); }
}
