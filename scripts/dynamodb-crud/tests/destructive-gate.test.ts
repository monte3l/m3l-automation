import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return { ...actual, AWS: { ...actual.AWS, describeTable: vi.fn() } };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import { runDestructiveGate } from "../src/steps/destructive-gate.js";

/**
 * Contract: docs/reference/scripts/dynamodb-crud.md, `destructive-gate` row.
 * Shared confirm-gate for `delete`/`update`/`batch-delete`/`import`: describes
 * the target table's approximate size (`AWS.describeTable`) and delegates the
 * actual confirm/abort decision to the library's `Core.confirmDestructive`
 * (`packages/m3l-common/src/core/prompt/M3LDestructiveGate.ts`), injecting a
 * real `Core.M3LPrompt` backed by a mock `M3LPromptAdapter` so the step is
 * unit-testable without a real TTY.
 */

/**
 * Builds a mock `M3LPromptAdapter` as an object of `vi.fn()`s.
 *
 * Left inferred (not annotated as `M3LPromptAdapter`) — mirrors
 * `packages/m3l-common/tests/prompt.test.ts`'s `makeMockAdapter`: several
 * adapter methods are generic over `Value`, and a non-generic `vi.fn()` mock
 * is not a valid override of a generic method signature under an explicit
 * interface annotation.
 */
function makeMockAdapter() {
  return {
    input: vi.fn(),
    password: vi.fn(),
    number: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    checkbox: vi.fn(),
    search: vi.fn(),
  };
}

// A non-sensitive default `awsTarget` — `isSensitiveTarget` will not match
// this, so every existing (pre-escalation) test keeps its current plain
// yes/no `confirm` behavior once the src change lands.
const nonSensitiveTarget: Core.M3LDestructiveTarget = {
  profile: "dev-sandbox",
};

const describeTableMock = vi.mocked(AWS.describeTable);

// Only the mocked `AWS.describeTable` is invoked in these tests; the client
// value itself is never dereferenced, so an opaque placeholder is safe.
const fakeClient = {} as Parameters<typeof AWS.describeTable>[0];

afterEach(() => {
  vi.restoreAllMocks();
  describeTableMock.mockReset();
});

