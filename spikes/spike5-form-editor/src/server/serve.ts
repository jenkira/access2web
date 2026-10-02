// Start the prototype for a validation session. Usage: npm run serve
import { demoFull } from "../../fixtures/node.ts";
import { createServer } from "./server.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const srv = createServer({
  base: demoFull(),
  grants: { mia: ["manage_application"], dana: ["design_application"], ed: ["edit_data", "view_data"] },
  staticDir: root,
});
const port = await srv.listen(Number(process.env.PORT ?? 8080));
const u = (user: string, mode: string, form: string) => `http://127.0.0.1:${port}/public/index.html?mode=${mode}&user=${user}&form=${form}`;
console.log(`Prototype running at http://127.0.0.1:${port}/`);
console.log(`  Run a form as a user:        ${u("ed", "run", "OrderForm")}`);
console.log(`  Edit a form (Design level):  ${u("dana", "edit", "CustomerForm")}`);
console.log(`  Edit and publish (Manage):   ${u("mia", "edit", "CustomerForm")}`);
console.log("State is in memory. Restart the server to reset it.");
