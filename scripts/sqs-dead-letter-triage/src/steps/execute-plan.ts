/**
 * `sqs-dead-letter-triage/steps/execute-plan` — decides WHAT to do with an
 * already-triaged `TriageReport`: the verdict-to-action mapping, the
 * printed plan, the prohibition invariant check, and (review round 2,
 * MUST-FIX 10) the `sourceQueueUrl` guard a `reinsert` plan must pass before
 * `applyActions` can send to it. Pure: no AWS client, no I/O, nothing here
 * ever awaits. Split from `./execute-actions.js` (which does the DOING —
 * every SQS call) purely to stay under the per-file byte ceiling
 * (`pnpm check:file-budget`); the seam is real, not a size dodge — planning
 * is a pure function of the report while application is entirely I/O, the
 * same shape as `build-procedure.ts` / `steps-graph.ts`. `resolveSourceQueueUrl`
 * moved here (out of `run-sqs-dead-letter-triage.ts`) for the same reason,
 * once its account/region cross-check pushed that file over the byte
 * ceiling — it is exactly this pure, report/plan-shaped validation.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import type { TriagePreset, TriageVerdict } from "./preset.js";
import type { TriageReport } from "./report.js";

/** The error code every guard failure and internal invariant check in this step carries. */
export const EXECUTE_CODE = "ERR_DLQ_TRIAGE_EXECUTE";

/**
 * The outcome one planned message resolves to, reusing
 * {@link AWS.M3LSQSRedriveDecision} (ADR-0077) rather than inventing a
 * parallel vocabulary. The names read backwards for this domain, though:
 * `"drop"` means **delete the message from the dead-letter queue** (a
 * `remove` verdict), and `"retry"` means **leave it exactly where it is**
 * (every verdict that isn't `remove`/`reinsert` — `hold`, `escalate`, an
 * unresolved terminal case, …). Only `"move"` reads the same way in both
 * vocabularies: send it on, then remove it from here. See
 * {@link buildExecutePlan}'s TSDoc for the full verdict-to-action table.
 */
export type TriageAction = AWS.M3LSQSRedriveDecision;

/** One message's resolved action, ready to print or apply. */
export interface PlannedAction {
  readonly messageId: string;
  readonly verdict: TriageVerdict;
  readonly action: TriageAction;
  /** Why this verdict produced this action — shown in the printed plan. */
  readonly reason: string;
}

/** What {@link buildExecutePlan} resolves to: a full plan, ready to log or apply. */
export interface ExecutePlan {
  readonly actions: readonly PlannedAction[];
  readonly removeCount: number;
  readonly reinsertCount: number;
  readonly leaveCount: number;
  /** `true` when at least one planned action is a `"move"`, which needs `sourceQueueUrl`. */
  readonly needsSourceQueue: boolean;
}

/** One row of `TriageReport.rows`, read structurally rather than imported by name (not exported by `report.ts`). */
type TriageReportRow = TriageReport["rows"][number];

/**
 * The verdict-to-action-kind table {@link actionForVerdict} looks up before
 * building the actual {@link TriageAction}. A `Record` keyed by the full
 * {@link TriageVerdict} union (rather than a `switch`'s `default` branch)
 * makes the exhaustiveness check **structural**: a future verdict added to
 * the union fails to compile right here, on the missing table entry, instead
 * of silently falling through a branch chain that forgot it.
 */
const VERDICT_ACTION_KIND: Readonly<
  Record<TriageVerdict, TriageAction["action"]>
> = {
  remove: "drop",
  reinsert: "move",
  hold: "retry",
  escalate: "retry",
  "known-no-action": "retry",
  "not-runbook-managed": "retry",
  unparseable: "retry",
  unrouted: "retry",
  "no-key": "retry",
  "entity-not-found": "retry",
  unrecognised: "retry",
};

