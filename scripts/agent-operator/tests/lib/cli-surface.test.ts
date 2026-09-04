/**
 * Tests for `src/lib/cli-surface.ts` — the typed adapter over
 * `src/lib/cli-process.ts`. Every scenario injects
 * `tests/support/cliFakes.ts`'s fake `runCliProcess` as `deps.runProcess`;
 * no real child process, no `vi.mock`.
 */
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

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
  makeRunEnvelopePayload,
  signalledResult,
  spawnFailedResult,
  timedOutResult,
  truncatedResult,
} from "../support/cliFakes.js";

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
    maxOutputBytes: 1_048_576,
    dryRunAllowlist: new Set([DRY_RUN_ALLOWED_NAME]),
    presetAllowlist: new Map([[PRESET_ALLOWED_NAME, PRESET_RELATIVE_PATH]]),
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
 * Reads the value an own-property-less bag would INHERIT for `key`, without
 * asserting anything about how it got there. `undefined` is the only clean
 * state: `Object.prototype` carries none of these keys in a healthy run.
 */
function readInheritedCtorDep(key: OptionalCtorDepKey): unknown {
  const bag: Record<string, unknown> = {};
  return bag[key];
}

/** Fails loudly, at the source, if a row leaked its pollution. */
function expectCtorPrototypeUnpolluted(): void {
  for (const key of OPTIONAL_CTOR_DEP_KEYS) {
    expect(Object.hasOwn(Object.prototype, key)).toBe(false);
    expect(readInheritedCtorDep(key)).toBeUndefined();
  }
}

/**
 * Installs `Object.prototype[key]` for the duration of `body` and removes it
 * unconditionally afterwards.
 *
 * Non-enumerable on purpose: an enumerable `Object.prototype` property would
 * also change every `for…in` and `JSON.stringify` in the process during the
 * window, which would make a failure inside `body` ambiguous between the
 * finding and the fixture. `configurable: true` is what makes the removal in
 * the `finally` guaranteed to succeed, and `Reflect.deleteProperty` keeps it
 * a static call rather than a dynamic `delete`.
 *
 * The inherited read is asserted INSIDE the `try`, before `body` runs: a
 * fixture whose `defineProperty` silently failed to take would otherwise let
 * a row pass for the wrong reason (rows 1–3 all assert an outcome that a
 * CLEAN prototype already produces).
 */
async function withInheritedCtorDep(
  key: OptionalCtorDepKey,
  value: unknown,
  body: () => Promise<void>,
): Promise<void> {
  expectCtorPrototypeUnpolluted();
  Object.defineProperty(Object.prototype, key, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  try {
    expect(readInheritedCtorDep(key)).toBe(value);
    await body();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
  expectCtorPrototypeUnpolluted();
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
    maxOutputBytes: 1_048_576,
    dryRunAllowlist: new Set([DRY_RUN_ALLOWED_NAME]),
    presetAllowlist: new Map([[PRESET_ALLOWED_NAME, PRESET_RELATIVE_PATH]]),
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
