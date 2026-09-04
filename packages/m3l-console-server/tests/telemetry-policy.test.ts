/**
 * Tests for `src/runs/admission.ts`'s `policy.decision` telemetry (X8 slice
 * 3c): `admitRun` emits exactly one
 * {@link M3LTelemetryPolicyDecisionSample} per gate it runs — the
 * confirmation policy (`posture: "confirmation"`, outcome `"allow"` /
 * `"deny"`) and the admission-control governor (`posture: "admission"`,
 * outcome `"accept"` / `"queue"` / `"reject"`) — and in every branch writes
 * the audit entry FIRST, the telemetry sample SECOND.
 *
 * RED: `M3LRunAdmissionOptions` has no `telemetry` field yet and `admitRun`
 * calls `policyDecision` nowhere, so every case below fails on an empty
 * `samples` / `sequence` array. Vitest does not typecheck, so the cases do
 * run; `pnpm typecheck` is a separate gate and is expected to flag only the
 * missing `telemetry` property once the orchestrator's construction site is
 * updated.
 *
 * `admitRun` IS a named export of `src/runs/admission.ts` and could be
 * called directly. Every case below nonetheless launches through a real
 * `createRunOrchestrator` (mirroring `telemetry-runs.test.ts`, slice 3a)
 * because the orchestrator is `admitRun`'s only production construction
 * site, and driving that site is what catches INERT WIRING: an orchestrator
 * that forgot to forward its own `telemetry` recorder into
 * `M3LRunAdmissionOptions` — or that stopped calling `admitRun` at all —
 * would leave a direct-call test fully green while no sample ever reached
 * the recorder in production. Calling `admitRun` directly would assert the
 * function in isolation; calling it through `launch` asserts the function
 * AND the wiring that reaches it.
 *
 * The confirmation gate uses the REAL `createConfirmationPolicy()` rather
 * than an always-allow fake: `allow` vs `deny` then follows from the request
 * body the way production does (`dryRun || confirmed`), so an `allow` case
 * cannot silently become a `deny` case (or vice versa) through a fake's own
 * hard-coded verdict.
 *
 * Fakes are copied and trimmed from `telemetry-runs.test.ts` /
 * `runs-orchestrator.test.ts` (this package's established convention) rather
 * than imported, so this file stays independently readable.
 * `Core.M3LLogger` has `#private` fields and can never be satisfied by a
 * plain-object fake — every test builds a real instance over a local
 * `RecordingHandler`. That handler also swallows any recorder-level warning,
 * so nothing here infers "not reached" from stdout; every negative assertion
 * below is made against a captured array instead.
 */
import * as fs from "node:fs";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LRunAdmissionOptions } from "../src/runs/admission.js";
import type { M3LRunAuditRecord, M3LRunAuditSink } from "../src/runs/audit.js";
import type { M3LRunEvent, M3LRunEventSink } from "../src/runs/events.js";
import type { M3LRunExecutor } from "../src/runs/executor.js";
import type {
  M3LRunGovernor,
  M3LRunGovernorDecision,
} from "../src/runs/governor.js";
import { createRunOrchestrator } from "../src/runs/orchestrator.js";
import type {
  M3LRunLaunchRequest,
  M3LRunOrchestratorOptions,
} from "../src/runs/orchestrator.js";
import type { M3LSpawnExitInfo } from "../src/runs/outcome.js";
import type { M3LRunRequestBody } from "../src/runs/parameters.js";
import { createConfirmationPolicy } from "../src/runs/policy.js";
import type { M3LRunRegistry } from "../src/runs/registry.js";
import type {
  M3LRunFinish,
  M3LRunInsert,
  M3LRunListQuery,
  M3LRunRecord,
} from "../src/store/runs-repository.js";
import type {
  M3LTelemetryPolicyDecisionSample,
  M3LTelemetryRecorder,
} from "../src/telemetry/port.js";