/**
 * Maps one {@link TriageVerdict} to its {@link TriageAction}, per the table
 * documented on {@link buildExecutePlan}. The `entry.body` on a `"move"`
 * action is the report's (possibly truncated) excerpt — good enough for a
 * human reading the printed plan, but never what actually gets sent:
 * {@link applyActions} always sends the drain's own full, untruncated body
 * (held in `deps.messages`), never this excerpt.
 */
function actionForVerdict(
  messageId: string,
  bodyExcerpt: string,
  verdict: TriageVerdict,
): TriageAction {
  const kind = VERDICT_ACTION_KIND[verdict];
  switch (kind) {
    case "drop":
      return { action: "drop" };
    case "move":
      return { action: "move", entry: { id: messageId, body: bodyExcerpt } };
    case "retry":
      return { action: "retry" };
    default: {
      const exhaustive: never = kind;
      throw new Core.M3LError(
        `unreachable action kind '${String(exhaustive)}' while building the execute plan`,
        { code: EXECUTE_CODE },
      );
    }
  }
}

/**
 * The single most safety-critical guarantee in ADR-0077: a prohibition
 * always wins. `cases.ts`'s `downgradeForProhibitions` already downgrades a
 * blocked `remove`/`reinsert` verdict to `hold` before it ever reaches a
 * conclusion, so a row carrying BOTH a non-undefined `prohibited` AND a
 * `remove`/`reinsert` verdict should be unreachable in practice. This is a
 * cheap last-line invariant check on that guarantee, not a re-application of
 * the prohibition logic itself — if the upstream downgrade were ever
 * skipped or bypassed, this throws instead of silently planning a
 * drop/move for a message the preset author explicitly prohibited from one.
 */
function assertNotIllegallyProhibited(
  messageId: string,
  verdict: TriageVerdict,
  prohibited: string | undefined,
): void {
  if (prohibited === undefined) return;
  if (verdict !== "remove" && verdict !== "reinsert") return;
  throw new Core.M3LError(
    `message '${messageId}' concluded '${verdict}' but carries a prohibition ('${prohibited}') — the upstream downgrade to 'hold' should have already applied; refusing to plan a drop/move`,
    { code: EXECUTE_CODE },
  );
}

/** Builds the human-readable reason shown next to one planned action. */
function buildReason(
  row: TriageReportRow,
  verdict: TriageVerdict,
  action: TriageAction,
): string {
  const caseNote = row.caseId === undefined ? "" : ` (case '${row.caseId}')`;
  return `verdict '${verdict}' → ${action.action}${caseNote}: ${row.description}`;
}

/**
 * Builds the plan for an already-triaged {@link TriageReport}: what to do
 * with every message, and the counts an operator reads before deciding
 * whether to `--apply`. A row whose run never reached a conclusion
 * (`verdict === "(none)"`, the `failed`/`aborted` outcomes) is excluded
 * entirely — there is nothing safe to do with a message this run never
 * judged.
 *
 * **Verdict → action** (the SQS vocabulary reused here reads backwards for
 * this domain — see {@link TriageAction}'s TSDoc):
 *
 * | Verdict                                            | Action  | Meaning                    |
 * | --------------------------------------------------- | ------- | -------------------------- |
 * | `remove`                                             | `drop`  | Delete from the DLQ        |
 * | `reinsert`                                           | `move`  | Send to `sourceQueue`, then delete from the DLQ |
 * | `hold`, `escalate`, `known-no-action`, and every codified terminal verdict (`not-runbook-managed`, `unparseable`, `unrouted`, `no-key`, `entity-not-found`, `unrecognised`) | `retry` | Leave untouched            |
 *
 * @param report - The triage report to plan against.
 * @returns The plan: one {@link PlannedAction} per conclusive row, plus tallies.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_EXECUTE` if a row
 *   carries both a `prohibited` note and a `remove`/`reinsert` verdict — see
 *   {@link assertNotIllegallyProhibited}.
 *
 * @example
 * ```typescript
 * import { buildExecutePlan } from "./execute-plan.js";
 *
 * declare const report: import("./report.js").TriageReport;
 * const plan = buildExecutePlan(report);
 * console.log(plan.removeCount, plan.reinsertCount, plan.leaveCount);
 * ```
 */
