/**
 * `sessions/service` — `createSessionService`, the X6 workbench-sessions
 * domain service (slice 4, Part A, issue #554).
 *
 * Built entirely on the `sessions` zone's own allowance (`sessions`,
 * `errors`, `store` — `bin/check-eslint-zones.mjs`'s `CONSOLE_SERVER_LAYERS`):
 * `store/sessions-repository.ts` for session/step/binding/decision CRUD,
 * `sessions/launch-parameters.ts` for resolving a step's bindings (each a
 * caller reference into a prior step's recorded output) into the launched
 * run's parameter map, `sessions/artifacts.ts` for reading/persisting that
 * output, and `sessions/ports.ts`'s declared-not-imported mirrors of
 * `runs/`'s launch/event shapes so this service never imports `runs/`
 * directly.
 *
 * `addStep` and `handleRunEvent` are both `Promise`-returning: `addStep`
 * `await`s `M3LSessionArtifactStore.readArtifact` to resolve a binding
 * against a prior step's output, and `handleRunEvent`'s `run.ended` branch
 * `await`s `M3LSessionArtifactStore.put` to persist the finishing step's
 * payload — both real methods on `sessions/artifacts.ts`'s
 * `M3LSessionArtifactStore` return `Promise<...>`, so a synchronous surface
 * could not `await` either call.
 *
 * The READ-ONLY methods (`listBindingsForSession`, and X7d's
 * `readStepArtifact`) live in `sessions/service-reads.ts`, and X7d's
 * standalone `selectBinding` in `sessions/service-bindings.ts`; both are
 * spread in here. See those modules' headers for why, and for why each
 * declares its own narrow dependency type instead of importing this file's.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionDecisionRecord,
  M3LSessionListQuery,
  M3LSessionRecord,
  M3LSessionStepRecord,
} from "../store/sessions-repository.js";

import type {
  M3LSessionArtifactRef,
  M3LSessionArtifactStore,
} from "./artifacts.js";
import { decodeArtifactRef, encodeArtifactRef } from "./artifacts.js";
import { buildSessionBindingMethods } from "./service-bindings.js";
import type { SessionBindingMethods } from "./service-bindings.js";
import { buildSessionReadMethods } from "./service-reads.js";
import type { SessionReadMethods } from "./service-reads.js";
import type {
  M3LSessionAddStepBinding,
  M3LSessionAddStepInput,
} from "./launch-parameters.js";
import { resolveBindingValue } from "./launch-parameters.js";
import type {
  M3LSessionRunEvent,
  M3LSessionRunHandle,
  M3LSessionRunLauncherPort,
} from "./ports.js";

/**
 * The result {@link M3LSessionService.addStep} resolves to: the inserted
 * step, already carrying the attached `runId`, and the launched run's
 * handle.
 *
 * @example
 * ```ts
 * function describe(result: M3LSessionAddStepResult): string {
 *   return `${result.step.id} -> ${result.handle.id}`;
 * }
 * ```
 */
interface M3LSessionAddStepResult {
  /** The inserted step, carrying the attached `runId`. */
  readonly step: M3LSessionStepRecord;
  /** The launched run's handle. */
  readonly handle: M3LSessionRunHandle;
}

/**
 * Constructor options for {@link createSessionService}.
 *
 * @example
 * ```ts
 * import type { CreateSessionServiceOptions } from "@m3l-automation/m3l-console-server/sessions/service";
 *
 * declare const options: CreateSessionServiceOptions;
 * options.openSessionsMax; // a positive integer
 * ```
 */
export interface CreateSessionServiceOptions {
  /** The workbench-sessions repository. */
  readonly sessionsRepository: M3LConsoleSessionsRepository;
  /** The step-output artifact store. */
  readonly artifactStore: M3LSessionArtifactStore;
  /** The run-launching port. */
  readonly launcher: M3LSessionRunLauncherPort;
  /** The maximum number of sessions allowed open at once. */
  readonly openSessionsMax: number;
  /** Generates a fresh id for a newly created session/step/decision. */
  readonly newId: () => string;
  /** The current time, in epoch milliseconds — injected for determinism. */
  readonly nowMs: () => number;
}

/**
 * The X6 workbench-sessions domain service: session lifecycle, step
 * addition (binding resolution + launch), run-event handling, and operator
 * decisions.
 *
 * @example
 * ```ts
 * import type { M3LSessionService } from "@m3l-automation/m3l-console-server/sessions/service";
 *
 * declare const service: M3LSessionService;
 * service.createSession("alice", "corr-1");
 * ```
 */
