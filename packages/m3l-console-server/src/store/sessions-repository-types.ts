/**
 * `store/sessions-repository-types` — the public type surface of
 * `store/sessions-repository.ts`, split into its own file purely because
 * `sessions-repository.ts` sits at the 25,000-byte per-file budget ceiling
 * (ADR-0072). There is no design rationale beyond that: this is a
 * byte-budget split, not a layering decision — mirrors
 * `runs/orchestrator-types.ts`'s own split off `runs/orchestrator.ts` — and
 * `sessions-repository.ts` re-exports every symbol declared here, so no
 * consumer needs to know the split exists.
 *
 * @packageDocumentation
 */

import type { M3LRunStatus, M3LRunTerminalStatus } from "./run-status.js";

/** The closed `console_sessions.status` vocabulary — console-local, not `store/run-status.ts`'s. */
export type M3LSessionStatus = "open" | "closed";

/** The closed `console_session_decisions.status` vocabulary. */
export type M3LSessionDecisionStatus = "pending" | "answered";

/**
 * The `console_sessions` fields that don't vary between the `'open'` and
 * `'closed'` {@link M3LSessionRecord} variants.
 */
interface M3LSessionBase {
  /** The session's id, unique within this store. */
  readonly id: string;
  /** The operator this session belongs to. */
  readonly operator: string;
  /** The correlation id this session's diagnostics are tagged with. */
  readonly correlationId: string;
  /** Epoch-millisecond timestamp this session was created at. */
  readonly createdAtMs: number;
  /** Epoch-millisecond timestamp this session was last updated at. */
  readonly updatedAtMs: number;
}

/**
 * One `console_sessions` row, projected into camelCase fields. A
 * discriminated union on `status`, mirroring the table's
 * `CHECK ((status = 'closed') = (closed_at_ms IS NOT NULL))` invariant: the
 * `'open'` variant forbids `closedAtMs`, the `'closed'` variant requires it.
 *
 * @example
 * ```ts
 * function isOpen(record: M3LSessionRecord): boolean {
 *   return record.status === "open";
 * }
 * ```
 */
export type M3LSessionRecord =
  | (M3LSessionBase & {
      /** The session is currently open; it has no close timestamp. */
      readonly status: "open";
      readonly closedAtMs?: never;
    })
  | (M3LSessionBase & {
      /** The session is closed; `closedAtMs` records when. */
      readonly status: "closed";
      /** Epoch-millisecond timestamp this session was closed at. */
      readonly closedAtMs: number;
    });

/**
 * The fields `insertSession` writes for a newly created session. `status` is
 * always `'open'` at insert time; `updatedAtMs` is always `createdAtMs` at
 * insert time — so neither is part of this shape.
 *
 * @example
 * ```ts
 * const input: M3LSessionInsert = {
 *   id: "session-1",
 *   operator: "alice",
 *   correlationId: "corr-1",
 *   createdAtMs: Date.now(),
 * };
 * ```
 */
export interface M3LSessionInsert {
  /** The session's id, unique within this store. */
  readonly id: string;
  /** The operator this session belongs to. */
  readonly operator: string;
  /** The correlation id this session's diagnostics are tagged with. */
  readonly correlationId: string;
  /** Epoch-millisecond timestamp this session was created at. */
  readonly createdAtMs: number;
}

/**
 * Filters and a limit for `listSessions`. `limit` is required — see
 * `runs-repository.ts`'s `M3LRunListQuery` for why there is no unbounded
 * default and why `limit` must be a non-negative integer.
 *
 * @example
 * ```ts
 * const query: M3LSessionListQuery = { status: "open", limit: 20 };
 * ```
 */
export interface M3LSessionListQuery {
  /** Restricts results to this status, when given. */
  readonly status?: M3LSessionStatus;
  /** Restricts results to this operator, when given. */
  readonly operator?: string;
  /** The maximum number of rows to return. Must be a non-negative integer. */
  readonly limit: number;
}

/**
 * One `console_session_steps` row, projected into camelCase fields.
 * `status`/`outcome` share `store/run-status.ts`'s
 * {@link M3LRunStatus}/{@link M3LRunTerminalStatus} vocabulary unchanged —
 * see `store/sessions-repository.ts`'s own `@packageDocumentation` for why.
 *
 * @example
 * ```ts
 * function isPending(record: M3LSessionStepRecord): boolean {
 *   return record.status === "queued" || record.status === "running";
 * }
 * ```
 */
