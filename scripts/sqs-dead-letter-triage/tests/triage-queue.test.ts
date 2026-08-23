import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s
 * `triageQueue` (`src/steps/triage-queue.ts`) — drains a queue (via
 * `drainQueue`, mocked here so this file exercises only `triageQueue`'s own
 * orchestration), loads and compiles the queue's preset once, then runs the
 * REAL, unmocked `buildTriageProcedure` once per drained message with a
 * fresh `createTriageRunState()` each time.
 *
 * `TriageQueueDeps`'s exact field set is under-specified by the PR 3a spec
 * (it lists dependencies in prose, not a literal interface, unlike
 * `DrainQueueDeps`/`DynamoDBLookupDeps`). This file assumes a `lookup:
 * TriageEntityLookup` field — the seam `lookup-entity.ts`'s
 * `createDynamoDBLookup` already produces — rather than a raw
 * `AWS.M3LDynamoDBOperations`, keeping `triage-queue.ts` decoupled from the
 * AWS wrapper directly. Flagged in the RED report for the hub to confirm or
 * correct before GREEN.
 *
 * `drainQueue`, `loadRunbook`, and `presetPathFor` are mocked via
 * `vi.hoisted()` (the static-import mocking gotcha documented in
 * `run-sqs-dead-letter-triage.test.ts`).
 */

const { drainQueueMock, loadRunbookMock, presetPathForMock } = vi.hoisted(
  () => ({
    drainQueueMock: vi.fn(),
    loadRunbookMock: vi.fn(),
    presetPathForMock: vi.fn().mockReturnValue("runbooks/orders-dlq.json"),
  }),
);

vi.mock("../src/steps/drain-queue.js", () => ({
  drainQueue: drainQueueMock,
  DRAIN_CODE: "ERR_DLQ_TRIAGE_DRAIN",
}));
vi.mock("../src/steps/load-runbook.js", () => ({
  loadRunbook: loadRunbookMock,
  PRESET_CODE: "ERR_DLQ_TRIAGE_PRESET",
  PRESET_EXTENSION: ".json",
}));
vi.mock("../src/steps/explain-runbook.js", () => ({
  presetPathFor: presetPathForMock,
  explainRunbook: vi.fn(),
}));

import { Core } from "@m3l-automation/m3l-common";

import { TRIAGE_CODE, triageQueue } from "../src/steps/triage-queue.js";
import type { TriageQueueDeps } from "../src/steps/triage-queue.js";
import {
  baseArm,
  baseCase,
  baseLookupTier,
  baseState,
  basePreset,
  buildMessage,
  createSpyLookup,
  standardPayload,
} from "./support/preset-fixtures.js";
import {
  createFakeSqsOperations,
  createRecordingLogger,
} from "./support/aws-fakes.js";

const paths = new Core.M3LPaths();

function baseDeps(overrides: Partial<TriageQueueDeps> = {}): TriageQueueDeps {
  const { logger } = createRecordingLogger();
  return {
    sqs: createFakeSqsOperations(),
    lookup: createSpyLookup(),
    reader: new Core.M3LInputFileReader({
      paths,
      code: "ERR_DLQ_TRIAGE_PRESET",
    }),
    paths,
    logger,
    runbookDir: "runbooks",
    queue: "orders-dlq",
    queueUrl: "https://sqs.example/orders-dlq",
    maxMessages: 100,
    visibilityTimeout: 1800,
    signal: undefined,
    ...overrides,
  };
}

/** A drained-message fixture, mirroring `DrainedMessage`. */
function drained(messageId: string, body: unknown) {
  return {
    ...buildMessage(body, { messageId }),
    receiptHandle: `rh-${messageId}`,
  };
}

