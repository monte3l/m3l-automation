/**
 * `internal/agent/budgets` — step 3 of the evaluator: the five declared
 * ceilings, checked in a fixed order against the frozen run-ledger
 * projection, and the UTC day-window roll `invocationsPerDay` needs.
 *
 * Private to `core/agent`; never re-exported through a public barrel.
 */

import type { M3LAgentBudgets } from "../../core/agent/policy-types.js";

/** Milliseconds in one UTC calendar day. */
const MS_PER_DAY = 86_400_000;

/**
 * The step-0 projection of {@link M3LAgentRunLedger}: every numeric field is
 * materialised as an own key holding `undefined` when the caller omitted it,
 * and `dryRunCompletedShapes` defaults to a frozen empty list. Step 3 and
 * step 6 read this projection alone — never `options.run` again — which is
 * what closes the TOCTOU hole a live re-read of the caller's ledger would
 * open.
 */
export interface M3LAgentProjectedRunLedger {
  readonly invocationsThisRun: number | undefined;
  readonly invocationsToday: number | undefined;
  readonly todayCountedAt: number | undefined;
  readonly now: number | undefined;
  readonly tokensThisRun: number | undefined;
  readonly costThisRun: number | undefined;
  readonly loopIterations: number | undefined;
  readonly dryRunCompletedShapes: readonly string[];
}

/** The projection for a run with no ledger supplied at all. */
const EMPTY_PROJECTED_RUN_LEDGER: M3LAgentProjectedRunLedger = Object.freeze({
  invocationsThisRun: undefined,
  invocationsToday: undefined,
  todayCountedAt: undefined,
  now: undefined,
  tokensThisRun: undefined,
  costThisRun: undefined,
  loopIterations: undefined,
  dryRunCompletedShapes: Object.freeze([]),
});

/** The ten budget rule ids `evaluateBudgets` can produce. */
type M3LAgentBudgetRuleId =
  | "budget.invocations-per-run"
  | "budget.invocations-per-day"
  | "budget.tokens-per-run"
  | "budget.cost-per-run"
  | "budget.loop-iterations"
  | "budget.invocations-per-run.unobservable"
  | "budget.invocations-per-day.unobservable"
  | "budget.tokens-per-run.unobservable"
  | "budget.cost-per-run.unobservable"
  | "budget.loop-iterations.unobservable";

/** Step 3's verdict when a declared ceiling is exhausted or unobservable. */
export interface M3LAgentBudgetVerdict {
  readonly rule: M3LAgentBudgetRuleId;
  readonly reason: string;
}

/**
 * `true` when both epoch-millisecond instants fall in the same UTC calendar
 * day. Epoch milliseconds are already timezone-independent, so a plain
 * integer division by the day length needs no timezone input and cannot
 * drift between a caller and the library.
 */
function isSameUtcDay(a: number, b: number): boolean {
  return Math.floor(a / MS_PER_DAY) === Math.floor(b / MS_PER_DAY);
}

/**
 * The observed `invocationsToday`, after the UTC-day roll. Presence of all
 * three of `invocationsToday`/`todayCountedAt`/`now` is checked BEFORE the
 * window: any one absent is unobservable, even when the two timestamps that
 * ARE present would have rolled the window and made the count irrelevant.
 */
function observedInvocationsToday(
  ledger: M3LAgentProjectedRunLedger,
): number | undefined {
  const { invocationsToday, todayCountedAt, now } = ledger;
  if (
    invocationsToday === undefined ||
    todayCountedAt === undefined ||
    now === undefined
  ) {
    return undefined;
  }
  return isSameUtcDay(todayCountedAt, now) ? invocationsToday : 0;
}

/**
 * Compares one declared ceiling against its observation. A budget is
 * exhausted when `observed >= ceiling` — a reject-AT bound, deliberately the
 * opposite polarity to every structural reject-ABOVE ceiling on this module:
 * `invocationsThisRun` counts what has already happened, and the action
 * under judgement would be the next one. An absent observation escalates on
 * the ceiling's own `.unobservable` id rather than `rule` — "you have spent
 * your budget" and "I cannot see your ledger" are opposite states and must
 * not share a label — and rather than defaulting to `0`, because a declared
 * ceiling this module cannot prove unexhausted is an unprovable state, not a
 * safe one.
 */
function checkCeiling(
  check: M3LAgentCeilingCheck,
  ceiling: number,
  observed: number | undefined,
  subject: string,
): M3LAgentBudgetVerdict | undefined {
  if (observed === undefined) {
    return {
      rule: check.unobservableRule,
      reason: `${subject} is escalated: the declared "${check.key}" budget cannot be evaluated because the run ledger has no ${check.observationLabel}.`,
    };
  }
  if (observed >= ceiling) {
    return {
      rule: check.rule,
      reason: `${subject} is escalated: the declared "${check.key}" budget is exhausted (observed ${String(observed)} >= ceiling ${String(ceiling)}).`,
    };
  }
  return undefined;
}