export interface M3LSessionStepRecord {
  /** The step's id, unique within this store. */
  readonly id: string;
  /** The session this step belongs to. */
  readonly sessionId: string;
  /**
   * This step's position within its session's ordered plan. 1-based,
   * matching `sessions/reference.ts`'s addressable-reference grammar
   * (`step-1`, `step-2`, ...; `step-0` is invalid).
   */
  readonly ordinal: number;
  /** The operation (e.g. a script identifier) this step invokes. */
  readonly operation: string;
  /** This step's parameters, round-tripped through JSON. */
  readonly parameters: unknown;
  /** The underlying `console_runs` id this step claimed, once claimed. */
  readonly runId: string | undefined;
  /** This step's current status. */
  readonly status: M3LRunStatus;
  /** A reference to this step's result, once available. */
  readonly resultRef: string | undefined;
  /** Epoch-millisecond timestamp this step was queued at. */
  readonly queuedAtMs: number;
  /** Epoch-millisecond timestamp this step started at, or `undefined` if it never started. */
  readonly startedAtMs: number | undefined;
  /** Epoch-millisecond timestamp this step ended at, or `undefined` while pending. */
  readonly endedAtMs: number | undefined;
  /** This step's terminal outcome, or `undefined` while pending. */
  readonly outcome: M3LRunTerminalStatus | undefined;
  /** A human-readable failure description, or `undefined` on a non-failure outcome. */
  readonly failureMessage: string | undefined;
}

/**
 * The fields `insertStep` writes for a newly queued step. `status` is always
 * `'queued'` at insert time — see `runs-repository.ts`'s `M3LRunInsert` for
 * why `runId`/`resultRef`/timing fields are absent here too.
 *
 * @example
 * ```ts
 * const input: M3LSessionStepInsert = {
 *   id: "step-1",
 *   sessionId: "session-1",
 *   ordinal: 1,
 *   operation: "scripts/example",
 *   parameters: { mode: "batch" },
 *   queuedAtMs: Date.now(),
 * };
 * ```
 */
export interface M3LSessionStepInsert {
  /** The step's id, unique within this store. */
  readonly id: string;
  /** The session this step belongs to. */
  readonly sessionId: string;
  /**
   * This step's position within its session's ordered plan. 1-based,
   * matching `sessions/reference.ts`'s addressable-reference grammar
   * (`step-1`, `step-2`, ...; `step-0` is invalid).
   */
  readonly ordinal: number;
  /** The operation (e.g. a script identifier) this step invokes. */
  readonly operation: string;
  /**
   * This step's parameters; round-tripped through JSON, so must be
   * JSON-serializable — see `store/parameters-json.ts`'s own
   * `@packageDocumentation` for the exact acceptance boundary.
   */
  readonly parameters: unknown;
  /** Epoch-millisecond timestamp this step was queued at. */
  readonly queuedAtMs: number;
}

/**
 * The fields `finishStep` writes when a step reaches a terminal outcome.
 *
 * @example
 * ```ts
 * const result: M3LSessionStepFinish = { outcome: "success", endedAtMs: Date.now() };
 * ```
 */
export interface M3LSessionStepFinish {
  /** This step's terminal outcome. */
  readonly outcome: M3LRunTerminalStatus;
  /** Epoch-millisecond timestamp the step ended at. */
  readonly endedAtMs: number;
  /** A reference to this step's result, when applicable. */
  readonly resultRef?: string;
  /** A human-readable failure description, when applicable. */
  readonly failureMessage?: string;
}

/**
 * One `console_session_bindings` row, projected into camelCase fields.
 *
 * @example
 * ```ts
 * function describe(record: M3LSessionBindingRecord): string {
 *   return `${record.reference} (${record.expectedType})`;
 * }
 * ```
 */
export interface M3LSessionBindingRecord {
  /** The binding's id, unique within this store. */
  readonly id: string;
  /** The session this binding belongs to. */
  readonly sessionId: string;
  /** The named reference this binding exposes (e.g. `"step-1.result"`). */
  readonly reference: string;
  /** The type a value bound to this reference is expected to have. */
  readonly expectedType: string;
  /** Whether this binding accepts multiple selected values. */
  readonly multiSelect: boolean;
  /** Epoch-millisecond timestamp this binding was created at. */
  readonly createdAtMs: number;
}

