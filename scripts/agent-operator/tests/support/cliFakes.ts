/**
 * Test-only fakes for the `src/lib/cli-process.ts` / `src/lib/cli-surface.ts`
 * seam. `cli-surface.test.ts` injects {@link createFakeRunCliProcess}'s
 * `runProcess` into `createAgentCliSurface({ runProcess })` so no real child
 * process is ever spawned while exercising the argv table, the exit-code
 * policy, and the disposition-to-error mapping.
 *
 * `cli-process.test.ts` tests one layer lower (the actual spawn plumbing) and
 * builds its own local `node:child_process` fakes — it does not use this
 * file.
 */
import type { CliRunResult, runCliProcess } from "../../src/lib/cli-process.js";

/**
 * A fake `runCliProcess`, plus the recorded `calls` (the full `args` array of
 * every invocation, in order) so a test can assert both what argv the
 * surface built AND — just as important — that nothing was spawned at all
 * (an empty `calls` array) for a rejected flag-injection attempt.
 */
export interface FakeRunCliProcess {
  /** Drop-in replacement for `runCliProcess`, injected as `deps.runProcess`. */
  readonly runProcess: typeof runCliProcess;
  /** One entry per invocation: that call's `args` array, in call order. */
  readonly calls: string[][];
  /** Scripts the `CliRunResult` the next invocation resolves with (FIFO). */
  enqueueResult(result: CliRunResult): void;
}

/**
 * Creates a {@link FakeRunCliProcess}. Each call to `runProcess` records
 * `options.args` into `calls` and resolves with the next queued result —
 * throwing a plain `Error` (a test-fixture bug, not a scenario under test) if
 * the queue is empty, so a forgotten `enqueueResult` fails loudly instead of
 * resolving `undefined`.
 *
 * @example
 * ```ts
 * const fake = createFakeRunCliProcess();
 * fake.enqueueResult(exitedResult({ stdout: makeListPayload() }));
 * const surface = createAgentCliSurface({ ...deps, runProcess: fake.runProcess });
 * await surface.list();
 * expect(fake.calls).toEqual([["list", "--json"]]);
 * ```
 */
export function createFakeRunCliProcess(): FakeRunCliProcess {
  const calls: string[][] = [];
  const queue: CliRunResult[] = [];
  const runProcess: typeof runCliProcess = (options: {
    readonly args: readonly string[];
  }) => {
    calls.push([...options.args]);
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(
          `createFakeRunCliProcess: no CliRunResult queued for call #${String(calls.length)}`,
        ),
      );
    }
    return Promise.resolve(next);
  };
  return {
    runProcess,
    calls,
    enqueueResult(result) {
      queue.push(result);
    },
  };
}

// ---------------------------------------------------------------------------
// CliRunResult builders — one per CliRunDisposition, with sane defaults so a
// test only overrides the fields its scenario cares about.
// ---------------------------------------------------------------------------

/** A successful (or non-zero, still clean) process exit. Defaults to code 0. */
export function exitedResult(
  overrides: Partial<CliRunResult> = {},
): CliRunResult {
  return {
    disposition: "exited",
    exitCode: 0,
    stdout: "",
    stderr: "",
    failureCode: undefined,
    ...overrides,
  };
}

/** A spawn-level failure (e.g. `ENOENT`) — never a real process exit. */
export function spawnFailedResult(
  overrides: Partial<CliRunResult> = {},
): CliRunResult {
  return {
    disposition: "spawn-failed",
    exitCode: null,
    stdout: "",
    stderr: "",
    failureCode: "ENOENT",
    ...overrides,
  };
}

/** The own-timer timeout path — distinct from `spawn`'s own `timeout` option. */
export function timedOutResult(
  overrides: Partial<CliRunResult> = {},
): CliRunResult {
  return {
    disposition: "timed-out",
    exitCode: null,
    stdout: "",
    stderr: "",
    failureCode: undefined,
    ...overrides,
  };
}

/** The signal reached the process layer but the caller-supplied signal aborted. */
export function abortedResult(
  overrides: Partial<CliRunResult> = {},
): CliRunResult {
  return {
    disposition: "aborted",
    exitCode: null,
    stdout: "",
    stderr: "",
    failureCode: undefined,
    ...overrides,
  };
}

/** The child died from a signal other than the process layer's own timeout kill. */
export function signalledResult(
  overrides: Partial<CliRunResult> = {},
): CliRunResult {
  return {
    disposition: "signalled",
    exitCode: null,
    stdout: "",
    stderr: "",
    failureCode: undefined,
    ...overrides,
  };
}