/** See `runs-orchestrator.test.ts`'s identical constants for full rationale. */
const RUNS_OUTPUT_ROOT = "/runs-output";
const SCRIPTS_ROOT = "/scripts";
const SCRIPT_NAME = "sqs-etl";

/** The two postures and five outcomes slice 3c's vocabulary allows, as literal expected samples. */
const CONFIRMATION_ALLOW: M3LTelemetryPolicyDecisionSample = {
  posture: "confirmation",
  outcome: "allow",
};
const CONFIRMATION_DENY: M3LTelemetryPolicyDecisionSample = {
  posture: "confirmation",
  outcome: "deny",
};
const ADMISSION_ACCEPT: M3LTelemetryPolicyDecisionSample = {
  posture: "admission",
  outcome: "accept",
};
const ADMISSION_QUEUE: M3LTelemetryPolicyDecisionSample = {
  posture: "admission",
  outcome: "queue",
};
const ADMISSION_REJECT: M3LTelemetryPolicyDecisionSample = {
  posture: "admission",
  outcome: "reject",
};

/**
 * The exact error {@link createThrowingTelemetryRecorder}'s `policyDecision`
 * throws. A module-level instance so the propagation cases can assert
 * IDENTITY — a matching message alone would also be satisfied by an
 * implementation that caught the original and rethrew a look-alike.
 */
const RECORDER_FAILURE = new Error("telemetry recorder exploded");

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

afterEach(() => {
  vi.restoreAllMocks();
});

type GovernorDecisionKind = M3LRunGovernorDecision["kind"];

/** Builds a fully-populated {@link M3LConsoleRunsConfig}, overridable per test. */
function buildConfig(
  overrides: Partial<M3LConsoleRunsConfig> = {},
): M3LConsoleRunsConfig {
  return {
    scriptsDir: SCRIPTS_ROOT,
    maxPerScript: 1,
    queueCapacity: 16,
    streamRetention: 256,
    killTimeoutMs: 5000,
    maxConcurrency: 4,
    queueTimeoutMs: 30_000,
    ...overrides,
  };
}

/** Builds a validated {@link M3LRunLaunchRequest} (confirmed, non-dry-run by default). */
function buildRequest(
  bodyOverrides: Partial<M3LRunRequestBody> = {},
): M3LRunLaunchRequest {
  return {
    body: {
      scriptName: SCRIPT_NAME,
      confirmed: true,
      dryRun: false,
      parameters: {},
      ...bodyOverrides,
    },
    operator: "ada",
    correlationId: "corr-1",
  };
}

/**
 * A recording `M3LLoggerHandler` fake (mirrors `runs-events.test.ts`'s
 * pattern).
 *
 * `reset()` is NOT dead code and must not be deleted: `Core.M3LLoggerHandler`
 * declares it as a REQUIRED member, so dropping it fails `pnpm typecheck`
 * (TS2420 on this class, TS2741 at the {@link buildLogger} construction
 * site) even though `pnpm test` stays green. No test calls it — every test
 * gets a fresh handler from `buildLogger`, so there is never accumulated
 * state to clear — it exists solely to satisfy the port.
 */
class RecordingHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];

  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

/**
 * Builds a real `Core.M3LLogger` over a fresh {@link RecordingHandler},
 * returning BOTH so a test can assert on what was logged.
 *
 * The handler reference is returned rather than discarded because this
 * file's central stance — the emit is not wrapped in a try/catch — is only
 * meaningful if nothing downstream quietly logs the failure instead: a
 * captured-events array is how that is asserted rather than inferred from
 * stdout.
 */
function buildLogger(): {
  readonly logger: Core.M3LLogger;
  readonly handler: RecordingHandler;
} {
  const handler = new RecordingHandler();
  return { logger: new Core.M3LLogger([handler]), handler };
}