export interface M3LSessionService
  extends SessionReadMethods, SessionBindingMethods {
  /**
   * Creates a new open session.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_LIMIT_EXCEEDED"`
   *   when the number of currently open sessions has already reached
   *   `openSessionsMax` — checked before any write.
   */
  createSession(operator: string, correlationId: string): M3LSessionRecord;
  /** Reads one session by id, or `undefined` when no such row exists. */
  getSession(id: string): M3LSessionRecord | undefined;
  /** Lists sessions matching `query` — see `store/sessions-repository.ts`'s `listSessions`. */
  listSessions(query: M3LSessionListQuery): readonly M3LSessionRecord[];
  /**
   * Closes an open session.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `id` names no session.
   * @returns `true` when this call's own write applied; `false` when the
   *   session was already closed.
   */
  closeSession(id: string): boolean;
  /**
   * Reopens a closed session.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `id` names no session.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_LIMIT_EXCEEDED"`
   *   when the number of currently open sessions has already reached
   *   `openSessionsMax` — checked after confirming `id` exists, before the
   *   reopen write.
   * @returns `true` when this call's own write applied; `false` when the
   *   session was already open.
   */
  reopenSession(id: string): boolean;
  /**
   * Resolves `input`'s bindings against prior steps' recorded output,
   * launches the run, records the new step, and attaches the launched run
   * to it. When the launcher's returned handle already reports `"running"`
   * — the real orchestrator can publish `run.started` synchronously inside
   * `launch()`, before this call ever gets the handle back to attach —
   * claims the step for start immediately rather than relying on an event
   * that has already fired and been missed.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `sessionId` names no session.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_CLOSED"`
   *   when the target session is not `open`.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_STEP_NOT_FOUND"`
   *   when a binding's reference names an ordinal with no step yet in this
   *   session.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_REFERENCE_INVALID"`
   *   when a binding's referenced step has no recorded result yet, or its
   *   resolved value does not match the binding's expected shape.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT"` or
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE"`, propagated unchanged from
   *   `artifactStore.readArtifact` while resolving a binding's referenced
   *   step's recorded output.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`,
   *   `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"`,
   *   `"ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED"`, or
   *   `"ERR_CONSOLE_RUN_CAPACITY_EXCEEDED"`, propagated unchanged from
   *   `launcher.launch` (the real orchestrator's own documented codes — see
   *   `ports.ts`'s `M3LSessionRunLauncherPort.launch`).
   */
  addStep(
    sessionId: string,
    input: M3LSessionAddStepInput,
  ): Promise<M3LSessionAddStepResult>;
  /**
   * Handles one run-lifecycle event: a silent no-op for `run.queued`/
   * `run.line` and for any `runId` with no attached step; claims the step
   * for start on `run.started`; persists the step's output artifact and
   * finishes the step on `run.ended`.
   *
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT"` when a `run.ended` event's
   *   handling fails to decode a prior step's persisted artifact reference
   *   while computing the session's running byte total.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE"` when a `run.ended` event's
   *   finishing step's own payload would exceed the session's configured
   *   byte cap — a foreseeable, caller-triggerable outcome, not an internal
   *   defect. Only a genuine internal defect (an unhandled event variant)
   *   otherwise propagates.
   */
  handleRunEvent(event: M3LSessionRunEvent): Promise<void>;
  /**
   * Raises a new pending decision for `stepId` within `sessionId`.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `sessionId` names no session.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_STEP_NOT_FOUND"`
   *   when `stepId` names no step, or names a step belonging to a different
   *   session (indistinguishable from "not found" from the caller's
   *   perspective — the error does not reveal which session actually owns
   *   it).
   */
  raiseDecision(
    sessionId: string,
    stepId: string,
    prompt: string,
    options?: unknown,
  ): M3LSessionDecisionRecord;
  /**
   * Answers a pending decision.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_STEP_NOT_FOUND"`
   *   when `id` names no decision.
   * @returns `true` when this call's own write applied; `false` when the
   *   decision was already answered.
   */
  answerDecision(id: string, answer: unknown): boolean;
  /**
   * Lists every decision raised for `sessionId`.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `sessionId` names no session.
   */
  listDecisionsForSession(
    sessionId: string,
  ): readonly M3LSessionDecisionRecord[];
}