/**
 * One entry in the fixed evaluation order: the declaration key, the rule id
 * it produces on exhaustion and on unobservability, the ledger field(s) its
 * `reason` names when unobservable, and how to read its observation off the
 * ledger projection. Pairing `rule` and `unobservableRule` on the same entry
 * is deliberate — table-driven, so a future ceiling cannot be added with only
 * one of the two ids wired up.
 */
interface M3LAgentCeilingCheck {
  readonly key: keyof M3LAgentBudgets;
  readonly rule: M3LAgentBudgetRuleId;
  readonly unobservableRule: M3LAgentBudgetRuleId;
  readonly observationLabel: string;
  readonly observe: (ledger: M3LAgentProjectedRunLedger) => number | undefined;
}

/**
 * The five ceilings, in the FIXED order this module checks them — never
 * declaration key order, so the same run against two declarations differing
 * only in key order produces the same log entry.
 */
const CEILING_CHECKS: readonly M3LAgentCeilingCheck[] = [
  {
    key: "invocationsPerRun",
    rule: "budget.invocations-per-run",
    unobservableRule: "budget.invocations-per-run.unobservable",
    observationLabel: "invocationsThisRun observation",
    observe: (ledger) => ledger.invocationsThisRun,
  },
  {
    key: "invocationsPerDay",
    rule: "budget.invocations-per-day",
    unobservableRule: "budget.invocations-per-day.unobservable",
    observationLabel: "invocationsToday, todayCountedAt, or now observation",
    observe: observedInvocationsToday,
  },
  {
    key: "tokensPerRun",
    rule: "budget.tokens-per-run",
    unobservableRule: "budget.tokens-per-run.unobservable",
    observationLabel: "tokensThisRun observation",
    observe: (ledger) => ledger.tokensThisRun,
  },
  {
    key: "costPerRun",
    rule: "budget.cost-per-run",
    unobservableRule: "budget.cost-per-run.unobservable",
    observationLabel: "costThisRun observation",
    observe: (ledger) => ledger.costThisRun,
  },
  {
    key: "loopIterations",
    rule: "budget.loop-iterations",
    unobservableRule: "budget.loop-iterations.unobservable",
    observationLabel: "loopIterations observation",
    observe: (ledger) => ledger.loopIterations,
  },
];

/**
 * Step 3: checks every declared ceiling, in {@link CEILING_CHECKS}'s fixed
 * order.
 *
 * `budgets` must already be read via `Object.hasOwn(policy, "budgets")` by
 * the caller (a polluted `Object.prototype.budgets` must not make this
 * function run at all for a policy that declared none). Each ceiling's OWN
 * presence is likewise read via `Object.hasOwn`, never a dot read, so a
 * polluted `Object.prototype.tokensPerRun` cannot invent a ceiling a
 * declaration never wrote down.
 *
 * @param budgets - The validated declaration's budgets, or `undefined` when
 *   the policy declares none — step 3 is skipped entirely in that case.
 * @param run - The step-0 ledger projection, or `undefined` when the caller
 *   passed no `run` at all (treated as every observation absent).
 * @param subject - The library-authored prose naming the action under
 *   judgement, shared with the sibling decision arms.
 * @returns The first exhausted or unobservable ceiling's verdict, in fixed
 *   order, or `undefined` when every declared ceiling is satisfied.
 */
export function evaluateBudgets(
  budgets: M3LAgentBudgets | undefined,
  run: M3LAgentProjectedRunLedger | undefined,
  subject: string,
): M3LAgentBudgetVerdict | undefined {
  if (budgets === undefined) {
    return undefined;
  }
  const ledger = run ?? EMPTY_PROJECTED_RUN_LEDGER;

  for (const check of CEILING_CHECKS) {
    if (!Object.hasOwn(budgets, check.key)) {
      continue;
    }
    // Narrowing read, not a cast: `validateAgentPolicy` rule 14 already
    // rejects any non-positive-finite ceiling, so this arm is unreachable
    // today — the documented second line of defence, not a redundancy (same
    // framing as `allOperations !== true` in `decide.ts`). An unusable
    // ceiling is the same "cannot evaluate this budget" state an absent
    // observation is, so it escalates on the SAME `.unobservable` id rather
    // than `continue`-ing past the check or falling through to a bare `as
    // number` that would let `observed >= ceiling` silently evaluate `false`
    // and fail the budget open.
    const ceilingValue = budgets[check.key];
    if (typeof ceilingValue !== "number" || !Number.isFinite(ceilingValue)) {
      return {
        rule: check.unobservableRule,
        reason: `${subject} is escalated: the declared "${check.key}" budget has no usable ceiling.`,
      };
    }
    const verdict = checkCeiling(
      check,
      ceilingValue,
      check.observe(ledger),
      subject,
    );
    if (verdict !== undefined) {
      return verdict;
    }
  }
  return undefined;
}