/** A `Map`-backed fake `M3LRunRegistry`, trimmed to what this file's scenarios need. */
function createFakeRegistry(): M3LRunRegistry & {
  readonly rows: Map<string, M3LRunRecord>;
} {
  const rows = new Map<string, M3LRunRecord>();
  return {
    rows,
    insertQueued(input: M3LRunInsert): void {
      rows.set(input.id, {
        id: input.id,
        script: input.script,
        status: "queued",
        dryRun: input.dryRun,
        executionMode: input.executionMode,
        parameters: input.parameters,
        operator: input.operator,
        correlationId: input.correlationId,
        queuedAtMs: input.queuedAtMs,
        startedAtMs: undefined,
        endedAtMs: undefined,
        outcome: undefined,
        exitCode: undefined,
        failureMessage: undefined,
      });
    },
    claimForStart(id: string, startedAtMs: number): boolean {
      const row = rows.get(id);
      if (row === undefined || row.status !== "queued") return false;
      rows.set(id, { ...row, status: "running", startedAtMs });
      return true;
    },
    finish(id: string, result: M3LRunFinish): boolean {
      const row = rows.get(id);
      if (row === undefined || row.status !== "running") return false;
      rows.set(id, {
        ...row,
        status: result.outcome,
        outcome: result.outcome,
        endedAtMs: result.endedAtMs,
        exitCode: result.exitCode,
        failureMessage: result.failureMessage,
      });
      return true;
    },
    get(id: string): M3LRunRecord | undefined {
      return rows.get(id);
    },
    list(query: M3LRunListQuery): readonly M3LRunRecord[] {
      return [...rows.values()].slice(0, query.limit);
    },
    countRunningForScript(script: string): number {
      return [...rows.values()].filter(
        (row) => row.status === "running" && row.script === script,
      ).length;
    },
    reconcileOrphaned(): number {
      return 0;
    },
    abandonQueued(id: string, endedAtMs: number): boolean {
      const row = rows.get(id);
      if (row === undefined || row.status !== "queued") return false;
      rows.set(id, {
        ...row,
        status: "interrupted",
        outcome: "interrupted",
        endedAtMs,
      });
      return true;
    },
  };
}

/**
 * A fake `M3LRunGovernor` that hands out `decisions` in order (defaulting to
 * `"accept"` once exhausted) and logs every port call. The log is what makes
 * "the governor was never consulted" assertable, rather than inferred.
 *
 * The log is deliberately NOT the shared `sequence` array the ordering cases
 * assert with: the contract pins audit-vs-telemetry order only, and folding
 * governor calls into the same array would over-pin it.
 */
function createFakeGovernor(
  decisions: readonly GovernorDecisionKind[] = [],
): M3LRunGovernor & { readonly log: string[] } {
  const remaining = [...decisions];
  const log: string[] = [];
  let activeCount = 0;
  let queuedCount = 0;
  return {
    log,
    decide(scriptName: string): M3LRunGovernorDecision {
      const kind: GovernorDecisionKind = remaining.shift() ?? "accept";
      log.push(`decide:${scriptName}:${kind}`);
      return { kind };
    },
    accept(scriptName: string): void {
      log.push(`accept:${scriptName}`);
      activeCount += 1;
    },
    release(scriptName: string): void {
      log.push(`release:${scriptName}`);
      activeCount -= 1;
    },
    enqueue(): void {
      log.push("enqueue");
      queuedCount += 1;
    },
    dequeue(): void {
      log.push("dequeue");
      queuedCount -= 1;
    },
    get activeCount(): number {
      return activeCount;
    },
    get queuedCount(): number {
      return queuedCount;
    },
  };
}

/**
 * A fake `M3LRunAuditSink` that both records every entry and tags the shared
 * `sequence` array — the single array the ordering cases assert on, so
 * "audit first, telemetry second" is checked as an ORDER, never as two
 * independent counts.
 */
function createFakeAudit(sequence: string[]): M3LRunAuditSink & {
  readonly records: M3LRunAuditRecord[];
} {
  const records: M3LRunAuditRecord[] = [];
  return {
    records,
    record(entry: M3LRunAuditRecord): void {
      records.push(entry);
      sequence.push(`audit:${entry.action}`);
    },
  };
}