/**
 * The fields `insertBinding` writes for a new binding.
 *
 * @example
 * ```ts
 * const input: M3LSessionBindingInsert = {
 *   id: "binding-1",
 *   sessionId: "session-1",
 *   reference: "step-1.result",
 *   expectedType: "string",
 *   multiSelect: false,
 *   createdAtMs: Date.now(),
 * };
 * ```
 */
export interface M3LSessionBindingInsert {
  /** The binding's id, unique within this store. */
  readonly id: string;
  /** The session this binding belongs to. */
  readonly sessionId: string;
  /** The named reference this binding exposes (e.g. `"step-1.result"`). */
  readonly reference: string;
  /** The type a value bound to this reference is expected to have. */
  readonly expectedType: string;
  /** Whether this binding accepts multiple selected values. */
  readonly multiSelect: boolean;
  /** Epoch-millisecond timestamp this binding was created at. */
  readonly createdAtMs: number;
}

/**
 * The `console_session_decisions` fields that don't vary between the
 * `'pending'` and `'answered'` {@link M3LSessionDecisionRecord} variants.
 * `options` stays `unknown` on both branches — it is independent of the
 * pending/answered distinction, unlike `answer`.
 */
interface M3LSessionDecisionBase {
  /** The decision's id, unique within this store. */
  readonly id: string;
  /** The session this decision belongs to. */
  readonly sessionId: string;
  /** The step that raised this decision. */
  readonly stepId: string;
  /** The operator-facing prompt for this decision. */
  readonly prompt: string;
  /** The offered options, round-tripped through JSON, or `undefined` when none were given. */
  readonly options: unknown;
  /** Epoch-millisecond timestamp this decision was created at. */
  readonly createdAtMs: number;
}

/**
 * One `console_session_decisions` row, projected into camelCase fields. A
 * discriminated union on `status`, mirroring the table's two `CHECK`
 * constraints tying `status = 'answered'` to `answer_json`/`answered_at_ms`
 * both being non-`NULL`: the `'pending'` variant forbids `answer`/
 * `answeredAtMs`, the `'answered'` variant requires both.
 *
 * @example
 * ```ts
 * function isPending(record: M3LSessionDecisionRecord): boolean {
 *   return record.status === "pending";
 * }
 * ```
 */
export type M3LSessionDecisionRecord =
  | (M3LSessionDecisionBase & {
      /** The decision has not been answered yet. */
      readonly status: "pending";
      readonly answer?: never;
      readonly answeredAtMs?: never;
    })
  | (M3LSessionDecisionBase & {
      /** The decision has been answered. */
      readonly status: "answered";
      /** The operator's answer, round-tripped through JSON. */
      readonly answer: unknown;
      /** Epoch-millisecond timestamp this decision was answered at. */
      readonly answeredAtMs: number;
    });

/**
 * The fields `insertDecision` writes for a newly raised decision. `status`
 * is always `'pending'` at insert time.
 *
 * @example
 * ```ts
 * const input: M3LSessionDecisionInsert = {
 *   id: "decision-1",
 *   sessionId: "session-1",
 *   stepId: "step-1",
 *   prompt: "Proceed?",
 *   createdAtMs: Date.now(),
 * };
 * ```
 */
export interface M3LSessionDecisionInsert {
  /** The decision's id, unique within this store. */
  readonly id: string;
  /** The session this decision belongs to. */
  readonly sessionId: string;
  /** The step that raised this decision. */
  readonly stepId: string;
  /** The operator-facing prompt for this decision. */
  readonly prompt: string;
  /**
   * The offered options, when any; round-tripped through JSON, so must be
   * JSON-serializable when given.
   */
  readonly options?: unknown;
  /** Epoch-millisecond timestamp this decision was created at. */
  readonly createdAtMs: number;
}

/**
 * The fields `answerDecision` writes when a pending decision is answered.
 *
 * @example
 * ```ts
 * const answer: M3LSessionDecisionAnswer = { answer: "yes", answeredAtMs: Date.now() };
 * ```
 */
export interface M3LSessionDecisionAnswer {
  /**
   * The operator's answer; round-tripped through JSON, so must be
   * JSON-serializable.
   */
  readonly answer: unknown;
  /** Epoch-millisecond timestamp this decision was answered at. */
  readonly answeredAtMs: number;
}