describe("runDestructiveGate", () => {
  test("resolves without throwing when the adapter's confirm resolves true", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 42,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new Core.M3LPrompt({ adapter });

    await expect(
      runDestructiveGate({
        dynamoDB: fakeClient,
        tableName: "orders",
        operation: "delete",
        logger,
        prompt,
        awsTarget: nonSensitiveTarget,
      }),
    ).resolves.toBeUndefined();

    expect(describeTableMock).toHaveBeenCalledWith(fakeClient, "orders");
    expect(adapter.confirm).toHaveBeenCalledTimes(1);
    const [config] = adapter.confirm.mock.calls[0] as [{ message: string }];
    expect(config.message).toEqual(expect.stringContaining("orders"));
    expect(config.message).toEqual(expect.stringContaining("delete"));
    expect(config.message).toEqual(expect.stringContaining("42"));
  });

  test("never calls a standalone logger.warning before confirming (yes is always false here)", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 10,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new Core.M3LPrompt({ adapter });

    await runDestructiveGate({
      dynamoDB: fakeClient,
      tableName: "orders",
      operation: "delete",
      logger,
      prompt,
      awsTarget: nonSensitiveTarget,
    });

    // Core.confirmDestructive only warns on the yes=true bypass channel;
    // runDestructiveGate always passes yes: false, so no warning is logged
    // here (unlike the old standalone `logger.warning` this step used to
    // issue itself before calling confirm).
    expect(warningSpy).not.toHaveBeenCalled();
  });

  test("throws M3LError with code ERR_DYNAMO_CRUD_ABORTED when the adapter's confirm resolves false", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 100,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(false);
    const prompt = new Core.M3LPrompt({ adapter });

    let thrown: unknown;
    try {
      await runDestructiveGate({
        dynamoDB: fakeClient,
        tableName: "orders",
        operation: "batch-delete",
        logger,
        prompt,
        awsTarget: nonSensitiveTarget,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_ABORTED");
    expect(adapter.confirm).toHaveBeenCalledTimes(1);
  });

  test("still prompts for confirmation when itemCount is 0 (approximate count, not proof of emptiness)", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 0,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new Core.M3LPrompt({ adapter });

    await runDestructiveGate({
      dynamoDB: fakeClient,
      tableName: "empty-looking-table",
      operation: "import",
      logger,
      prompt,
      awsTarget: nonSensitiveTarget,
    });

    expect(adapter.confirm).toHaveBeenCalledTimes(1);
  });

  test("propagates a describeTable failure unmodified and never calls the prompt's confirm", async () => {
    const describeError = new AWS.M3LDynamoDBOperationError(
      "describeTable failed",
      { context: { tableName: "orders" } },
    );
    describeTableMock.mockRejectedValue(describeError);
    const logger = new Core.M3LLogger([]);
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new Core.M3LPrompt({ adapter });

    let thrown: unknown;
    try {
      await runDestructiveGate({
        dynamoDB: fakeClient,
        tableName: "orders",
        operation: "update",
        logger,
        prompt,
        awsTarget: nonSensitiveTarget,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(describeError);
    expect(adapter.confirm).not.toHaveBeenCalled();
  });

  test("passes the exact tableName through to describeTable for every documented operation", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 5,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new Core.M3LPrompt({ adapter });

    await runDestructiveGate({
      dynamoDB: fakeClient,
      tableName: "widgets",
      operation: "update",
      logger,
      prompt,
      awsTarget: nonSensitiveTarget,
    });

    expect(describeTableMock).toHaveBeenCalledWith(fakeClient, "widgets");
  });

  test("uses the plain confirm (not escalated) when the target is not sensitive", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 7,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const adapter = makeMockAdapter();
    adapter.confirm.mockResolvedValue(true);
    const prompt = new Core.M3LPrompt({ adapter });

    await runDestructiveGate({
      dynamoDB: fakeClient,
      tableName: "orders",
      operation: "delete",
      logger,
      prompt,
      awsTarget: { profile: "dev-sandbox" },
    });

    expect(adapter.confirm).toHaveBeenCalledTimes(1);
    expect(adapter.input).not.toHaveBeenCalled();
  });

  test("escalates to the typed-echo prompt when the target's profile contains 'prod'", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 7,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const adapter = makeMockAdapter();
    // The escalated typed-echo path is `Core.M3LPrompt.text()`, which
    // delegates to the adapter's `input()` method (there is no separate
    // `text()` adapter method) — see
    // packages/m3l-common/src/core/prompt/M3LPrompt.ts.
    adapter.input.mockResolvedValue("prod");
    const prompt = new Core.M3LPrompt({ adapter });

    await expect(
      runDestructiveGate({
        dynamoDB: fakeClient,
        tableName: "orders",
        operation: "delete",
        logger,
        prompt,
        awsTarget: { profile: "prod" },
      }),
    ).resolves.toBeUndefined();

    expect(adapter.input).toHaveBeenCalledTimes(1);
    const [config] = adapter.input.mock.calls[0] as [{ message: string }];
    expect(config.message).toEqual(expect.stringContaining("orders"));
    expect(config.message).toEqual(expect.stringContaining("prod"));
    expect(adapter.confirm).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_ABORTED when the typed-echo input doesn't match the profile", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 7,
      tableStatus: "ACTIVE",
    });
    const logger = new Core.M3LLogger([]);
    const adapter = makeMockAdapter();
    adapter.input.mockResolvedValue("nope");
    const prompt = new Core.M3LPrompt({ adapter });

    let thrown: unknown;
    try {
      await runDestructiveGate({
        dynamoDB: fakeClient,
        tableName: "orders",
        operation: "delete",
        logger,
        prompt,
        awsTarget: { profile: "prod" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_ABORTED");
    expect(adapter.confirm).not.toHaveBeenCalled();
  });

  test("type contract: runDestructiveGate resolves void and takes a Core.M3LPrompt, not a bare confirm callback", () => {
    expectTypeOf(runDestructiveGate).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<
      Parameters<typeof runDestructiveGate>[0]["prompt"]
    >().toEqualTypeOf<Core.M3LPrompt>();
    expectTypeOf<
      Parameters<typeof runDestructiveGate>[0]["dynamoDB"]
    >().toEqualTypeOf<Parameters<typeof AWS.describeTable>[0]>();
    expectTypeOf<
      Parameters<typeof runDestructiveGate>[0]["awsTarget"]
    >().toEqualTypeOf<Core.M3LDestructiveTarget>();
  });
});