/** A fake `M3LRunEventSink` recording every event, in order. */
function createFakeEvents(): M3LRunEventSink & {
  readonly published: M3LRunEvent[];
} {
  const published: M3LRunEvent[] = [];
  return {
    published,
    publish(event: M3LRunEvent): void {
      published.push(event);
    },
  };
}

/**
 * A fake `M3LRunExecutor` whose `execute()` never settles, so a launched run
 * stays ACTIVE: the governor slot it committed is never released, and no
 * post-launch continuation (terminal write, queue pump) runs to perturb what
 * the assertions observe. Every case here asserts only on writes `admitRun`
 * makes synchronously during `launch`, so nothing needs the run to finish.
 */
function createHangingExecutor(): M3LRunExecutor {
  return {
    execute(): Promise<M3LSpawnExitInfo> {
      return new Promise<M3LSpawnExitInfo>(() => undefined);
    },
  };
}

/** A fake `timerImpl` (`typeof setTimeout`) recording every scheduled call. */
function createFakeTimer(): typeof setTimeout {
  return vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setTimeout;
}

/**
 * Configures `existsSync`/`lstatSync` so every `resolveScript` call resolves
 * a spawn-mode script — mirrors `telemetry-runs.test.ts`'s own helper. No
 * real filesystem is touched.
 */
function mockSpawnModeScripts(): void {
  vi.spyOn(fs, "existsSync").mockImplementation(
    (target: fs.PathLike) => !String(target).endsWith("command.js"),
  );
  vi.spyOn(fs, "lstatSync").mockImplementation((() => ({
    isSymbolicLink: () => false,
  })) as unknown as typeof fs.lstatSync);
}

/**
 * A capturing {@link M3LTelemetryRecorder}: every method is implemented (a
 * partial object cannot satisfy the port), `policyDecision` samples are
 * captured in order into `samples`, and each one also tags the shared
 * `sequence`.
 */
function createCapturingTelemetryRecorder(sequence: string[]): {
  readonly telemetry: M3LTelemetryRecorder;
  readonly samples: M3LTelemetryPolicyDecisionSample[];
} {
  const samples: M3LTelemetryPolicyDecisionSample[] = [];
  const telemetry: M3LTelemetryRecorder = {
    httpRequest: () => undefined,
    runFinished: () => undefined,
    sseStream: () => undefined,
    policyDecision: (sample) => {
      samples.push(sample);
      sequence.push(
        `telemetry:${sample.posture}/${sample.outcome ?? "(none)"}`,
      );
    },
    storeHealth: () => undefined,
  };
  return { telemetry, samples };
}

/**
 * A contract-VIOLATING {@link M3LTelemetryRecorder}: `policyDecision` throws
 * {@link RECORDER_FAILURE}, but only for samples whose `posture` matches
 * `throwOnPosture`. The filter matters — a recorder that threw on the FIRST
 * emit would abort `admitRun` before the gate under test ran at all, so a
 * case about the governor arm has to let the confirmation emit through.
 *
 * `attempts` records every sample handed to it (including the one that
 * throws), which is what proves the throwing path was actually exercised
 * rather than never reached.
 */
function createThrowingTelemetryRecorder(throwOnPosture: string): {
  readonly telemetry: M3LTelemetryRecorder;
  readonly attempts: M3LTelemetryPolicyDecisionSample[];
} {
  const attempts: M3LTelemetryPolicyDecisionSample[] = [];
  const telemetry: M3LTelemetryRecorder = {
    httpRequest: () => undefined,
    runFinished: () => undefined,
    sseStream: () => undefined,
    policyDecision: (sample) => {
      attempts.push(sample);
      if (sample.posture === throwOnPosture) throw RECORDER_FAILURE;
    },
    storeHealth: () => undefined,
  };
  return { telemetry, attempts };
}

/**
 * A clock that advances by `stepMs` on every call, starting at `startMs`.
 * MUST advance (never a constant) — a frozen clock lets two independently
 * derived timestamps agree by coincidence.
 */