/** Throws `ERR_CONSOLE_SESSION_NOT_FOUND`, or returns the found session record. */
function requireSession(
  sessionsRepository: M3LConsoleSessionsRepository,
  sessionId: string,
): M3LSessionRecord {
  const session = sessionsRepository.getSession(sessionId);
  if (session === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      `no session found with id "${sessionId}"`,
    );
  }
  return session;
}

/**
 * Throws `ERR_CONSOLE_SESSION_STEP_NOT_FOUND` unless `stepId` names a step
 * owned by `sessionId` — extracted from `raiseDecision` to keep
 * {@link buildDecisionServiceMethods} under the per-function line ceiling.
 */
function requireStepInSession(
  sessionsRepository: M3LConsoleSessionsRepository,
  sessionId: string,
  stepId: string,
): void {
  const step = sessionsRepository.getStep(stepId);
  if (step === undefined || step.sessionId !== sessionId) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
      `no step found with id "${stepId}"`,
    );
  }
}

/**
 * Throws `ERR_CONSOLE_SESSION_LIMIT_EXCEEDED` when the number of currently
 * open sessions has already reached `openSessionsMax` — shared by
 * `createSession` (before the new row is inserted) and `reopenSession`
 * (after the target is confirmed to exist, before its status write) so both
 * open-session-count-increasing paths enforce the identical cap.
 */
function requireOpenSessionCapacity(
  sessionsRepository: M3LConsoleSessionsRepository,
  openSessionsMax: number,
): void {
  if (sessionsRepository.countOpenSessions() >= openSessionsMax) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED",
      `the open-session limit of ${String(openSessionsMax)} has been reached`,
    );
  }
}

/** The 1-based ordinal the next inserted step should take: one past the highest existing ordinal, or 1 for an empty session. */
function nextStepOrdinal(steps: readonly M3LSessionStepRecord[]): number {
  return steps.reduce((max, step) => Math.max(max, step.ordinal), 0) + 1;
}

/** Reads back a just-inserted step, throwing a genuine internal defect if it is somehow absent. */
function requireStep(
  sessionsRepository: M3LConsoleSessionsRepository,
  stepId: string,
): M3LSessionStepRecord {
  const step = sessionsRepository.getStep(stepId);
  if (step === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `step "${stepId}" vanished immediately after insert`,
    );
  }
  return step;
}

/**
 * Resolves each of `bindings` in order via `resolveBindingValue`, persisting
 * a {@link M3LSessionBindingRecord} for a binding via `insertBinding`
 * immediately after that binding's own resolution succeeds — never before,
 * and never for a binding whose resolution has not yet been attempted. A
 * later binding's resolution failure therefore leaves every already-resolved
 * binding's persisted record in place (no rollback) while never persisting
 * the failed binding itself, matching this audit trail's "what was actually
 * resolved" contract.
 */
async function resolveAndPersistBindings(
  options: CreateSessionServiceOptions,
  sessionId: string,
  bindings: readonly M3LSessionAddStepBinding[],
): Promise<Record<string, string>> {
  const { sessionsRepository, artifactStore, newId, nowMs } = options;
  const parameters: Record<string, string> = {};
  for (const binding of bindings) {
    const value = await resolveBindingValue(
      sessionsRepository,
      artifactStore,
      sessionId,
      binding,
    );
    parameters[binding.parameterName] =
      typeof value === "string" ? value : JSON.stringify(value);
    sessionsRepository.insertBinding({
      id: newId(),
      sessionId,
      reference: binding.reference,
      expectedType: binding.expectedType,
      multiSelect: binding.multiSelect,
      parameterName: binding.parameterName,
      createdAtMs: nowMs(),
    });
  }
  return parameters;
}

