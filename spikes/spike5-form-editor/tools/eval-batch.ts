// Evaluate a batch of expressions and print the results as JSON. The Python differential test calls this.
// Input (stdin): [{ expr, record, now, rename?: { from, to } }]. Output: one result for each input.
import { ExprError, evaluate, refs, renameRef } from "../src/model/expr.ts";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const cases = JSON.parse(raw) as { expr: string; record: Record<string, unknown>; now: string; rename?: { from: string; to: string } }[];

const out = cases.map((c) => {
  try {
    const value = evaluate(c.expr, c.record, new Date(c.now));
    return { value, refs: refs(c.expr), renamed: c.rename ? renameRef(c.expr, c.rename.from, c.rename.to) : null };
  } catch (e) {
    if (e instanceof ExprError) return { error: true };
    throw e;
  }
});
process.stdout.write(JSON.stringify(out));