/**
 * The console store's workbench-sessions registry (X6 slice 1):
 * `console_sessions`/`console_session_steps`/`console_session_bindings`/
 * `console_session_decisions` CRUD plus the guarded FSM transitions each
 * lifecycle needs.
 *
 * @example
 * ```ts
 * function isSessionOpen(repository: M3LConsoleSessionsRepository, id: string): boolean {
 *   return repository.getSession(id)?.status === "open";
 * }
 * ```
 */
export interface M3LConsoleSessionsRepository {
  /**
   * Inserts a new `'open'` session.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_STORE_QUERY_FAILED"`
   *   when the write fails (e.g. a duplicate `id`).
   */
  insertSession(input: M3LSessionInsert): void;
  /** Reads one session by id, or `undefined` when no such row exists. */
  getSession(id: string): M3LSessionRecord | undefined;
  /**
   * Lists sessions matching `query`, oldest-created-first, up to
   * `query.limit`.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `query.limit` is not a non-negative integer.
   */
  listSessions(query: M3LSessionListQuery): readonly M3LSessionRecord[];
  /**
   * Guarded `open` to `closed` transition.
   *
   * @returns `true` when this call's own write applied (the session was
   *   `open`); `false` when it was not (already closed, or unknown id).
   */
  closeSession(id: string, closedAtMs: number): boolean;
  /**
   * Guarded `closed` to `open` transition, clearing `closedAtMs`.
   *
   * @returns `true` when this call's own write applied (the session was
   *   `closed`); `false` when it was not (already open, or unknown id).
   */
  reopenSession(id: string, updatedAtMs: number): boolean;
  /**
   * Inserts a new `'queued'` step.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `input.parameters` is not JSON-serializable.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_STORE_QUERY_FAILED"`
   *   when the write fails (an unknown `sessionId`, or a duplicate
   *   `(sessionId, ordinal)` pair).
   */
  insertStep(input: M3LSessionStepInsert): void;
  /**
   * Guarded `queued` to `running` transition.
   *
   * @returns `true` when this call's own write applied (the step was
   *   `queued`); `false` when it was not (already running, already
   *   terminal, or unknown id) — a lost race reports `false`, never throws.
   */
  claimStepForStart(id: string, startedAtMs: number): boolean;
  /**
   * Guarded `running` to terminal transition.
   *
   * @returns `true` when this call's own write applied (the step was
   *   `running`); `false` when it was not (still queued, already terminal,
   *   or unknown id).
   */
  finishStep(id: string, result: M3LSessionStepFinish): boolean;
  /** Reads one step by id, or `undefined` when no such row exists. */
  getStep(id: string): M3LSessionStepRecord | undefined;
  /** Reads one step by its `(sessionId, ordinal)` pair, or `undefined` when no such row exists. */
  getStepByOrdinal(
    sessionId: string,
    ordinal: number,
  ): M3LSessionStepRecord | undefined;
  /** Lists every step for `sessionId`, ordinal-ascending. */
  listStepsForSession(sessionId: string): readonly M3LSessionStepRecord[];
  /**
   * Inserts a new binding.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_STORE_QUERY_FAILED"`
   *   when the write fails (e.g. an unknown `sessionId`).
   */
  insertBinding(input: M3LSessionBindingInsert): void;
  /** Lists every binding for `sessionId`, created-ascending. */
  listBindingsForSession(sessionId: string): readonly M3LSessionBindingRecord[];
  /**
   * Inserts a new `'pending'` decision.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `input.options` is given and is not JSON-serializable.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_STORE_QUERY_FAILED"`
   *   when the write fails (an unknown `sessionId` or `stepId`).
   */
  insertDecision(input: M3LSessionDecisionInsert): void;
  /**
   * Guarded `pending` to `answered` transition.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `answer.answer` is not JSON-serializable — checked before the
   *   guarded write, so a rejected answer leaves the decision `'pending'`.
   * @returns `true` when this call's own write applied (the decision was
   *   `pending`); `false` when it was not (already answered, or unknown id).
   */
  answerDecision(id: string, answer: M3LSessionDecisionAnswer): boolean;
  /** Reads one decision by id, or `undefined` when no such row exists. */
  getDecision(id: string): M3LSessionDecisionRecord | undefined;
  /** Lists every decision for `sessionId`, created-ascending. */
  listDecisionsForSession(
    sessionId: string,
  ): readonly M3LSessionDecisionRecord[];
  /** Counts sessions currently `'open'`. */
  countOpenSessions(): number;
}
