import { type Definition, canonical } from "./types.ts";
import { type Op, apply } from "./ops.ts";

/**
 * A draft is the base definition plus a log of operations and a pointer.
 * Undo and redo move the pointer. A new edit drops everything after the pointer.
 * The log alone rebuilds the draft, which is what publish and audit rely on.
 */
export class History {
  readonly base: Definition;
  private ops: Op[] = [];
  private pointer = 0;
  private states: Definition[];

  constructor(base: Definition) { this.base = structuredClone(base); this.states = [this.base]; }

  get current(): Definition { return this.states[this.pointer]!; }
  get log(): Op[] { return structuredClone(this.ops.slice(0, this.pointer)); }
  get fullLog(): Op[] { return structuredClone(this.ops); }
  get position(): number { return this.pointer; }
  get canUndo(): boolean { return this.pointer > 0; }
  get canRedo(): boolean { return this.pointer < this.ops.length; }

  /** Apply an edit. A rejected edit leaves the draft and the log unchanged. */
  do(op: Op): Definition {
    const next = apply(this.current, op);
    this.ops = this.ops.slice(0, this.pointer);
    this.states = this.states.slice(0, this.pointer + 1);
    this.ops.push(structuredClone(op));
    this.states.push(next);
    this.pointer++;
    return next;
  }

  undo(): Definition { if (this.canUndo) this.pointer--; return this.current; }
  redo(): Definition { if (this.canRedo) this.pointer++; return this.current; }

  /** Rebuild from the log alone. */
  static rebuild(base: Definition, log: Op[]): Definition {
    return log.reduce((d, op) => apply(d, op), structuredClone(base));
  }

  /** True when the log rebuilds the current draft exactly. */
  verify(): boolean {
    return canonical(History.rebuild(this.base, this.log)) === canonical(this.current);
  }
}
