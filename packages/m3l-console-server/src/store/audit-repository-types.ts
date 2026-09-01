/**
 * `store/audit-repository-types` — the public type surface of
 * `store/audit-repository.ts`, split into its own file purely because
 * `audit-repository.ts` sits at the 25,000-byte per-file budget ceiling
 * (ADR-0072). There is no design rationale beyond that: this is a
 * byte-budget split, not a layering decision — mirrors
 * `store/sessions-repository-types.ts`'s own split off
 * `store/sessions-repository.ts` — and `audit-repository.ts` re-exports
 * every symbol declared here, so no consumer needs to know the split
 * exists.
 *
 * **`src/store/**` sits in the `store` eslint zone, asserted at exactly
 * `["store", "errors"]` by `bin/check-eslint-zones.mjs`** — so this file
 * cannot import from `src/audit/`. The `M3LHumanActionIndex*` union types
 * below deliberately duplicate `audit/record.ts`'s own `M3LHumanAction*`
 * types rather than importing them, exactly as `runs-repository.ts` declares
 * `M3LRunInsert`/`M3LRunRecord` without importing from `src/runs/`. Do not
 * "deduplicate" this by adding an import — the zone gate will reject it.
 *
 * @packageDocumentation
 */

/** The closed action vocabulary `console_human_actions.action`'s own `CHECK` constraint enforces. */
export type M3LHumanActionIndexKind =
  | "run.launch"
  | "run.cancel"
  | "session.create"
  | "session.step.add"
  | "session.decision.raise"
  | "session.decision.answer"
  | "session.binding.select"
  | "session.close"
  | "session.reopen";

/** The closed target-kind vocabulary `console_human_actions.target_kind`'s own `CHECK` constraint enforces. */
export type M3LHumanActionIndexTargetKind =
  "script" | "run" | "session" | "step" | "artifact";

/** The closed posture vocabulary `console_human_actions.posture`'s own `CHECK` constraint enforces. */
export type M3LHumanActionIndexPosture = "auto" | "confirmed" | "escalated";

/** The closed outcome vocabulary `console_human_actions.outcome`'s own `CHECK` constraint enforces. */
export type M3LHumanActionIndexOutcome =
  "allowed" | "denied" | "rejected" | "failed" | "served";

/**
 * The fields common to every `M3LHumanActionIndexInput` variant, regardless
 * of `targetKind`/`scriptName` pairing — factored out so
 * {@link M3LHumanActionIndexInput}'s own discriminated union only has to
 * spell out the two fields that actually vary together.
 */
interface M3LHumanActionIndexCommon {
  /** Epoch-millisecond timestamp the action occurred at. Must be a safe integer. */
  readonly atMs: number;
  /** The operator who performed the action. Must be non-empty. */
  readonly operator: string;
  /** Whether the operator's identity carried a declared email. */
  readonly operatorEmailDeclared: boolean;
  /** The correlation id this action's diagnostics are tagged with. Must be non-empty. */
  readonly correlationId: string;
  /** Which kind of human action this row indexes. */
  readonly action: M3LHumanActionIndexKind;
  /** The posture the action was taken under. */
  readonly posture: M3LHumanActionIndexPosture;
  /** The action's outcome. */
  readonly outcome: M3LHumanActionIndexOutcome;
}

/**
 * The `targetKind`/`targetId`/`scriptName` half of
 * {@link M3LHumanActionIndexInput}, as a discriminated union on
 * `targetKind` — this is what makes the CHECK-guaranteed pairing
 * ("`scriptName` is present if and only if `targetKind` is `\"script\"`")
 * unrepresentable on the typed path, closing the hazard `insert`'s runtime
 * `requireValidTarget` guard exists to catch at the cast boundary instead
 * (see `store/migrations/registry.ts`'s own `CREATE_CONSOLE_HUMAN_ACTIONS_TABLE`
 * TSDoc for the three-layer picture).
 */
type M3LHumanActionIndexTarget =
  | {
      readonly targetKind: "script";
      readonly targetId: string;
      readonly scriptName: string;
    }
  | {
      readonly targetKind: Exclude<M3LHumanActionIndexTargetKind, "script">;
      readonly targetId: string;
      readonly scriptName?: undefined;
    };

/**
 * The fields `insert`/`insertAll` write for one human-action index row.
 * `scriptName` is required when `targetKind` is `"script"`, and must be
 * `undefined` otherwise — a discriminated union on `targetKind`, so the
 * illegal pairing cannot be constructed on the typed path at all. The
 * table's own trailing `CHECK` constraint enforces the same pairing at the
 * database level too (see `store/migrations/registry.ts`'s
 * `CREATE_CONSOLE_HUMAN_ACTIONS_TABLE`).
 *
 * @example
 * ```ts
 * const input: M3LHumanActionIndexInput = {
 *   atMs: Date.now(),
 *   operator: "alice",
 *   operatorEmailDeclared: true,
 *   correlationId: "corr-1",
 *   action: "run.launch",
 *   targetKind: "script",
 *   targetId: "scripts/example",
 *   scriptName: "scripts/example",
 *   posture: "auto",
 *   outcome: "allowed",
 * };
 * ```
 */
