/**
 * Tests for src/flow/load.ts — resolving, reading and validating a flow
 * definition at `<workspaceRoot>/data/config/flows/<name>.yaml`, plus
 * `listFlows` (U10 slice 3, stage A).
 *
 * These use a real temp directory rather than a `node:fs` mock for every
 * happy-path/authoring-fault scenario: `Core.M3LYAMLConfigProvider` reads
 * through the bare `"fs"` specifier (a distinct mock target from `"node:fs"`,
 * mirroring `packages/m3l-cli/tests/presets-store.test.ts`), and writing real
 * files is simpler than mocking two module specifiers to serve one loader.
 * The fs calls use bare named imports, the pattern
 * `packages/m3l-cli/tests/completion.test.ts` already establishes for this.
 *
 * The two machine-side read-failure tests below are the exception: they mock
 * `"node:fs"`'s `readdirSync` (for `listFlows`) and bare `"fs"`'s
 * `readFileSync` (for `readFlowRecord`, via `M3LYAMLConfigProvider`)
 * individually with `vi.spyOn`, on top of a REAL temp directory/file so every
 * other fs call in the same scenario stays real — spreading `vi.importActual`
 * into the mock factory (rather than a blanket `vi.mock`) is what keeps the
 * mock from bleeding into the rest of this file's real-fs tests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsModule from "fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

// Make 'fs'/'node:fs' configurable so vi.spyOn can intercept individual
// functions (ESM namespace objects are non-writable) — mirrors
// packages/m3l-cli/tests/presets-store.test.ts's pattern. Spreading `actual`
// keeps every unspyed function (including this file's real mkdtempSync et
// al. and the rest of this file's real reads) behaving exactly like the real
// module.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fsModule>("fs");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof nodeFs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";

import { exitCodeForError, M3LCliError } from "../src/cli/errors.js";
import { DEFAULT_MAX_STEP_EXECUTIONS } from "../src/flow/types.js";
import type { M3LCliFlowDefinition } from "../src/flow/types.js";
import type {
  M3LCliFlowValidationContext,
  M3LCliFlowValidationParameter,
} from "../src/flow/validate.js";
import { listFlows, loadFlowDefinition } from "../src/flow/load.js";

/** Temp workspace roots created by this file, removed in `afterEach`. */
const createdRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/**
 * Builds a script's declared-parameter facts from names that are all
 * NON-secret. The context carries `{ name, secret }` pairs, so a name can
 * never reach the validator without stating whether ADR-0085 forbids it from
 * a flow definition.
 */
function declared(
  ...names: readonly string[]
): readonly M3LCliFlowValidationParameter[] {
  return names.map((name) => ({ name, secret: false }));
}

/** The injected script knowledge every loader test validates against. */
const context: M3LCliFlowValidationContext = {
  parametersByScript: new Map([
    ["sqs-etl", declared("command", "queueUrl", "input", "output")],
    ["json-etl", declared("input", "output", "format", "fields")],
    ["dynamodb-crud", declared("operation", "table", "input")],
  ]),
};

/**
 * The same knowledge, except `json-etl` declares `api-token` SECRET — the one
 * fact the loader has to carry all the way into the validator for the
 * ADR-0085 screen to bite on a real file.
 */
const secretsContext: M3LCliFlowValidationContext = {
  parametersByScript: new Map([
    [
      "json-etl",
      [...declared("input", "output"), { name: "api-token", secret: true }],
    ],
  ]),
};

/** An obvious placeholder — never a realistic-looking credential in a fixture. */
const PLACEHOLDER_SECRET = "PLACEHOLDER-NOT-A-REAL-SECRET";

/** Creates an empty temp workspace root, registered for cleanup. */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "m3l-flow-load-"));
  createdRoots.push(root);
  return root;
}

/**
 * Creates a temp workspace root whose `data/config/flows/` directory holds
 * one file per `[fileName, content]` entry. Passing an empty array creates
 * the directory but no files; the `flows` directory is deliberately NOT
 * created by {@link makeWorkspace}, so a missing-directory case is expressed
 * by using `makeWorkspace()` alone.
 */