export function buildExecutePlan(report: TriageReport): ExecutePlan {
  const actions: PlannedAction[] = [];
  let removeCount = 0;
  let reinsertCount = 0;
  let leaveCount = 0;

  for (const row of report.rows) {
    const verdict = row.verdict;
    if (verdict === "(none)") continue;

    assertNotIllegallyProhibited(row.messageId, verdict, row.prohibited);
    const action = actionForVerdict(row.messageId, row.bodyExcerpt, verdict);

    switch (action.action) {
      case "drop":
        removeCount += 1;
        break;
      case "move":
        reinsertCount += 1;
        break;
      case "retry":
        leaveCount += 1;
        break;
      default: {
        const exhaustive: never = action;
        throw new Core.M3LError(
          "unreachable planned action while tallying the execute plan",
          { code: EXECUTE_CODE, cause: exhaustive },
        );
      }
    }

    actions.push({
      messageId: row.messageId,
      verdict,
      action,
      reason: buildReason(row, verdict, action),
    });
  }

  return {
    actions,
    removeCount,
    reinsertCount,
    leaveCount,
    needsSourceQueue: reinsertCount > 0,
  };
}

/**
 * Prints an {@link ExecutePlan} to the logger: the tallies, then one line
 * per planned action. This is the `--operation=execute` (no `--apply`)
 * surface — it never touches SQS.
 *
 * @param logger - The run's logger.
 * @param plan - The plan to print.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { logExecutePlan } from "./execute-plan.js";
 *
 * declare const plan: import("./execute-plan.js").ExecutePlan;
 * logExecutePlan(new Core.M3LLogger([]), plan);
 * ```
 */
export function logExecutePlan(
  logger: Core.M3LLogger,
  plan: ExecutePlan,
): void {
  logger.section("Execute plan");
  logger.text(
    `remove=${String(plan.removeCount)} reinsert=${String(plan.reinsertCount)} leave=${String(plan.leaveCount)}`,
  );
  for (const planned of plan.actions) {
    logger.text(
      `- ${planned.messageId}: ${planned.verdict} → ${planned.action.action} (${planned.reason})`,
    );
  }
}

/**
 * The parsed account id and region out of a standard SQS queue URL — see
 * {@link parseQueueUrl}.
 */
interface ParsedQueueUrl {
  readonly accountId: string;
  readonly region: string;
}

/**
 * Parses the account id and region out of a standard SQS queue URL —
 * `https://sqs.<region>.amazonaws.com/<accountId>/<queueName>`, or the
 * legacy `https://<region>.queue.amazonaws.com/<accountId>/<queueName>`
 * form. Both values are always present in a real SQS URL, so
 * {@link resolveSourceQueueUrl} needs no extra AWS call to cross-check them
 * (review round 2, MUST-FIX 10). Returns `undefined` on anything else — a
 * malformed URL, a non-numeric account segment, or a non-AWS host — which
 * the caller treats as a guard failure, never a silent pass.
 */
function parseQueueUrl(url: string): ParsedQueueUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const sqsHost = /^sqs\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(
    parsed.hostname,
  );
  const legacyHost = /^([a-z0-9-]+)\.queue\.amazonaws\.com(?:\.cn)?$/.exec(
    parsed.hostname,
  );
  const region = sqsHost?.[1] ?? legacyHost?.[1];
  if (region === undefined) return undefined;
  const accountId = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(0);
  if (accountId === undefined || !/^\d{12}$/.test(accountId)) {
    return undefined;
  }
  return { accountId, region };
}

