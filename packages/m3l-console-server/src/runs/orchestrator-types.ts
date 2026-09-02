/**
 * `runs/orchestrator-types` — the public type surface of
 * `runs/orchestrator.ts`, split into its own file purely because
 * `orchestrator.ts` sits at the 25,000-byte per-file budget ceiling. There is
 * no design rationale beyond that: this is a byte-budget split, not a
 * layering decision, and `orchestrator.ts` re-exports every symbol declared
 * here so no consumer needs to know the split exists.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import type { RunExecutionMode } from "../store/runs-repository.js";

import type { M3LRunAuditSink } from "./audit.js";
import type { M3LRunEventSink } from "./events.js";
import type { M3LRunExecutor } from "./executor.js";
import type { M3LRunGovernor } from "./governor.js";
import type { M3LRunRequestBody } from "./parameters.js";
import type { M3LRunPolicy } from "./policy.js";
import type { M3LRunRegistry } from "./registry.js";

/**
 * The X4 run-governor's boot-time configuration, as the orchestrator needs
 * it. Declared locally — field for field identical to
 * `../config/runs.js`'s `M3LConsoleRunsConfig` — rather than imported: zone
 * rules let `runs/` import only `runs/`, `errors/`, `store/`, `stream/`, and
 * `config/` is not among them. `M3LConsoleRunsConfig` satisfies this
 * interface exactly — the same declared-not-imported trick
 * `lifecycle/shutdown.ts`'s `M3LShutdownDisposable` uses — and `main.ts`
 * (Round 3) passing the real config object is the compile-time proof.
 *
 * @example
 * ```ts
 * const config: M3LRunOrchestratorConfig = {
 *   scriptsDir: "/opt/scripts",
 *   maxPerScript: 1,
 *   queueCapacity: 16,
 *   streamRetention: 256,
 *   killTimeoutMs: 5000,
 *   maxConcurrency: 4,
 *   queueTimeoutMs: 30_000,
 * };
 * ```
 */
export interface M3LRunOrchestratorConfig {
  /** The resolved, absolute path to the scripts directory. */
  readonly scriptsDir: string;
  /** The maximum number of concurrent runs allowed per script. */
  readonly maxPerScript: number;
  /** The maximum number of runs the queue may hold once every slot is busy. */
  readonly queueCapacity: number;
  /** How many output lines a run's stream retains for replay. */
  readonly streamRetention: number;
  /** How long a killed run is given to exit before it is force-killed. */
  readonly killTimeoutMs: number;
  /** The maximum number of runs allowed to execute concurrently, across every script. */
  readonly maxConcurrency: number;
  /** How long a queued run waits for a free slot before it times out. */
  readonly queueTimeoutMs: number;
}

/**
 * Constructor options for {@link createRunOrchestrator}: every collaborator
 * the launch → start → finish lifecycle depends on.
 *
 * @example
 * ```ts
 * function describeOptions(options: M3LRunOrchestratorOptions): string {
 *   return options.config.scriptsDir;
 * }
 * ```
 */
export interface M3LRunOrchestratorOptions {
  /** The run governor's resolved boot-time configuration. */
  readonly config: M3LRunOrchestratorConfig;
  /** The run-persistence port. */
  readonly registry: M3LRunRegistry;
  /** The admission-control port. */
  readonly governor: M3LRunGovernor;
  /** The launch-confirmation policy port. */
  readonly policy: M3LRunPolicy;
  /** The run-lifecycle audit port. */
  readonly audit: M3LRunAuditSink;
  /** The run-event publication port. */
  readonly events: M3LRunEventSink;
  /** The executor used for a script with no opted-in command module. */
  readonly spawnExecutor: M3LRunExecutor;
  /** The executor used for a script that opted into ADR-0054's in-process command module. */
  readonly inProcessExecutor: M3LRunExecutor;
  /** The logger warnings/errors/reconciliation counts are recorded through. */
  readonly logger: Core.M3LLogger;
  /**
   * The directory every run's own output tree is created under (X7d,
   * ADR-0070). The orchestrator hands each run `<runsOutputRoot>/<runId>` as
   * its executor's `outputDir`, which the spawn executor turns into the
   * child's `M3L_OUTPUT_DIR`.
   *
   * An OPTION rather than a `config` field: {@link M3LRunOrchestratorConfig}
   * mirrors `config/runs.js`'s `M3LConsoleRunsConfig` field for field, and
   * this root is resolved the way the sibling session-artifact and audit
   * roots are — straight off an env var at composition time, never through
   * the settings-descriptor table. Adding it to `config` would make the two
   * shapes disagree and break the compile-time proof that they conform.
   */
  readonly runsOutputRoot: string;
}

