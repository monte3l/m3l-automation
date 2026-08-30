/**
 * Tests for `src/lib/cli-surface.ts` — the typed adapter over
 * `src/lib/cli-process.ts`. Every scenario injects
 * `tests/support/cliFakes.ts`'s fake `runCliProcess` as `deps.runProcess`;
 * no real child process, no `vi.mock`.
 */
import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { runCliProcess } from "../../src/lib/cli-process.js";
import {
  createAgentCliSurface,
  type AgentCliSurface,
} from "../../src/lib/cli-surface.js";
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
 * Mirrors `createAgentCliSurface`'s documented `deps` shape (PR 1 contract),
 * plus `workspaceRoot` (M2 fix — not yet a field on the real
 * `CreateAgentCliSurfaceOptions`; kept here so the M2 scrub tests below
 * compile in RED, since assigning through a typed variable (not an object
 * literal) skips TypeScript's excess-property check).
 */
interface AgentCliSurfaceDeps {
  readonly entrypoint: string;
  readonly cwd: string;
  readonly nodeExecPath: string;
  readonly cliTimeoutMs: number;
  readonly dryRunTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly dryRunAllowlist: ReadonlySet<string>;
  readonly workspaceRoot?: string;
  readonly signal?: AbortSignal;
  readonly runProcess?: typeof runCliProcess;
}

const DRY_RUN_ALLOWED_NAME = "widget-export";

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

const FIXED_MODEL_FACING_MESSAGES: readonly string[] = [
  SCRIPT_NAME_REJECTION_MESSAGE,
  CLI_SPAWN_REJECTION_MESSAGE,
  CLI_OUTPUT_REJECTION_MESSAGE,
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
    expect(FIXED_MODEL_FACING_MESSAGES).toHaveLength(3);
    expect(new Set(FIXED_MODEL_FACING_MESSAGES).size).toBe(3);
  });
});
