/**
 * Tests for `src/lib/cli-surface.ts` — the typed adapter over
 * `src/lib/cli-process.ts`. Every scenario injects
 * `tests/support/cliFakes.ts`'s fake `runCliProcess` as `deps.runProcess`;
 * no real child process, no `vi.mock`.
 */
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@monte3l/m3l-common";

import type { AgentOperatorScriptName } from "../../src/lib/cli-names.js";
import type { CliRunResult, runCliProcess } from "../../src/lib/cli-process.js";
import {
  createAgentCliSurface,
  type AgentCliRunOptions,
  type AgentCliSurface,
  type CreateAgentCliSurfaceOptions,
} from "../../src/lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import type {
  AgentOperatorPresetName,
  AgentOperatorPresetPath,
} from "../../src/lib/preset-names.js";
import {
  abortedResult,
  createFakeRunCliProcess,
  exitedResult,
  makeDoctorCheck,
  makeDoctorPayload,
  makeInspectPayload,
  makeListPayload,
  makeParamDescriptor,
  makeRunEnvelope,
  makeRunEnvelopePayload,
  signalledResult,
  spawnFailedResult,
  timedOutResult,
  truncatedResult,
} from "../support/cliFakes.js";
import { createPrototypePollutionHarness } from "../support/prototypePollution.js";

/**
 * The surface's real constructor-options type. Earlier RED rounds mirrored
 * it locally because `presetAllowlist` and `workspaceRoot` did not exist on
 * `CreateAgentCliSurfaceOptions` yet; both are real fields now, so the alias
 * keeps every `createDeps` call site unchanged while pinning the ACTUAL
 * shape instead of a copy free to drift from it.
 */
type AgentCliSurfaceDeps = CreateAgentCliSurfaceOptions;

const DRY_RUN_ALLOWED_NAME = "widget-export";

// V9 slice 2a preset fixtures. The allowlist stores the path exactly as an
// operator declares it in config — **workspace-relative**, so the entry is
// reviewable in a config diff — and `run` is what must turn it absolute.
const PRESET_ALLOWED_NAME = "nightly";
// S1: `run` re-asserts containment where the value is USED, so a legal entry
// must live inside the presets directory named by
// `AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX` (`lib/preset-names.ts`) — the one
// boundary shared by that use-site re-check and the config-text rule
// `parsePresetAllowlist` applies in `steps/resolve-runtime.ts`, so the two
// cannot drift into accepting different sets. The fixture below has to spell
// the directory out because a declared allowlist entry is a concrete string;
// what pins it to the CLI's own preset store is the drift guard in
// `tests/steps/resolve-runtime.test.ts`, and because both checks derive from
// the shared prefix that guard now reaches this boundary too. A fixture
// outside the directory is no longer a valid happy path.
const PRESET_RELATIVE_PATH = "data/config/presets/agent-operator/nightly.json";

function createDeps(overrides: Partial<AgentCliSurfaceDeps> = {}): {
  readonly deps: AgentCliSurfaceDeps;
  readonly fake: ReturnType<typeof createFakeRunCliProcess>;
} {
  const fake = createFakeRunCliProcess();
  const deps: AgentCliSurfaceDeps = {
    entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
    cwd: "/repo",
    nodeExecPath: "/usr/bin/node",
    cliTimeoutMs: 30_000,
    dryRunTimeoutMs: 120_000,
    flowTimeoutMs: 600_000,
    maxOutputBytes: 1_048_576,
    dryRunAllowlist: new Set([DRY_RUN_ALLOWED_NAME]),
    presetAllowlist: new Map([[PRESET_ALLOWED_NAME, PRESET_RELATIVE_PATH]]),
    // Closed by default, mirroring `presetAllowlist`'s own "empty still
    // means closed" convention — `createFlowDeps` below overrides this with
    // the real fixture allowlist for every `flowRun` scenario.
    flowAllowlist: new Set<string>(),
    runProcess: fake.runProcess,
    ...overrides,
  };
  return { deps, fake };
}

/** Captures a rejection's thrown value without a second `invoke` call. */
async function captureRejection(
  invoke: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await invoke();
  } catch (error) {
    return error;
  }
  throw new Error("expected the invocation to reject, but it resolved");
}

describe("createAgentCliSurface — argv table", () => {
  test("list() sends exactly ['list', '--json']", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(exitedResult({ stdout: makeListPayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.list();

    expect(fake.calls).toEqual([["list", "--json"]]);
  });

  test("doctor() sends exactly ['doctor', '--json']", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(exitedResult({ stdout: makeDoctorPayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.doctor();

    expect(fake.calls).toEqual([["doctor", "--json"]]);
  });

  test("inspect(name) sends exactly ['inspect', name, '--json']", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(exitedResult({ stdout: makeInspectPayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.inspect(DRY_RUN_ALLOWED_NAME);

    expect(fake.calls).toEqual([["inspect", DRY_RUN_ALLOWED_NAME, "--json"]]);
  });

  test("dryRun(name) sends exactly ['run', name, '--json', '--', '--dry-run'], with --json before -- and --dry-run after", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.dryRun(DRY_RUN_ALLOWED_NAME);

    expect(fake.calls).toEqual([
      ["run", DRY_RUN_ALLOWED_NAME, "--json", "--", "--dry-run"],
    ]);
    const argv = fake.calls[0] ?? [];
    const jsonIndex = argv.indexOf("--json");
    const dashIndex = argv.indexOf("--");
    const dryRunIndex = argv.indexOf("--dry-run");
    // `partitionJsonFlag` only strips `--json` when it precedes the bare
    // `--`; `splitAtFirstDoubleDash` only forwards `--dry-run` when it
    // follows it. Position, not mere presence, is the contract.
    expect(jsonIndex).toBeGreaterThanOrEqual(0);
    expect(dashIndex).toBeGreaterThan(jsonIndex);
    expect(dryRunIndex).toBeGreaterThan(dashIndex);
  });
});

describe("createAgentCliSurface — exit-code policy", () => {
  test("list at exit 0 resolves with the parsed rows", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(
      exitedResult({ exitCode: 0, stdout: makeListPayload() }),
    );
    const surface = createAgentCliSurface(deps);

    await expect(surface.list()).resolves.toHaveLength(1);
  });

  test("list at exit 1 REJECTS with ERR_AGENT_OPERATOR_CLI_OUTPUT (the {0}-only policy)", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(
      exitedResult({ exitCode: 1, stdout: makeListPayload() }),
    );
    const surface = createAgentCliSurface(deps);

    await expect(surface.list()).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CLI_OUTPUT",
    });
  });

  test.each([[0], [1]])(
    "doctor with a 'fail' row RESOLVES with blocking: true at exit code %i — a failing health check is the answer, not an error",
    async (exitCode) => {
      const { deps, fake } = createDeps();
      fake.enqueueResult(
        exitedResult({
          exitCode,
          stdout: makeDoctorPayload([
            makeDoctorCheck({ name: "workspace-root", status: "ok" }),
            makeDoctorCheck({
              name: "aws-credentials",
              status: "fail",
              detail: "no credentials resolved",
            }),
          ]),
        }),
      );
      const surface = createAgentCliSurface(deps);

      const report = await surface.doctor();

      expect(report.blocking).toBe(true);
    },
  );

  test("doctor with only ok/warn rows resolves blocking: false", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(
      exitedResult({
        stdout: makeDoctorPayload([
          makeDoctorCheck({ status: "ok" }),
          makeDoctorCheck({ status: "warn" }),
        ]),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const report = await surface.doctor();

    expect(report.blocking).toBe(false);
  });

  test("doctor at an exit code outside {0,1} rejects with ERR_AGENT_OPERATOR_CLI_OUTPUT", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(
      exitedResult({ exitCode: 2, stdout: makeDoctorPayload() }),
    );
    const surface = createAgentCliSurface(deps);

    await expect(surface.doctor()).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CLI_OUTPUT",
    });
  });

  test("dryRun accepts any exit code, resolving with the envelope's own exitCode/outcome", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(
      exitedResult({
        exitCode: 6,
        stdout: makeRunEnvelopePayload({ exitCode: 6, outcome: "partial" }),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const envelope = await surface.dryRun(DRY_RUN_ALLOWED_NAME);

    expect(envelope.exitCode).toBe(6);
    expect(envelope.outcome).toBe("partial");
  });
});

// Table-driven flag-injection attempts (PR 1 contract's required table, plus
// two extra values from the contract's own testing section: an
// uppercase-cased name and a doubled-hyphen name).
const INJECTION_ATTEMPTS = [
  "--json",
  "-h",
  "../../etc/passwd",
  "a;rm -rf /",
  "",
  "-",
  "x".repeat(65),
  "a\0b",
  "Agent-Operator",
  "a--b",
] as const;

describe("createAgentCliSurface — flag-injection defence", () => {
  test.each(INJECTION_ATTEMPTS)(
    "inspect(%p) rejects with ERR_AGENT_OPERATOR_SCRIPT_NAME and spawns nothing",
    async (name) => {
      const { deps, fake } = createDeps();
      const surface = createAgentCliSurface(deps);

      await expect(surface.inspect(name)).rejects.toMatchObject({
        code: "ERR_AGENT_OPERATOR_SCRIPT_NAME",
      });
      // The point: nothing was ever spawned, not merely that the promise rejected.
      expect(fake.calls).toEqual([]);
    },
  );

  test.each(INJECTION_ATTEMPTS)(
    "dryRun(%p) rejects with ERR_AGENT_OPERATOR_SCRIPT_NAME and spawns nothing",
    async (name) => {
      const { deps, fake } = createDeps({
        dryRunAllowlist: new Set([...INJECTION_ATTEMPTS, DRY_RUN_ALLOWED_NAME]),
      });
      const surface = createAgentCliSurface(deps);

      await expect(surface.dryRun(name)).rejects.toMatchObject({
        code: "ERR_AGENT_OPERATOR_SCRIPT_NAME",
      });
      expect(fake.calls).toEqual([]);
    },
  );
});

describe("createAgentCliSurface — dry-run allowlist", () => {
  test("dryRun on a regex-valid name absent from dryRunAllowlist rejects with ERR_AGENT_OPERATOR_SCRIPT_NAME and spawns nothing", async () => {
    const { deps, fake } = createDeps({
      dryRunAllowlist: new Set(["some-other-script"]),
    });
    const surface = createAgentCliSurface(deps);

    await expect(surface.dryRun(DRY_RUN_ALLOWED_NAME)).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    });
    expect(fake.calls).toEqual([]);
  });

  test("inspect is NOT gated by dryRunAllowlist — a name valid by regex alone is spawned", async () => {
    const { deps, fake } = createDeps({
      dryRunAllowlist: new Set(["some-other-script"]),
    });
    fake.enqueueResult(exitedResult({ stdout: makeInspectPayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.inspect(DRY_RUN_ALLOWED_NAME);

    expect(fake.calls).toEqual([["inspect", DRY_RUN_ALLOWED_NAME, "--json"]]);
  });
});

const METHOD_TABLE: readonly {
  readonly name: "list" | "doctor" | "inspect" | "dryRun";
  readonly invoke: (surface: AgentCliSurface) => Promise<unknown>;
}[] = [
  { name: "list", invoke: (surface) => surface.list() },
  { name: "doctor", invoke: (surface) => surface.doctor() },
  {
    name: "inspect",
    invoke: (surface) => surface.inspect(DRY_RUN_ALLOWED_NAME),
  },
  {
    name: "dryRun",
    invoke: (surface) => surface.dryRun(DRY_RUN_ALLOWED_NAME),
  },
];

describe("createAgentCliSurface — abort classification (ADR-0049)", () => {
  test.each(METHOD_TABLE)(
    "$name rejects with Core.M3LOperationAbortedError (code ERR_OPERATION_ABORTED), never a script-local code, on an 'aborted' disposition",
    async ({ invoke }) => {
      const { deps, fake } = createDeps();
      fake.enqueueResult(abortedResult());
      const surface = createAgentCliSurface(deps);

      const thrown = await captureRejection(() => invoke(surface));

      // `instanceof` must survive: ADR-0049 classifies by code, and
      // `deriveCommandOutcome` maps `ERR_OPERATION_ABORTED` to exit 5 — a
      // script-local code here would make Ctrl-C exit 1 on the spawn path
      // and 5 in-process.
      expect(thrown).toBeInstanceOf(Core.M3LOperationAbortedError);
      expect((thrown as Core.M3LOperationAbortedError).code).toBe(
        "ERR_OPERATION_ABORTED",
      );
    },
  );
});

const SPAWN_LAYER_DISPOSITIONS = [
  ["spawn-failed", spawnFailedResult],
  ["timed-out", timedOutResult],
  ["signalled", signalledResult],
  ["output-truncated", truncatedResult],
] as const;

describe("createAgentCliSurface — spawn-layer failures map to ERR_AGENT_OPERATOR_CLI_SPAWN", () => {
  test.each(SPAWN_LAYER_DISPOSITIONS)(
    "a '%s' disposition rejects with ERR_AGENT_OPERATOR_CLI_SPAWN",
    async (_label, buildResult) => {
      const { deps, fake } = createDeps();
      fake.enqueueResult(buildResult());
      const surface = createAgentCliSurface(deps);

      await expect(surface.list()).rejects.toMatchObject({
        code: "ERR_AGENT_OPERATOR_CLI_SPAWN",
      });
    },
  );

  test("includes failureCode in context only when the disposition carries one", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(spawnFailedResult({ failureCode: "ENOENT" }));
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() => surface.list());

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).context).toMatchObject({
      failureCode: "ENOENT",
    });
  });

  test("omits failureCode from context when the disposition carries none", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(timedOutResult({ failureCode: undefined }));
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() => surface.list());

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect(
      Object.hasOwn((thrown as Core.M3LError).context, "failureCode"),
    ).toBe(false);
  });
});

describe("createAgentCliSurface — output parse failures", () => {
  test("malformed stdout on list() rejects with ERR_AGENT_OPERATOR_CLI_OUTPUT, and the raw stdout never appears anywhere in the thrown error", async () => {
    const { deps, fake } = createDeps();
    const rawStdout = "not-json-at-all {{{ dangling-token-zzyzx";
    fake.enqueueResult(exitedResult({ stdout: rawStdout }));
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() => surface.list());

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const err = thrown as Core.M3LError;
    expect(err.code).toBe("ERR_AGENT_OPERATOR_CLI_OUTPUT");
    const surfaceText = `${err.message} ${JSON.stringify(err.toJSON())}`;
    expect(surfaceText).not.toContain(rawStdout);
    expect(surfaceText).not.toContain("dangling-token-zzyzx");
  });

  test("a run envelope with the wrong schemaVersion rejects with ERR_AGENT_OPERATOR_CLI_OUTPUT", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(
      exitedResult({
        stdout: JSON.stringify({
          kind: "m3l.run.result",
          schemaVersion: 2,
          script: DRY_RUN_ALLOWED_NAME,
        }),
      }),
    );
    const surface = createAgentCliSurface(deps);

    await expect(surface.dryRun(DRY_RUN_ALLOWED_NAME)).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CLI_OUTPUT",
    });
  });
});

// ---------------------------------------------------------------------------
// Fixed model-facing message set (contract requirement: every reachable
// model-facing rejection message is a member of a fixed, non-interpolated
// set — proving no script name, stdout, or filesystem path is ever
// echoed into a message string).
// ---------------------------------------------------------------------------

const SCRIPT_NAME_REJECTION_MESSAGE =
  "the script name did not pass this tool's allowed-name check";
const CLI_SPAWN_REJECTION_MESSAGE =
  "the CLI process could not be run to completion";
const CLI_OUTPUT_REJECTION_MESSAGE =
  "the CLI exited with an unacceptable status or produced output that could not be parsed";