/**
 * One validated launch request.
 *
 * @example
 * ```ts
 * const request: M3LRunLaunchRequest = {
 *   body: { scriptName: "sqs-etl", confirmed: true, dryRun: false, parameters: {} },
 *   operator: "ada",
 *   correlationId: "c-1",
 * };
 * ```
 */
export interface M3LRunLaunchRequest {
  /** The validated request body — see `runs/parameters`'s `parseRunRequest`. */
  readonly body: M3LRunRequestBody;
  /** The operator requesting the launch. */
  readonly operator: string;
  /** The correlation id this run's diagnostics are tagged with. */
  readonly correlationId: string;
}

/**
 * The handle {@link M3LRunOrchestrator.launch} returns for a newly launched
 * run.
 *
 * @example
 * ```ts
 * function describe(handle: M3LRunHandle): string {
 *   return `${handle.id} (${handle.status})`;
 * }
 * ```
 */
export interface M3LRunHandle {
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
 * The run orchestrator port: the X4 run-governor's single write path for a
 * script run's full lifecycle.
 *
 * @example
 * ```ts
 * declare const orchestrator: M3LRunOrchestrator;
 * orchestrator.activeCount; // 0
 * ```
 */
export interface M3LRunOrchestrator {
  /**
   * Resolves, policy-checks, admission-controls, persists, and — when a slot
   * is free — starts a run.
   *
   * @param request - See {@link M3LRunLaunchRequest}.
   * @returns The launched run's {@link M3LRunHandle}.
   * @throws {@link M3LConsoleError} propagated unchanged from `resolveScript`
   *   (`"ERR_CONSOLE_BAD_REQUEST"` / `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"`), or
   *   raised here with `"ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED"` (policy
   *   denial) / `"ERR_CONSOLE_RUN_CAPACITY_EXCEEDED"` (governor rejection).
   */
  launch(request: M3LRunLaunchRequest): M3LRunHandle;
  /**
   * Cancels a run, ACTIVE or QUEUED (X7d — this contract changed; a queued
   * run previously reported `false`).
   *
   * The two branches are not symmetric, and the difference is load-bearing:
   *
   * - An **active** run is only ABORTED here. Its own `executeAndSettle`
   *   continuation still owns the terminal write, and racing it would
   *   produce two finish records for one run. The run reaches `interrupted`
   *   the same way a signal death does.
   * - A **queued** run IS terminally written here, through
   *   `registry.abandonQueued`'s guarded `queued` to `interrupted`
   *   transition — never `claimForStart`-then-`finish`, because a run that
   *   never executed must never be given a fabricated `started_at_ms`.
   *   There is no continuation waiting to do it instead.
   *
   * Either way the run lands on the existing terminal `interrupted` status.
   * No new status, and no migration.
   *
   * `false` still never means merely "not found": it means "there is
   * nothing this call can cancel" — an unknown id, an already-terminal run,
   * or a lost race against whichever path settled it first. A caller that
   * needs to tell an unknown id apart asks the registry, which is what
   * `http/routes/runs.ts`'s cancel handler does to choose between 404 and
   * 409.
   *
   * @param id - The run's id.
   * @returns `true` when a run was cancelled, `false` otherwise.
   */
  cancel(id: string): boolean;
  /**
   * Transitions every orphaned (`queued`/`running`) row left over from a
   * killed previous process to `interrupted`. Call once at boot, before the
   * listener binds.
   *
   * @returns The number of rows reconciled.
   */
  reconcileOnBoot(): number;
  /** The number of runs currently active (started and not yet settled). */
  readonly activeCount: number;
  /**
   * Aborts every active run's signal and resolves once every one of them —
   * including any run that enters the active set only after the drain
   * started, whatever its source — has settled. Also permanently stops the
   * queue from being pumped: a run still `'queued'` when drain resolves
   * stays `'queued'`, for the next boot's `reconcileOnBoot` to reconcile —
   * nothing here ever starts it. Each executor's own kill-signal escalation
   * bounds how long draining the active set takes.
   */
  drain(): Promise<void>;
}
