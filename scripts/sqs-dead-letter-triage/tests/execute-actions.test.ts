import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { applyActions } from "../src/steps/execute-actions.js";
import type { ApplyResult } from "../src/steps/execute-actions.js";
import type { ExecutePlan } from "../src/steps/execute-plan.js";
import { createFakeSqsOperations } from "./support/aws-fakes.js";
import { basePreset } from "./support/preset-fixtures.js";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s
 * `execute-actions.ts` (PR 3b spec, STEP 2's application half) —
 * `applyActions` actually doing what a plan decided, against a fake
 * `AWS.M3LSQSOperations`, never a real client. `buildExecutePlan`/
 * `logExecutePlan` (the pure planning half, now split into
 * `./execute-plan.ts`) are covered by `execute-plan.test.ts`; only
 * type-only imports come from that module here, so `perFile` v8 coverage
 * keeps `execute-plan.ts` bound to its own test file, not this one. This
 * file also does not exercise `run-sqs-dead-letter-triage.ts`'s `execute`
 * dispatch wiring or the confirm-destructive gate — that lives in
 * `run-sqs-dead-letter-triage.test.ts`.
 *
 * `applyActions` never re-receives (`reReceivePlanned` was deleted): it
 * reuses the exact receipt handles the drain already holds, threaded
 * through via `ApplyActionsDeps.messages`. `buildDeps` below builds that
 * field explicitly per test via `heldMessage`, instead of mocking `receive`
 * — a `receive` mock on this step is dead weight, since `applyActions` no
 * longer calls it at all (see the "never calls receive" regression test
 * below, and this module's own `@packageDocumentation`).
 */

/** Builds one drained message as `ApplyActionsDeps.messages` carries it — `messageId`, `body`, and `receiptHandle` verbatim from the one drain this run's plan was built from. */
function heldMessage(
  messageId: string,
  body: unknown,
  receiptHandle = `rh-${messageId}`,
): { messageId: string; receiptHandle: string; body: string } {
  return {
    messageId,
    receiptHandle,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function buildDeps(overrides: {
  readonly sqs?: ReturnType<typeof createFakeSqsOperations>;
  readonly preset?: Parameters<typeof basePreset>[0];
  readonly sourceQueueUrl?: string;
  readonly messages?: Parameters<typeof applyActions>[1]["messages"];
}): Parameters<typeof applyActions>[1] {
  return {
    sqs: overrides.sqs ?? createFakeSqsOperations(),
    logger: new Core.M3LLogger([]),
    queueUrl: "https://sqs.example/orders-dlq",
    sourceQueueUrl: overrides.sourceQueueUrl,
    preset: basePreset(overrides.preset),
    signal: undefined,
    messages: overrides.messages ?? [],
  };
}

function dropPlan(messageId: string): ExecutePlan {
  return {
    actions: [
      {
        messageId,
        verdict: "remove",
        action: { action: "drop" },
        reason: "remove verdict",
      },
    ],
    removeCount: 1,
    reinsertCount: 0,
    leaveCount: 0,
    needsSourceQueue: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyActions — never re-receives (handle reuse, not re-acquisition)", () => {
  test("never calls sqs.receive, even against a fully populated plan", async () => {
    const sqs = createFakeSqsOperations();
    const deps = buildDeps({
      sqs,
      messages: [heldMessage("msg-1", "body")],
    });

    await applyActions(dropPlan("msg-1"), deps);

    // The direct guard against `reReceivePlanned` (deleted) being
    // reintroduced: this step must act purely on `deps.messages`.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqs.receive).not.toHaveBeenCalled();
  });

  test("deleteBatch entries carry exactly deps.messages' own receiptHandle values, never a freshly-minted one", async () => {
    const plan: ExecutePlan = {
      actions: [
        {
          messageId: "msg-drop",
          verdict: "remove",
          action: { action: "drop" },
          reason: "remove verdict",
        },
        {
          messageId: "msg-move",
          verdict: "reinsert",
          action: {
            action: "move",
            entry: { id: "msg-move", body: "payload" },
          },
          reason: "reinsert verdict",
        },
      ],
      removeCount: 1,
      reinsertCount: 1,
      leaveCount: 0,
      needsSourceQueue: true,
    };
    const deleteBatch = vi.fn().mockResolvedValue({
      successful: [{ id: "msg-drop" }, { id: "msg-move" }],
      failed: [],
    });
    const sqs = createFakeSqsOperations({
      sendBatch: vi
        .fn()
        .mockResolvedValue({ successful: [{ id: "msg-move" }], failed: [] }),
      deleteBatch,
    });
    const deps = buildDeps({
      sqs,
      sourceQueueUrl: "https://sqs.example/orders-inbound",
      messages: [
        heldMessage("msg-drop", "drop-body", "handle-drop-original"),
        heldMessage("msg-move", "payload", "handle-move-original"),
      ],
    });

    await applyActions(plan, deps);

    expect(deleteBatch).toHaveBeenCalledTimes(1);
    const entries = deleteBatch.mock.calls[0]?.[1] as readonly {
      readonly id: string;
      readonly receiptHandle: string;
    }[];
    expect(entries).toHaveLength(2);
    expect(
      entries.find((entry) => entry.id === "msg-drop")?.receiptHandle,
    ).toBe("handle-drop-original");
    expect(
      entries.find((entry) => entry.id === "msg-move")?.receiptHandle,
    ).toBe("handle-move-original");
  });
});

describe("applyActions — a planned message absent from deps.messages", () => {
  test("lands in skipped, and neither sendBatch nor deleteBatch is called for it", async () => {
    const sqs = createFakeSqsOperations();
    const deps = buildDeps({ sqs, messages: [] }); // msg-1 not held from the drain

    const result = await applyActions(dropPlan("msg-1"), deps);

    expect(result.skipped).toContain("msg-1");
    expect(result.removed).toBe(0);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqs.deleteBatch).not.toHaveBeenCalled();
  });
});

describe("applyActions — send-then-delete ordering (a failed send must never be deleted)", () => {
  test("a failed sendBatch entry leaves its message undeleted and lands in failed", async () => {
    const plan: ExecutePlan = {
      actions: [
        {
          messageId: "msg-1",
          verdict: "reinsert",
          action: {
            action: "move",
            entry: { id: "msg-1", body: "the payload" },
          },
          reason: "reinsert verdict",
        },
      ],
      removeCount: 0,
      reinsertCount: 1,
      leaveCount: 0,
      needsSourceQueue: true,
    };
    const sqs = createFakeSqsOperations({
      sendBatch: vi.fn().mockResolvedValue({
        successful: [],
        failed: [
          {
            entry: { id: "msg-1", body: "the payload" },
            code: "InternalError",
            senderFault: false,
            message: "send failed",
          },
        ],
      }),
    });
    const deps = buildDeps({
      sqs,
      sourceQueueUrl: "https://sqs.example/orders-inbound",
      messages: [heldMessage("msg-1", "the payload")],
    });

    const result = await applyActions(plan, deps);

    // Delete-then-failed-send would lose the message permanently; this
    // asserts the recoverable ordering (send first) was honoured — no
    // deleteBatch call was ever made for the message whose send failed.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- structural fake cast to AWS.M3LSQSOperations; property is a vi.fn(), never called unbound
    expect(sqs.deleteBatch).not.toHaveBeenCalled();
    expect(result.reinserted).toBe(0);
    expect(
      result.failed.some(
        (failure: ApplyResult["failed"][number]) =>
          failure.messageId === "msg-1",
      ),
    ).toBe(true);
  });
});

describe("applyActions — a batch delete failure lands in failed, never silently dropped", () => {
  test("a failed deleteBatch entry (drop verdict) is reported, not swallowed", async () => {
    const sqs = createFakeSqsOperations({
      deleteBatch: vi.fn().mockResolvedValue({
        successful: [],
        failed: [
          {
            entry: { id: "msg-1", receiptHandle: "rh-msg-1" },
            code: "ReceiptHandleIsInvalid",
            senderFault: true,
            message: "handle expired",
          },
        ],
      }),
    });
    const deps = buildDeps({ sqs, messages: [heldMessage("msg-1", "body")] });

    const result = await applyActions(dropPlan("msg-1"), deps);

    expect(result.removed).toBe(0);
    const failure = result.failed.find(
      (entry: ApplyResult["failed"][number]) => entry.messageId === "msg-1",
    );
    expect(failure).toBeDefined();
    expect(failure?.reason.length).toBeGreaterThan(0);
  });
});

describe("applyActions — FIFO: single-entry, ordered sends carrying messageGroupId", () => {
  test("sends 'move' actions one at a time, in preset.orderBy order, each with groupIdPath's value", async () => {
    const plan: ExecutePlan = {
      actions: [
        {
          messageId: "msg-b",
          verdict: "reinsert",
          action: { action: "move", entry: { id: "msg-b", body: "b" } },
          reason: "reinsert verdict",
        },
        {
          messageId: "msg-a",
          verdict: "reinsert",
          action: { action: "move", entry: { id: "msg-a", body: "a" } },
          reason: "reinsert verdict",
        },
      ],
      removeCount: 0,
      reinsertCount: 2,
      leaveCount: 0,
      needsSourceQueue: true,
    };
    const sendBatch = vi
      .fn()
      .mockResolvedValue({ successful: [{ id: "x" }], failed: [] });
    const sqs = createFakeSqsOperations({ sendBatch });
    const deps = buildDeps({
      sqs,
      preset: {
        fifo: true,
        orderBy: "seq",
        groupIdPath: "shipmentId",
        sourceQueue: "orders-inbound",
      },
      sourceQueueUrl: "https://sqs.example/orders-inbound",
      messages: [
        heldMessage("msg-b", { seq: 2, shipmentId: "grp-b" }),
        heldMessage("msg-a", { seq: 1, shipmentId: "grp-a" }),
      ],
    });

    await applyActions(plan, deps);

    expect(sendBatch).toHaveBeenCalledTimes(2);
    // orderBy ascending: msg-a (seq 1) before msg-b (seq 2), despite the
    // plan/held order listing msg-b first.
    const firstCallEntries = sendBatch.mock.calls[0]?.[1] as readonly {
      readonly messageGroupId?: string;
    }[];
    const secondCallEntries = sendBatch.mock.calls[1]?.[1] as readonly {
      readonly messageGroupId?: string;
    }[];
    expect(firstCallEntries).toHaveLength(1);
    expect(secondCallEntries).toHaveLength(1);
    expect(firstCallEntries[0]?.messageGroupId).toBe("grp-a");
    expect(secondCallEntries[0]?.messageGroupId).toBe("grp-b");
  });
});

/** Builds an all-'reinsert' plan whose actions are the given `messageId`s, in order. */
function movePlan(messageIds: readonly string[]): ExecutePlan {
  return {
    actions: messageIds.map((messageId) => ({
      messageId,
      verdict: "reinsert" as const,
      action: {
        action: "move" as const,
        entry: { id: messageId, body: "body" },
      },
      reason: "reinsert verdict",
    })),
    removeCount: 0,
    reinsertCount: messageIds.length,
    leaveCount: 0,
    needsSourceQueue: true,
  };
}

/** The FIFO deps shared by every test below: `preset.fifo: true`, `orderBy: "seq"`, `groupIdPath: "shipmentId"`, and the given held messages. */
function buildFifoDeps(
  sqs: ReturnType<typeof createFakeSqsOperations>,
  messages: Parameters<typeof applyActions>[1]["messages"],
): Parameters<typeof applyActions>[1] {
  return buildDeps({
    sqs,
    preset: {
      fifo: true,
      orderBy: "seq",
      groupIdPath: "shipmentId",
      sourceQueue: "orders-inbound",
    },
    sourceQueueUrl: "https://sqs.example/orders-inbound",
    messages,
  });
}

describe("applyActions — FIFO: mixed orderBy value types across a batch (majority wins, minority fails)", () => {
  // The only pre-existing FIFO test uses an all-numeric `orderBy`, so
  // `splitByOrderValueType` returns early (`numbers.length === 0 ||
  // strings.length === 0`) and never reaches its own branch logic — none of
  // the four tests below were previously exercised at all.
  test("a 2-numbers/1-string batch sends the two numeric messages and fails the minority string one", async () => {
    const plan = movePlan(["msg-n1", "msg-n2", "msg-s1"]);
    const sendBatch = vi
      .fn()
      .mockResolvedValue({ successful: [{ id: "x" }], failed: [] });
    const sqs = createFakeSqsOperations({ sendBatch });
    const deps = buildFifoDeps(sqs, [
      heldMessage("msg-n1", { seq: 1, shipmentId: "g-n1" }),
      heldMessage("msg-n2", { seq: 2, shipmentId: "g-n2" }),
      heldMessage("msg-s1", { seq: "z", shipmentId: "g-s1" }),
    ]);

    const result = await applyActions(plan, deps);

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(
      result.failed.some(
        (failure: ApplyResult["failed"][number]) =>
          failure.messageId === "msg-s1",
      ),
    ).toBe(true);
    expect(
      result.failed.find(
        (failure: ApplyResult["failed"][number]) =>
          failure.messageId === "msg-s1",
      )?.reason,
    ).toContain("mixed types cannot be ordered together");
  });

  test("a tie (1 number, 1 string) favours the number, failing the string", async () => {
    const plan = movePlan(["msg-n", "msg-s"]);
    const sendBatch = vi
      .fn()
      .mockResolvedValue({ successful: [{ id: "x" }], failed: [] });
    const sqs = createFakeSqsOperations({ sendBatch });
    const deps = buildFifoDeps(sqs, [
      heldMessage("msg-n", { seq: 5, shipmentId: "g-n" }),
      heldMessage("msg-s", { seq: "p", shipmentId: "g-s" }),
    ]);

    const result = await applyActions(plan, deps);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const sentEntries = sendBatch.mock.calls[0]?.[1] as readonly {
      readonly id: string;
    }[];
    expect(sentEntries[0]?.id).toBe("msg-n");
    expect(
      result.failed.some(
        (failure: ApplyResult["failed"][number]) =>
          failure.messageId === "msg-s",
      ),
    ).toBe(true);
  });

  test("a message with no value at groupIdPath fails per-message, without blocking the rest of the batch", async () => {
    const plan = movePlan(["msg-ok", "msg-nogroup"]);
    const sendBatch = vi
      .fn()
      .mockResolvedValue({ successful: [{ id: "x" }], failed: [] });
    const sqs = createFakeSqsOperations({ sendBatch });
    const deps = buildFifoDeps(sqs, [
      heldMessage("msg-ok", { seq: 1, shipmentId: "g-ok" }),
      heldMessage("msg-nogroup", { seq: 2 }), // no `shipmentId` at all
    ]);

    const result = await applyActions(plan, deps);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const failure = result.failed.find(
      (entry: ApplyResult["failed"][number]) =>
        entry.messageId === "msg-nogroup",
    );
    expect(failure).toBeDefined();
    expect(failure?.reason).toContain("no FIFO message group id");
  });

  test("a non-string/non-number orderBy value (an object) fails per-message, without blocking the rest of the batch", async () => {
    const plan = movePlan(["msg-ok", "msg-badorder"]);
    const sendBatch = vi
      .fn()
      .mockResolvedValue({ successful: [{ id: "x" }], failed: [] });
    const sqs = createFakeSqsOperations({ sendBatch });
    const deps = buildFifoDeps(sqs, [
      heldMessage("msg-ok", { seq: 1, shipmentId: "g-ok" }),
      heldMessage("msg-badorder", {
        seq: { nested: true },
        shipmentId: "g-bad",
      }),
    ]);

    const result = await applyActions(plan, deps);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const failure = result.failed.find(
      (entry: ApplyResult["failed"][number]) =>
        entry.messageId === "msg-badorder",
    );
    expect(failure).toBeDefined();
    expect(failure?.reason).toContain("did not resolve to a string or number");
  });
});
