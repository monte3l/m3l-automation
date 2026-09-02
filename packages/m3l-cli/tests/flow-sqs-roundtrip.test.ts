/**
 * Acceptance test for the shipped U10 flow definition at
 * `data/config/flows/sqs-roundtrip.yaml` (ADR-0056).
 *
 * This exercises the REAL `loadFlowDefinition` path against the REAL file on
 * disk, with a validation context built from REAL script discovery
 * (`discoverScripts` + `loadScriptParameters`, no caching writes) — never a
 * stubbed parameter set. A stub would make this vacuous: the whole value of
 * this test is that a renamed script parameter, or a script's declared
 * parameter set drifting from what the file assumes, fails it. Only a manual
 * `--dry-run` would otherwise catch that.
 *
 * The repo root is resolved the same way `packages/m3l-cli/tests/doctor.test.ts`
 * resolves it for its own real-`src/`-tree assertions: three `..` segments up
 * from this file's own `import.meta.url` (tests/ -> m3l-cli/ -> packages/ ->
 * repo root). `data/` is anchored at the workspace root by
 * `pnpm-workspace.yaml`'s MONOREPO mode, so that same root is also the
 * `workspaceRoot` `loadFlowDefinition` expects.
 */
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { discoverScripts } from "../src/discovery/discover.js";
import { loadScriptParameters } from "../src/discovery/load-config.js";
import { loadFlowDefinition } from "../src/flow/load.js";
import type { M3LCliFlowValidationContext } from "../src/flow/validate.js";

/** Three `..` up from `tests/flow-sqs-roundtrip.test.ts`: the repo root. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Builds the same validation context `m3l flow run` builds in
 * `commands/flow.ts`'s `buildParametersByScript`, minus the discovery-cache
 * read/write — every script's REAL declared parameters, read straight from
 * its own config module, so a renamed or removed parameter fails this test
 * exactly as it would fail a real `m3l flow run`.
 */
async function buildRealValidationContext(): Promise<M3LCliFlowValidationContext> {
  const candidates = discoverScripts(REPO_ROOT);
  const parametersByScript = new Map<
    string,
    readonly { readonly name: string; readonly secret: boolean }[]
  >();
  for (const candidate of candidates) {
    const parameters = await loadScriptParameters(candidate.directory);
    parametersByScript.set(candidate.name, parameters);
  }
  return { parametersByScript };
}

describe("the shipped sqs-roundtrip flow definition", () => {
  test("loads and validates against the real, currently-discovered script parameters", async () => {
    const context = await buildRealValidationContext();

    const definition = loadFlowDefinition(REPO_ROOT, "sqs-roundtrip", context);

    expect(definition.name).toBe("sqs-roundtrip");
    expect(definition.steps.map((step) => step.id)).toEqual([
      "dump-queue",
      "project-body",
      "load-table",
      "replay-queue",
    ]);
    expect(definition.steps.map((step) => step.script)).toEqual([
      "sqs-etl",
      "json-etl",
      "dynamodb-crud",
      "sqs-etl",
    ]);
  });

  test("replay-queue reads project-body's output — the projection is what makes step 4 possible", async () => {
    const context = await buildRealValidationContext();

    const definition = loadFlowDefinition(REPO_ROOT, "sqs-roundtrip", context);

    const projectBody = definition.steps.find(
      (step) => step.id === "project-body",
    );
    const replayQueue = definition.steps.find(
      (step) => step.id === "replay-queue",
    );
    expect(projectBody).toBeDefined();
    expect(replayQueue).toBeDefined();

    // Compare the two live values against each other, never a literal path
    // restated twice — that is the assertion a silent edit to either step
    // must not survive.
    expect(replayQueue?.parameters["input"]).toBe(
      projectBody?.parameters["output"],
    );
  });
});