/** The `addStep` implementation, split out of {@link buildSessionService} purely to keep that function short. */
async function addStep(
  options: CreateSessionServiceOptions,
  sessionId: string,
  input: M3LSessionAddStepInput,
): Promise<M3LSessionAddStepResult> {
  const { sessionsRepository, launcher, newId, nowMs } = options;
  const session = requireSession(sessionsRepository, sessionId);
  if (session.status !== "open") {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_CLOSED",
      `session "${sessionId}" is not open`,
    );
  }

  const parameters = await resolveAndPersistBindings(
    options,
    sessionId,
    input.bindings,
  );
  const handle = launcher.launch({
    body: {
      scriptName: input.operation,
      confirmed: input.confirmed,
      dryRun: input.dryRun,
      parameters,
    },
    operator: input.operator,
    correlationId: input.correlationId,
  });

  const stepId = newId();
  const ordinal = nextStepOrdinal(
    sessionsRepository.listStepsForSession(sessionId),
  );
  sessionsRepository.insertStep({
    id: stepId,
    sessionId,
    ordinal,
    operation: input.operation,
    parameters,
    queuedAtMs: nowMs(),
  });
  if (!sessionsRepository.attachStepRun(stepId, handle.id)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `failed to attach run "${handle.id}" to freshly inserted step "${stepId}"`,
    );
  }
  // The real orchestrator can publish `run.started` synchronously inside
  // `launch()`, before this function ever gets a handle back to attach —
  // `handleRunStarted`'s `getStepByRunId` then finds nothing attached yet
  // and silently no-ops (correct behavior for a genuinely unrelated run,
  // wrong here). If the returned handle already reports "running", that
  // event has already fired and been missed — catch up explicitly rather
  // than waiting for an event that already happened. `claimStepForStart`'s
  // guarded WHERE-clause (`status = 'queued'`) makes this idempotent/safe
  // even if a genuine `run.started` event for this step also arrives
  // through the normal event path shortly after.
  if (handle.status === "running") {
    sessionsRepository.claimStepForStart(stepId, nowMs());
  }

  return { step: requireStep(sessionsRepository, stepId), handle };
}

/** The session's current artifact running total: the sum of every step's `resultRef` that decodes to a `"file"`-kind ref's `sizeBytes`; `0` for `"inline"` kind or no `resultRef`. */
function computeSessionRunningTotalBytes(
  sessionsRepository: M3LConsoleSessionsRepository,
  sessionId: string,
): number {
  let total = 0;
  for (const step of sessionsRepository.listStepsForSession(sessionId)) {
    if (step.resultRef === undefined) continue;
    const ref: M3LSessionArtifactRef = decodeArtifactRef(step.resultRef);
    if (ref.kind === "file") total += ref.sizeBytes;
  }
  return total;
}

/** Handles `run.started`: claims the matching step for start, a silent no-op when no step is attached to `event.runId`. */
function handleRunStarted(
  sessionsRepository: M3LConsoleSessionsRepository,
  runId: string,
  atMs: number,
): void {
  const step = sessionsRepository.getStepByRunId(runId);
  if (step === undefined) return;
  sessionsRepository.claimStepForStart(step.id, atMs);
}

/** Handles `run.ended`: persists the finishing step's output artifact and finishes the step, a silent no-op when no step is attached to `event.runId`. */
async function handleRunEnded(
  options: CreateSessionServiceOptions,
  event: Extract<M3LSessionRunEvent, { readonly event: "run.ended" }>,
): Promise<void> {
  const { sessionsRepository, artifactStore, nowMs } = options;
  const step = sessionsRepository.getStepByRunId(event.runId);
  if (step === undefined) return;
  if (step.status !== "running") return;

  const runningTotal = computeSessionRunningTotalBytes(
    sessionsRepository,
    step.sessionId,
  );
  const ref = await artifactStore.put(
    step.sessionId,
    step.id,
    { outcome: event.outcome, exitCode: event.exitCode },
    runningTotal,
  );
  sessionsRepository.finishStep(step.id, {
    outcome: event.outcome,
    endedAtMs: nowMs(),
    resultRef: encodeArtifactRef(ref),
  });
}