function makeWorkspaceWithFlows(
  files: readonly (readonly [string, string])[],
): string {
  const root = makeWorkspace();
  const directory = join(root, "data", "config", "flows");
  mkdirSync(directory, { recursive: true });
  for (const [fileName, content] of files) {
    writeFileSync(join(directory, fileName), content, "utf8");
  }
  return root;
}

/** A minimal valid single-step flow document named `name`. */
function validFlowYaml(name: string): string {
  return [
    `name: ${name}`,
    "steps:",
    "  - id: reshape",
    "    script: json-etl",
    "    parameters:",
    "      input: data/output/dump.jsonl",
    "      output: data/output/reshaped.jsonl",
    "",
  ].join("\n");
}

/**
 * Runs `run` and returns the `M3LCliError` it threw. Fails when the call
 * returns normally, and rethrows any other error class so a wrong error type
 * is visible instead of swallowed.
 */
function captureCliError(run: () => unknown): M3LCliError {
  try {
    run();
  } catch (error) {
    if (error instanceof M3LCliError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an M3LCliError, but the call returned normally");
}

describe("listFlows", () => {
  test("returns [] when data/config/flows does not exist", () => {
    expect(listFlows(makeWorkspace())).toEqual([]);
  });

  test("returns [] for an existing but empty flows directory", () => {
    expect(listFlows(makeWorkspaceWithFlows([]))).toEqual([]);
  });

  test("returns the .yaml flow names, sorted, with the extension stripped", () => {
    const root = makeWorkspaceWithFlows([
      ["zeta.yaml", validFlowYaml("zeta")],
      ["alpha.yaml", validFlowYaml("alpha")],
      ["dlq-reconcile.yaml", validFlowYaml("dlq-reconcile")],
    ]);

    expect(listFlows(root)).toEqual(["alpha", "dlq-reconcile", "zeta"]);
  });

  test("skips every extension the loader cannot resolve", () => {
    // The loader resolves `<name>.yaml` only, so listing a `.yml` or `.json`
    // file would offer a suggestion that then fails to load.
    const root = makeWorkspaceWithFlows([
      ["real.yaml", validFlowYaml("real")],
      ["other.yml", validFlowYaml("other")],
      ["other.json", "{}"],
      ["README.md", "# flows"],
      ["notes.txt", "hi"],
    ]);

    expect(listFlows(root)).toEqual(["real"]);
  });

  test("does not read or parse the listed files", () => {
    // Listing must stay cheap and total: one malformed file cannot make the
    // suggestion pool for every other flow unavailable.
    const root = makeWorkspaceWithFlows([
      ["broken.yaml", "steps: [\n  - id: unterminated"],
      ["fine.yaml", validFlowYaml("fine")],
    ]);

    expect(listFlows(root)).toEqual(["broken", "fine"]);
  });

  test("throws M3LCliError ERR_CLI_FLOW_READ_FAILED when the directory cannot be listed, chaining the original as cause", () => {
    // A real, existing (empty) flows directory, so `existsSync` genuinely
    // passes for real — only `readdirSync` itself is made to fail, the way a
    // permission failure (EACCES) would in practice.
    const root = makeWorkspaceWithFlows([]);
    const original = new Error(
      "EACCES: permission denied",
    ) as NodeJS.ErrnoException;
    original.code = "EACCES";
    vi.spyOn(nodeFs, "readdirSync").mockImplementation(() => {
      throw original;
    });

    const error = captureCliError(() => listFlows(root));

    expect(error.code).toBe("ERR_CLI_FLOW_READ_FAILED");
    expect(error.cause).toBe(original);
  });
});

describe("loadFlowDefinition — happy path", () => {
  test("loads and validates the flow file, returning the normalized definition", () => {
    const root = makeWorkspaceWithFlows([
      ["dlq-reconcile.yaml", validFlowYaml("dlq-reconcile")],
    ]);

    const definition: M3LCliFlowDefinition = loadFlowDefinition(
      root,
      "dlq-reconcile",
      context,
    );

    expect(definition.name).toBe("dlq-reconcile");
    expect(definition.steps).toHaveLength(1);
    expect(definition.steps[0]?.id).toBe("reshape");
    expect(definition.steps[0]?.script).toBe("json-etl");
    expect(definition.steps[0]?.parameters).toEqual({
      input: "data/output/dump.jsonl",
      output: "data/output/reshaped.jsonl",
    });
  });

  test("applies the validator's defaults to a file that declares only the required keys", () => {
    const root = makeWorkspaceWithFlows([["demo.yaml", validFlowYaml("demo")]]);

    const definition = loadFlowDefinition(root, "demo", context);

    expect(definition.maxStepExecutions).toBe(DEFAULT_MAX_STEP_EXECUTIONS);
    expect(definition.description).toBeUndefined();
    expect(definition.steps[0]?.execution).toBe("auto");
    expect(definition.steps[0]?.onSuccess).toBe("continue");
    expect(definition.steps[0]?.onFailure).toBe("stop");
    expect(definition.steps[0]?.onPartial).toBe("stop");
  });

  test("loads a multi-step flow with a backward goto and an explicit guard", () => {
    const root = makeWorkspaceWithFlows([
      [
        "dlq-reconcile.yaml",
        [
          "name: dlq-reconcile",
          "description: Drain a DLQ, reshape, land, republish.",
          "maxStepExecutions: 12",
          "steps:",
          "  - id: dump",
          "    script: sqs-etl",
          "    parameters:",
          "      command: dump",
          "      output: data/output/dump.jsonl",
          "    execution: spawn",
          "    onSuccess: continue",
          "    onFailure: stop",
          "  - id: republish",
          "    script: sqs-etl",
          "    parameters:",
          "      command: send",
          "      input: data/output/dump.jsonl",
          "    onFailure:",
          "      goto: dump",
          "    onPartial: continue",
          "    dryRun: true",
          "",
        ].join("\n"),
      ],
    ]);

    const definition = loadFlowDefinition(root, "dlq-reconcile", context);

    expect(definition.description).toBe(
      "Drain a DLQ, reshape, land, republish.",
    );
    expect(definition.maxStepExecutions).toBe(12);
    expect(definition.steps).toHaveLength(2);
    expect(definition.steps[0]?.id).toBe("dump");
    expect(definition.steps[1]?.id).toBe("republish");
    expect(definition.steps[1]?.onFailure).toEqual({ goto: "dump" });
    expect(definition.steps[1]?.onPartial).toBe("continue");
    expect(definition.steps[1]?.dryRun).toBe(true);
  });
});

describe("loadFlowDefinition — unknown flow", () => {
  test("throws an unknown-flow error naming suggestions, not a validation error about missing steps", () => {
    // `Core.M3LYAMLConfigProvider` treats a missing file as an empty map, so
    // without an existence check FIRST an unknown flow would surface as an
    // "empty/invalid flow" complaining about a missing `steps` key. Both arms
    // are reachable here — the file genuinely does not exist and the raw
    // values genuinely would be empty — so this discriminates the ordering.
    const root = makeWorkspaceWithFlows([
      ["dlq-reconcile.yaml", validFlowYaml("dlq-reconcile")],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "dlq-reconcil", context),
    );

    expect(error.code).toBe("ERR_CLI_UNKNOWN_FLOW");
    expect(error.message).toContain("dlq-reconcil");
    expect(error.message).not.toContain("steps");
    expect(error.suggestions).toContain("dlq-reconcile");
  });

  test("throws an unknown-flow error with no suggestions when the flows directory is missing", () => {
    const error = captureCliError(() =>
      loadFlowDefinition(makeWorkspace(), "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_UNKNOWN_FLOW");
    expect(error.suggestions).toEqual([]);
  });

  test("throws an unknown-flow error with no suggestions when nothing is close", () => {
    const root = makeWorkspaceWithFlows([
      ["dlq-reconcile.yaml", validFlowYaml("dlq-reconcile")],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "zzzzzzzzzz", context),
    );

    expect(error.code).toBe("ERR_CLI_UNKNOWN_FLOW");
    expect(error.suggestions).toEqual([]);
  });

  test("an unknown flow maps to the usage exit code 2", () => {
    const error = captureCliError(() =>
      loadFlowDefinition(makeWorkspace(), "demo", context),
    );

    expect(exitCodeForError(error)).toBe(2);
  });

  test("does not resolve a .yml sibling as the requested flow", () => {
    const root = makeWorkspaceWithFlows([["demo.yml", validFlowYaml("demo")]]);

    expect(
      captureCliError(() => loadFlowDefinition(root, "demo", context)).code,
    ).toBe("ERR_CLI_UNKNOWN_FLOW");
  });
});

describe("loadFlowDefinition — malformed file", () => {
  test("surfaces a YAML parse failure as an M3LCliError with the parse error chained as cause", () => {
    const root = makeWorkspaceWithFlows([
      ["demo.yaml", "steps: [\n  - id: unterminated\n"],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.cause).toBeInstanceOf(Core.M3LConfigParseError);
  });

  test("surfaces a top-level YAML sequence as an M3LCliError with the cause chained", () => {
    const root = makeWorkspaceWithFlows([["demo.yaml", "- one\n- two\n"]]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.cause).toBeInstanceOf(Core.M3LConfigParseError);
  });

  test("surfaces a top-level YAML scalar as an M3LCliError with the cause chained", () => {
    const root = makeWorkspaceWithFlows([["demo.yaml", "just a string\n"]]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.cause).toBeInstanceOf(Core.M3LConfigParseError);
  });

  test("surfaces the provider's top-level prototype-pollution rejection with the cause chained", () => {
    const root = makeWorkspaceWithFlows([
      ["demo.yaml", `__proto__:\n  polluted: true\n${validFlowYaml("demo")}`],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.cause).toBeInstanceOf(Core.M3LUnsafeConfigKeyError);
  });

  test("treats an empty flow file as a validation failure, not an unknown flow", () => {
    // The file exists, so the existence check passes and the provider yields
    // an empty map — which is a genuinely invalid definition, and must be
    // reported as one rather than as a missing flow.
    const root = makeWorkspaceWithFlows([["demo.yaml", "\n"]]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
  });

  test("surfaces a raw read failure (e.g. EACCES) as ERR_CLI_FLOW_READ_FAILED, chaining the original as cause — distinct from a malformed file's ERR_CLI_FLOW_INVALID above", () => {
    // The file genuinely exists and is genuinely listed (so existence/listing
    // both pass for real); only the byte-level read that
    // `Core.M3LYAMLConfigProvider` performs is made to fail with something
    // that is NOT `ENOENT` (which the provider tolerates as "missing") and is
    // not a parse/prototype-pollution fault either — a raw filesystem fault,
    // which `readFlowRecord` must classify as ERR_CLI_FLOW_READ_FAILED rather
    // than ERR_CLI_FLOW_INVALID. This is the other arm of the same
    // classification the "malformed file" tests above exercise, made
    // reachable in the same real-file setup.
    const root = makeWorkspaceWithFlows([["demo.yaml", validFlowYaml("demo")]]);
    const original = new Error(
      "EACCES: permission denied",
    ) as NodeJS.ErrnoException;
    original.code = "EACCES";
    vi.spyOn(fsModule, "readFileSync").mockImplementation(() => {
      throw original;
    });

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_READ_FAILED");
    expect(error.cause).toBe(original);
  });
});

describe("loadFlowDefinition — validation reaches the file's own content", () => {
  test("rejects a file whose name key does not equal the filename stem", () => {
    const root = makeWorkspaceWithFlows([
      ["demo.yaml", validFlowYaml("other")],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("other");
    expect(error.message).toContain("demo");
  });

  test("rejects an unknown flow-level key present in the file, naming it", () => {
    // Enumerating the document's own top-level keys is what makes every later
    // format addition forward-safe, so the loader must hand the validator the
    // WHOLE record — not just the four keys it already knows how to read.
    const root = makeWorkspaceWithFlows([
      ["demo.yaml", `retries: 3\n${validFlowYaml("demo")}`],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("retries");
  });

  test("rejects an unknown step-level key present in the file, naming it", () => {
    const root = makeWorkspaceWithFlows([
      [
        "demo.yaml",
        [
          "name: demo",
          "steps:",
          "  - id: reshape",
          "    script: json-etl",
          "    parameters: {}",
          "    onError: stop",
          "",
        ].join("\n"),
      ],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("onError");
  });

  test("rejects a script the injected context does not know, with suggestions", () => {
    const root = makeWorkspaceWithFlows([
      [
        "demo.yaml",
        [
          "name: demo",
          "steps:",
          "  - id: reshape",
          "    script: json-et",
          "    parameters: {}",
          "",
        ].join("\n"),
      ],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.suggestions).toContain("json-etl");
  });

  test("rejects a step-level dangerous key the top-level provider screen cannot see", () => {
    const root = makeWorkspaceWithFlows([
      [
        "demo.yaml",
        [
          "name: demo",
          "steps:",
          "  - id: reshape",
          "    script: json-etl",
          "    parameters:",
          "      __proto__: polluted",
          "",
        ].join("\n"),
      ],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    // `__proto__` is ALSO a parameter `json-etl` does not declare, so
    // asserting the key name alone would still pass with the dangerous-key
    // screen removed — the undeclared-parameter rule rejects the same file.
    // Pin the pollution phrase from `screenDangerousKeys` instead, so this
    // test dies when the screen stops matching `__proto__`.
    expect(error.message).toContain("declares prototype-pollution key(s)");
    expect(error.message).toContain("__proto__");
    expect(error.message).not.toContain("does not accept");
  });

  test("rejects a real file whose step declares a secret parameter, end to end (ADR-0085)", () => {
    // The pure validator owns the rule; this proves the LOADER carries the
    // secret-ness from its injected context into it, so the guard bites on
    // bytes read from disk and not only in a unit test of `validate.ts`.
    const root = makeWorkspaceWithFlows([
      [
        "demo.yaml",
        [
          "name: demo",
          "steps:",
          "  - id: reshape",
          "    script: json-etl",
          "    parameters:",
          "      input: data/output/dump.jsonl",
          `      api-token: ${PLACEHOLDER_SECRET}`,
          "",
        ].join("\n"),
      ],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", secretsContext),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("api-token");
    expect(error.message).toContain("secret");
    expect(error.message).toContain("ADR-0085");
    // `api-token` IS declared by `json-etl`, so the undeclared-parameter rule
    // cannot be what rejected this file.
    expect(error.message).not.toContain("does not accept");
    expect(error.message).not.toContain(PLACEHOLDER_SECRET);
    expect(exitCodeForError(error)).toBe(2);
  });

  test("loads the same file's non-secret parameter fine once the secret key is gone", () => {
    // The control for the case above: `secretsContext` does not make every
    // `json-etl` step unloadable.
    const root = makeWorkspaceWithFlows([
      [
        "demo.yaml",
        [
          "name: demo",
          "steps:",
          "  - id: reshape",
          "    script: json-etl",
          "    parameters:",
          "      input: data/output/dump.jsonl",
          "",
        ].join("\n"),
      ],
    ]);

    const definition = loadFlowDefinition(root, "demo", secretsContext);

    expect(definition.steps[0]?.parameters).toEqual({
      input: "data/output/dump.jsonl",
    });
  });

  test("a malformed definition maps to the usage exit code 2", () => {
    const root = makeWorkspaceWithFlows([
      ["demo.yaml", "name: demo\nsteps: []\n"],
    ]);

    const error = captureCliError(() =>
      loadFlowDefinition(root, "demo", context),
    );

    expect(exitCodeForError(error)).toBe(2);
  });
});
