import { vi } from "vitest";
import type { Mock } from "vitest";

import type {
  TriageArm,
  TriageCase,
  TriageConclusion,
  TriageEntityLookup,
  TriageKeyRule,
  TriageLookupTier,
  TriageMessage,
  TriagePreset,
  TriageStateMap,
  TriageVerdict,
} from "../../src/steps/preset.js";
import type {
  MessageOutcome,
  TriageQueueResult,
} from "../../src/steps/triage-queue.js";
import type { TriageReport } from "../../src/steps/report.js";

/**
 * Shared preset/message/lookup fixture factories for the PR 3a AWS-triage
 * test files (`drain-queue`, `lookup-entity`, `triage-queue`, `report`).
 * Extracted here per the PR 2 review carry-over: `build-procedure.test.ts`
 * had these same shapes duplicated inline. New test files in this slice
 * import from here instead of re-declaring them; `build-procedure.test.ts`
 * itself is left untouched (out of this slice's write scope).
 *
 * Every factory returns a fully-populated value; callers override just the
 * field(s) a given test cares about via the `overrides` parameter.
 */

export function baseKey(overrides: Partial<TriageKeyRule> = {}): TriageKeyRule {
  return {
    path: "orderId",
    stripPrefix: undefined,
    addSuffix: undefined,
    capture: undefined,
    ...overrides,
  };
}

export function baseLookupTier(
  overrides: Partial<TriageLookupTier> = {},
): TriageLookupTier {
  return {
    label: "primary",
    table: "orders",
    keyField: "orderId",
    ...overrides,
  };
}

export function baseState(
  overrides: Partial<TriageStateMap> = {},
): TriageStateMap {
  return {
    fromState: "status",
    nextState: "status",
    progression: undefined,
    ...overrides,
  };
}

export function baseCase(
  overrides: Partial<TriageCase> &
    Pick<TriageCase, "id" | "priority" | "verdict">,
): TriageCase {
  return {
    description: `case ${overrides.id}`,
    prose: `prose for ${overrides.id}`,
    fromState: undefined,
    nextState: undefined,
    eventType: undefined,
    signature: undefined,
    requiredProgression: undefined,
    ticket: undefined,
    resolution: undefined,
    escalateTo: undefined,
    followUps: [],
    ...overrides,
  };
}

export function baseArm(overrides: Partial<TriageArm> = {}): TriageArm {
  return {
    match: "order.created",
    label: "order-created-arm",
    key: baseKey(),
    lookup: [baseLookupTier()],
    onMissing: "hold",
    state: baseState(),
    cases: [],
    ...overrides,
  };
}

export function basePreset(
  overrides: Partial<TriagePreset> = {},
): TriagePreset {
  return {
    queue: "orders-dlq",
    title: "Orders DLQ triage",
    handling: "runbook",
    prohibitions: [],
    fifo: false,
    orderBy: undefined,
    sourceQueue: undefined,
    // Required when `fifo: true` (a FIFO reinsert needs a message group id
    // path) and rejected outright when `fifo: false` — see
    // `load-runbook.ts`'s `requireFifoFieldsMatchFifo`.
    groupIdPath: undefined,
    envelope: { bodyIsJson: true, payloadPath: undefined },
    routeOn: "eventType",
    arms: [baseArm()],
    escalateTo: "orders-team",
    followUps: [],
    todos: [],
    ...overrides,
  };
}

/**
 * Every {@link TriageVerdict} member, tracked via the `Record<Union, true>`
 * idiom (`.claude/rules/library-src.md`) rather than a hand-copied array: a
 * verdict added to (or removed from) the union without a matching key here
 * fails typecheck on this file, so `execute-actions.test.ts`'s "all eleven
 * verdicts" `test.each` can never silently narrow to fewer members as the
 * vocabulary grows.
 */
const ALL_TRIAGE_VERDICTS_MAP: Record<TriageVerdict, true> = {
  remove: true,
  reinsert: true,
  hold: true,
  escalate: true,
  "known-no-action": true,
  "not-runbook-managed": true,
  unparseable: true,
  unrouted: true,
  "no-key": true,
  "entity-not-found": true,
  unrecognised: true,
};

export const ALL_TRIAGE_VERDICTS = Object.keys(
  ALL_TRIAGE_VERDICTS_MAP,
) as readonly TriageVerdict[];

/** One row of `TriageReport.rows` — not exported by `report.ts` itself, so derived structurally. */
export type TriageReportRow = TriageReport["rows"][number];

export function baseReportRow(
  overrides: Partial<TriageReportRow> & Pick<TriageReportRow, "messageId">,
): TriageReportRow {
  return {
    verdict: "hold",
    caseId: "case-1",
    description: "description",
    ticket: undefined,
    prohibited: undefined,
    followUps: [],
    bodyExcerpt: "{}",
    bodyLength: 2,
    status: "matched",
    failure: undefined,
    ...overrides,
  };
}