export type M3LHumanActionIndexInput = M3LHumanActionIndexCommon &
  M3LHumanActionIndexTarget;

/**
 * One `console_human_actions` row, projected into camelCase fields.
 *
 * Declared flat rather than extending {@link M3LHumanActionIndexInput} — an
 * interface cannot extend a union, and the read path needs no
 * `targetKind`/`scriptName` discrimination anyway: the `CHECK` constraint
 * already guarantees the pairing on the way out, so `scriptName` is simply
 * `string | undefined` here regardless of `targetKind`. A deliberate
 * consequence: `M3LHumanActionIndexRecord` is NOT assignable to
 * `M3LHumanActionIndexInput` (its `targetKind` is the whole
 * {@link M3LHumanActionIndexTargetKind} union, never narrowed to one arm),
 * so `repository.insertAll(repository.list(q))` does not compile — no
 * legitimate caller round-trips a read into a write.
 *
 * @example
 * ```ts
 * function summarize(record: M3LHumanActionIndexRecord): string {
 *   return `${record.id} (${record.action})`;
 * }
 * ```
 */
export interface M3LHumanActionIndexRecord {
  /** The row's rowid-aliased id. Rows carry no natural key — see `audit-repository.ts`'s own `@packageDocumentation`. */
  readonly id: number;
  /** Epoch-millisecond timestamp the action occurred at. */
  readonly atMs: number;
  /** The operator who performed the action. */
  readonly operator: string;
  /** Whether the operator's identity carried a declared email. */
  readonly operatorEmailDeclared: boolean;
  /** The correlation id this action's diagnostics are tagged with. */
  readonly correlationId: string;
  /** Which kind of human action this row indexes. */
  readonly action: M3LHumanActionIndexKind;
  /** The kind of entity this action targeted. */
  readonly targetKind: M3LHumanActionIndexTargetKind;
  /** The id of the targeted entity. */
  readonly targetId: string;
  /** The script identifier — present if and only if `targetKind` is `"script"`. */
  readonly scriptName: string | undefined;
  /** The posture the action was taken under. */
  readonly posture: M3LHumanActionIndexPosture;
  /** The action's outcome. */
  readonly outcome: M3LHumanActionIndexOutcome;
}

/**
 * Filters and a limit for `list`. `limit` is required, mirroring
 * `store/runs-repository.ts`'s own `M3LRunListQuery` — there is no unbounded
 * default. `fromMs`/`toMs` form an INCLUSIVE `[fromMs, toMs]` range: an audit
 * range query is read by a human asking "what happened between these two
 * timestamps", and a half-open range would silently drop an action landing
 * exactly on a boundary.
 *
 * @example
 * ```ts
 * const query: M3LHumanActionIndexQuery = { operator: "alice", limit: 20 };
 * ```
 */
export interface M3LHumanActionIndexQuery {
  /** Restricts results to this correlation id, when given. */
  readonly correlationId?: string | undefined;
  /** Restricts results to this operator, when given. */
  readonly operator?: string | undefined;
  /** Inclusive lower bound on `atMs`, when given. Must be a safe integer. */
  readonly fromMs?: number | undefined;
  /** Inclusive upper bound on `atMs`, when given. Must be a safe integer, and not less than `fromMs`. */
  readonly toMs?: number | undefined;
  /** The maximum number of rows to return. Must be a non-negative integer. */
  readonly limit: number;
}

/**
 * The console store's human-action audit index: `console_human_actions`
 * insert/query, and the truncate half of the JSONL rebuild path.
 *
 * @example
 * ```ts
 * function isEmpty(repository: M3LConsoleAuditRepository): boolean {
 *   return repository.count() === 0;
 * }
 * ```
 */
export interface M3LConsoleAuditRepository {
  /**
   * Inserts one row.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `input.atMs` is not a safe integer.
   */
  insert(input: M3LHumanActionIndexInput): void;
  /**
   * Inserts every row in `inputs`, in order. Opens no transaction of its
   * own — see `audit-repository.ts`'s own `@packageDocumentation` for why.
   *
   * @returns The number of rows inserted.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` on
   *   the first row whose `atMs` is not a safe integer; every row inserted
   *   before it stays persisted.
   */
  insertAll(inputs: readonly M3LHumanActionIndexInput[]): number;
  /**
   * Deletes every row — the truncate half of the JSONL rebuild path (see
   * `audit-repository.ts`'s own `@packageDocumentation`).
   *
   * @returns The number of rows deleted.
   */
  deleteAll(): number;
  /**
   * Lists rows matching `query`, most-recent-first (`at_ms` descending, ties
   * broken by `id` descending so ordering is deterministic within one
   * millisecond). Filters compose with `AND`.
   *
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
   *   when `query.limit` is not a non-negative integer, when `query.fromMs`
   *   or `query.toMs` is given and is not a safe integer, or when both are
   *   given with `fromMs` greater than `toMs`.
   */
  list(query: M3LHumanActionIndexQuery): readonly M3LHumanActionIndexRecord[];
  /** Counts every row currently in the table. */
  count(): number;
}
