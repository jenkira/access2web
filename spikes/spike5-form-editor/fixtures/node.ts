// Node-only fixtures: the 10 handlers from Spike 3, so the rename test scans real handler source.
import { readdirSync, readFileSync } from "node:fs";
import { demoDefinition } from "./demo.ts";
import type { Definition } from "../src/model/types.ts";

export function loadHandlers(): Definition["handlers"] {
  const dir = new URL("../../spike3-sandbox/handlers/", import.meta.url);
  return readdirSync(dir).filter((f) => /^\d\d-.*\.ts$/.test(f)).sort()
    .map((f) => ({ name: f.replace(/\.ts$/, ""), event: "spike3", source: readFileSync(new URL(f, dir), "utf8") }));
}

export function demoFull(): Definition {
  return demoDefinition(loadHandlers());
}
