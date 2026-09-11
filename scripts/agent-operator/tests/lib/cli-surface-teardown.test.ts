/**
 * Tests for `src/lib/cli-surface.ts`'s per-method teardown scope (V13) — the
 * one place `CliInvocationSpec.teardown` is set, and the proof that exactly
 * ONE of the seven surface methods opts into process-group teardown.
 *
 * Lives in its own file rather than in `cli-surface.test.ts`: that file is
 * baselined against `check:file-budget`'s per-file ceiling and may not grow.
 *
 * The recorder here captures the whole `runCliProcess` options bag (not just
 * `args`, which is all `tests/support/cliFakes.ts` records by contract), so
 * `teardown` is observable. No real child process, no `vi.mock`.
 */
import { describe, expect, test } from "vitest";

import type {
  CliRunResult,
  CliTeardownScope,
  runCliProcess,
} from "../../src/lib/cli-process.js";
import { createAgentCliSurface } from "../../src/lib/cli-surface.js";
import type { AgentCliSurface } from "../../src/lib/cli-surface.js";
import {
  exitedResult,
  makeDoctorPayload,
  makeInspectPayload,
  makeListPayload,
  makeRunEnvelope,
  makeRunEnvelopePayload,
} from "../support/cliFakes.js";

const SCRIPT_NAME = "widget-export";
const FLOW_NAME = "dlq-reconcile";
const PRESET_NAME = "nightly";
const PRESET_RELATIVE_PATH = "data/config/presets/agent-operator/nightly.json";
const OPERATOR_PROFILE = "ops-writer";

/**
 * One recorded invocation. Deliberately carries ONLY the field under test —
 * argv is already exhaustively pinned by `cli-surface.test.ts`, and a
 * recorded-but-never-asserted field reads as coverage while proving nothing.
 */
interface RecordedTeardown {
  readonly teardown: CliTeardownScope | undefined;
}

function createTeardownRecorder(): {
  readonly runProcess: typeof runCliProcess;
  readonly invocations: readonly RecordedTeardown[];
  enqueueResult(result: CliRunResult): void;
} {
  const invocations: RecordedTeardown[] = [];
  const queue: CliRunResult[] = [];
  const runProcess: typeof runCliProcess = (options) => {
    invocations.push({ teardown: options.teardown });
    const next = queue.shift();
    if (next === undefined) {
      // A forgotten `enqueueResult` is a fixture bug, not a scenario.
      return Promise.reject(
        new Error(
          `createTeardownRecorder: no CliRunResult queued for call #${String(invocations.length)}`,
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

function createSurface(runProcess: typeof runCliProcess): AgentCliSurface {
  return createAgentCliSurface({
    entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
    cwd: "/repo",
    nodeExecPath: "/usr/bin/node",
    cliTimeoutMs: 30_000,
    dryRunTimeoutMs: 120_000,
    flowTimeoutMs: 600_000,
    maxOutputBytes: 1_048_576,
    workspaceRoot: "/repo",
    dryRunAllowlist: new Set([SCRIPT_NAME]),
    presetAllowlist: new Map([[PRESET_NAME, PRESET_RELATIVE_PATH]]),
    flowAllowlist: new Set([FLOW_NAME]),
    runProcess,
  });
}

/** The `flow run --json` envelope shape, with one successful step. */
function makeFlowEnvelopePayload(): string {
  return JSON.stringify({
    kind: "m3l.flow.result",
    schemaVersion: 1,
    flow: FLOW_NAME,
    runId: "flow-run-1",
    definitionHash: "deadbeefcafefeed",
    startedAt: "2026-09-11T00:00:00.000Z",
    finishedAt: "2026-09-11T00:00:02.000Z",
    durationMs: 2000,
    status: "completed",
    exitCode: 0,
    exitCodeName: "SUCCESS",
    dryRun: false,
    stepExecutionCount: 1,
    haltingStepId: null,
    resumeStepId: null,
    steps: [
      {
        stepId: "step-1",
        script: SCRIPT_NAME,
        attempt: 1,
        branch: "continue",
        // The typed fixture, never a `JSON.parse` of its serialized form —
        // that round trip would hand an `any` to the step object.
        run: makeRunEnvelope({ outcome: "success" }),
      },
    ],
  });
}

/**
 * One row per surface method: the stdout payload its parser accepts, and the
 * call that drives it. Deliberately a table over ALL SEVEN methods, so an
 * eighth method added without a `teardown` literal has no row and its
 * omission is visible here as well as at the compiler.
 */
const METHODS: readonly (readonly [
  label: string,
  payload: () => string,
  drive: (surface: AgentCliSurface) => Promise<unknown>,
])[] = [
  ["list", makeListPayload, (surface) => surface.list()],
  ["doctor", makeDoctorPayload, (surface) => surface.doctor()],
  ["inspect", makeInspectPayload, (surface) => surface.inspect(SCRIPT_NAME)],
  [
    "dryRun",
    () => makeRunEnvelopePayload(),
    (surface) => surface.dryRun(SCRIPT_NAME),
  ],
  [
    "run",
    () => makeRunEnvelopePayload(),
    (surface) => surface.run(SCRIPT_NAME, PRESET_NAME, { mode: "dry-run" }),
  ],
  [
    "triageRun",
    () => makeRunEnvelopePayload(),
    (surface) => surface.triageRun(SCRIPT_NAME, PRESET_NAME, OPERATOR_PROFILE),
  ],
  [
    "flowRun",
    makeFlowEnvelopePayload,
    (surface) => surface.flowRun(FLOW_NAME, { mode: "mutate" }),
  ],
];

/** Drives one method and returns the teardown scope it forwarded. */
async function captureTeardown(
  label: string,
): Promise<CliTeardownScope | undefined> {
  const row = METHODS.find(([name]) => name === label);
  if (row === undefined) throw new Error(`no METHODS row for ${label}`);
  const [, payload, drive] = row;
  const recorder = createTeardownRecorder();
  recorder.enqueueResult(exitedResult({ stdout: payload() }));
  await drive(createSurface(recorder.runProcess));

  expect(recorder.invocations).toHaveLength(1);
  return recorder.invocations[0]?.teardown;
}

describe("cli-surface — flowRun is the only method that tears down a process group", () => {
  test("flowRun() forwards teardown: 'group'", async () => {
    expect(await captureTeardown("flowRun")).toBe("group");
  });

  test.each(["mutate", "dry-run"] as const)(
    "flowRun() forwards teardown: 'group' in %s mode too — a dry-run flow still spawns every step",
    async (mode) => {
      const recorder = createTeardownRecorder();
      recorder.enqueueResult(
        exitedResult({ stdout: makeFlowEnvelopePayload() }),
      );

      await createSurface(recorder.runProcess).flowRun(FLOW_NAME, { mode });

      expect(recorder.invocations[0]?.teardown).toBe("group");
    },
  );

  // Asserted as `=== "child"`, never as `!== "group"`: an eighth method (or a
  // spec whose `teardown` went missing in a refactor) must fail here rather
  // than pass on a falsy value.
  test.each([
    ["list"],
    ["doctor"],
    ["inspect"],
    ["dryRun"],
    ["run"],
    ["triageRun"],
  ])("%s() forwards teardown: 'child' exactly", async (label) => {
    expect(await captureTeardown(label)).toBe("child");
  });
});