/** The byte cap was breached and the child was killed. */
export function truncatedResult(
  overrides: Partial<CliRunResult> = {},
): CliRunResult {
  return {
    disposition: "output-truncated",
    exitCode: null,
    stdout: "",
    stderr: "",
    failureCode: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Wire-shape payload builders — the exact JSON shapes the real CLI emits
// (verified in this worktree; see the PR 1 contract's "Ground truth"
// section). `doctor`/`list`/`inspect` are bare arrays with no envelope or
// `schemaVersion`; only `run --json` is a `kind`/`schemaVersion`-carrying
// object.
// ---------------------------------------------------------------------------

/** `m3l list --json` row shape — the successfully-loaded variant. */
export interface FakeListRowLoaded {
  readonly name: string;
  readonly description: string;
  readonly parameterCount: number;
  readonly loadError: null;
}

/** `m3l list --json` row shape — the load-failed variant. */
export interface FakeListRowFailed {
  readonly name: string;
  readonly description: string;
  readonly parameterCount: null;
  readonly loadError: string;
}

export type FakeListRow = FakeListRowLoaded | FakeListRowFailed;

/** Builds one successfully-loaded `list --json` row. */
export function makeListRow(
  overrides: Partial<FakeListRowLoaded> = {},
): FakeListRowLoaded {
  return {
    name: "widget-export",
    description: "Exports widgets to the warehouse",
    parameterCount: 5,
    loadError: null,
    ...overrides,
  };
}

/** Builds one load-failed `list --json` row. */
export function makeListRowFailed(
  overrides: Partial<FakeListRowFailed> = {},
): FakeListRowFailed {
  return {
    name: "broken-script",
    description: "",
    parameterCount: null,
    loadError: "failed to load config module",
    ...overrides,
  };
}

/** Serializes a `list --json` row array exactly as the real CLI emits it. */
export function makeListPayload(
  rows: readonly FakeListRow[] = [makeListRow()],
): string {
  return JSON.stringify(rows);
}

/** `m3l doctor --json` check shape. */
export interface FakeDoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

/** Builds one `doctor --json` check row. Defaults to a passing check. */
export function makeDoctorCheck(
  overrides: Partial<FakeDoctorCheck> = {},
): FakeDoctorCheck {
  return {
    name: "workspace-root",
    status: "ok",
    detail: "resolved",
    ...overrides,
  };
}

/** Serializes a `doctor --json` check array exactly as the real CLI emits it. */
export function makeDoctorPayload(
  checks: readonly FakeDoctorCheck[] = [makeDoctorCheck()],
): string {
  return JSON.stringify(checks);
}

/** `M3LConfigOperationDescriptor` shape, as it appears nested in `inspect --json`. */
export interface FakeParamOperationDescriptor {
  readonly name: string;
  readonly description: string;
  readonly requiredParameters: readonly string[];
}

/** `m3l inspect <name> --json` parameter-descriptor shape. */
export interface FakeParamDescriptor {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue: string | undefined;
  readonly description: string;
  readonly secret: boolean;
  readonly operations: readonly FakeParamOperationDescriptor[];
}

/** Builds one `inspect --json` parameter descriptor. */
export function makeParamDescriptor(
  overrides: Partial<FakeParamDescriptor> = {},
): FakeParamDescriptor {
  return {
    name: "awsProfile",
    aliases: [],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "AWS profile to assume",
    secret: false,
    operations: [],
    ...overrides,
  };
}

/** Serializes an `inspect --json` descriptor array exactly as the real CLI emits it. */
export function makeInspectPayload(
  descriptors: readonly FakeParamDescriptor[] = [makeParamDescriptor()],
): string {
  return JSON.stringify(descriptors);
}

/** `m3l run <name> --json -- --dry-run` envelope shape (a single object). */
export interface FakeRunEnvelope {
  readonly kind: "m3l.run.result";
  readonly schemaVersion: 1;
  readonly script: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly exitCodeName: string | null;
  readonly outcome:
    "success" | "failure" | "dry-run" | "interrupted" | "partial" | null;
  readonly reportPath: string | null;
  readonly reportUnavailable:
    | "output-directory-missing"
    | "output-directory-unreadable"
    | "no-matching-report"
    | "report-unreadable"
    | "report-malformed"
    | null;
  readonly timelineCount: number | null;
  readonly timelineSourceCount: number | null;
  readonly recoveryTotal: number | null;
}

/** Builds a `run --json` envelope. Defaults to a clean dry-run success. */
export function makeRunEnvelope(
  overrides: Partial<FakeRunEnvelope> = {},
): FakeRunEnvelope {
  return {
    kind: "m3l.run.result",
    schemaVersion: 1,
    script: "widget-export",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:01.000Z",
    durationMs: 1000,
    exitCode: 0,
    exitCodeName: "SUCCESS",
    outcome: "dry-run",
    reportPath: null,
    reportUnavailable: null,
    timelineCount: null,
    timelineSourceCount: null,
    recoveryTotal: null,
    ...overrides,
  };
}

/** Serializes a `run --json` envelope exactly as the real CLI emits it. */
export function makeRunEnvelopePayload(
  overrides: Partial<FakeRunEnvelope> = {},
): string {
  return JSON.stringify(makeRunEnvelope(overrides));
}
