// The shared form-rule vectors. The Python checker in backend/a2w/formrules.py runs the same file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { failedRules, unknownFields } from "../src/ui/render.ts";
import type { Definition } from "../src/model/types.ts";

const spec = JSON.parse(readFileSync(new URL("../../../spec/expression/forms.json", import.meta.url), "utf8"));
const def = { ...spec.definition, queries: [], handlers: [] } as Definition;

for (const [i, c] of (spec.cases as { form: string; record: Record<string, unknown>; errors: unknown[]; unknown: string[]; note?: string }[]).entries()) {
  test(`${c.form} #${i}: ${JSON.stringify(c.record)}`, () => {
    const form = def.forms.find((f) => f.name === c.form)!;
    assert.deepEqual(failedRules(def, form, c.record as never, new Date(spec.now)), c.errors);
    assert.deepEqual(unknownFields(form, c.record), c.unknown);
  });
}