function createSteppingClock(startMs: number, stepMs: number): () => number {
  let calls = 0;
  return (): number => {
    calls += 1;
    return startMs + calls * stepMs;
  };
}

/** The orchestrator collaborators one test needs, plus the shared ordering `sequence`. */
interface FixtureOptions {
  readonly sequence: string[];
  readonly registry: M3LRunRegistry & {
    readonly rows: Map<string, M3LRunRecord>;
  };
  readonly governor: M3LRunGovernor & { readonly log: string[] };
  readonly audit: M3LRunAuditSink & { readonly records: M3LRunAuditRecord[] };
  readonly events: M3LRunEventSink & { readonly published: M3LRunEvent[] };
  readonly executor: M3LRunExecutor;
  readonly logger: Core.M3LLogger;
  /** The handler behind {@link FixtureOptions.logger} — its `events` are the captured log. */
  readonly logHandler: RecordingHandler;
}

/** Builds a fresh set of orchestrator collaborators, overridable per test. */
function buildFixtures(
  overrides: Partial<{
    readonly decisions: readonly GovernorDecisionKind[];
    readonly executor: M3LRunExecutor;
  }> = {},
): FixtureOptions {
  const sequence: string[] = [];
  const { logger, handler } = buildLogger();
  return {
    sequence,
    registry: createFakeRegistry(),
    governor: createFakeGovernor(overrides.decisions ?? []),
    audit: createFakeAudit(sequence),
    events: createFakeEvents(),
    executor: overrides.executor ?? createHangingExecutor(),
    logger,
    logHandler: handler,
  };
}

/** Assembles a full `M3LRunOrchestratorOptions` around `fixtures` and `telemetry`. */
function buildOrchestratorOptions(
  fixtures: FixtureOptions,
  telemetry: M3LTelemetryRecorder,
  configOverrides: Partial<M3LConsoleRunsConfig> = {},
): M3LRunOrchestratorOptions {
  return {
    config: buildConfig(configOverrides),
    registry: fixtures.registry,
    governor: fixtures.governor,
    // The real confirmation policy, not a fake — see this file's header.
    policy: createConfirmationPolicy(),
    audit: fixtures.audit,
    events: fixtures.events,
    spawnExecutor: fixtures.executor,
    inProcessExecutor: fixtures.executor,
    logger: fixtures.logger,
    runsOutputRoot: RUNS_OUTPUT_ROOT,
    telemetry,
  };
}

/** Launches through a real orchestrator, returning the thrown error (if any). */
function captureThrow(launch: () => void): unknown {
  try {
    launch();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("admitRun — policy.decision telemetry on an admitted launch", () => {
  test("a confirmed non-dry-run launch records confirmation/allow then admission/accept, in that order", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({ decisions: ["accept"] });
    const { telemetry, samples } = createCapturingTelemetryRecorder(
      fixtures.sequence,
    );
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    const handle = orchestrator.launch(buildRequest());

    // Preconditions: the launch really passed BOTH gates, so both samples are
    // genuinely reachable — otherwise the equality below could be satisfied
    // by an implementation that never ran the governor at all.
    expect(handle.status).toBe("running");
    expect(fixtures.governor.log).toEqual([
      `decide:${SCRIPT_NAME}:accept`,
      `accept:${SCRIPT_NAME}`,
    ]);
    // One assertion pins content, count AND order in a single comparison.
    expect(samples).toEqual([CONFIRMATION_ALLOW, ADMISSION_ACCEPT]);
  });

  test("a dry run is allowed without confirmation and records the same two samples", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({ decisions: ["accept"] });
    const { telemetry, samples } = createCapturingTelemetryRecorder(
      fixtures.sequence,
    );
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    // confirmed: false — the real policy allows this ONLY because dryRun is
    // true, which is the branch under test.
    const handle = orchestrator.launch(
      buildRequest({ confirmed: false, dryRun: true }),
    );

    expect(handle.dryRun).toBe(true);
    expect(handle.status).toBe("running");
    expect(samples).toEqual([CONFIRMATION_ALLOW, ADMISSION_ACCEPT]);
  });

  test("a launch the governor queues records confirmation/allow then admission/queue", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({ decisions: ["queue"] });
    const { telemetry, samples } = createCapturingTelemetryRecorder(
      fixtures.sequence,
    );
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      {
        newId: () => "run-1",
        nowMs: createSteppingClock(1_000, 10),
        timerImpl: createFakeTimer(),
      },
    );

    const handle = orchestrator.launch(buildRequest());

    // Precondition: the run really took the queue arm (never the accept arm).
    expect(handle.status).toBe("queued");
    expect(fixtures.governor.log).toEqual([
      `decide:${SCRIPT_NAME}:queue`,
      "enqueue",
    ]);
    expect(samples).toEqual([CONFIRMATION_ALLOW, ADMISSION_QUEUE]);
  });
});

