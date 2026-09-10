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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { loadScriptParameters } from "../src/discovery/load-config.js";
import { loadFlowDefinition } from "../src/flow/load.js";
import { checkFlowPreflight } from "../src/flow/preflight.js";
import type { M3LCliFlowValidationContext } from "../src/flow/validate.js";

/** Three `..` up from `tests/flow-sqs-roundtrip.test.ts`: the repo root. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Discovers every script and loads its REAL declared parameters, read
 * straight from its own config module — the same discovery + load pass
 * `commands/flow.ts`'s `buildParametersByScript` performs, minus the
 * discovery-cache read/write. Shared by both the validation-context builder
 * below and the pre-flight tests: both need "every script's real declared
 * parameters", just wrapped in a different context shape.
 */
async function buildRealParametersByScript(): Promise<
  ReadonlyMap<string, readonly M3LCliParameterDescriptor[]>
> {
  const candidates = discoverScripts(REPO_ROOT);
  const parametersByScript = new Map<
    string,
    readonly M3LCliParameterDescriptor[]
  >();
  for (const candidate of candidates) {
    const parameters = await loadScriptParameters(candidate.directory);
    parametersByScript.set(candidate.name, parameters);
  }
  return parametersByScript;
}

/**
 * Builds the same validation context `m3l flow run` builds in
 * `commands/flow.ts`'s `buildParametersByScript`, minus the discovery-cache
 * read/write — every script's REAL declared parameters, read straight from
 * its own config module, so a renamed or removed parameter fails this test
 * exactly as it would fail a real `m3l flow run`.
 */
async function buildRealValidationContext(): Promise<M3LCliFlowValidationContext> {
  const parametersByScript = await buildRealParametersByScript();
  return { parametersByScript };
}

describe("the shipped sqs-roundtrip flow definition", () => {
  // Real script discovery + per-script config load is identical across both
  // tests below and does no caching writes, so it is safe (and considerably
  // cheaper) to do it once here rather than in each test.
  let context: M3LCliFlowValidationContext;

  beforeAll(async () => {
    context = await buildRealValidationContext();
  });

  test("loads and validates against the real, currently-discovered script parameters", () => {
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

  test("replay-queue reads project-body's output — the projection is what makes step 4 possible", () => {
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
    // must not survive. Assert the shared value itself is present and
    // non-empty first: without that, two missing keys would each resolve to
    // `undefined` and the `toBe` below would pass vacuously.
    const sharedValue = replayQueue?.parameters["input"];
    expect(sharedValue).toBeDefined();
    expect(sharedValue).not.toBe("");
    expect(sharedValue).toBe(projectBody?.parameters["output"]);
  });
});

describe("the shipped flow definitions pass the pre-flight resolution check (issue #883)", () => {
  // Same real discovery + per-script config load as the describe block
  // above — safe and cheap to share across both flows under test here.
  let parametersByScript: ReadonlyMap<
    string,
    readonly M3LCliParameterDescriptor[]
  >;

  beforeAll(async () => {
    parametersByScript = await buildRealParametersByScript();
  });

  test.each(["sqs-roundtrip", "dlq-reconcile"] as const)(
    "%s supplies every required parameter from its own committed definition, with zero ambient environment or env-file reliance",
    (flowName) => {
      const definition = loadFlowDefinition(REPO_ROOT, flowName, {
        parametersByScript,
      });

      // Deliberately the weakest possible context: no ambient environment
      // variables at all, and an empty env-file-reach map so every script
      // falls back to `false` via checkFlowPreflight's own `?? false` — zero
      // benefit of the doubt from any of the check's own blind spots. If
      // `report.missing` is non-empty under THIS context, the flow's own
      // committed `parameters:` values alone do not satisfy its scripts'
      // required parameters.
      const report = checkFlowPreflight(definition, {
        parametersByScript,
        env: {},
        envFileReachByScript: new Map(),
      });

      // If this ever fails: STOP. Do not edit the flow YAML or the
      // preflight check to force it green — report the exact step/script/
      // parameter finding back to the hub for investigation first, per this
      // task's instructions.
      expect(report.missing).toEqual([]);

      // `report.unverified` is intentionally NOT asserted empty here — a
      // flow may legitimately carry advisory findings (an unresolved
      // ADR-0055 selector, a script the context has no descriptors for)
      // while still having zero missing. Documented for a future reader
      // rather than asserted away:
      //   sqs-roundtrip: every step declares its own selector value
      //     (`command`, `operation`) directly in `parameters`, so no
      //     conditional-requirement selector is left unresolved.
      //   dlq-reconcile: same — `command` is always given a literal value
      //     on both steps.
      // Both flows are therefore expected to report `unverified: []` too
      // today, but that is not the guarantee this test exists to lock in.
    },
  );
});

describe("the pre-flight's one documented blind spot (asyncFallback)", () => {
  test("no script declares an asyncFallback — the pre-flight's one blind spot has nothing to hide today", () => {
    const scriptsRoot = join(REPO_ROOT, "scripts");
    const scriptDirectories = readdirSync(scriptsRoot, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());

    const offenders: string[] = [];
    for (const directory of scriptDirectories) {
      const configPath = join(scriptsRoot, directory.name, "src", "config.ts");
      let contents: string;
      try {
        contents = readFileSync(configPath, "utf8");
      } catch {
        // No src/config.ts for this script directory — nothing to check.
        continue;
      }
      if (contents.includes("asyncFallback")) {
        offenders.push(directory.name);
      }
    }

    expect(offenders).toEqual([]);
  });
});
