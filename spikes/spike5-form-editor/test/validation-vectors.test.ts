// The shared form-validation vectors. The Python validator in backend/a2w/formrules.py runs the same file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateDefinition } from "../src/model/validate.ts";
import type { Definition } from "../src/model/types.ts";

const spec = JSON.parse(readFileSync(new URL("../../../spec/expression/validation.json", import.meta.url), "utf8"));

for (const c of spec.cases as { name: string; valid: boolean; forms: unknown[] }[]) {
  test(`${c.valid ? "valid" : "invalid"}: ${c.name}`, () => {
    const def = { app: "t", version: 1, entities: spec.entities, forms: c.forms, queries: [], handlers: [] } as Definition;
    const problems = validateDefinition(def);
    assert.equal(problems.length === 0, c.valid, problems.join("; "));
  });
}