// V9 slice 2a adds a fourth reachable model-facing message: `run`'s preset
// rejection. It is deliberately its own string rather than a reuse of
// SCRIPT_NAME_REJECTION_MESSAGE — the two name a different argument — but it
// is just as fixed, and every preset failure mode collapses onto it.
const PRESET_NAME_REJECTION_MESSAGE =
  "the preset name did not pass this tool's allowed-name check";

// V9 log-triage slice: `triageRun`'s third `operatorProfile` parameter is the
// SAME value `steps/build-triage-tools.ts` stamped into a judged action's
// `target.profile` — an empty string would hand the child no usable target
// while the parent had already graded a real one, so it must reject before
// anything spawns. Reuses `ERR_AGENT_OPERATOR_CONFIG`, the code already
// documented for "a caller supplied a value this seam does not accept"
// (`assertRunMode`'s `mode` rejection), rather than minting an eleventh code
// for the same class of caller-supplied-value failure.
const OPERATOR_PROFILE_REJECTION_MESSAGE =
  "the operator profile must be a non-empty string";

const FIXED_MODEL_FACING_MESSAGES: readonly string[] = [
  SCRIPT_NAME_REJECTION_MESSAGE,
  CLI_SPAWN_REJECTION_MESSAGE,
  CLI_OUTPUT_REJECTION_MESSAGE,
  PRESET_NAME_REJECTION_MESSAGE,
];

// ---------------------------------------------------------------------------
// M2 — workspace-root scrub threading. `model-safety.ts`'s
// `AgentOperatorProjectionOptions.workspaceRoot` scrub is dead on every
// production path today: none of the four `project*` call sites in
// `cli-surface.ts` (`:343,362,381,401`) forward it, and
// `CreateAgentCliSurfaceOptions` has no `workspaceRoot` field at all. These
// tests drive the real `createAgentCliSurface` through the injected
// `runProcess` seam with a synthetic root baked into fixture text (never the
// real cwd), and must fail RED today because the raw root survives into the
// projection.
// ---------------------------------------------------------------------------

const FAKE_WORKSPACE_ROOT = "/fake/workspace/root";

