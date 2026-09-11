/**
 * `audit/kinds` — the closed vocabulary {@link M3LHumanActionRecord} is built
 * from: what action was taken ({@link M3LHumanActionKind}), what it acted
 * upon ({@link M3LHumanActionTarget}), how much human intent stood behind it
 * ({@link M3LHumanActionPosture}), and what the console did with the request
 * ({@link M3LHumanActionOutcome}) — plus the runtime validation table for
 * each.
 *
 * Split out of `audit/record.ts` purely to keep that file under the
 * 25,000-byte file-budget cap (`bin/check-file-budget.mjs`) — a pure,
 * behavior-preserving extraction, not a layering or design decision.
 *
 * @packageDocumentation
 */

/**
 * The closed set of operator-initiated actions the console audits.
 *
 * Machine transitions (`run.started`, `run.finished`, `run.reconciled`) are
 * deliberately absent: those belong to `runs/audit.ts`'s run-lifecycle sink,
 * not to the human-action trail.
 *
 * @example
 * ```ts
 * const kind: M3LHumanActionKind = "run.launch";
 * ```
 * * The `view.` members deliberately INVERT the `<subject>.<action>` shape the
 * write kinds use. ADR-0070 treats a rendering as a distinct **exposure
 * class**, not another operation on a subject, and `startsWith("view.")` is
 * the query an auditor actually runs — "what did this operator SEE" is a
 * different question from "what did they change". `runs/audit.ts` already
 * uses a prefix that way.
 *
 * X7d wired both remaining `view.*` kinds: `view.run.report` behind
 * `GET /api/v1/runs/:id/report` (plus the output-directory pin that makes a
 * run's report addressable at all — `config/paths.ts`'s
 * `resolveRunsOutputRoot`), and `view.session.artifact` behind
 * `GET /api/v1/sessions/:id/steps/:stepId/artifact`. Declaring both up front
 * in X7b is what let each endpoint land without another `CHECK` recreate —
 * see `store/migrations/human-actions.ts`. `run.cancel` and
 * `session.binding.select` landed in the same wave, behind
 * `POST /api/v1/runs/:id/cancel` and `POST /api/v1/sessions/:id/bindings`.
 */
export type M3LHumanActionKind =
  | "run.launch"
  | "run.cancel"
  | "session.create"
  | "session.step.add"
  | "session.decision.raise"
  | "session.decision.answer"
  | "session.binding.select"
  | "session.close"
  | "session.reopen"
  | "view.run.report"
  | "view.run.stream"
  | "view.session.artifact";

/** The closed set {@link M3LHumanActionKind} declares, as a runtime table. */
export const ACTION_KINDS: ReadonlySet<M3LHumanActionKind> = new Set([
  "run.launch",
  "run.cancel",
  "session.create",
  "session.step.add",
  "session.decision.raise",
  "session.decision.answer",
  "session.binding.select",
  "session.close",
  "session.reopen",
  "view.run.report",
  "view.run.stream",
  "view.session.artifact",
]);

/**
 * What an audited action acted upon, discriminated on `kind`.
 *
 * Every arm carries an opaque `id` and nothing else, except `script`, which
 * also carries the script's name — a launch is the one action whose target
 * an operator recognises by name rather than by id. Declared structurally
 * rather than imported from `runs/`/`sessions/` (see `record.ts`'s module
 * note).
 *
 * @example
 * ```ts
 * const target: M3LHumanActionTarget = { kind: "run", id: "run-1" };
 * ```
 */
export type M3LHumanActionTarget =
  | {
      readonly kind: "script";
      readonly id: string;
      readonly scriptName: string;
    }
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "step"; readonly id: string }
  | { readonly kind: "artifact"; readonly id: string };

/** The closed set of {@link M3LHumanActionTarget} discriminants. */
export const TARGET_KINDS: ReadonlySet<M3LHumanActionTarget["kind"]> = new Set([
  "script",
  "run",
  "session",
  "step",
  "artifact",
]);

/**
 * How much human intent stood behind an action: `auto` when no gesture was
 * needed (a dry run), `confirmed` when the operator made one, `escalated`
 * when one was required and missing. See {@link humanActionPostureFor}.
 *
 * @example
 * ```ts
 * const posture: M3LHumanActionPosture = "confirmed";
 * ```
 */
export type M3LHumanActionPosture = "auto" | "confirmed" | "escalated";

/** The closed set {@link M3LHumanActionPosture} declares, as a runtime table. */
export const POSTURES: ReadonlySet<M3LHumanActionPosture> = new Set([
  "auto",
  "confirmed",
  "escalated",
]);

/**
 * What the console did with the request.
 *
 * Exported although no `src/**` symbol names it outside this module yet: it
 * is a member of {@link M3LHumanActionRecord}'s public shape, so a consumer
 * building or narrowing a record needs to be able to name it. knip stays
 * green because its vitest plugin makes `tests/**` entry points, so a
 * test-only import IS a consumer — the same standing
 * {@link M3LHumanActionRecordInput} already has.
 *
 * @example
 * ```ts
 * const outcome: M3LHumanActionOutcome = "allowed";
 * ```
 */
export type M3LHumanActionOutcome =
  "allowed" | "denied" | "rejected" | "failed" | "served";

/** The closed set {@link M3LHumanActionOutcome} declares, as a runtime table. */
export const OUTCOMES: ReadonlySet<M3LHumanActionOutcome> = new Set([
  "allowed",
  "denied",
  "rejected",
  "failed",
  "served",
]);