describe("admitRun — policy.decision telemetry on a refused launch", () => {
  test("an unconfirmed non-dry-run launch records ONLY confirmation/deny — no admission-posture sample — and still throws ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED", () => {
    mockSpawnModeScripts();
    // The governor is scripted to ACCEPT: if the confirmation gate leaked
    // through to it, an admission/accept sample would be emitted and the
    // exact-array assertion below would fail. That is what keeps the
    // "no admission sample" claim non-vacuous — the governor is not merely
    // unreachable by construction, it is primed to emit if consulted.
    const fixtures = buildFixtures({ decisions: ["accept"] });
    const { telemetry, samples } = createCapturingTelemetryRecorder(
      fixtures.sequence,
    );
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    const thrown = captureThrow(() => {
      orchestrator.launch(buildRequest({ confirmed: false, dryRun: false }));
    });

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
    );
    // The governor was never consulted at all — the deny arm throws first.
    expect(fixtures.governor.log).toEqual([]);
    // Pins the deny arm's sample array exactly: one sample, the confirmation
    // deny, and nothing else. What this does NOT pin is where the ALLOW emit
    // sits — moving that one after the governor call leaves this assertion
    // green, because the deny arm has its own emit inside
    // `applyConfirmationGate` and never reaches the governor. Sample ORDER on
    // the paths that do emit an allow is pinned by the three admitted-launch
    // cases and the governor-rejection case; the reject branch's
    // shared-`sequence` case pins that emit against its audit write.
    expect(samples).toEqual([CONFIRMATION_DENY]);
  });

  test("a launch the governor rejects records confirmation/allow then admission/reject, and throws ERR_CONSOLE_RUN_CAPACITY_EXCEEDED", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({ decisions: ["reject"] });
    const { telemetry, samples } = createCapturingTelemetryRecorder(
      fixtures.sequence,
    );
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    const thrown = captureThrow(() => {
      orchestrator.launch(buildRequest());
    });

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
    );
    // Rejected means no commitment: decide only, never accept/enqueue.
    expect(fixtures.governor.log).toEqual([`decide:${SCRIPT_NAME}:reject`]);
    expect(samples).toEqual([CONFIRMATION_ALLOW, ADMISSION_REJECT]);
  });
});

/**
 * The `default:` arm's "counts NOTHING" contract (stated in
 * `src/runs/admission.ts`'s `applyAdmissionGate` doc) needs BOTH of its
 * halves — reaching the arm, and observing that nothing was emitted — in one
 * place, which is what keeps the case below non-redundant.
 *
 * The arm is already reachable from `runs-orchestrator.test.ts`'s
 * unrecognised-decision case, but that test builds the orchestrator with no
 * `telemetry` option, so `src/runs/orchestrator.ts:537`
 * (`telemetry: options.telemetry ?? createNoOpTelemetryRecorder()`)
 * substitutes the no-op recorder, whose `policyDecision` is `() => undefined`
 * (`src/telemetry/no-op.ts:35`) — an emit added to the arm is invisible there
 * by construction. Every other case in THIS file wires a capturing recorder
 * but never reaches the arm. Mutation testing confirmed the split: adding
 * `policyDecision({ posture: "admission", outcome: "unknown" })` to the arm
 * left both files fully green.
 */