function mockDrainResult(messages: readonly ReturnType<typeof drained>[]) {
  drainQueueMock.mockResolvedValue({
    messages,
    archivePath: "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
    depth: messages.length,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  drainQueueMock.mockReset();
  loadRunbookMock.mockReset();
  presetPathForMock.mockReset();
  presetPathForMock.mockReturnValue("runbooks/orders-dlq.json");
});

describe("triageQueue — fresh run state per message", () => {
  // The single most important correctness property in this module: two
  // messages routed to DIFFERENT arms, run through the same compiled
  // procedure, must not let the first message's selected arm/entity leak
  // into the second's conclusion. Both arms are reachable in this test's
  // own setup (msg1 -> arm-a with a found entity and a matching case;
  // msg2 -> arm-b with no entity, concluding the codified
  // 'entity-not-found' terminal case per its own `onMissing`).
  //
  // Verified against the shipped step graph (`steps-graph.ts`/`cases.ts`):
  // every step that reads `TriageRunState.arm`/`.entity`/`.payload` is
  // itself preceded, within the SAME run, by the step that sets it on
  // every currently reachable path — so this assertion also happens to
  // hold for a `triageQueue` that (incorrectly) reused one shared state
  // object across messages processed sequentially. It is included anyway
  // because the spec mandates `createTriageRunState()` per message as the
  // defensive, correct-by-construction design, and it still locks in the
  // per-message arm/entity attribution this module must never get wrong.
  it("does not let message 1's arm/entity leak into message 2's conclusion", async () => {
    const armA = baseArm({
      match: "order.created",
      label: "order-arm",
      lookup: [baseLookupTier({ table: "orders", keyField: "orderId" })],
      onMissing: "hold",
      state: baseState({ fromState: "status", nextState: "status" }),
      cases: [
        baseCase({
          id: "order-known",
          priority: 100,
          fromState: "created",
          nextState: "paid",
          verdict: "known-no-action",
        }),
      ],
    });
    const armB = baseArm({
      match: "shipment.created",
      label: "shipment-arm",
      lookup: [baseLookupTier({ table: "shipments", keyField: "shipmentId" })],
      onMissing: "escalate",
      key: {
        path: "shipmentId",
        stripPrefix: undefined,
        addSuffix: undefined,
        capture: undefined,
      },
      cases: [],
    });
    const preset = basePreset({ routeOn: "eventType", arms: [armA, armB] });
    loadRunbookMock.mockResolvedValue(preset);

    const lookup = createSpyLookup();
    lookup.get
      .mockResolvedValueOnce({ orderId: "ord-1", status: "Created" }) // msg1 hit
      .mockResolvedValueOnce(undefined); // msg2 miss

    mockDrainResult([
      drained(
        "msg-1",
        standardPayload({ eventType: "order.created", orderId: "ord-1" }),
      ),
      drained("msg-2", { eventType: "shipment.created", shipmentId: "ship-1" }),
    ]);

    const result = await triageQueue(baseDeps({ lookup }));

    expect(result.outcomes).toHaveLength(2);
    const [outcome1, outcome2] = result.outcomes;
    if (outcome1?.status !== "matched") {
      throw new Error("expected outcome1 to be matched");
    }
    expect(outcome1.conclusion.caseId).toBe("order-known");
    // If message 2 had observed message 1's leftover arm/entity, this would
    // wrongly resolve via arm-a's case row or a stale entity — instead it
    // must reach the codified entity-not-found terminal case (a `.case()`
    // entry, hence still `status: "matched"`), concluding per arm-b's own
    // `onMissing: "escalate"`.
    if (outcome2?.status !== "matched") {
      throw new Error("expected outcome2 to be matched");
    }
    expect(outcome2.conclusion.verdict).toBe("escalate");
    expect(outcome2.conclusion.caseId).toBe("entity-not-found");
  });
});

describe("triageQueue — matched and unrecognized both produce a conclusion", () => {
  it("resolves 'matched' with a conclusion for a message that hits a case row", async () => {
    const preset = basePreset({
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "case-1",
              priority: 100,
              fromState: "created",
              nextState: "paid",
              verdict: "known-no-action",
            }),
          ],
        }),
      ],
    });
    loadRunbookMock.mockResolvedValue(preset);
    const lookup = createSpyLookup();
    lookup.get.mockResolvedValue({ status: "Created" });
    mockDrainResult([drained("msg-1", standardPayload())]);

    const result = await triageQueue(baseDeps({ lookup }));

    const outcome = result.outcomes[0];
    if (outcome?.status !== "matched") {
      throw new Error("expected a matched outcome");
    }
    expect(outcome.conclusion.verdict).toBe("known-no-action");
  });

  it("resolves 'unrecognized' with the fallback conclusion for a message matching no row", async () => {
    const preset = basePreset({ arms: [baseArm({ cases: [] })] });
    loadRunbookMock.mockResolvedValue(preset);
    const lookup = createSpyLookup();
    lookup.get.mockResolvedValue({ status: "created" });
    mockDrainResult([drained("msg-1", standardPayload())]);

    const result = await triageQueue(baseDeps({ lookup }));

    const outcome = result.outcomes[0];
    if (outcome?.status !== "unrecognized") {
      throw new Error("expected an unrecognized outcome");
    }
    expect(outcome.conclusion.verdict).toBe("unrecognised");
  });
});

describe("triageQueue — a failed message does not stop the others", () => {
  it("collects a failed outcome and still triages the remaining messages", async () => {
    const preset = basePreset({ arms: [baseArm({ cases: [] })] });
    loadRunbookMock.mockResolvedValue(preset);
    const lookupFailure = new Error("DynamoDB throttled");
    const lookup = createSpyLookup();
    lookup.get
      .mockRejectedValueOnce(lookupFailure)
      .mockResolvedValueOnce({ status: "created" });
    mockDrainResult([
      drained("msg-1", standardPayload({ orderId: "ord-1" })),
      drained("msg-2", standardPayload({ orderId: "ord-2" })),
    ]);

    const result = await triageQueue(baseDeps({ lookup }));

    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]?.status).toBe("failed");
    expect(result.outcomes[0]?.failure).toBeDefined();
    expect(result.outcomes[0]?.conclusion).toBeUndefined();
    expect(result.outcomes[1]?.status).toBe("unrecognized");
  });
});

describe("triageQueue — an aborted outcome stops the loop", () => {
  it("stops processing further messages once one message's run is aborted", async () => {
    const preset = basePreset({ arms: [baseArm({ cases: [] })] });
    loadRunbookMock.mockResolvedValue(preset);
    const controller = new AbortController();
    controller.abort();
    const lookup = createSpyLookup();
    mockDrainResult([
      drained("msg-1", standardPayload()),
      drained("msg-2", standardPayload()),
      drained("msg-3", standardPayload()),
    ]);

    const result = await triageQueue(
      baseDeps({ lookup, signal: controller.signal }),
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.status).toBe("aborted");
  });
});

describe("triageQueue — preset load/compile failures propagate unchanged", () => {
  it("does not re-wrap a loadRunbook rejection under TRIAGE_CODE", async () => {
    const presetFailure = new Core.M3LError("preset is malformed", {
      code: "ERR_DLQ_TRIAGE_PRESET",
    });
    loadRunbookMock.mockRejectedValue(presetFailure);
    mockDrainResult([drained("msg-1", standardPayload())]);

    await expect(triageQueue(baseDeps())).rejects.toBe(presetFailure);
  });
});

describe("TRIAGE_CODE", () => {
  it("is exported as the documented literal", () => {
    expect(TRIAGE_CODE).toBe("ERR_DLQ_TRIAGE_RUN");
  });
});
