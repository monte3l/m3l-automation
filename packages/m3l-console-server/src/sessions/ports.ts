/**
 * `sessions/ports` — declared-not-imported mirrors of the `runs/` zone's
 * launch-request/run-handle/run-event shapes (X6 workbench-sessions module,
 * slice 4, Part A).
 *
 * The `sessions` zone (`bin/check-eslint-zones.mjs`'s `CONSOLE_SERVER_LAYERS`)
 * may import only `sessions`, `errors`, `store` — never `runs/` — so this
 * module cannot import `runs/orchestrator-types.ts` or `runs/events.ts`
 * directly. It instead declares its own narrow, structurally-equivalent
 * types, the same declared-not-imported trick `http/routes/runs.ts` uses for
 * the same reason (see that module's own header TSDoc for the full
 * argument): the real `runs/` types satisfy these structurally, without
 * either zone importing the other, and `tests/sessions-ports-drift.test.ts`
 * pins the mirror against drift.
 *
 * `M3LSessionRunHandle.executionMode` uses the real `RunExecutionMode` union
 * exactly, rather than a widened mirror — `store` is within this zone's own
 * declared allowance, so importing `store/runs-repository.ts`'s type here
 * does not over-reach it.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import type { RunExecutionMode } from "../store/runs-repository.js";

/**
 * One validated launch request body — mirrors `runs/parameters.ts`'s
 * `M3LRunRequestBody` field for field.
 *
 * @example
 * ```ts
 * import type { M3LSessionLaunchRequestBody } from "@m3l-automation/m3l-console-server/sessions/ports";
 *
 * const body: M3LSessionLaunchRequestBody = {
 *   scriptName: "sqs-etl",
 *   confirmed: true,
 *   dryRun: false,
 *   parameters: { queue: "my-q" },
 * };
 * ```
 */
export interface M3LSessionLaunchRequestBody {
  /** The kebab-case name of the script to run. */
  readonly scriptName: string;
  /** Whether the caller explicitly confirmed a non-dry-run execution. */
  readonly confirmed: boolean;
  /** Whether the run should execute in dry-run mode. */
  readonly dryRun: boolean;
  /** The caller-supplied parameters, every value a string. */
  readonly parameters: Readonly<Record<string, string>>;
}

/**
 * One validated launch request — mirrors `runs/orchestrator-types.ts`'s
 * `M3LRunLaunchRequest` field for field.
 *
 * @example
 * ```ts
 * import type { M3LSessionLaunchRequest } from "@m3l-automation/m3l-console-server/sessions/ports";
 *
 * const request: M3LSessionLaunchRequest = {
 *   body: { scriptName: "sqs-etl", confirmed: true, dryRun: false, parameters: {} },
 *   operator: "ada",
 *   correlationId: "c-1",
 * };
 * ```
 */
export interface M3LSessionLaunchRequest {
  /** The validated request body — see {@link M3LSessionLaunchRequestBody}. */
  readonly body: M3LSessionLaunchRequestBody;
  /** The operator requesting the launch. */
  readonly operator: string;
  /** The correlation id this run's diagnostics are tagged with. */
  readonly correlationId: string;
}

/**
 * The handle a launch returns — mirrors `runs/orchestrator-types.ts`'s
 * `M3LRunHandle` field for field, including `executionMode`'s real
 * {@link RunExecutionMode} type (see this module's own
 * `@packageDocumentation` for why importing it here is within this zone's
 * allowance).
 *
 * @example
 * ```ts
 * import type { M3LSessionRunHandle } from "@m3l-automation/m3l-console-server/sessions/ports";
 *
 * function describe(handle: M3LSessionRunHandle): string {
 *   return `${handle.id} (${handle.status})`;
 * }
 * ```
 */
export interface M3LSessionRunHandle {
  /** The run's id. */
  readonly id: string;
  /** The script identifier this run invokes. */
  readonly scriptName: string;
  /** Whether the run started immediately or is waiting in the queue. */
  readonly status: "queued" | "running";
  /** Whether this run executes in dry-run mode. */
  readonly dryRun: boolean;
  /** Whether this run executes as a spawned subprocess or in-process. */
  readonly executionMode: RunExecutionMode;
}

/**
 * The local launcher port `sessions/service.ts` depends on — mirrors
 * `runs/orchestrator.ts`'s `M3LRunOrchestrator.launch` field for field, so
 * the real orchestrator satisfies it structurally without a
 * `sessions -> runs` import.
 *
 * @example
 * ```ts
 * import type { M3LSessionRunLauncherPort } from "@m3l-automation/m3l-console-server/sessions/ports";
 *
 * const launcher: M3LSessionRunLauncherPort = {
 *   launch: () => ({
 *     id: "run-1",
 *     scriptName: "sqs-etl",
 *     status: "running",
 *     dryRun: false,
 *     executionMode: "spawn",
 *   }),
 * };
 * ```
 */
export interface M3LSessionRunLauncherPort {
  /** Launches a validated run request; throws propagated unchanged from the real orchestrator. */
  launch(request: M3LSessionLaunchRequest): M3LSessionRunHandle;
}

/**
 * The closed set of run-lifecycle events this module tracks — a full
 * structural mirror of every `runs/events.ts` `M3LRunEvent` variant, not a
 * narrowed subset.
 *
 * @example
 * ```ts
 * import type { M3LSessionRunEvent } from "@m3l-automation/m3l-console-server/sessions/ports";
 *
 * function isTerminal(event: M3LSessionRunEvent): boolean {
 *   return event.event === "run.ended";
 * }
 * ```
 */
export type M3LSessionRunEvent =
  | {
      readonly event: "run.queued";
      readonly runId: string;
      readonly scriptName: string;
      readonly dryRun: boolean;
    }
  | {
      readonly event: "run.started";
      readonly runId: string;
      readonly atMs: number;
    }
  | {
      readonly event: "run.line";
      readonly runId: string;
      readonly line: string;
    }
  | {
      readonly event: "run.ended";
      readonly runId: string;
      readonly outcome: Core.M3LRunOutcome;
      readonly exitCode: number | undefined;
    };

/**
 * The local run-event publication port `sessions/service.ts` depends on —
 * mirrors `runs/events.ts`'s `M3LRunEventSink` field for field, so the real
 * sink satisfies it structurally without a `sessions -> runs` import.
 *
 * @example
 * ```ts
 * import type { M3LSessionRunEventSink } from "@m3l-automation/m3l-console-server/sessions/ports";
 *
 * function publishStarted(sink: M3LSessionRunEventSink, runId: string): void {
 *   sink.publish({ event: "run.started", runId, atMs: Date.now() });
 * }
 * ```
 */
export interface M3LSessionRunEventSink {
  /** Publishes `event`. Never throws — an event sink must not become a run failure mode. */
  publish(event: M3LSessionRunEvent): void;
}