describe("admitRun — the governor switch's defensive default arm counts NOTHING", () => {
  test("an out-of-union governor decision throws ERR_CONSOLE_INTERNAL and emits no admission-posture sample", () => {
    mockSpawnModeScripts();
    // `M3LRunGovernorDecision.kind` is a closed "accept" | "queue" | "reject"
    // union, so reaching the arm at all requires a value from outside it; the
    // cast is the one `runs-orchestrator.test.ts` uses for the same purpose.
    const fixtures = buildFixtures({
      decisions: ["bogus" as unknown as GovernorDecisionKind],
    });
    const { telemetry, samples } = createCapturingTelemetryRecorder(
      fixtures.sequence,
    );
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    const thrown = captureThrow(() => {
      orchestrator.launch(buildRequest());
    });

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    // Preconditions: the governor really was consulted, really did return the
    // out-of-union kind, and nothing was committed against it — so the arm
    // ran, rather than the launch failing earlier for some other reason.
    expect(fixtures.governor.log).toEqual([`decide:${SCRIPT_NAME}:bogus`]);
    // The confirmation gate's sample is the ONLY one. The exact-array form is
    // load-bearing here: `posture`/`outcome` is a permanent primary key in the
    // rollup store, so a sample describing an unrecognised decision would
    // pollute it for good — and a `filter(...)` negative check could not fail
    // on a third sample that carried some other posture.
    expect(samples).toEqual([CONFIRMATION_ALLOW]);
  });
});

describe("admitRun — the audit write precedes the telemetry emit in every refusing branch", () => {
  test("the deny branch audits run.launch-denied BEFORE emitting confirmation/deny", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({ decisions: ["accept"] });
    const { telemetry } = createCapturingTelemetryRecorder(fixtures.sequence);
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    const thrown = captureThrow(() => {
      orchestrator.launch(buildRequest({ confirmed: false, dryRun: false }));
    });

    // Precondition: the branch under test really was taken (it throws).
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    // Both writes tag ONE shared array, so this asserts the ORDER — a count
    // per side could not distinguish audit-then-telemetry from
    // telemetry-then-audit.
    expect(fixtures.sequence).toEqual([
      "audit:run.launch-denied",
      "telemetry:confirmation/deny",
    ]);
  });

  test("the reject branch audits run.launch-rejected BEFORE emitting admission/reject", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({ decisions: ["reject"] });
    const { telemetry } = createCapturingTelemetryRecorder(fixtures.sequence);
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    const thrown = captureThrow(() => {
      orchestrator.launch(buildRequest());
    });

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    // The confirmation allow emit comes first (that gate runs first and
    // writes no audit entry of its own), then the rejection's audit entry,
    // then its telemetry sample.
    expect(fixtures.sequence).toEqual([
      "telemetry:confirmation/allow",
      "audit:run.launch-rejected",
      "telemetry:admission/reject",
    ]);
  });
});