/**
 * Resolves the `sourceQueueUrl` `applyActions` will send `"move"` actions
 * to, per decision 1: required only when `plan.needsSourceQueue` (at least
 * one planned `reinsert`).
 *
 * Three checks then all must pass (review round 2, MUST-FIX 10 tightened
 * every one of them):
 * 1. The preset must declare its own `sourceQueue` at all — a plan needing
 *    one, built from a preset that never named one, is rejected rather than
 *    vacuously passing the next check.
 * 2. The supplied URL's last path segment must equal that declared
 *    `sourceQueue` — catches pasting the wrong queue's URL outright.
 * 3. The supplied URL's account id and region, parsed via
 *    {@link parseQueueUrl}, must equal the dead-letter queue's own — queue
 *    names are routinely identical across dev/staging/prod, so (2) alone
 *    would let a same-named queue in a different account or region through.
 *    A URL either side fails to parse (including a non-AWS host) is
 *    rejected here too, never treated as a vacuous match.
 *
 * A plan with no `reinsert` at all never reaches any of this: an operator
 * triaging a queue that yields none must never be forced to supply
 * `sourceQueueUrl`, and any value they DID supply anyway is passed through
 * unvalidated — `applyActions` never even looks at it in that case.
 *
 * @param plan - The plan being applied.
 * @param preset - The preset the plan was built from.
 * @param sourceQueueUrl - The caller-supplied `sourceQueueUrl` config value,
 *   if any.
 * @param queueUrl - The dead-letter queue's own URL, cross-checked against.
 * @returns `sourceQueueUrl` unchanged, once every needed check has passed.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_EXECUTE` when the plan
 *   needs `sourceQueueUrl` but none was supplied, the preset declares no
 *   `sourceQueue`, the supplied URL's last path segment does not equal
 *   `preset.sourceQueue`, or the supplied URL's account/region does not
 *   match the dead-letter queue's.
 *
 * @example
 * ```typescript
 * import { resolveSourceQueueUrl } from "./execute-plan.js";
 *
 * declare const plan: import("./execute-plan.js").ExecutePlan;
 * declare const preset: import("./preset.js").TriagePreset;
 * const sourceQueueUrl = resolveSourceQueueUrl(
 *   plan,
 *   preset,
 *   "https://sqs.us-east-1.amazonaws.com/123456789012/orders-source",
 *   "https://sqs.us-east-1.amazonaws.com/123456789012/orders-dlq",
 * );
 * ```
 */
export function resolveSourceQueueUrl(
  plan: ExecutePlan,
  preset: TriagePreset,
  sourceQueueUrl: string | undefined,
  queueUrl: string,
): string | undefined {
  if (!plan.needsSourceQueue) return sourceQueueUrl;
  if (sourceQueueUrl === undefined) {
    throw new Core.M3LError(
      `'sourceQueueUrl' is required: the plan for '${preset.queue}' contains ${String(plan.reinsertCount)} reinsert action(s)`,
      { code: EXECUTE_CODE },
    );
  }
  if (preset.sourceQueue === undefined) {
    throw new Core.M3LError(
      `preset '${preset.queue}' declares no 'sourceQueue' but the plan contains ${String(plan.reinsertCount)} reinsert action(s) — refusing to send anywhere`,
      { code: EXECUTE_CODE },
    );
  }
  const lastSegment = sourceQueueUrl
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(-1);
  if (lastSegment !== preset.sourceQueue) {
    throw new Core.M3LError(
      `'sourceQueueUrl' (${sourceQueueUrl}) does not name preset '${preset.queue}''s declared sourceQueue ('${preset.sourceQueue}') — refusing to send into a possibly unrelated queue`,
      { code: EXECUTE_CODE },
    );
  }
  const source = parseQueueUrl(sourceQueueUrl);
  const dlq = parseQueueUrl(queueUrl);
  if (
    source === undefined ||
    dlq === undefined ||
    source.accountId !== dlq.accountId ||
    source.region !== dlq.region
  ) {
    throw new Core.M3LError(
      `'sourceQueueUrl' (${sourceQueueUrl}) does not resolve to the same AWS account and region as the dead-letter queue (${queueUrl}) — refusing to send across accounts or regions`,
      { code: EXECUTE_CODE },
    );
  }
  return sourceQueueUrl;
}
