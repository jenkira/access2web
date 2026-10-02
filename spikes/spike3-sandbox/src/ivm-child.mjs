// Runs one handler on a V8 isolate in its own process, so a fatal V8 error cannot take down the comparison run.
import { runIvm } from "./ivm.mjs";
import { checkHandler, transpile } from "./check.mjs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { source, useCheck, input } = JSON.parse(raw);
let result;
if (useCheck && checkHandler(source).length) {
  result = { status: "rejected_by_check", error: { name: "CheckFailed", message: checkHandler(source).join("; ") }, ui: [], ms: 0, stats: { queries: 0, dbMs: 0 } };
} else {
  result = await runIvm({ js: transpile(source), input, client: null, limits: {} });
}
result.hostPolluted = ({}).polluted !== undefined;
process.stdout.write("\n@@RESULT@@" + JSON.stringify(result) + "\n");
process.exit(0);