describe("admitRun — a throwing telemetry recorder is NOT swallowed", () => {
  test("a throwing admission emit propagates the recorder's own error out of launch, unwrapped and unreclassified", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({ decisions: ["accept"] });
    // Throws on the governor gate's emit only, so the confirmation gate's
    // emit lands first and the governor is genuinely reached.
    const { telemetry, attempts } =
      createThrowingTelemetryRecorder("admission");
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    const thrown = captureThrow(() => {
      orchestrator.launch(buildRequest());
    });

    // The recorder was really invoked, on both gates, and the second call is
    // the one that threw.
    expect(attempts.map((sample) => sample.posture)).toEqual([
      "confirmation",
      "admission",
    ]);
    // Identity, not class: `admitRun` follows the stance stated in
    // `recordFinish`'s own TSDoc in `src/runs/orchestrator.ts` (currently
    // :83-85 — "The call is NOT wrapped in a try/catch: the port never
    // throws by contract"; the symbol is the durable reference, the line
    // range shifts with every edit above it), so a recorder that violates
    // the port's
    // never-throws contract surfaces as its own error. Asserting
    // `M3LConsoleError` here would instead permit reclassification, and
    // asserting nothing would permit a silent guard.
    expect(thrown).toBe(RECORDER_FAILURE);
    expect(thrown).not.toBeInstanceOf(M3LConsoleError);
    // What the next two assertions document (they are not a wish): the
    // governor slot IS committed by the time the emit throws, while the
    // launch never gets as far as persisting its row or auditing
    // `run.launch-allowed` — both happen in the orchestrator AFTER `admitRun`
    // returns. A contract-violating recorder therefore ORPHANS that slot,
    // permanently consuming capacity for a run that does not exist. That is
    // the cost of the never-throws stance, deferred from slice 3a and
    // identical in shape for the `audit` and `events` ports; it is recorded
    // here for the maintainer, not fixed here. The mitigation today is that
    // both shipped recorders honour the contract: the store-backed one wraps
    // every repository failure and reports it through `logger.warning`
    // (`src/telemetry-recorder.ts:156-157`), and the no-op recorder
    // (`src/telemetry/no-op.ts`) has no failure mode at all.
    expect(fixtures.governor.log).toEqual([
      `decide:${SCRIPT_NAME}:accept`,
      `accept:${SCRIPT_NAME}`,
    ]);
    expect(fixtures.registry.rows.get("run-1")).toBeUndefined();
    expect(
      fixtures.audit.records.some(
        (record) => record.action === "run.launch-allowed",
      ),
    ).toBe(false);
    // Asserted against the CAPTURED log, not stdout: the recorder's failure
    // surfaced by THROWING and by nothing else. `thrown === RECORDER_FAILURE`
    // above already rules out a swallow-and-log guard; this rules out the
    // subtler throw-AND-log variant, where the same failure would be counted
    // twice by an operator reading the log alongside the error.
    expect(
      fixtures.logHandler.events.map((event) => event.message),
    ).not.toContain(RECORDER_FAILURE.message);
  });

  test("a throwing confirmation emit propagates too, and the deny branch's audit entry — written first — still survives", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({ decisions: ["accept"] });
    const { telemetry, attempts } =
      createThrowingTelemetryRecorder("confirmation");
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    const thrown = captureThrow(() => {
      orchestrator.launch(buildRequest({ confirmed: false, dryRun: false }));
    });

    expect(attempts.map((sample) => sample.posture)).toEqual(["confirmation"]);
    expect(thrown).toBe(RECORDER_FAILURE);
    // The denial's own error never gets raised: the recorder's throw
    // pre-empts it. Another consequence of the never-throws stance worth the
    // maintainer's attention — a contract-violating recorder MASKS the
    // launch's real refusal from the caller.
    expect(thrown).not.toBeInstanceOf(M3LConsoleError);
    // The audit write precedes the emit in this branch (unlike the accept
    // arm above), so the refusal is still on the record.
    expect(
      fixtures.audit.records.some(
        (record) => record.action === "run.launch-denied",
      ),
    ).toBe(true);
    // Same captured-log guard as the admission case above.
    expect(
      fixtures.logHandler.events.map((event) => event.message),
    ).not.toContain(RECORDER_FAILURE.message);
  });
});

describe("M3LRunAdmissionOptions — telemetry is a REQUIRED option", () => {
  test("telemetry is exactly M3LTelemetryRecorder — not optional, not `| undefined`", () => {
    // A type-level pin only: invisible to `pnpm test` (it always "passes" at
    // runtime) and enforced solely by `pnpm typecheck`. `toEqualTypeOf` is
    // exact and `exactOptionalPropertyTypes` is on, so an optional
    // `telemetry?: M3LTelemetryRecorder` would fail this comparison.
    expectTypeOf<
      M3LRunAdmissionOptions["telemetry"]
    >().toEqualTypeOf<M3LTelemetryRecorder>();
  });
});