describe("createAgentCliSurface — workspace-root scrub threading (M2)", () => {
  test("doctor() scrubs a detail equal to the raw workspace root", async () => {
    const { deps, fake } = createDeps({ workspaceRoot: FAKE_WORKSPACE_ROOT });
    fake.enqueueResult(
      exitedResult({
        stdout: makeDoctorPayload([
          makeDoctorCheck({
            name: "workspace-root",
            detail: FAKE_WORKSPACE_ROOT,
          }),
        ]),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const report = await surface.doctor();

    const check = report.checks.find((c) => c.name === "workspace-root");
    expect(check).toBeDefined();
    expect(check?.detail).toContain("<workspace>");
    expect(check?.detail).not.toContain(FAKE_WORKSPACE_ROOT);
    expect(JSON.stringify(report)).not.toContain(FAKE_WORKSPACE_ROOT);
  });

  test("doctor() scrubs BOTH occurrences of the root in a checkImportability-style detail — a non-global replace would only fix the first", async () => {
    const { deps, fake } = createDeps({ workspaceRoot: FAKE_WORKSPACE_ROOT });
    const leakyDetail =
      `Cannot find module '${FAKE_WORKSPACE_ROOT}/scripts/json-etl/dist/config.js' ` +
      `imported from '${FAKE_WORKSPACE_ROOT}/packages/m3l-cli/dist/x.js'`;
    fake.enqueueResult(
      exitedResult({
        stdout: makeDoctorPayload([
          makeDoctorCheck({ name: "importability", detail: leakyDetail }),
        ]),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const report = await surface.doctor();

    const check = report.checks.find((c) => c.name === "importability");
    expect(check).toBeDefined();
    expect(check?.detail).not.toContain(FAKE_WORKSPACE_ROOT);
    const scrubbedOccurrences = check?.detail.match(/<workspace>/g) ?? [];
    expect(scrubbedOccurrences).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain(FAKE_WORKSPACE_ROOT);
  });

  test("inspect(name) scrubs the root from both description and defaultValue", async () => {
    const { deps, fake } = createDeps({ workspaceRoot: FAKE_WORKSPACE_ROOT });
    fake.enqueueResult(
      exitedResult({
        stdout: makeInspectPayload([
          makeParamDescriptor({
            secret: false,
            description: `resolved config path is ${FAKE_WORKSPACE_ROOT}/config.json`,
            defaultValue: `${FAKE_WORKSPACE_ROOT}/data`,
          }),
        ]),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const descriptors = await surface.inspect(DRY_RUN_ALLOWED_NAME);

    const descriptor = descriptors[0];
    expect(descriptor).toBeDefined();
    expect(descriptor?.description).toContain("<workspace>");
    expect(descriptor?.description).not.toContain(FAKE_WORKSPACE_ROOT);
    expect(descriptor?.defaultValue).toContain("<workspace>");
    expect(descriptor?.defaultValue).not.toContain(FAKE_WORKSPACE_ROOT);
    expect(JSON.stringify(descriptors)).not.toContain(FAKE_WORKSPACE_ROOT);
  });

  test("dryRun(name) scrubs the root from the projected run envelope", async () => {
    const { deps, fake } = createDeps({ workspaceRoot: FAKE_WORKSPACE_ROOT });
    fake.enqueueResult(
      exitedResult({
        stdout: makeRunEnvelopePayload({
          // `script` is the only free-text field on the run envelope (every
          // other field is a validated enum/timestamp/count — see
          // `projectRunEnvelope`'s own TSDoc) — so it is the vector this
          // scenario proves is threaded, even though a well-behaved CLI
          // normally echoes back only the bare, already-validated name.
          script: `${FAKE_WORKSPACE_ROOT}/scripts/${DRY_RUN_ALLOWED_NAME}`,
        }),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const envelope = await surface.dryRun(DRY_RUN_ALLOWED_NAME);

    expect(envelope.script).not.toContain(FAKE_WORKSPACE_ROOT);
    expect(JSON.stringify(envelope)).not.toContain(FAKE_WORKSPACE_ROOT);
  });

  test("control: with no workspaceRoot supplied, doctor() still resolves and performs no scrub", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(
      exitedResult({
        stdout: makeDoctorPayload([
          makeDoctorCheck({
            name: "workspace-root",
            detail: FAKE_WORKSPACE_ROOT,
          }),
        ]),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const report = await surface.doctor();

    const check = report.checks.find((c) => c.name === "workspace-root");
    expect(check).toBeDefined();
    // No workspaceRoot means nothing to scrub — the raw text passes through
    // unchanged (`options` staying optional must not make the method throw).
    expect(check?.detail).toBe(FAKE_WORKSPACE_ROOT);
  });
});

describe("createAgentCliSurface — fixed model-facing rejection messages", () => {
  test("a flag-injection rejection uses the fixed script-name message", async () => {
    const { deps } = createDeps();
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() => surface.inspect("-h"));

    expect((thrown as Core.M3LError).message).toBe(
      SCRIPT_NAME_REJECTION_MESSAGE,
    );
  });

  test("a spawn-layer rejection uses the fixed CLI-spawn message", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(spawnFailedResult());
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() => surface.list());

    expect((thrown as Core.M3LError).message).toBe(CLI_SPAWN_REJECTION_MESSAGE);
  });

  test("an output-policy rejection uses the fixed CLI-output message", async () => {
    const { deps, fake } = createDeps();
    fake.enqueueResult(
      exitedResult({ exitCode: 1, stdout: makeListPayload() }),
    );
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() => surface.list());

    expect((thrown as Core.M3LError).message).toBe(
      CLI_OUTPUT_REJECTION_MESSAGE,
    );
  });

  test("every message observed above is a member of the fixed allowlist", () => {
    // Declared here per the contract's requirement, rather than only
    // inferred from the three tests above — this is the explicit gate a
    // future added rejection path must also satisfy.
    expect(FIXED_MODEL_FACING_MESSAGES).toHaveLength(4);
    expect(new Set(FIXED_MODEL_FACING_MESSAGES).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// V9 slice 2a — `run(scriptName, presetName)`, the mutating counterpart to
// `dryRun`. Two things make this method different from every method above:
//
//  1. It carries a SECOND caller-supplied value (the preset name), so the
//     "the model supplies exactly one value" claim in this module's header
//     becomes "two values, both allowlisted" — the preset name by MEMBERSHIP
//     in the operator-declared `presetAllowlist`, not by a regex alone.
//  2. The token it emits is a **filesystem path**, and `m3l run` spawns the
//     child with `cwd: scriptDirectory` (not the workspace root) while
//     `M3LScriptPresetLoader.load` does a bare `path.resolve(filePath)`. A
//     workspace-relative token would therefore resolve under
//     `scripts/<name>/` and silently load the wrong file (or none). The
//     emitted path MUST be absolute — that is what the joining tests below
//     exist to prove, and they are written to fail if someone forwards the
//     relative path the allowlist stores.
//
// The shared `tests/support/cliFakes.ts` fake records only `args`, so these
// tests inject a local recording seam that captures the whole options bag —
// `timeoutMs` included, since "which timeout did this method forward?" is
// part of the contract and invisible to a call-args-only fake.
// ---------------------------------------------------------------------------

/** One recorded `runProcess` invocation: its argv plus its forwarded timeout. */
interface RecordedInvocation {
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** A `runProcess` seam that records the full options bag, not just `args`. */
interface RecordingRunProcess {
  readonly runProcess: typeof runCliProcess;
  readonly invocations: readonly RecordedInvocation[];
  enqueueResult(result: CliRunResult): void;
}

function createRecordingRunProcess(): RecordingRunProcess {
  const invocations: RecordedInvocation[] = [];
  const queue: CliRunResult[] = [];
  const runProcess: typeof runCliProcess = (options) => {
    invocations.push({ args: [...options.args], timeoutMs: options.timeoutMs });
    const next = queue.shift();
    if (next === undefined) {
      // A forgotten `enqueueResult` is a fixture bug, not a scenario — fail
      // loudly rather than resolving `undefined` into the surface.
      return Promise.reject(
        new Error(
          `createRecordingRunProcess: no CliRunResult queued for call #${String(invocations.length)}`,
        ),
      );
    }
    return Promise.resolve(next);
  };
  return {
    runProcess,
    invocations,
    enqueueResult(result) {
      queue.push(result);
    },
  };
}

// Deliberately NOT `DRY_RUN_ALLOWED_NAME`: `run` is gated by the V6 policy
// layer, never by `dryRunAllowlist` (a `--dry-run` opt-in list). Using a
// script name absent from that set means a helper copy-pasted from
// `assertDryRunEligible` without dropping the membership check fails here.
const RUN_SCRIPT_NAME = "warehouse-sync";

const RUN_CLI_TIMEOUT_MS = 11_000;
const RUN_DRY_RUN_TIMEOUT_MS = 222_000;

/** The absolute token `run` must emit, derived from the injected root. */
const EXPECTED_PRESET_PATH = path.join(
  FAKE_WORKSPACE_ROOT,
  PRESET_RELATIVE_PATH,
);

const EXPECTED_RUN_ARGV: readonly string[] = [
  "run",
  RUN_SCRIPT_NAME,
  "--json",
  "--",
  `--preset=${EXPECTED_PRESET_PATH}`,
];

/**
 * The dry-run variant: identical argv with `--dry-run` appended LAST, after
 * the `--preset=` token. Both live after the bare `--`, so both are
 * forwarded verbatim to the child script.
 */
const EXPECTED_DRY_RUN_ARGV: readonly string[] = [
  ...EXPECTED_RUN_ARGV,
  "--dry-run",
];

/** Builds `run`-flavoured deps around the recording seam. */
function createRunDeps(overrides: Partial<AgentCliSurfaceDeps> = {}): {
  readonly deps: AgentCliSurfaceDeps;
  readonly recorder: RecordingRunProcess;
} {
  const recorder = createRecordingRunProcess();
  const { deps } = createDeps({
    cliTimeoutMs: RUN_CLI_TIMEOUT_MS,
    dryRunTimeoutMs: RUN_DRY_RUN_TIMEOUT_MS,
    workspaceRoot: FAKE_WORKSPACE_ROOT,
    runProcess: recorder.runProcess,
    ...overrides,
  });
  return { deps, recorder };
}

describe("createAgentCliSurface — run() argv", () => {
  test("run(script, preset, { mode: 'mutate' }) sends exactly ['run', script, '--json', '--', '--preset=<absolute>'] and NO --dry-run", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(
      exitedResult({ stdout: makeRunEnvelopePayload({ outcome: "success" }) }),
    );
    const surface = createAgentCliSurface(deps);

    await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" });

    expect(recorder.invocations.map((call) => call.args)).toEqual([
      EXPECTED_RUN_ARGV,
    ]);
    // A mutating run that silently carried `--dry-run` would report success
    // while changing nothing — assert its absence explicitly, not just via
    // the array equality above.
    expect(recorder.invocations[0]?.args).not.toContain("--dry-run");
  });

  test("run() emits the preset path joined onto workspaceRoot — never the workspace-relative path the allowlist stores", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" });

    const argv = recorder.invocations[0]?.args ?? [];
    const presetToken = argv.find((arg) => arg.startsWith("--preset="));
    expect(presetToken).toBeDefined();
    const emittedPath = (presetToken ?? "").slice("--preset=".length);
    // The three-way pin: absolute, anchored at the injected root, and NOT
    // the relative string the allowlist holds. `m3l run` spawns the child
    // with `cwd: scriptDirectory`, so the relative form resolves under
    // `scripts/<name>/` — this is the assertion that fails if someone
    // forwards `PRESET_RELATIVE_PATH` verbatim.
    expect(path.isAbsolute(emittedPath)).toBe(true);
    expect(emittedPath).toBe(EXPECTED_PRESET_PATH);
    expect(emittedPath).not.toBe(PRESET_RELATIVE_PATH);
    expect(presetToken).not.toBe(`--preset=${PRESET_RELATIVE_PATH}`);
  });

  test("run() puts --json before the bare -- and --preset= after it", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" });

    const argv = recorder.invocations[0]?.args ?? [];
    const jsonIndex = argv.indexOf("--json");
    const dashIndex = argv.indexOf("--");
    const presetIndex = argv.findIndex((arg) => arg.startsWith("--preset="));
    // Same reasoning as the `dryRun` ordering test: `partitionJsonFlag` only
    // strips `--json` when it precedes the bare `--`, and only args AFTER
    // the `--` are forwarded verbatim to the child script. The attached
    // `--preset=<path>` form is required because the child's `parseArgv`
    // splits on the first `=`; a detached `--preset <path>` pair would not
    // bind.
    expect(jsonIndex).toBeGreaterThanOrEqual(0);
    expect(dashIndex).toBeGreaterThan(jsonIndex);
    expect(presetIndex).toBeGreaterThan(dashIndex);
  });

  test("run() forwards dryRunTimeoutMs, not cliTimeoutMs", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" });

    expect(recorder.invocations[0]?.timeoutMs).toBe(RUN_DRY_RUN_TIMEOUT_MS);
    expect(recorder.invocations[0]?.timeoutMs).not.toBe(RUN_CLI_TIMEOUT_MS);
  });
});

describe("createAgentCliSurface — run() exit policy", () => {
  test("run() accepts any exit code, resolving with the envelope's own exitCode/outcome", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(
      exitedResult({
        exitCode: 6,
        stdout: makeRunEnvelopePayload({ exitCode: 6, outcome: "partial" }),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const envelope = await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
      mode: "mutate",
    });

    // Same policy as `dryRun`: the envelope carries its own outcome, so a
    // non-zero child exit is data, not a failure of this tool.
    expect(envelope.exitCode).toBe(6);
    expect(envelope.outcome).toBe("partial");
  });
});

// A preset name the `/^[a-z0-9-]+$/` shape check itself rejects (bad chars,
// empty, or over the 64-char cap).
const INVALID_PRESET_NAMES = [
  "",
  "Nightly",
  "night_ly",
  "night ly",
  "a;rm -rf /",
  "../../etc/passwd",
  "n".repeat(65),
  "a\0b",
] as const;

// Preset names the shape check ACCEPTS (the pattern admits `-`-leading and
// all-digit names) but which the operator never declared. Membership, not
// the pattern, is what rejects these.
const UNLISTED_PRESET_NAMES = ["weekly", "--json", "-h", "123", "--"] as const;

describe("createAgentCliSurface — run() preset rejection", () => {
  test.each(INVALID_PRESET_NAMES)(
    "run(script, %p) rejects with ERR_AGENT_OPERATOR_PRESET and spawns nothing (shape)",
    async (presetName) => {
      const { deps, recorder } = createRunDeps();
      const surface = createAgentCliSurface(deps);

      await expect(
        surface.run(RUN_SCRIPT_NAME, presetName, { mode: "mutate" }),
      ).rejects.toMatchObject({
        code: "ERR_AGENT_OPERATOR_PRESET",
        message: PRESET_NAME_REJECTION_MESSAGE,
      });
      expect(recorder.invocations).toEqual([]);
    },
  );

  test.each(UNLISTED_PRESET_NAMES)(
    "run(script, %p) rejects with ERR_AGENT_OPERATOR_PRESET and spawns nothing (membership)",
    async (presetName) => {
      const { deps, recorder } = createRunDeps();
      const surface = createAgentCliSurface(deps);

      await expect(
        surface.run(RUN_SCRIPT_NAME, presetName, { mode: "mutate" }),
      ).rejects.toMatchObject({
        code: "ERR_AGENT_OPERATOR_PRESET",
        message: PRESET_NAME_REJECTION_MESSAGE,
      });
      expect(recorder.invocations).toEqual([]);
    },
  );

  test("an invalid preset name and a valid-but-unlisted one are INDISTINGUISHABLE — identical message and identical code", async () => {
    const { deps: shapeDeps, recorder: shapeRecorder } = createRunDeps();
    const shapeSurface = createAgentCliSurface(shapeDeps);
    const { deps: listDeps, recorder: listRecorder } = createRunDeps();
    const listSurface = createAgentCliSurface(listDeps);

    // Arm 1: fails the shape check. Arm 2: passes it (`weekly` matches
    // `/^[a-z0-9-]+$/`) and fails only membership — so BOTH arms are
    // genuinely reachable in this test's own setup, and the equality below
    // is a real property rather than two copies of one code path.
    const shapeError = await captureRejection(() =>
      shapeSurface.run(RUN_SCRIPT_NAME, "Nightly", { mode: "mutate" }),
    );
    const listError = await captureRejection(() =>
      listSurface.run(RUN_SCRIPT_NAME, "weekly", { mode: "mutate" }),
    );

    expect(shapeError).toBeInstanceOf(Core.M3LError);
    expect(listError).toBeInstanceOf(Core.M3LError);
    const shape = shapeError as Core.M3LError;
    const list = listError as Core.M3LError;
    // The load-bearing assertion: equal to EACH OTHER. If a model can tell
    // "not a well-formed name" from "a well-formed name you are not allowed
    // to use", it can probe the allowlist one guess at a time.
    expect(shape.message).toBe(list.message);
    expect(shape.code).toBe(list.code);
    // ...and both are the fixed, documented pair (so the test cannot pass
    // by both arms failing the same unrelated way).
    expect(shape.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
    expect(shape.code).toBe("ERR_AGENT_OPERATOR_PRESET");
    expect(shapeRecorder.invocations).toEqual([]);
    expect(listRecorder.invocations).toEqual([]);
  });

  test("the rejection message never echoes the supplied preset name — not a traversal sequence, not a shell metacharacter", async () => {
    const { deps, recorder } = createRunDeps();
    const hostile = "../../etc/passwd;rm -rf /";
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() =>
      surface.run(RUN_SCRIPT_NAME, hostile, { mode: "mutate" }),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const message = (thrown as Core.M3LError).message;
    expect(message).toBe(PRESET_NAME_REJECTION_MESSAGE);
    expect(message).not.toContain(hostile);
    expect(message).not.toContain("..");
    expect(message).not.toContain("/etc/passwd");
    expect(message).not.toContain(";");
    expect(recorder.invocations).toEqual([]);
  });

  test("run() with an unusable script name rejects with ERR_AGENT_OPERATOR_SCRIPT_NAME and spawns nothing", async () => {
    const { deps, recorder } = createRunDeps();
    const surface = createAgentCliSurface(deps);

    await expect(
      surface.run("-h", PRESET_ALLOWED_NAME, { mode: "mutate" }),
    ).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    });
    expect(recorder.invocations).toEqual([]);
  });
});

describe("createAgentCliSurface — run() without workspaceRoot", () => {
  test("run() rejects with the fixed preset message when the surface was built with no workspaceRoot, rather than emitting a relative or 'undefined/...' path", async () => {
    const recorder = createRecordingRunProcess();
    // `workspaceRoot` is optional on `CreateAgentCliSurfaceOptions` (it only
    // enables the scrub for the other four methods), so this construction is
    // legal — but `run` cannot build an absolute preset path without it. It
    // must fail loudly instead of silently emitting a relative token or an
    // interpolated `undefined`.
    const { deps } = createDeps({ runProcess: recorder.runProcess });
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() =>
      surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" }),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe("ERR_AGENT_OPERATOR_PRESET");
    expect(error.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
    // The whole point: no spawn happened, so no relative `--preset=` token
    // and no `undefined/...` path ever reached the CLI.
    expect(recorder.invocations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The `mode: "dry-run"` variant of `run`. It exists so slice 2b's two-phase
// pass can call `run(n, p, { mode: "dry-run" })` and then
// `run(n, p, { mode: "mutate" })` on one signature — and so the `--dry-run`
// argv branch is reachable HERE, where the argv is under test, rather than
// shipping dark until a later slice wires a caller.
//
// M3 replaced the old `options?: { dryRun?: boolean }` with a REQUIRED
// discriminator, so the pre-fix rows (`{}`, `{ dryRun: false }`) are gone:
// they no longer typecheck, and the truthiness-vs-`=== true` property they
// guarded cannot exist without a default. What replaces them is the
// type-level pin in the "requires an explicit mode" describe below — the
// absence of a default is now itself part of the contract.
// ---------------------------------------------------------------------------

describe("createAgentCliSurface — run() dry-run variant", () => {
  test("run(script, preset, { mode: 'dry-run' }) sends exactly ['run', script, '--json', '--', '--preset=<absolute>', '--dry-run'] with --dry-run LAST", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(
      exitedResult({ stdout: makeRunEnvelopePayload({ outcome: "dry-run" }) }),
    );
    const surface = createAgentCliSurface(deps);

    await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
      mode: "dry-run",
    });

    expect(recorder.invocations.map((call) => call.args)).toEqual([
      EXPECTED_DRY_RUN_ARGV,
    ]);
    // Position, not presence: `--dry-run` is appended after the `--preset=`
    // token, and both sit after the bare `--`.
    const argv = recorder.invocations[0]?.args ?? [];
    expect(argv.at(-1)).toBe("--dry-run");
    expect(argv.indexOf("--dry-run")).toBeGreaterThan(
      argv.findIndex((arg) => arg.startsWith("--preset=")),
    );
  });

  test("the dry-run variant still forwards dryRunTimeoutMs, not cliTimeoutMs", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
      mode: "dry-run",
    });

    expect(recorder.invocations[0]?.timeoutMs).toBe(RUN_DRY_RUN_TIMEOUT_MS);
    expect(recorder.invocations[0]?.timeoutMs).not.toBe(RUN_CLI_TIMEOUT_MS);
  });

  test("the dry-run variant still accepts any exit code, resolving with the envelope's own exitCode/outcome", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(
      exitedResult({
        exitCode: 6,
        stdout: makeRunEnvelopePayload({ exitCode: 6, outcome: "partial" }),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const envelope = await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
      mode: "dry-run",
    });

    expect(envelope.exitCode).toBe(6);
    expect(envelope.outcome).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// M3 — the required `mode` discriminator. The runtime halves of this fix are
// already covered above (the `mutate` argv and the `dry-run` argv), so what
// is left is the part only the type system can hold: that there is NO
// default. `run(s, p)` used to emit the MUTATING argv, which is the wrong
// polarity for a guarded-mutation seam and the reason slice 2b — which will
// feed this method from model-supplied JSON typed `unknown` — must not be
// able to omit the option at all.
// ---------------------------------------------------------------------------

describe("createAgentCliSurface — run() requires an explicit mode (M3)", () => {
  test("run's third parameter is required, and mode is a closed two-member union", () => {
    expectTypeOf<Parameters<AgentCliSurface["run"]>>().toEqualTypeOf<
      [string, string, { readonly mode: "dry-run" | "mutate" }]
    >();
    // Arity is the load-bearing half: an OPTIONAL third parameter widens
    // `length` to `2 | 3`, so this equality is what fails if a later change
    // re-introduces a default by making `options` optional again.
    expectTypeOf<
      Parameters<AgentCliSurface["run"]>["length"]
    >().toEqualTypeOf<3>();
  });

  test("run(s, p), run(s, p, {}), an unknown mode and the old dryRun shape are each compile errors", () => {
    const { deps } = createRunDeps();
    const surface = createAgentCliSurface(deps);

    // Declared, never invoked: the assertion IS the compile error on each
    // line. While `options` is still optional and `dryRun`-shaped, every
    // directive below is an unused-`@ts-expect-error` diagnostic — that is
    // the RED signal for M3. Once the required `mode` lands, each directive
    // absorbs a real error and this file typechecks clean.
    const compileErrorProbes = (): void => {
      // @ts-expect-error -- `options` is REQUIRED: there is no default mode.
      void surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME);
      // @ts-expect-error -- `{}` omits the required `mode` discriminator.
      void surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {});
      // Hoisted to keep the call on ONE line: a `@ts-expect-error`
      // suppresses only the line that follows it, and TS reports a bad
      // member on the member's own line — a wrapped call would leave this
      // directive unused (a false GREEN failure).
      const mutant = { mode: "mutant" } as const;
      // @ts-expect-error -- "mutant" is not a member of the `mode` union.
      void surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, mutant);
      // @ts-expect-error -- the pre-fix `{ dryRun: boolean }` shape is gone.
      void surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { dryRun: true });
    };

    // The probes must exist for `tsc` to see them; nothing here spawns.
    expect(compileErrorProbes).toBeTypeOf("function");
  });
});

// ---------------------------------------------------------------------------
// M1 — the brand that actually protects the argv. `AgentOperatorPresetName`
// is minted by the name check but never appears in a field or parameter
// position, so the value that reaches argv — the resolved PATH — is an
// unbranded `string` today. The fix mints `AgentOperatorPresetPath` in
// `resolveAllowedPresetPath` and types the `run` union member with it.
//
// The union and the resolver are both module-private, so these are the
// reachable assertions: the exported brand exists, a bare `string` cannot
// stand in for it, and it cannot be confused with either NAME brand. NOTE:
// these tests are type-only — they pass at RUNTIME even in RED (type
// imports erase), so `pnpm exec tsc` is the gate that reports M1, not
// `vitest`.
// ---------------------------------------------------------------------------

describe("preset path brand (M1)", () => {
  test("a bare string is NOT assignable to AgentOperatorPresetPath, but the brand is a string", () => {
    expectTypeOf<string>().not.toExtend<AgentOperatorPresetPath>();
    // The brand must stay a `string` subtype: `buildArgv` interpolates it
    // into the `--preset=` token without a conversion step.
    expectTypeOf<AgentOperatorPresetPath>().toExtend<string>();
  });

  test("the path brand is mutually non-assignable with both name brands", () => {
    // Each brand's own `unique symbol` is what makes these four directions
    // fail: a validated preset NAME must not be usable where the resolved
    // PATH is expected (that swap is exactly how a relative, unanchored
    // value would reach argv), and a script name must not be either.
    expectTypeOf<AgentOperatorPresetPath>().not.toExtend<AgentOperatorPresetName>();
    expectTypeOf<AgentOperatorPresetName>().not.toExtend<AgentOperatorPresetPath>();
    expectTypeOf<AgentOperatorPresetPath>().not.toExtend<AgentOperatorScriptName>();
    expectTypeOf<AgentOperatorScriptName>().not.toExtend<AgentOperatorPresetPath>();
  });
});

// ---------------------------------------------------------------------------
// M2 + S3 — the three collapsed preset rejections must stay identical to the
// MODEL and distinguishable to an OPERATOR. The model-facing collapse is
// what stops the allowlist being enumerated one guess at a time; the missing
// `cause` is what made a standalone-mode wiring defect (a `deriveWorkspaceRoot`
// that returned `undefined`) look, forever, like a bad preset name.
// ---------------------------------------------------------------------------

/**
 * Asserts the fixed model-facing pair on a captured preset rejection and
 * returns its `cause`'s message — the operator-only channel M2/S3 add.
 */
function presetCauseMessage(thrown: unknown): string {
  expect(thrown).toBeInstanceOf(Core.M3LError);
  const error = thrown as Core.M3LError;
  expect(error.code).toBe("ERR_AGENT_OPERATOR_PRESET");
  expect(error.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
  const cause: unknown = error.cause;
  expect(cause).toBeInstanceOf(Error);
  return (cause as Error).message;
}

describe("createAgentCliSurface — collapsed preset rejections keep an operator-facing cause (M2 + S3)", () => {
  test("all three arms share one message and code, yet carry three DISTINCT causes", async () => {
    // Arm 1 — shape: "Nightly" fails the name check.
    const { deps: shapeDeps, recorder: shapeRecorder } = createRunDeps();
    // Arm 2 — membership: "weekly" PASSES the name check (it matches
    // `/^[a-z0-9-]+$/`) and fails only the allowlist lookup, so this arm is
    // genuinely reachable rather than a second copy of arm 1.
    const { deps: listDeps, recorder: listRecorder } = createRunDeps();
    // Arm 3 — wiring: a valid, LISTED name against a surface built with no
    // `workspaceRoot` (standalone mode). Reachable only because both checks
    // above pass first, which is precisely why its rejection is so
    // misleading today.
    const wiringRecorder = createRecordingRunProcess();
    const { deps: wiringDeps } = createDeps({
      runProcess: wiringRecorder.runProcess,
    });

    const shapeMessage = presetCauseMessage(
      await captureRejection(() =>
        createAgentCliSurface(shapeDeps).run(RUN_SCRIPT_NAME, "Nightly", {
          mode: "mutate",
        }),
      ),
    );
    const membershipMessage = presetCauseMessage(
      await captureRejection(() =>
        createAgentCliSurface(listDeps).run(RUN_SCRIPT_NAME, "weekly", {
          mode: "mutate",
        }),
      ),
    );
    const wiringMessage = presetCauseMessage(
      await captureRejection(() =>
        createAgentCliSurface(wiringDeps).run(
          RUN_SCRIPT_NAME,
          PRESET_ALLOWED_NAME,
          { mode: "mutate" },
        ),
      ),
    );

    // The operator-facing halves must differ from EACH OTHER — a shared
    // "preset rejected" cause on all three would re-create the defect with
    // extra ceremony.
    expect(new Set([shapeMessage, membershipMessage, wiringMessage]).size).toBe(
      3,
    );
    // ...and each must be non-empty, so "distinct" cannot be satisfied by
    // near-empty placeholder text.
    for (const message of [shapeMessage, membershipMessage, wiringMessage]) {
      expect(message.length).toBeGreaterThan(0);
    }
    // No spawn on any arm.
    expect(shapeRecorder.invocations).toEqual([]);
    expect(listRecorder.invocations).toEqual([]);
    expect(wiringRecorder.invocations).toEqual([]);
  });

  test("only the wiring arm's cause names the workspace root — the two name arms must not send an operator hunting for one", async () => {
    // This is the semantic half of "distinct": three different strings are
    // worthless if the wiring defect's cause still talks about a preset
    // name. `workspaceRoot` is the field an operator greps for, so it is
    // safe to pin (the exact prose is not).
    const wiringRecorder = createRecordingRunProcess();
    const { deps: wiringDeps } = createDeps({
      runProcess: wiringRecorder.runProcess,
    });
    const { deps: listDeps } = createRunDeps();
    const { deps: shapeDeps } = createRunDeps();

    const wiringMessage = presetCauseMessage(
      await captureRejection(() =>
        createAgentCliSurface(wiringDeps).run(
          RUN_SCRIPT_NAME,
          PRESET_ALLOWED_NAME,
          { mode: "mutate" },
        ),
      ),
    );
    const membershipMessage = presetCauseMessage(
      await captureRejection(() =>
        createAgentCliSurface(listDeps).run(RUN_SCRIPT_NAME, "weekly", {
          mode: "mutate",
        }),
      ),
    );
    const shapeMessage = presetCauseMessage(
      await captureRejection(() =>
        createAgentCliSurface(shapeDeps).run(RUN_SCRIPT_NAME, "Nightly", {
          mode: "mutate",
        }),
      ),
    );

    expect(wiringMessage).toMatch(/workspace\s?root/i);
    expect(membershipMessage).not.toMatch(/workspace\s?root/i);
    expect(shapeMessage).not.toMatch(/workspace\s?root/i);
  });

  test("the SHAPE arm's cause never echoes the model-supplied preset name", async () => {
    // The shape arm is the one whose input is arbitrary model text — control
    // bytes, traversal, shell metacharacters. Its `cause` is written by
    // `assertAllowedPresetName`, whose whole contract is a fixed message.
    // (The MEMBERSHIP arm is different on purpose: by then the name has
    // already passed `[a-z0-9-]{1,64}`, so the fix contract says it is
    // injection-safe to carry there — this test deliberately does NOT
    // assert its absence in that arm.)
    const { deps, recorder } = createRunDeps();
    const hostile = "../../etc/passwd;rm -rf /";

    const message = presetCauseMessage(
      await captureRejection(() =>
        createAgentCliSurface(deps).run(RUN_SCRIPT_NAME, hostile, {
          mode: "mutate",
        }),
      ),
    );

    expect(message).not.toContain(hostile);
    expect(message).not.toContain("..");
    expect(message).not.toContain("/etc/passwd");
    expect(message).not.toContain(";");
    expect(recorder.invocations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S8 — `workspaceRoot` must be ABSOLUTE on the `run` path. The current check
// is `!== undefined`, so a surface built with `""` emitted
// `--preset=data/config/presets/...` — a RELATIVE token, the exact outcome
// `resolveAllowedPresetPath`'s own docstring says must never happen (the CLI
// spawns the child with `cwd: scriptDirectory`, so a relative token resolves
// under `scripts/<name>/` and loads the wrong file, or none).
// ---------------------------------------------------------------------------

// Labelled rows, and `%s` rather than `%p`: this vitest version leaves `%p`
// un-interpolated (visible on the older rows above), which would give the
// two arms identical titles and make a failure ambiguous.
const NON_ABSOLUTE_WORKSPACE_ROOTS = [
  ["an empty string", ""],
  ["a relative path", "relative/root"],
] as const;

describe("createAgentCliSurface — run() requires an absolute workspaceRoot (S8)", () => {
  test.each(NON_ABSOLUTE_WORKSPACE_ROOTS)(
    "run() rejects when workspaceRoot is %s, instead of emitting a relative --preset= token",
    async (_label, workspaceRoot) => {
      const { deps, recorder } = createRunDeps({ workspaceRoot });
      const surface = createAgentCliSurface(deps);

      const thrown = await captureRejection(() =>
        surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" }),
      );

      // Asserted FIRST on purpose: this is the finding (a relative
      // `--preset=` token reaching the CLI), so a RED failure here prints
      // the leaked argv rather than an error-type mismatch.
      expect(recorder.invocations).toEqual([]);
      expect(thrown).toBeInstanceOf(Core.M3LError);
      const error = thrown as Core.M3LError;
      // Same fixed pair as every other preset failure: an absoluteness
      // defect must not become a new, enumerable signal for the model.
      expect(error.code).toBe("ERR_AGENT_OPERATOR_PRESET");
      expect(error.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
    },
  );

  test("the non-absolute arm also carries an operator-facing cause", async () => {
    // M2's principle applied to the arm S8 introduces: a rejection with no
    // `cause` is what made the missing-`workspaceRoot` defect invisible in
    // the first place, and a non-absolute root is the same class of wiring
    // mistake. (Flagged in the RED report: the fix contract names causes for
    // M2/S3's two arms explicitly and is silent about this third one.)
    const { deps } = createRunDeps({ workspaceRoot: "relative/root" });

    const message = presetCauseMessage(
      await captureRejection(() =>
        createAgentCliSurface(deps).run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
          mode: "mutate",
        }),
      ),
    );

    expect(message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// S1 — containment is re-checked where the value is USED. Today the only
// guarantee lives in module-private `parsePresetAllowlist`, so a map handed
// straight to `createAgentCliSurface` (the shape this module's own
// `@example` demonstrates) reaches `path.join(workspaceRoot, value)`
// unchecked. Probes produced `--preset=/etc/passwd` from a directly
// constructed allowlist. These tests bypass `parsePresetAllowlist` on
// PURPOSE — that bypass is the finding.
// ---------------------------------------------------------------------------

const BYPASSING_ALLOWLIST_ROWS = [
  ["a `..` escape", "../../../etc/passwd"],
  ["an absolute value", "/etc/passwd"],
  ["a value outside data/config/presets/", "data/config/other/nightly.json"],
  // The bare-directory rows. An entry that is the presets DIRECTORY rather
  // than a file beneath it must reject too: `--preset=<a directory>` is not
  // a preset the CLI can load, and it is the one containment arm no earlier
  // row reaches.
  //
  // These two rows do NOT prove the same arm, and the difference is
  // recorded here rather than assumed. With the prefix at
  // `data/config/presets/` (trailing separator included):
  //   - the trailing-separator form is byte-identical to the prefix, so it
  //     clears the relative, `..`-free and `startsWith` arms and is rejected
  //     ONLY by the "longer than the prefix" arm — this row discriminates
  //     that arm.
  //   - the no-separator form is one character short of the prefix, so
  //     `startsWith` already rejects it and the length arm is never
  //     evaluated. It is a REGRESSION LOCK on the prefix comparison (a
  //     truncation, distinct in shape from the `data/config/other/` row
  //     above), not a proof of the bare-directory arm.
  // If the prefix is ever redefined WITHOUT its trailing separator, the two
  // rows swap roles — which is precisely why both are pinned.
  ["the bare presets directory", "data/config/presets/"],
  [
    "the bare presets prefix without a trailing separator",
    "data/config/presets",
  ],
] as const;

describe("createAgentCliSurface — run() re-checks allowlist containment at the use site (S1)", () => {
  test.each(BYPASSING_ALLOWLIST_ROWS)(
    "an allowlist built directly with %s rejects at run() instead of emitting a --preset= token",
    async (_label, relativePath) => {
      const { deps, recorder } = createRunDeps({
        presetAllowlist: new Map([[PRESET_ALLOWED_NAME, relativePath]]),
      });
      const surface = createAgentCliSurface(deps);

      const thrown = await captureRejection(() =>
        surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" }),
      );

      // Asserted FIRST: the probe finding is the EMITTED token
      // (`--preset=/etc/passwd`), so a RED failure here prints the leaked
      // argv instead of an error-type mismatch.
      expect(recorder.invocations).toEqual([]);
      // Not `not.toContain("--preset=" + relativePath)`: for the `..` and
      // absolute rows `path.join` NORMALISES the value (the probe's
      // `../../../etc/passwd` came out as `--preset=/etc/passwd`), so
      // matching the declared string would pass vacuously. Assert that NO
      // `--preset=` token was emitted at all.
      expect(
        recorder.invocations
          .flatMap((call) => [...call.args])
          .filter((arg) => arg.startsWith("--preset=")),
      ).toEqual([]);
      expect(thrown).toBeInstanceOf(Core.M3LError);
      const error = thrown as Core.M3LError;
      expect(error.code).toBe("ERR_AGENT_OPERATOR_PRESET");
      expect(error.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
    },
  );

  test("the emitted token for a CONTAINED entry still resolves under data/config/presets/ — the containment re-check must not reject the happy path", async () => {
    // The other half of S1: a use-site check that rejects everything would
    // pass every test above while breaking the seam. This pins that the
    // legal fixture still spawns exactly once with its anchored token.
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" });

    expect(recorder.invocations.map((call) => call.args)).toEqual([
      EXPECTED_RUN_ARGV,
    ]);
    expect(EXPECTED_PRESET_PATH).toContain("data/config/presets/");
  });
});

// ---------------------------------------------------------------------------
// S4 (adjacent) — the catch in `assertUsablePresetName` swallows EVERYTHING
// and re-throws a preset rejection, so the moment the name check grows a
// real check a `TypeError` would be laundered into "the preset name did not
// pass this tool's allowed-name check". Injecting a non-CliError from inside
// `assertAllowedPresetName` needs a module mock of `preset-names.js`, which
// this file deliberately does not do (it would hoist over every real-
// behaviour test here), so the true S4 arm is NOT covered — see the RED
// report.
//
// What IS injectable is the neighbouring lookup: a `ReadonlyMap` whose
// `get()` throws. That discriminates the realistic wrong fix for S1/M2 —
// wrapping the whole of `resolveAllowedPresetPath` in one try/catch that
// mints a preset rejection. NOTE: this test PASSES against the pre-fix code
// (there is no catch there yet), so it is a regression lock, not a proof of
// S4; re-confirm it still discriminates once the narrowed catch lands.
// ---------------------------------------------------------------------------

describe("createAgentCliSurface — run() does not launder an unexpected internal error (S4, adjacent)", () => {
  test("a TypeError raised by the allowlist's own get() propagates unchanged", async () => {
    class ThrowingAllowlist extends Map<string, string> {
      override get(): string | undefined {
        throw new TypeError("allowlist lookup is broken");
      }
    }
    const { deps, recorder } = createRunDeps({
      presetAllowlist: new ThrowingAllowlist([
        [PRESET_ALLOWED_NAME, PRESET_RELATIVE_PATH],
      ]),
    });
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() =>
      surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" }),
    );

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).not.toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as TypeError).message).toBe("allowlist lookup is broken");
    expect(recorder.invocations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M4 — the `mode` discriminator is COMPILE-TIME ONLY, and it still fails
// open to mutation. `dryRun: options.mode === "dry-run"` treats every value
// that is not the exact literal as "mutate", so a casting caller — which is
// exactly what slice 2b becomes when it hands this method a bag parsed out
// of model-supplied JSON — selects mutation by typo, by case, by a stray
// space, or by omitting the bag entirely.
//
// Every bag below is passed through a DELIBERATE cast. That is the point of
// the section: M3's required discriminator protects a caller who writes the
// object literal in TypeScript and protects NOTHING at runtime, and slice
// 2b's `unknown`-JSON path is not that caller. The fix is a positive runtime
// narrowing before the derivation — accept the two literals, reject
// everything else with a coded `M3LAgentOperatorCliError`, and let nothing
// unrecognised reach argv in EITHER mode.
//
// Each row enqueues a result, so pre-fix the call RESOLVES (the recorded
// argv is the finding) rather than tripping the fixture's empty-queue guard.
// ---------------------------------------------------------------------------

/** How a `run` call settled, plus every argv token that reached the seam. */
interface RunSettlement {
  readonly rejected: boolean;
  readonly thrown: unknown;
  readonly emittedArgs: readonly string[];
}

/**
 * Invokes `run` and reports how it settled WITHOUT throwing on a resolve —
 * `captureRejection` above throws its own error when the call resolves,
 * which would hide the leaked argv these rows exist to print.
 */
async function settleRun(
  invoke: () => Promise<unknown>,
  recorder: RecordingRunProcess,
): Promise<RunSettlement> {
  let rejected = false;
  let thrown: unknown;
  try {
    await invoke();
  } catch (error) {
    rejected = true;
    thrown = error;
  }
  return {
    rejected,
    thrown,
    emittedArgs: recorder.invocations.flatMap((call) => [...call.args]),
  };
}

/**
 * Asserts a settlement is a fail-closed, CODED rejection: nothing spawned,
 * and the thrown value carries an `agent-operator` code rather than being a
 * bare `TypeError` whose `.code` is `undefined` (what omitting the bag
 * produces today, so a caller narrowing on `.code` sees nothing at all).
 */
function assertCodedFailClosedRejection(
  settlement: RunSettlement,
): M3LAgentOperatorCliError {
  // Asserted FIRST: the finding is the EMITTED argv, so a RED failure prints
  // the mutating command line instead of an error-type mismatch.
  expect(settlement.emittedArgs).toEqual([]);
  expect(settlement.rejected).toBe(true);
  expect(settlement.thrown).toBeInstanceOf(M3LAgentOperatorCliError);
  // The bare-`TypeError` half of the finding, pinned separately: an
  // `M3LAgentOperatorCliError` is not a `TypeError`, so this fails loudly if
  // the "fix" is a thrown built-in rather than a coded error.
  expect(settlement.thrown).not.toBeInstanceOf(TypeError);
  const error = settlement.thrown as M3LAgentOperatorCliError;
  // Not pinned to one specific code: the fix contract requires "a coded
  // `M3LAgentOperatorCliError`" and leaves the choice of code (an existing
  // one or an eleventh) to the implementation. What must hold is that a
  // catch site narrowing on `.code` sees an agent-operator code.
  expect(error.code).toBeDefined();
  expect(typeof error.code).toBe("string");
  expect(error.code).toMatch(/^ERR_AGENT_OPERATOR_[A-Z_]+$/);
  return error;
}

/**
 * The bags that must all fail closed. Typed `unknown` and cast at the call
 * site — a `readonly [string, AgentCliRunOptions][]` table could not hold
 * them, which is the whole finding restated as a type.
 *
 * `%p` is NOT interpolated by this Vitest version (visible on older rows in
 * this file), so every row carries an explicit `%s` label; without one all
 * fourteen titles would render identically and a failure would be
 * unattributable.
 */
const UNRECOGNISED_RUN_MODE_BAGS: readonly (readonly [
  label: string,
  bag: unknown,
])[] = [
  ["an empty bag {}", {}],
  ["mode: undefined", { mode: undefined }],
  ["mode: null", { mode: null }],
  // Runtime-identical to omitting the third argument entirely: JS binds a
  // missing parameter to `undefined`, so `options.mode` throws the same bare
  // `TypeError` either way. Written as an explicit `undefined` because an
  // arity-erased cast of `surface.run` would trip `unbound-method` for no
  // extra coverage.
  ["the options bag omitted entirely (undefined at runtime)", undefined],
  // Near-miss of "mutate". Must REJECT rather than silently flipping to a
  // probe: a fix written as `dryRun: options.mode !== "mutate"` would pass
  // every dry-run row above and quietly turn this one into a no-op run that
  // reports success.
  ["an upper-case MUTATE", { mode: "MUTATE" }],
  ["a mixed-case Mutate", { mode: "Mutate" }],
  // Near-misses of "dry-run" — the DANGEROUS direction. Each of these
  // currently emits the mutating argv with no `--dry-run` token.
  ["a capitalised Dry-Run", { mode: "Dry-Run" }],
  ["an upper-case DRY-RUN", { mode: "DRY-RUN" }],
  ["a leading space before dry-run", { mode: " dry-run" }],
  ["a trailing space after dry-run", { mode: "dry-run " }],
  ["dry-run with the hyphen dropped (dryrun)", { mode: "dryrun" }],
  ["mode: 0", { mode: 0 }],
  ["mode: false", { mode: false }],
  ["mode: an array containing dry-run", { mode: ["dry-run"] }],
  // The pre-M3 shape. It has no `mode` at all, so it is an omission wearing
  // the old signature's clothes — and it currently mutates.
  ["the pre-fix { dryRun: true } shape", { dryRun: true }],
] as const;

describe("createAgentCliSurface — run() narrows mode at RUNTIME and fails closed (M4)", () => {
  test.each(UNRECOGNISED_RUN_MODE_BAGS)(
    "run() rejects %s instead of emitting any argv",
    async (_label, bag) => {
      const { deps, recorder } = createRunDeps();
      recorder.enqueueResult(
        exitedResult({ stdout: makeRunEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      const settlement = await settleRun(
        () =>
          // The cast is DELIBERATE and is the finding: the declared type
          // rejects this bag, and a caller that casts — slice 2b, handing
          // over a bag parsed from model-supplied JSON typed `unknown` — gets
          // no protection from it at runtime.
          surface.run(
            RUN_SCRIPT_NAME,
            PRESET_ALLOWED_NAME,
            bag as AgentCliRunOptions,
          ),
        recorder,
      );

      assertCodedFailClosedRejection(settlement);
    },
  );

  test("a boxed String('dry-run') fails closed rather than resolving to a mutating run", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);
    // A wrapper object, not a primitive: `=== "dry-run"` is false, so today
    // this selects MUTATION. Kept out of the table above because a boxed
    // primitive is the one row whose construction (not its value) is the
    // point — a `String` object is what `JSON.parse` reviver code and some
    // schema coercers hand back.
    const boxed = { mode: new String("dry-run") };

    const settlement = await settleRun(
      () =>
        surface.run(
          RUN_SCRIPT_NAME,
          PRESET_ALLOWED_NAME,
          boxed as unknown as AgentCliRunOptions,
        ),
      recorder,
    );

    assertCodedFailClosedRejection(settlement);
  });

  test("a bag parsed out of model-supplied JSON with mode 'dryrun' rejects — it must never mutate", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);
    // The decisive case. This expression typechecks with ZERO errors today
    // and emits the MUTATING argv, and it is precisely the shape slice 2b
    // will use: a model asks for a probe, mistypes the mode by one hyphen,
    // and the seam mutates. The cast is deliberate for that reason.
    const modelSupplied = JSON.parse('{"mode":"dryrun"}') as AgentCliRunOptions;

    const settlement = await settleRun(
      () => surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, modelSupplied),
      recorder,
    );

    const error = assertCodedFailClosedRejection(settlement);
    // The rejection must not echo the unrecognised value back to the model —
    // same non-interpolation rule every other rejection in this module obeys.
    expect(error.message).not.toContain("dryrun");
  });

  test("a near-miss of 'dry-run' must not fall through to the MUTATING argv", async () => {
    // The dangerous direction stated as its own assertion rather than as a
    // by-product of "nothing was emitted": a caller who ASKED for a probe
    // and got a mutating run is the failure this whole seam exists to
    // prevent. `" dry-run"` (one leading space) is the cheapest way for
    // model-supplied JSON to produce it.
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    const settlement = await settleRun(
      () =>
        surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
          mode: " dry-run",
        } as unknown as AgentCliRunOptions),
      recorder,
    );

    // Pinned three ways, because "did not mutate" is the claim: no mutating
    // argv, no `--preset=` token at all, and no spawn.
    expect(settlement.emittedArgs).not.toEqual([...EXPECTED_RUN_ARGV]);
    expect(
      settlement.emittedArgs.filter((arg) => arg.startsWith("--preset=")),
    ).toEqual([]);
    expect(recorder.invocations).toEqual([]);
    assertCodedFailClosedRejection(settlement);
  });

  test("a near-miss of 'mutate' must reject rather than silently downgrade to a probe", async () => {
    // The other direction. If the runtime narrowing is written as a NEGATIVE
    // check (`mode !== "mutate"` selects a dry run), "MUTATE" resolves as a
    // probe: the operator believes a mutation happened, nothing changed, and
    // no error was raised. This row is what makes that wrong fix visible.
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    const settlement = await settleRun(
      () =>
        surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
          mode: "MUTATE",
        } as unknown as AgentCliRunOptions),
      recorder,
    );

    expect(settlement.emittedArgs).not.toContain("--dry-run");
    assertCodedFailClosedRejection(settlement);
  });
});

// The two literals the narrowing must keep accepting. These PASS today — a
// runtime narrowing that rejected them would be caught by the argv tests far
// above too, so this table is a REGRESSION LOCK on the accepted set, not a
// proof of M4.
const RECOGNISED_RUN_MODES: readonly (readonly [
  label: string,
  mode: AgentCliRunOptions["mode"],
  expectedArgv: readonly string[],
])[] = [
  ["mutate (no --dry-run token)", "mutate", EXPECTED_RUN_ARGV],
  ["dry-run (--dry-run last)", "dry-run", EXPECTED_DRY_RUN_ARGV],
] as const;

describe("createAgentCliSurface — run() still accepts exactly the two mode literals (M4 regression lock)", () => {
  test.each(RECOGNISED_RUN_MODES)(
    "run() with mode %s emits its exact argv",
    async (_label, mode, expectedArgv) => {
      const { deps, recorder } = createRunDeps();
      recorder.enqueueResult(
        exitedResult({ stdout: makeRunEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode });

      expect(recorder.invocations.map((call) => call.args)).toEqual([
        expectedArgv,
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// S9 — `workspaceRoot` absoluteness is checked but not NORMALISED, so
// `path.isAbsolute("/repo/../etc")` is true and the emitted token anchors at
// `/etc`. `isDeclarablePresetPath` already bans a `..` segment in the stored
// entry even when it normalises back inside; the root half of the same join
// must be held to the same rule, or the asymmetry gets copied the next time
// someone adds an anchoring path.
// ---------------------------------------------------------------------------

const DOT_DOT_WORKSPACE_ROOTS: readonly (readonly [
  label: string,
  workspaceRoot: string,
])[] = [
  // The finding: absolute, `isAbsolute`-clean, and anchors somewhere else
  // entirely.
  ["a `..` that re-anchors the join under another root", "/repo/../etc"],
  ["a trailing `..`", `${FAKE_WORKSPACE_ROOT}/..`],
  // Banned even though `path.normalize` collapses it back to
  // FAKE_WORKSPACE_ROOT — the same unconditional rule
  // `isDeclarablePresetPath` applies to the entry side of the join, so the
  // two halves cannot drift apart.
  ["a `..` that normalises back inside", `${FAKE_WORKSPACE_ROOT}/sub/..`],
] as const;

describe("createAgentCliSurface — run() rejects a `..`-bearing workspaceRoot (S9)", () => {
  test.each(DOT_DOT_WORKSPACE_ROOTS)(
    "run() rejects when workspaceRoot contains %s",
    async (_label, workspaceRoot) => {
      const { deps, recorder } = createRunDeps({ workspaceRoot });
      recorder.enqueueResult(
        exitedResult({ stdout: makeRunEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      const settlement = await settleRun(
        () =>
          surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" }),
        recorder,
      );

      // Finding first: the leaked token (`--preset=/etc/...`) is what a RED
      // failure should print.
      expect(settlement.emittedArgs).toEqual([]);
      expect(settlement.rejected).toBe(true);
      expect(settlement.thrown).toBeInstanceOf(Core.M3LError);
      const error = settlement.thrown as Core.M3LError;
      // The same fixed pair as every other preset arm: an anchoring defect
      // must not become a new, enumerable signal for the model.
      expect(error.code).toBe("ERR_AGENT_OPERATOR_PRESET");
      expect(error.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
    },
  );

  test("a clean absolute workspaceRoot still anchors and emits (S9 must not reject the happy path)", async () => {
    // Passes today; kept so a normalisation check written as "reject any
    // root that `path.normalize` changes" — which would also reject a
    // trailing-slash or double-slash root — cannot land unnoticed.
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" });

    expect(recorder.invocations.map((call) => call.args)).toEqual([
      EXPECTED_RUN_ARGV,
    ]);
  });
});

// ---------------------------------------------------------------------------
// S10 — the use-site re-check must never be MORE PERMISSIVE than the config
// parser. `steps/resolve-runtime.ts`'s `assertWellFormedEntryPresetPath`
// rejects a whitespace-padded path and any Unicode control or format
// character; `isDeclarablePresetPath` here shares only the containment
// boundary, so a directly-constructed allowlist (the shape this module's own
// `@example` demonstrates, and the bypass S1 exists for) reaches
// `path.join` with a padded, NUL-bearing or newline-bearing value and emits
// a token. Contained today only because `runCliProcess` folds the spawn
// throw into a coded error — the doc claim that the two checks "cannot drift
// into accepting different sets" is what is untrue.
//
// Every control character below is BUILT IN CODE (`String.fromCodePoint`),
// never written as a literal escape: `check:control-chars` scans only
// TRACKED files, so a literal byte in a new file passes the gate while the
// fixture is corrupt.
// ---------------------------------------------------------------------------

const NUL_CHARACTER = String.fromCodePoint(0);
const NEWLINE_CHARACTER = String.fromCodePoint(10);

const PARSER_REJECTED_ALLOWLIST_PATHS: readonly (readonly [
  label: string,
  relativePath: string,
])[] = [
  ["a trailing space", `${PRESET_RELATIVE_PATH} `],
  ["an embedded space", "data/config/presets/agent-operator/night ly.json"],
  [
    "an embedded NUL",
    `data/config/presets/agent-operator/nightly${NUL_CHARACTER}.json`,
  ],
  // The one with teeth: a newline turns one declared entry into a value
  // whose second line reads as another flag. `shell: false` plus an argv
  // array means it cannot become a separate argument today, but the parser
  // rejects it and the use site must not be the looser of the two.
  [
    "a newline followed by --dry-run",
    `${PRESET_RELATIVE_PATH}${NEWLINE_CHARACTER}--dry-run`,
  ],
  // REGRESSION LOCK, not a proof of S10: a leading space breaks the
  // `startsWith` prefix comparison, so the existing containment arm already
  // rejects this one and the whitespace rule is never reached. Pinned
  // because it is the row that would start passing if the prefix check were
  // ever loosened to a `trim()`-then-compare.
  ["a leading space", ` ${PRESET_RELATIVE_PATH}`],
] as const;

describe("createAgentCliSurface — run()'s use-site re-check is at least as strict as the config parser (S10)", () => {
  test.each(PARSER_REJECTED_ALLOWLIST_PATHS)(
    "a directly-built allowlist entry with %s rejects at run() instead of emitting a --preset= token",
    async (_label, relativePath) => {
      const { deps, recorder } = createRunDeps({
        presetAllowlist: new Map([[PRESET_ALLOWED_NAME, relativePath]]),
      });
      recorder.enqueueResult(
        exitedResult({ stdout: makeRunEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      const settlement = await settleRun(
        () =>
          surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, { mode: "mutate" }),
        recorder,
      );

      // Finding first: a RED failure prints the emitted token, including the
      // bytes the parser would have refused.
      expect(settlement.emittedArgs).toEqual([]);
      expect(
        settlement.emittedArgs.filter((arg) => arg.startsWith("--preset=")),
      ).toEqual([]);
      expect(settlement.rejected).toBe(true);
      expect(settlement.thrown).toBeInstanceOf(Core.M3LError);
      const error = settlement.thrown as Core.M3LError;
      expect(error.code).toBe("ERR_AGENT_OPERATOR_PRESET");
      expect(error.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
      // The rejected bytes must not be echoed back through the model-facing
      // message — the whole reason the parser keeps them out of ITS message.
      expect(error.message).not.toContain(relativePath);
    },
  );
});

// ---------------------------------------------------------------------------
// M4b — the runtime narrowing added by M4 reads `mode` with a PROTOTYPE-
// WALKING dot access (`(bag as { mode?: unknown }).mode`), so a bag carrying
// no own `mode` inherits one. With `Object.prototype.mode = "mutate"` in
// effect, `run(s, p, {})` — the exact bag M4 already rejects on a clean
// prototype — is accepted and SPAWNS A REAL MUTATION.
//
// The rule this seam is missing is the one
// `packages/m3l-common/src/internal/agent/decide.ts` applies to every policy
// field it reads (`Object.hasOwn(policy, "sensitiveTargets") ? … :
// undefined`, and the same for `dryRunFirst`/`requireDecisionLog`). Its
// comment records why: a polluted `Object.prototype.sensitiveTargets` once
// skipped the grading arm and AUTO-APPROVED A PROD MUTATION under a policy
// that had opted out of grading precisely so everything would escalate.
// `mode` is the same kind of value — a declaration the caller must make, not
// one the ambient object graph may supply — so presence must be established
// by `Object.hasOwn` before the value is compared.
//
// Both pollution directions are failures, and for the same reason: an
// inherited `"dry-run"` looks safe but is still not a declaration by the
// caller. Accepting it leaves the guard half-applied, and a seam that trusts
// inheritance in one direction is one `Object.prototype` write away from
// trusting it in the other.
//
// HYGIENE: every row installs the pollution with `configurable: true` and
// `delete`s it in an unconditional `finally`, then asserts it is gone —
// an escaped `Object.prototype.mode` would poison every later test in the
// run and surface as unrelated failures far from here. The `afterEach`
// below is the backstop for an early failure inside a body.
// ---------------------------------------------------------------------------

/**
 * Reads the value an own-property-less bag would INHERIT for `mode`, without
 * asserting anything about how it got there. `undefined` is the only clean
 * state: `Object.prototype` carries no `mode` in a healthy run.
 */
function readInheritedMode(): unknown {
  return ({} as { readonly mode?: unknown }).mode;
}

/** Fails loudly, at the source, if a row leaked its pollution. */
function expectPrototypeUnpolluted(): void {
  expect(Object.hasOwn(Object.prototype, "mode")).toBe(false);
  expect(readInheritedMode()).toBeUndefined();
}

/**
 * Installs `Object.prototype.mode` for the duration of `body` and removes it
 * unconditionally afterwards.
 *
 * Non-enumerable on purpose: an enumerable `Object.prototype` property would
 * also change every `for…in` and `JSON.stringify` in the process during the
 * window, which would make a failure inside `body` ambiguous between the
 * finding and the fixture. `configurable: true` is what makes the `delete`
 * in the `finally` guaranteed to succeed.
 */
async function withInheritedMode(
  value: unknown,
  body: () => Promise<void>,
): Promise<void> {
  expectPrototypeUnpolluted();
  Object.defineProperty(Object.prototype, "mode", {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  try {
    await body();
  } finally {
    delete (Object.prototype as { mode?: unknown }).mode;
  }
  expectPrototypeUnpolluted();
}

/**
 * Settles `run(script, preset, bag)` against a fresh recorder that has a
 * result enqueued, so a pre-fix ACCEPTANCE resolves (and records the argv it
 * emitted) instead of tripping the fake's empty-queue guard — the same
 * arrangement the M4 rows above use, and what makes the leaked command line
 * the thing a RED failure prints.
 */
async function settleRunWithBag(bag: unknown): Promise<RunSettlement> {
  const { deps, recorder } = createRunDeps();
  recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
  const surface = createAgentCliSurface(deps);
  return settleRun(
    () =>
      surface.run(
        RUN_SCRIPT_NAME,
        PRESET_ALLOWED_NAME,
        // The cast is the finding, exactly as in the M4 rows: slice 2b hands
        // this method a bag parsed out of model-supplied JSON typed
        // `unknown`, and such a bag can carry no own `mode` at all.
        bag as AgentCliRunOptions,
      ),
    recorder,
  );
}

/**
 * The rejection an unrecognised bag gets on a CLEAN prototype. Derived at
 * run time rather than hard-coded so the polluted rows assert "the SAME
 * coded error" against the implementation's own message
 * (`RUN_MODE_REJECTION_MESSAGE` is module-local and not exported), and so a
 * future re-wording cannot make the comparison pass vacuously.
 */
async function captureCleanPrototypeRejection(): Promise<M3LAgentOperatorCliError> {
  expectPrototypeUnpolluted();
  const control = await settleRunWithBag({});
  const error = assertCodedFailClosedRejection(control);
  // The documented code for "a caller supplied a value the seam does not
  // accept". Pinned here, once, so the polluted rows below inherit it via
  // the comparison instead of restating a literal three times.
  expect(error.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
  return error;
}

/** The pollution values whose acceptance is the defect, worst first. */
const INHERITED_RUN_MODES: readonly (readonly [
  label: string,
  value: string,
])[] = [
  // The dangerous direction: today this SPAWNS a real mutation for a caller
  // that declared nothing at all.
  ["mutate (today: spawns a real mutation)", "mutate"],
  // The safe-LOOKING direction. Still a rejection: inheriting a value is not
  // declaring one, and a fix that only screens `"mutate"` would leave `{}`
  // silently probing whenever the ambient prototype says so.
  ["dry-run (still not a declaration by the caller)", "dry-run"],
] as const;

describe("createAgentCliSurface — run() reads `mode` as an OWN property (M4b)", () => {
  // Backstop for a body that fails before its own `finally` runs the delete
  // (a `defineProperty` that throws, an assertion inside `withInheritedMode`
  // before the try). Cheap, and it fails the leaking row rather than an
  // innocent later one.
  afterEach(() => {
    expectPrototypeUnpolluted();
  });

  test.each(INHERITED_RUN_MODES)(
    "run(s, p, {}) with an inherited mode %s rejects with the same coded error a clean-prototype {} gets, and spawns nothing",
    async (_label, value) => {
      const control = await captureCleanPrototypeRejection();

      await withInheritedMode(value, async () => {
        // Sanity check on the fixture itself: if the pollution did not take,
        // the row would pass for the wrong reason (a clean `{}` is already
        // rejected), which is the one way this test could be a tautology.
        expect(readInheritedMode()).toBe(value);

        const settlement = await settleRunWithBag({});

        // Finding first: `assertCodedFailClosedRejection` asserts the EMITTED
        // ARGV is empty before anything about the error, so a RED failure
        // prints the mutating command line this defect produces.
        const error = assertCodedFailClosedRejection(settlement);
        // "It threw" is not the contract — a spawn is the dangerous outcome,
        // so the no-spawn claim is pinned directly on the recorder too, not
        // only through the flattened argv above.
        expect(settlement.emittedArgs).not.toEqual([...EXPECTED_RUN_ARGV]);
        expect(settlement.emittedArgs).not.toEqual([...EXPECTED_DRY_RUN_ARGV]);
        expect(error.code).toBe(control.code);
        expect(error.message).toBe(control.message);
      });
    },
  );

  // Both arms are reachable in each row below: the prototype really does
  // carry the OTHER mode (asserted), so an implementation that ignored the
  // own property and used the inherited one would emit the other argv, and
  // one that rejected any bag while the prototype is polluted would emit
  // none. That makes this a precedence assertion rather than a restatement
  // of the M4 regression lock.
  //
  // NOTE: this pair PASSES pre-fix (a dot read already prefers an own
  // property), so it is a regression lock on the fix's blast radius, not a
  // proof of M4b — it exists to stop the guard from being written as "any
  // pollution present ⇒ reject", which would break an honest caller for a
  // reason it cannot see or control.
  test.each([
    [
      "own mutate beats an inherited dry-run",
      "mutate",
      "dry-run",
      EXPECTED_RUN_ARGV,
    ],
    [
      "own dry-run beats an inherited mutate",
      "dry-run",
      "mutate",
      EXPECTED_DRY_RUN_ARGV,
    ],
  ] as const)(
    "run() still honours the caller's OWN mode while the prototype is polluted — %s",
    async (_label, ownMode, inherited, expectedArgv) => {
      await withInheritedMode(inherited, async () => {
        expect(readInheritedMode()).toBe(inherited);
        const { deps, recorder } = createRunDeps();
        recorder.enqueueResult(
          exitedResult({ stdout: makeRunEnvelopePayload() }),
        );
        const surface = createAgentCliSurface(deps);

        await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
          mode: ownMode,
        });

        expect(recorder.invocations.map((call) => call.args)).toEqual([
          expectedArgv,
        ]);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// M4c — the SAME defect class as M4b, one level up: `createAgentCliSurface`
// reads its three OPTIONAL deps with PROTOTYPE-WALKING dot accesses
// (`deps.workspaceRoot`, `deps.signal`, `deps.runProcess ?? runCliProcess`),
// so a bag that HONESTLY omits a key silently inherits whatever the ambient
// object graph supplies:
//
//   * `Object.prototype.runProcess = fn` replaces the spawn function for all
//     five methods — the hijacked function is actually INVOKED.
//   * `Object.prototype.workspaceRoot = "/evil"` makes `run` emit
//     `--preset=/evil/data/config/presets/...`. This is the serious one: a
//     mutating run's preset file supplies every parameter value, so an
//     inherited root sources it from an attacker-chosen directory.
//   * `Object.prototype.signal` reaches every spawn as a forged, non-
//     `AbortSignal` cancellation token.
//
// The rule is the same one M4b applies to `run`'s `mode`, and the same one
// `packages/m3l-common/src/internal/agent/decide.ts` applies to every policy
// field it reads: OWN PROPERTY OR TREAT AS ABSENT. That is exactly the
// documented optional behaviour of all three keys, so nothing changes for an
// honest caller and no new error code is needed —
//
//   * no `runProcess` -> the real `runCliProcess`;
//   * no `workspaceRoot` -> the projection scrub stays off and `run` rejects
//     with the fixed preset message (the behaviour already pinned by the
//     "run() without workspaceRoot" describe above);
//   * no `signal` -> nothing forwarded.
//
// HYGIENE: this block's pollution window is strictly bracketed — installed
// non-enumerable and `configurable: true`, removed in an UNCONDITIONAL
// `finally`, asserted absent before and after, with an `afterEach` backstop.
// An escaped `Object.prototype.runProcess` would replace the spawn function
// for every later test in the run, and the failures would look like anything
// but their cause.
// ---------------------------------------------------------------------------

/** The three optional ctor keys whose reads must be own-property reads. */
const OPTIONAL_CTOR_DEP_KEYS = [
  "runProcess",
  "workspaceRoot",
  "signal",
] as const;

type OptionalCtorDepKey = (typeof OPTIONAL_CTOR_DEP_KEYS)[number];

/**
 * Generalized `tests/support/prototypePollution.ts` harness, bound to this
 * block's three optional ctor keys. `expectCtorPrototypeUnpolluted` and
 * `withInheritedCtorDep` below are thin, name-preserving aliases onto it —
 * every row's content and assertions are unchanged from before this
 * extraction, this is a pure mechanical repoint.
 */
const ctorDepPollutionHarness =
  createPrototypePollutionHarness<OptionalCtorDepKey>(OPTIONAL_CTOR_DEP_KEYS);

/** Fails loudly, at the source, if a row leaked its pollution. */
function expectCtorPrototypeUnpolluted(): void {
  ctorDepPollutionHarness.expectUnpolluted();
}

/**
 * Installs `Object.prototype[key]` for the duration of `body` and removes it
 * unconditionally afterwards. See
 * `tests/support/prototypePollution.ts`'s `withInherited` for the full
 * rationale (non-enumerable, `configurable: true`,
 * `Reflect.deleteProperty` in `finally`, and the assert-inside-try
 * ordering).
 */
async function withInheritedCtorDep(
  key: OptionalCtorDepKey,
  value: unknown,
  body: () => Promise<void>,
): Promise<void> {
  await ctorDepPollutionHarness.withInherited(key, value, body);
}

/** The options bag the surface hands its `runProcess` seam. */
type CapturedRunOptions = Parameters<typeof runCliProcess>[0];

/**
 * A `runProcess` seam that keeps the RAW options object, not a copy of it.
 * `Object.hasOwn` on a spread copy would answer a question about the copy —
 * and the spread would itself drop the inherited key row 3 is hunting.
 */
interface OptionsCapturingRunProcess {
  readonly runProcess: typeof runCliProcess;
  readonly received: readonly CapturedRunOptions[];
  enqueueResult(result: CliRunResult): void;
}

function createOptionsCapturingRunProcess(): OptionsCapturingRunProcess {
  const received: CapturedRunOptions[] = [];
  const queue: CliRunResult[] = [];
  const runProcess: typeof runCliProcess = (options) => {
    received.push(options);
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(
          `createOptionsCapturingRunProcess: no CliRunResult queued for call #${String(received.length)}`,
        ),
      );
    }
    return Promise.resolve(next);
  };
  return {
    runProcess,
    received,
    enqueueResult(result) {
      queue.push(result);
    },
  };
}

// Row 1 omits `runProcess`, so the REAL `runCliProcess` runs and really does
// place one `spawn` call. These three paths are absent on any host, so the
// attempt fails at `spawn` with a deterministic `ENOENT` before a child
// exists — no CLI executes, nothing on the host is read or written, and the
// asserted `failureCode: "ENOENT"` is what proves a genuine spawn attempt
// happened (rather than, say, the timeout below firing).
const UNSPAWNABLE_NODE_EXEC_PATH = "/nonexistent-m3l-agent-operator/node";
const UNSPAWNABLE_ENTRYPOINT = "/nonexistent-m3l-agent-operator/m3l.mjs";
const UNSPAWNABLE_CWD = "/nonexistent-m3l-agent-operator/cwd";

/** The inherited root a polluted prototype offers row 2. */
const POLLUTED_WORKSPACE_ROOT = "/evil";

/**
 * The forged cancellation token row 3 must never see forwarded. Deliberately
 * NOT an `AbortSignal`: the harm is that an inherited value of any shape
 * reaches every spawn, and a plausible-looking imposter is the realistic
 * form of it.
 */
const FORGED_SIGNAL: unknown = Object.freeze({ aborted: false });

/**
 * Deps that HONESTLY omit all three optional keys — no own `runProcess`, no
 * own `workspaceRoot`, no own `signal`. `createDeps` above always injects a
 * `runProcess`, which is exactly the key row 1 must leave absent.
 */
function createBareDeps(): AgentCliSurfaceDeps {
  return {
    entrypoint: UNSPAWNABLE_ENTRYPOINT,
    cwd: UNSPAWNABLE_CWD,
    nodeExecPath: UNSPAWNABLE_NODE_EXEC_PATH,
    cliTimeoutMs: 2_000,
    dryRunTimeoutMs: 2_000,
    flowTimeoutMs: 2_000,
    maxOutputBytes: 1_048_576,
    dryRunAllowlist: new Set([DRY_RUN_ALLOWED_NAME]),
    presetAllowlist: new Map([[PRESET_ALLOWED_NAME, PRESET_RELATIVE_PATH]]),
    flowAllowlist: new Set<string>(),
  };
}

describe("createAgentCliSurface — reads its optional deps as OWN properties (M4c)", () => {
  // Backstop for a body that fails before its own `finally` runs the removal
  // (a `defineProperty` that throws, an assertion inside
  // `withInheritedCtorDep` before the `try`). Cheap, and it fails the leaking
  // row rather than an innocent later one.
  afterEach(() => {
    expectCtorPrototypeUnpolluted();
  });

  test("a deps bag with no own `runProcess` never invokes an inherited one — it falls back to the real runCliProcess", async () => {
    // The control runs on a CLEAN prototype and states the fallback contract
    // positively: an honest omission reaches the real `runCliProcess`, whose
    // spawn attempt fails `ENOENT`. Derived here at run time so the polluted
    // arm can compare against the implementation's own outcome instead of a
    // hard-coded code, and so this row proves "the REAL one ran" rather than
    // the much weaker "it threw".
    const control = await captureRejection(() =>
      createAgentCliSurface(createBareDeps()).list(),
    );
    expect(control).toBeInstanceOf(M3LAgentOperatorCliError);
    const controlError = control as M3LAgentOperatorCliError;
    expect(controlError.code).toBe("ERR_AGENT_OPERATOR_CLI_SPAWN");
    expect(controlError.context).toMatchObject({ failureCode: "ENOENT" });

    let hijackCalls = 0;
    const hijacked: typeof runCliProcess = () => {
      hijackCalls += 1;
      throw new Error("the inherited runProcess was invoked");
    };

    await withInheritedCtorDep("runProcess", hijacked, async () => {
      const thrown = await captureRejection(() =>
        createAgentCliSurface(createBareDeps()).list(),
      );

      // Finding first: the hijacked spawn function running AT ALL is the
      // defect, so it is asserted before anything about the error — a RED
      // failure then reads as "the polluted function was invoked" rather
      // than as an error-code mismatch.
      expect(hijackCalls).toBe(0);
      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const error = thrown as M3LAgentOperatorCliError;
      expect(error.code).toBe(controlError.code);
      expect(error.context).toMatchObject({ failureCode: "ENOENT" });
    });
  });

  test("a deps bag with no own `workspaceRoot` never anchors a preset path onto an inherited root — run() rejects and emits nothing", async () => {
    await withInheritedCtorDep(
      "workspaceRoot",
      POLLUTED_WORKSPACE_ROOT,
      async () => {
        const recorder = createRecordingRunProcess();
        // Enqueued so a pre-fix ACCEPTANCE resolves and records the argv it
        // leaked, instead of tripping the fixture's empty-queue guard.
        recorder.enqueueResult(
          exitedResult({ stdout: makeRunEnvelopePayload() }),
        );
        const { deps } = createDeps({ runProcess: recorder.runProcess });
        const surface = createAgentCliSurface(deps);

        const settlement = await settleRun(
          () =>
            surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
              mode: "mutate",
            }),
          recorder,
        );

        // Finding first, and stated as the harm rather than as a shape: no
        // emitted token may mention the inherited root. Asserted per token
        // so a RED failure prints the poisoned `--preset=` path itself.
        for (const arg of settlement.emittedArgs) {
          expect(arg).not.toContain(POLLUTED_WORKSPACE_ROOT);
        }
        // …and nothing may be emitted at all: an empty argv is the only
        // acceptable outcome, which the per-token loop alone cannot say.
        expect(settlement.emittedArgs).toEqual([]);
        expect(settlement.rejected).toBe(true);
        expect(settlement.thrown).toBeInstanceOf(Core.M3LError);
        const error = settlement.thrown as Core.M3LError;
        // The surface's DOCUMENTED absent-root behaviour, unchanged — the
        // same code and fixed message the "run() without workspaceRoot"
        // describe pins on a clean prototype. No new error code exists here.
        expect(error.code).toBe("ERR_AGENT_OPERATOR_PRESET");
        expect(error.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
      },
    );
  });

  test("a deps bag with no own `signal` forwards no signal to the spawn seam", async () => {
    let received: CapturedRunOptions | undefined;

    await withInheritedCtorDep("signal", FORGED_SIGNAL, async () => {
      const seam = createOptionsCapturingRunProcess();
      seam.enqueueResult(exitedResult({ stdout: makeListPayload() }));
      const { deps } = createDeps({ runProcess: seam.runProcess });

      await createAgentCliSurface(deps).list();

      expect(seam.received).toHaveLength(1);
      received = seam.received[0];
      expect(received).toBeDefined();
      // `Object.hasOwn`, NEVER `expect(...).not.toHaveProperty("signal")`:
      // `toHaveProperty` falls back to an `in`-style lookup that WALKS the
      // prototype, so with `Object.prototype.signal` installed it would
      // report the key as present in BOTH the fixed and broken worlds and
      // could never fail. That trap is the whole subject of this block.
      expect(Object.hasOwn(received as object, "signal")).toBe(false);
    });

    // Repeated outside the window, where the prototype is clean again: the
    // recorded bag must still have no `signal` — by then a plain dot read is
    // safe, and its `undefined` shows nothing was captured by reference
    // either.
    expect(received).toBeDefined();
    expect(Object.hasOwn(received as object, "signal")).toBe(false);
    expect(received?.signal).toBeUndefined();
  });

  // ---- Regression locks (these PASS pre-fix) ------------------------------
  // A dot read already prefers an own property, so the three rows below hold
  // today. They exist to bound the fix's blast radius: written as "any
  // pollution present ⇒ reject", the guard would break an honest caller for
  // a reason it cannot see or control. Both arms are genuinely reachable in
  // each row — the prototype really carries a DIFFERENT value (asserted by
  // `withInheritedCtorDep`), so an implementation that preferred the
  // inherited value would take the other branch and fail here.

  test("an own `runProcess` still wins while the prototype carries another one", async () => {
    let hijackCalls = 0;
    const hijacked: typeof runCliProcess = () => {
      hijackCalls += 1;
      throw new Error("the inherited runProcess was invoked");
    };

    await withInheritedCtorDep("runProcess", hijacked, async () => {
      const seam = createOptionsCapturingRunProcess();
      seam.enqueueResult(exitedResult({ stdout: makeListPayload() }));
      const { deps } = createDeps({ runProcess: seam.runProcess });

      await createAgentCliSurface(deps).list();

      expect(hijackCalls).toBe(0);
      expect(seam.received.map((options) => [...options.args])).toEqual([
        ["list", "--json"],
      ]);
    });
  });

  test("an own `workspaceRoot` still wins while the prototype carries another one", async () => {
    await withInheritedCtorDep(
      "workspaceRoot",
      POLLUTED_WORKSPACE_ROOT,
      async () => {
        // `createRunDeps` sets an OWN `workspaceRoot` (`FAKE_WORKSPACE_ROOT`),
        // so the expected argv below is anchored to it.
        const { deps, recorder } = createRunDeps();
        recorder.enqueueResult(
          exitedResult({ stdout: makeRunEnvelopePayload() }),
        );
        const surface = createAgentCliSurface(deps);

        await surface.run(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, {
          mode: "mutate",
        });

        const emitted = recorder.invocations.flatMap((call) => [...call.args]);
        for (const arg of emitted) {
          expect(arg).not.toContain(POLLUTED_WORKSPACE_ROOT);
        }
        expect(emitted).toEqual([...EXPECTED_RUN_ARGV]);
      },
    );
  });

  test("an own `signal` still wins while the prototype carries a forged one", async () => {
    const controller = new AbortController();

    await withInheritedCtorDep("signal", FORGED_SIGNAL, async () => {
      const seam = createOptionsCapturingRunProcess();
      seam.enqueueResult(exitedResult({ stdout: makeListPayload() }));
      const { deps } = createDeps({
        runProcess: seam.runProcess,
        signal: controller.signal,
      });

      await createAgentCliSurface(deps).list();

      const received = seam.received[0];
      expect(received).toBeDefined();
      expect(Object.hasOwn(received as object, "signal")).toBe(true);
      // Identity, not shape: the caller's OWN signal must be the one
      // forwarded, and the forged imposter must not be it.
      expect(received?.signal).toBe(controller.signal);
      expect(received?.signal).not.toBe(FORGED_SIGNAL);
    });
  });
});

// ---------------------------------------------------------------------------
// V9 log-triage slice — `triageRun(scriptName, presetName, operatorProfile)`.
// Closes the finding recorded in the review log: a preset file's own
// `operation:` key sits at `M3LScript` config precedence level 6, and an
// operator environment variable (`OPERATION`/`SOURCE`) sits at level 4 —
// with `lib/cli-process.ts` spawning the child with no `env` option, an
// inherited `OPERATION=convert` silently overrode the preset's declared verb
// while `triage-logs`'s action was graded `read-only-auto-approved`. A child
// passthrough argument binds at precedence level 1, above both, so
// `triageRun` appends a FIXED, non-interpolated `--operation=analyze` token
// nothing here can override — there is no `options` bag and no `mode`
// parameter, because a triage run never dry-runs and so has nothing to
// choose between.
//
// The SAME precedence gap applies to `aws.profile`: a preset is forbidden
// from declaring one, so the spawned child otherwise resolves its own
// profile from the inherited environment (level 4) — independently of the
// PARENT's own `aws.profile`, which resolves through the parent's full CLI
// (level 1) and config-file (levels 2-3) precedence. The policy grades the
// parent's value; a child that resolves a different one is a confidentiality
// bypass (`claude-pr-review` on PR #1081, Should-fix 1). `triageRun` closes
// it the same way it closed the verb: a THIRD `operatorProfile` parameter,
// appended as a FIXED-POSITION (never templated) `--aws.profile=` passthrough
// token, LAST — after `--operation=analyze`.
// ---------------------------------------------------------------------------

/** The operator profile fixture `triageRun` must pin as a level-1 passthrough. */
const TRIAGE_OPERATOR_PROFILE = "sandbox";

/** A second, distinct profile — proves the token tracks the parameter. */
const TRIAGE_SECOND_OPERATOR_PROFILE = "prod-readonly";

/** The absolute token `triageRun` must emit, derived from the injected root. */
const EXPECTED_TRIAGE_ARGV: readonly string[] = [
  "run",
  RUN_SCRIPT_NAME,
  "--json",
  "--",
  `--preset=${EXPECTED_PRESET_PATH}`,
  "--operation=analyze",
  `--aws.profile=${TRIAGE_OPERATOR_PROFILE}`,
];

// A second allowlisted preset, distinct from `PRESET_ALLOWED_NAME`, so the
// "fixed literal across two different presets" test below genuinely varies
// the one caller-supplied value that could plausibly leak into the token.
const TRIAGE_SECOND_PRESET_NAME = "weekly-triage";
const TRIAGE_SECOND_PRESET_RELATIVE_PATH =
  "data/config/presets/agent-operator/weekly-triage.json";

describe("createAgentCliSurface — triageRun() argv", () => {
  test("triageRun(script, preset, profile) sends exactly ['run', script, '--json', '--', '--preset=<absolute>', '--operation=analyze', '--aws.profile=<profile>'], element by element", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(
      exitedResult({ stdout: makeRunEnvelopePayload({ outcome: "success" }) }),
    );
    const surface = createAgentCliSurface(deps);

    await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      TRIAGE_OPERATOR_PROFILE,
    );

    const argv = recorder.invocations[0]?.args ?? [];
    // Element by element, not just the array-equality check below: the
    // contract names exactly 7 tokens at exactly these positions.
    expect(argv).toHaveLength(7);
    expect(argv[0]).toBe("run");
    expect(argv[1]).toBe(RUN_SCRIPT_NAME);
    expect(argv[2]).toBe("--json");
    expect(argv[3]).toBe("--");
    expect(argv[4]).toBe(`--preset=${EXPECTED_PRESET_PATH}`);
    expect(argv[5]).toBe("--operation=analyze");
    expect(argv[6]).toBe(`--aws.profile=${TRIAGE_OPERATOR_PROFILE}`);
    expect(recorder.invocations.map((call) => call.args)).toEqual([
      EXPECTED_TRIAGE_ARGV,
    ]);
  });

  test("triageRun() puts --json before the bare --, --preset= attached right after it, --operation=analyze next, and --aws.profile= LAST", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      TRIAGE_OPERATOR_PROFILE,
    );

    const argv = recorder.invocations[0]?.args ?? [];
    const jsonIndex = argv.indexOf("--json");
    const dashIndex = argv.indexOf("--");
    const presetIndex = argv.findIndex((arg) => arg.startsWith("--preset="));
    const operationIndex = argv.indexOf("--operation=analyze");
    const profileIndex = argv.findIndex((arg) =>
      arg.startsWith("--aws.profile="),
    );
    // Same partitioning reasoning as `run`'s own ordering test: `--json` must
    // precede the bare `--` to be stripped by the CLI's own flag
    // partitioning, and everything after `--` is forwarded verbatim to the
    // child, which binds each passthrough argument by splitting on its first
    // `=`.
    expect(jsonIndex).toBeGreaterThanOrEqual(0);
    expect(dashIndex).toBeGreaterThan(jsonIndex);
    expect(presetIndex).toBeGreaterThan(dashIndex);
    expect(operationIndex).toBeGreaterThan(presetIndex);
    expect(profileIndex).toBe(argv.length - 1);
    expect(profileIndex).toBeGreaterThan(operationIndex);
  });

  test("--operation=analyze is a fixed literal — byte-identical across two calls naming different presets and profiles", async () => {
    const { deps, recorder } = createRunDeps({
      presetAllowlist: new Map([
        [PRESET_ALLOWED_NAME, PRESET_RELATIVE_PATH],
        [TRIAGE_SECOND_PRESET_NAME, TRIAGE_SECOND_PRESET_RELATIVE_PATH],
      ]),
    });
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      TRIAGE_OPERATOR_PROFILE,
    );
    await surface.triageRun(
      RUN_SCRIPT_NAME,
      TRIAGE_SECOND_PRESET_NAME,
      TRIAGE_SECOND_OPERATOR_PROFILE,
    );

    const firstArgv = recorder.invocations[0]?.args ?? [];
    const secondArgv = recorder.invocations[1]?.args ?? [];
    // No caller input, no parameter and no config value reaches the
    // `--operation=analyze` token: a different preset name changes the
    // `--preset=` token and a different profile changes the trailing
    // `--aws.profile=` token, but the operation token in between must stay
    // byte-identical.
    const firstOperationToken = firstArgv.find(
      (arg) => arg === "--operation=analyze",
    );
    const secondOperationToken = secondArgv.find(
      (arg) => arg === "--operation=analyze",
    );
    expect(firstOperationToken).toBe("--operation=analyze");
    expect(secondOperationToken).toBe("--operation=analyze");
    expect(firstOperationToken).toBe(secondOperationToken);
    expect(firstArgv.find((arg) => arg.startsWith("--preset="))).not.toBe(
      secondArgv.find((arg) => arg.startsWith("--preset=")),
    );
    expect(firstArgv.at(-1)).not.toBe(secondArgv.at(-1));
  });

  test("--aws.profile=<profile> is interpolated from the parameter — two calls with different profiles change only that token", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      TRIAGE_OPERATOR_PROFILE,
    );
    await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      TRIAGE_SECOND_OPERATOR_PROFILE,
    );

    const firstArgv = recorder.invocations[0]?.args ?? [];
    const secondArgv = recorder.invocations[1]?.args ?? [];
    expect(firstArgv.at(-1)).toBe(`--aws.profile=${TRIAGE_OPERATOR_PROFILE}`);
    expect(secondArgv.at(-1)).toBe(
      `--aws.profile=${TRIAGE_SECOND_OPERATOR_PROFILE}`,
    );
    expect(firstArgv.at(-1)).not.toBe(secondArgv.at(-1));
    // Unlike the profile token, the genuinely fixed literal stays
    // byte-identical across the very same two calls.
    expect(firstArgv.find((arg) => arg === "--operation=analyze")).toBe(
      secondArgv.find((arg) => arg === "--operation=analyze"),
    );
  });

  test("a profile containing '=' still binds as one token — the whole value, not a truncation", async () => {
    const profileWithEquals = "sandbox=eu-west-1";
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      profileWithEquals,
    );

    const argv = recorder.invocations[0]?.args ?? [];
    // The child's own `parseArgv` splits on the FIRST `=`, so the whole
    // value — including the embedded `=` — must survive as one argv element;
    // a naive split-then-rejoin on this side would truncate it.
    expect(argv.at(-1)).toBe(`--aws.profile=${profileWithEquals}`);
    expect(argv.at(-1)).not.toBe("--aws.profile=sandbox");
  });

  test("triageRun() forwards dryRunTimeoutMs, not cliTimeoutMs", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      TRIAGE_OPERATOR_PROFILE,
    );

    expect(recorder.invocations[0]?.timeoutMs).toBe(RUN_DRY_RUN_TIMEOUT_MS);
    expect(recorder.invocations[0]?.timeoutMs).not.toBe(RUN_CLI_TIMEOUT_MS);
  });

  test("triageRun() has no options bag and no mode parameter — exactly (scriptName, presetName, operatorProfile), all required strings", () => {
    expectTypeOf<AgentCliSurface["triageRun"]>().parameters.toEqualTypeOf<
      [string, string, string]
    >();
    // Arity is the load-bearing half: an OPTIONAL third parameter would widen
    // `length` to `2 | 3`, which the tuple equality above cannot see on its
    // own the way it would for a genuinely optional member.
    expectTypeOf<
      Parameters<AgentCliSurface["triageRun"]>["length"]
    >().toEqualTypeOf<3>();
  });

  test("triageRun(script, preset) omitting operatorProfile is a compile error", () => {
    const { deps } = createRunDeps();
    const surface = createAgentCliSurface(deps);

    // Declared, never invoked: the assertion IS the compile error on the
    // line below. Against today's 2-parameter `triageRun` this directive is
    // unused (no error to suppress) — that unused-directive diagnostic is
    // the RED signal for this slice; once the required third parameter
    // lands, it absorbs a real "expected 3 arguments, but got 2" error and
    // this file typechecks clean.
    const compileErrorProbe = (): void => {
      // @ts-expect-error -- `operatorProfile` is REQUIRED: there is no default.
      void surface.triageRun(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME);
    };

    expect(compileErrorProbe).toBeTypeOf("function");
  });
});

describe("createAgentCliSurface — triageRun() operator profile validation", () => {
  test("an empty-string operatorProfile rejects before spawning — the parent graded a profile, and an empty one would hand the child no usable target", async () => {
    const { deps, recorder } = createRunDeps();
    const surface = createAgentCliSurface(deps);

    await expect(
      surface.triageRun(RUN_SCRIPT_NAME, PRESET_ALLOWED_NAME, ""),
    ).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CONFIG",
      message: OPERATOR_PROFILE_REJECTION_MESSAGE,
    });
    expect(recorder.invocations).toEqual([]);
  });
});

describe("createAgentCliSurface — triageRun() exit policy", () => {
  test("triageRun() accepts any exit code, resolving with the envelope's own exitCode/outcome", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(
      exitedResult({
        exitCode: 6,
        stdout: makeRunEnvelopePayload({ exitCode: 6, outcome: "partial" }),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const envelope = await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      TRIAGE_OPERATOR_PROFILE,
    );

    // Same policy as `run`/`dryRun`: the envelope carries its own outcome, so
    // a non-zero child exit is data, not a failure of this tool.
    expect(envelope.exitCode).toBe(6);
    expect(envelope.outcome).toBe("partial");
  });
});

describe("createAgentCliSurface — triageRun() preset rejection (same allowlist as run())", () => {
  test("triageRun(script, %p) rejects with ERR_AGENT_OPERATOR_PRESET and spawns nothing for an unknown preset name", async () => {
    const { deps, recorder } = createRunDeps();
    const surface = createAgentCliSurface(deps);

    await expect(
      surface.triageRun(
        RUN_SCRIPT_NAME,
        "not-on-the-allowlist",
        TRIAGE_OPERATOR_PROFILE,
      ),
    ).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_PRESET",
      message: PRESET_NAME_REJECTION_MESSAGE,
    });
    expect(recorder.invocations).toEqual([]);
  });

  test.each(INVALID_PRESET_NAMES)(
    "triageRun(script, %p) rejects with ERR_AGENT_OPERATOR_PRESET and spawns nothing (shape)",
    async (presetName) => {
      const { deps, recorder } = createRunDeps();
      const surface = createAgentCliSurface(deps);

      await expect(
        surface.triageRun(RUN_SCRIPT_NAME, presetName, TRIAGE_OPERATOR_PROFILE),
      ).rejects.toMatchObject({
        code: "ERR_AGENT_OPERATOR_PRESET",
        message: PRESET_NAME_REJECTION_MESSAGE,
      });
      expect(recorder.invocations).toEqual([]);
    },
  );

  test("triageRun() resolves a valid preset name to join(workspaceRoot, storedRelativePath) — the same anchoring run() uses", async () => {
    const { deps, recorder } = createRunDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.triageRun(
      RUN_SCRIPT_NAME,
      PRESET_ALLOWED_NAME,
      TRIAGE_OPERATOR_PROFILE,
    );

    const argv = recorder.invocations[0]?.args ?? [];
    const presetToken = argv.find((arg) => arg.startsWith("--preset="));
    expect(presetToken).toBeDefined();
    const emittedPath = (presetToken ?? "").slice("--preset=".length);
    expect(path.isAbsolute(emittedPath)).toBe(true);
    expect(emittedPath).toBe(EXPECTED_PRESET_PATH);
    expect(emittedPath).not.toBe(PRESET_RELATIVE_PATH);
  });

  test("the rejection message never echoes the supplied preset name", async () => {
    const { deps, recorder } = createRunDeps();
    const hostile = "../../etc/passwd;rm -rf /";
    const surface = createAgentCliSurface(deps);

    const thrown = await captureRejection(() =>
      surface.triageRun(RUN_SCRIPT_NAME, hostile, TRIAGE_OPERATOR_PROFILE),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const message = (thrown as Core.M3LError).message;
    expect(message).toBe(PRESET_NAME_REJECTION_MESSAGE);
    expect(message).not.toContain(hostile);
    expect(message).not.toContain("..");
    expect(message).not.toContain("/etc/passwd");
    expect(message).not.toContain(";");
    expect(recorder.invocations).toEqual([]);
  });

  test("triageRun() with an unusable script name rejects with ERR_AGENT_OPERATOR_SCRIPT_NAME and spawns nothing", async () => {
    const { deps, recorder } = createRunDeps();
    const surface = createAgentCliSurface(deps);

    await expect(
      surface.triageRun("-h", PRESET_ALLOWED_NAME, TRIAGE_OPERATOR_PROFILE),
    ).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_SCRIPT_NAME",
      message: SCRIPT_NAME_REJECTION_MESSAGE,
    });
    expect(recorder.invocations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PR B1 — `flowRun(flowName, options)`, the `m3l flow run` seam. Unlike
// `run`/`triageRun`, `flow run` parses `--json` itself and REJECTS every
// extra argument (exit code 2, per `packages/m3l-cli/src/commands/flow.ts`'s
// own `reportUnknownFlag`), so there is no bare `--` passthrough separator,
// no `--resume` (resuming would re-enter a partially-executed, already-
// mutated flow under an authorization granted for a fresh run), and no
// `--aws.profile=` pin the way `triageRun` carries one (a flow's profile is
// graded from the flow definition instead — PR B2). The flow name is
// validated by `lib/flow-names.ts`'s `assertAllowedFlowName`, which mirrors
// `assertAllowedScriptName`/`assertAllowedPresetName`'s shape-then-
// membership order but — unlike the collapsed preset/script messages —
// raises three DISTINCT, non-echoing messages, all coded
// `ERR_AGENT_OPERATOR_CONFIG` (read directly from `lib/flow-names.ts`, not
// invented). `options.mode` reuses the EXACT `AgentCliRunOptions` type and
// runtime-narrowing contract `run()` already enforces via `assertRunMode`,
// so the invalid-mode cases below reuse this file's own
// `settleRun`/`assertCodedFailClosedRejection` helpers rather than pin a
// message: those helpers already encode "coded `M3LAgentOperatorCliError`,
// never a bare `TypeError`, nothing spawned" without assuming which of the
// two run-mode-shaped seams raised it.
// ---------------------------------------------------------------------------

/** A flow name matching the slug shape AND declared into the fixture allowlist. */
const FLOW_ALLOWED_NAME = "dlq-reconcile";

const EXPECTED_FLOW_RUN_ARGV: readonly string[] = [
  "flow",
  "run",
  FLOW_ALLOWED_NAME,
  "--json",
];

/** `--dry-run` appended LAST, as the fifth token. */
const EXPECTED_FLOW_DRY_RUN_ARGV: readonly string[] = [
  ...EXPECTED_FLOW_RUN_ARGV,
  "--dry-run",
];

/**
 * `flowRun`-flavoured deps around the recording seam. No `workspaceRoot` is
 * needed: unlike `run`/`triageRun`, `flowRun` never resolves a filesystem
 * path — the flow name is interpolated directly into argv, so there is
 * nothing here for an anchoring root to join onto.
 *
 * `flowAllowlist` is not yet a declared field of
 * `CreateAgentCliSurfaceOptions` — it is this slice's own missing piece,
 * mirroring the existing `dryRunAllowlist`/`presetAllowlist` naming and
 * "required, closed-by-default" shape. Passing it here is expected to be a
 * RED-phase typecheck error (an unknown property on the options bag) until
 * `flowRun` and its config field ship together.
 */
function createFlowDeps(overrides: Partial<AgentCliSurfaceDeps> = {}): {
  readonly deps: AgentCliSurfaceDeps;
  readonly recorder: RecordingRunProcess;
} {
  const recorder = createRecordingRunProcess();
  const { deps } = createDeps({
    flowAllowlist: new Set([FLOW_ALLOWED_NAME]),
    runProcess: recorder.runProcess,
    ...overrides,
  });
  return { deps, recorder };
}

/**
 * Builds a `flow run --json` payload with exactly one step, whose nested
 * `run` envelope is a full `AgentOperatorRunEnvelope` produced by the
 * EXISTING `makeRunEnvelope` fixture (never a hand-rolled copy) — mirroring
 * how the real CLI's `buildStepEnvelope` composes a step from the real
 * `buildRunEnvelope`. `stepReportPath` defaults to `null` so most callers
 * get an unremarkable happy-path fixture; the projection end-to-end test
 * below is the one caller that sets it to an absolute path.
 */
function makeFlowEnvelopePayload(
  overrides: {
    readonly exitCode?: number;
    readonly stepReportPath?: string | null;
  } = {},
): string {
  const stepRun = makeRunEnvelope({
    reportPath: overrides.stepReportPath ?? null,
    outcome: "success",
  });
  return JSON.stringify({
    kind: "m3l.flow.result",
    schemaVersion: 1,
    flow: FLOW_ALLOWED_NAME,
    runId: "flow-run-1",
    definitionHash: "deadbeefcafefeed",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:00:02.000Z",
    durationMs: 2000,
    status: "completed",
    exitCode: overrides.exitCode ?? 0,
    exitCodeName: "SUCCESS",
    dryRun: false,
    stepExecutionCount: 1,
    haltingStepId: null,
    resumeStepId: null,
    steps: [
      {
        stepId: "step-1",
        script: FLOW_ALLOWED_NAME,
        attempt: 1,
        branch: "continue",
        run: stepRun,
      },
    ],
  });
}

const FLOW_RUN_MODES: readonly (readonly [
  label: string,
  mode: AgentCliRunOptions["mode"],
])[] = [
  ["mutate", "mutate"],
  ["dry-run", "dry-run"],
] as const;

describe("createAgentCliSurface — flowRun() argv", () => {
  test("flowRun(flowName, { mode: 'mutate' }) sends exactly ['flow', 'run', flowName, '--json']", async () => {
    const { deps, recorder } = createFlowDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeFlowEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.flowRun(FLOW_ALLOWED_NAME, { mode: "mutate" });

    expect(recorder.invocations.map((call) => call.args)).toEqual([
      EXPECTED_FLOW_RUN_ARGV,
    ]);
  });

  test("flowRun(flowName, { mode: 'dry-run' }) appends --dry-run as the fifth token", async () => {
    const { deps, recorder } = createFlowDeps();
    recorder.enqueueResult(exitedResult({ stdout: makeFlowEnvelopePayload() }));
    const surface = createAgentCliSurface(deps);

    await surface.flowRun(FLOW_ALLOWED_NAME, { mode: "dry-run" });

    expect(recorder.invocations.map((call) => call.args)).toEqual([
      EXPECTED_FLOW_DRY_RUN_ARGV,
    ]);
    const argv = recorder.invocations[0]?.args ?? [];
    expect(argv).toHaveLength(5);
    expect(argv.at(-1)).toBe("--dry-run");
  });

  test.each(FLOW_RUN_MODES)(
    "flowRun() never emits a bare '--' in %s mode — m3l flow parses --json itself and rejects every extra argument, so a passthrough separator would be a usage error",
    async (_label, mode) => {
      const { deps, recorder } = createFlowDeps();
      recorder.enqueueResult(
        exitedResult({ stdout: makeFlowEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      await surface.flowRun(FLOW_ALLOWED_NAME, { mode });

      const argv = recorder.invocations[0]?.args ?? [];
      expect(argv).not.toContain("--");
    },
  );

  test.each(FLOW_RUN_MODES)(
    "flowRun() never emits --resume in %s mode — resuming would re-enter a partially-executed flow under an authorization granted for a fresh run",
    async (_label, mode) => {
      const { deps, recorder } = createFlowDeps();
      recorder.enqueueResult(
        exitedResult({ stdout: makeFlowEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      await surface.flowRun(FLOW_ALLOWED_NAME, { mode });

      const argv = recorder.invocations[0]?.args ?? [];
      expect(argv).not.toContain("--resume");
    },
  );

  test.each(FLOW_RUN_MODES)(
    "flowRun() never emits an --aws.profile token in %s mode — unlike triageRun, a profile cannot be pinned here because m3l flow rejects every extra argument",
    async (_label, mode) => {
      const { deps, recorder } = createFlowDeps();
      recorder.enqueueResult(
        exitedResult({ stdout: makeFlowEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      await surface.flowRun(FLOW_ALLOWED_NAME, { mode });

      const argv = recorder.invocations[0]?.args ?? [];
      expect(argv.some((arg) => arg.startsWith("--aws.profile"))).toBe(false);
    },
  );

  test.each(FLOW_RUN_MODES)(
    "flowRun() forwards flowTimeoutMs, not dryRunTimeoutMs, in %s mode — a dry-run flow still spawns every step",
    async (_label, mode) => {
      const { deps, recorder } = createFlowDeps();
      recorder.enqueueResult(
        exitedResult({ stdout: makeFlowEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      await surface.flowRun(FLOW_ALLOWED_NAME, { mode });

      // `createFlowDeps` leaves `createDeps`'s own defaults (lines ~81-82)
      // in place: `flowTimeoutMs: 600_000`, `dryRunTimeoutMs: 120_000`. A
      // mis-wire to `deps.dryRunTimeoutMs` would satisfy every other
      // assertion in this describe block while forwarding the wrong
      // budget — this is the one seam that would catch it.
      expect(recorder.invocations[0]?.timeoutMs).toBe(600_000);
      expect(recorder.invocations[0]?.timeoutMs).not.toBe(120_000);
    },
  );
});

// The bags that must all fail closed before any argv is built. Mirrors this
// file's own `UNRECOGNISED_RUN_MODE_BAGS` table, narrowed to the four rows
// the contract calls out for this seam specifically. Typed `unknown` and
// cast at the call site for the same reason as that table: a
// `readonly [string, AgentCliRunOptions][]` could not hold them.
const FLOW_RUN_INVALID_MODE_BAGS: readonly (readonly [
  label: string,
  bag: unknown,
])[] = [
  ["the options bag omitted entirely (undefined at runtime)", undefined],
  ["a near-miss spelling { mode: 'mutates' }", { mode: "mutates" }],
  ["an empty-string mode", { mode: "" }],
  [
    "a bag parsed from model-supplied JSON with an unrecognised mode",
    JSON.parse('{"mode":"nope"}') as unknown,
  ],
] as const;

describe("createAgentCliSurface — flowRun() narrows mode at RUNTIME and fails closed before spawning", () => {
  test.each(FLOW_RUN_INVALID_MODE_BAGS)(
    "flowRun() rejects %s instead of emitting any argv",
    async (_label, bag) => {
      const { deps, recorder } = createFlowDeps();
      recorder.enqueueResult(
        exitedResult({ stdout: makeFlowEnvelopePayload() }),
      );
      const surface = createAgentCliSurface(deps);

      const settlement = await settleRun(
        () =>
          // The cast is deliberate, same reasoning as the `run()` table
          // above: the declared type rejects this bag, and a caller that
          // casts (a bag parsed from model-supplied JSON) gets no
          // protection from the type system at runtime.
          surface.flowRun(FLOW_ALLOWED_NAME, bag as AgentCliRunOptions),
        recorder,
      );

      // Reuses the SAME assertion `run()`'s own M4 mode-narrowing suite
      // uses for this exact condition, rather than inventing a message:
      // coded `M3LAgentOperatorCliError`, never a bare `TypeError`, and
      // nothing spawned.
      assertCodedFailClosedRejection(settlement);
    },
  );
});

describe("createAgentCliSurface — flowRun() flow-name validation refuses before spawning", () => {
  test("a flowName failing the slug shape check ('--dry-run') rejects with ERR_AGENT_OPERATOR_CONFIG and spawns nothing", async () => {
    const { deps, recorder } = createFlowDeps();
    const surface = createAgentCliSurface(deps);

    await expect(
      surface.flowRun("--dry-run", { mode: "mutate" }),
    ).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CONFIG",
      // Verified directly against `lib/flow-names.ts`'s
      // `assertAllowedFlowName`, which raises three DISTINCT messages (never
      // one collapsed message) — this is the shape-check arm's exact text.
      message: "flow name has an invalid shape",
    });
    expect(recorder.invocations).toEqual([]);
  });

  test("a shape-valid flowName absent from the declared allowlist rejects with ERR_AGENT_OPERATOR_CONFIG and spawns nothing", async () => {
    const { deps, recorder } = createFlowDeps({
      flowAllowlist: new Set(["some-other-flow"]),
    });
    const surface = createAgentCliSurface(deps);

    await expect(
      surface.flowRun(FLOW_ALLOWED_NAME, { mode: "mutate" }),
    ).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CONFIG",
      // The membership arm's exact text — proves this is not merely the
      // shape check succeeding twice.
      message: "flow name is not on the allowlist",
    });
    expect(recorder.invocations).toEqual([]);
  });
});

describe("createAgentCliSurface — flowRun() returns a PROJECTED flow envelope", () => {
  test("a step's run.reportPath (an absolute host path) is projected away entirely — no own reportPath key on the returned step's run", async () => {
    const { deps, recorder } = createFlowDeps();
    recorder.enqueueResult(
      exitedResult({
        stdout: makeFlowEnvelopePayload({
          stepReportPath: "/repo/data/agent-log/report.json",
        }),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const envelope = await surface.flowRun(FLOW_ALLOWED_NAME, {
      mode: "mutate",
    });

    const step = envelope.steps[0];
    expect(step).toBeDefined();
    // `not.toHaveProperty` cannot prove own-key absence (it falls back to
    // the `in` operator and walks the prototype chain) — `Object.hasOwn` is
    // the only assertion that actually proves the parser/projection wiring
    // dropped the field rather than merely shadowing it.
    expect(Object.hasOwn(step?.run ?? {}, "reportPath")).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain(
      "/repo/data/agent-log/report.json",
    );
  });

  test("flowRun() accepts a non-zero exit code, resolving with the envelope's own exitCode", async () => {
    const { deps, recorder } = createFlowDeps();
    recorder.enqueueResult(
      exitedResult({
        exitCode: 6,
        stdout: makeFlowEnvelopePayload({ exitCode: 6 }),
      }),
    );
    const surface = createAgentCliSurface(deps);

    const envelope = await surface.flowRun(FLOW_ALLOWED_NAME, {
      mode: "mutate",
    });

    // Same policy as `run`/`dryRun`/`triageRun`: the envelope carries its
    // own outcome data, so a non-zero child exit is data, not a failure of
    // this tool.
    expect(envelope.exitCode).toBe(6);
  });
});