/** A zero-count `verdictCounts` record, keyed off every real verdict plus the two non-conclusion statuses. */
function zeroVerdictCounts(): TriageReport["verdictCounts"] {
  return Object.fromEntries(
    [...ALL_TRIAGE_VERDICTS, "failed", "aborted"].map((key) => [key, 0]),
  ) as TriageReport["verdictCounts"];
}

/** A fully-populated `TriageReport`, for `execute-actions.test.ts`'s plan-building inputs. */
export function baseTriageReport(
  overrides: Partial<TriageReport> = {},
): TriageReport {
  return {
    queue: "orders-dlq",
    title: "Orders DLQ triage",
    queueUrl: "https://sqs.example/orders-dlq",
    generatedAt: "2026-08-23T12:00:00.000Z",
    depth: 0,
    drained: 0,
    archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
    verdictCounts: zeroVerdictCounts(),
    rows: [],
    followUps: [],
    escalateTo: "orders-team",
    ...overrides,
  };
}

/** Builds a message; a string `body` is used verbatim, else JSON-stringified. */
export function buildMessage(
  body: unknown,
  overrides: Partial<TriageMessage> = {},
): TriageMessage {
  return {
    messageId: "msg-1",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...overrides,
  };
}

/** A default JSON payload matching `basePreset()`'s single default arm. */
export function standardPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventType: "order.created",
    orderId: "ord-1",
    status: "paid",
    ...overrides,
  };
}

export interface LookupCall {
  readonly tier: TriageLookupTier;
  readonly key: string;
}

export interface FakeLookup extends TriageEntityLookup {
  readonly calls: LookupCall[];
}

/**
 * Builds a lookup double. Responses are consumed in call order; an
 * exhausted queue resolves `undefined`, matching a genuine miss.
 */
export function createFakeLookup(
  ...queued: readonly (Readonly<Record<string, unknown>> | undefined)[]
): FakeLookup {
  const responses = [...queued];
  const calls: LookupCall[] = [];
  return {
    calls,
    get(tier, key, _signal) {
      calls.push({ tier, key });
      return Promise.resolve(responses.shift());
    },
  };
}

/**
 * A `TriageEntityLookup` double whose `get` is a plain `vi.fn()`, for tests
 * that need per-call `mockResolvedValueOnce`/`mockRejectedValueOnce`
 * configuration rather than a fixed response queue.
 */
export function createSpyLookup(): TriageEntityLookup & {
  readonly get: Mock<TriageEntityLookup["get"]>;
} {
  return { get: vi.fn<TriageEntityLookup["get"]>() };
}

/** A fully-populated `TriageConclusion`, for `report.test.ts`'s row fixtures. */
export function baseConclusion(
  overrides: Partial<TriageConclusion> = {},
): TriageConclusion {
  return {
    verdict: "remove",
    caseId: "case-1",
    description: "description",
    prose: "prose",
    ticket: undefined,
    resolution: undefined,
    escalateTo: "orders-team",
    followUps: [],
    prohibited: undefined,
    ...overrides,
  };
}

/**
 * Builds a `"matched"`/`"unrecognized"` {@link MessageOutcome} — the
 * conclusion-carrying branch of the union. Only these two `status` values
 * carry a `conclusion`; `failure` is never present on this branch.
 */
export function buildMatchedOutcome(
  messageId: string,
  overrides: {
    readonly status?: "matched" | "unrecognized";
    readonly conclusion?: Partial<TriageConclusion>;
  } = {},
): MessageOutcome {
  return {
    messageId,
    status: overrides.status ?? "matched",
    conclusion: baseConclusion(overrides.conclusion),
  };
}

/**
 * Builds a `"failed"`/`"aborted"` {@link MessageOutcome} — the
 * failure-carrying branch of the union. Only these two `status` values carry
 * a `failure`; `conclusion` is never present on this branch.
 */
export function buildFailedOutcome(
  messageId: string,
  overrides: {
    readonly status?: "failed" | "aborted";
    readonly failure?: string;
  } = {},
): MessageOutcome {
  return {
    messageId,
    status: overrides.status ?? "failed",
    failure: overrides.failure ?? "failure reason",
  };
}

/** A fully-populated `TriageQueueResult`, for `report.test.ts`'s inputs. */
export function baseTriageQueueResult(
  overrides: Partial<TriageQueueResult> = {},
): TriageQueueResult {
  return {
    queue: "orders-dlq",
    title: "Orders DLQ triage",
    depth: 2,
    archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
    drained: 2,
    outcomes: [],
    messages: [],
    escalateTo: "orders-team",
    followUps: [],
    preset: basePreset(),
    ...overrides,
  };
}