/** The `handleRunEvent` implementation, split out of {@link buildSessionService} purely to keep that function short. */
async function handleRunEvent(
  options: CreateSessionServiceOptions,
  event: M3LSessionRunEvent,
): Promise<void> {
  switch (event.event) {
    case "run.queued":
    case "run.line":
      return;
    case "run.started":
      handleRunStarted(options.sessionsRepository, event.runId, event.atMs);
      return;
    case "run.ended":
      await handleRunEnded(options, event);
      return;
    default: {
      const exhaustive: never = event;
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `unhandled session run event: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * The session-lifecycle + step/run-event slice of {@link M3LSessionService}
 * — split out of {@link createSessionService} purely to keep that function
 * short; the returned object is spread back together with
 * {@link buildDecisionServiceMethods} below.
 */
function buildSessionLifecycleMethods(
  options: CreateSessionServiceOptions,
): Pick<
  M3LSessionService,
  | "createSession"
  | "getSession"
  | "listSessions"
  | "closeSession"
  | "reopenSession"
  | "addStep"
  | "handleRunEvent"
> {
  const { sessionsRepository, newId, nowMs, openSessionsMax } = options;

  return {
    createSession(operator: string, correlationId: string): M3LSessionRecord {
      requireOpenSessionCapacity(sessionsRepository, openSessionsMax);
      const id = newId();
      sessionsRepository.insertSession({
        id,
        operator,
        correlationId,
        createdAtMs: nowMs(),
      });
      return requireSession(sessionsRepository, id);
    },
    getSession(id: string): M3LSessionRecord | undefined {
      return sessionsRepository.getSession(id);
    },
    listSessions(query: M3LSessionListQuery): readonly M3LSessionRecord[] {
      return sessionsRepository.listSessions(query);
    },
    closeSession(id: string): boolean {
      requireSession(sessionsRepository, id);
      return sessionsRepository.closeSession(id, nowMs());
    },
    reopenSession(id: string): boolean {
      const session = requireSession(sessionsRepository, id);
      if (session.status === "closed") {
        requireOpenSessionCapacity(sessionsRepository, openSessionsMax);
      }
      return sessionsRepository.reopenSession(id, nowMs());
    },
    addStep(
      sessionId: string,
      input: M3LSessionAddStepInput,
    ): Promise<M3LSessionAddStepResult> {
      return addStep(options, sessionId, input);
    },
    handleRunEvent(event: M3LSessionRunEvent): Promise<void> {
      return handleRunEvent(options, event);
    },
  };
}

/**
 * The decision slice of {@link M3LSessionService} — see
 * {@link buildSessionLifecycleMethods}'s own TSDoc for why this is split
 * out.
 */
function buildDecisionServiceMethods(
  options: CreateSessionServiceOptions,
): Pick<
  M3LSessionService,
  "raiseDecision" | "answerDecision" | "listDecisionsForSession"
> {
  const { sessionsRepository, newId, nowMs } = options;

  return {
    raiseDecision(
      sessionId: string,
      stepId: string,
      prompt: string,
      decisionOptions?: unknown,
    ): M3LSessionDecisionRecord {
      requireSession(sessionsRepository, sessionId);
      requireStepInSession(sessionsRepository, sessionId, stepId);
      const id = newId();
      sessionsRepository.insertDecision({
        id,
        sessionId,
        stepId,
        prompt,
        createdAtMs: nowMs(),
        ...(decisionOptions !== undefined && { options: decisionOptions }),
      });
      const decision = sessionsRepository.getDecision(id);
      if (decision === undefined) {
        throw new M3LConsoleError(
          "ERR_CONSOLE_INTERNAL",
          `decision "${id}" vanished immediately after insert`,
        );
      }
      return decision;
    },
    answerDecision(id: string, answer: unknown): boolean {
      const decision = sessionsRepository.getDecision(id);
      if (decision === undefined) {
        throw new M3LConsoleError(
          "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
          `no decision found with id "${id}"`,
        );
      }
      return sessionsRepository.answerDecision(id, {
        answer,
        answeredAtMs: nowMs(),
      });
    },
    listDecisionsForSession(
      sessionId: string,
    ): readonly M3LSessionDecisionRecord[] {
      requireSession(sessionsRepository, sessionId);
      return sessionsRepository.listDecisionsForSession(sessionId);
    },
  };
}

/**
 * Creates a {@link M3LSessionService} over `options`.
 *
 * @param options - See {@link CreateSessionServiceOptions}.
 * @returns The created service.
 *
 * @example
 * ```ts
 * import { createSessionService } from "@m3l-automation/m3l-console-server/sessions/service";
 *
 * declare const dependencies: Parameters<typeof createSessionService>[0];
 * const service = createSessionService(dependencies);
 * service.createSession("alice", "corr-1");
 * ```
 */
export function createSessionService(
  options: CreateSessionServiceOptions,
): M3LSessionService {
  return {
    ...buildSessionLifecycleMethods(options),
    ...buildDecisionServiceMethods(options),
    ...buildSessionReadMethods(options),
    ...buildSessionBindingMethods(options),
  };
}
