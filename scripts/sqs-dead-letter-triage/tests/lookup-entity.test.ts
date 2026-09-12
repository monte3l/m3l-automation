import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  createDynamoDBLookup,
  LOOKUP_CODE,
} from "../src/steps/lookup-entity.js";
import type { DynamoDBLookupDeps } from "../src/steps/lookup-entity.js";
import { baseLookupTier } from "./support/preset-fixtures.js";
import { createFakeDynamoDBOperations } from "./support/aws-fakes.js";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s
 * `createDynamoDBLookup` (`src/steps/lookup-entity.ts`) — the
 * `TriageEntityLookup` adapter over `AWS.M3LDynamoDBOperations.getItem`.
 * Cancellation is a **pre-check** only (decision 2 in the PR 3a spec): a
 * `getItem` already in flight is not interrupted, so honouring `signal`
 * means throwing before the call is issued, never racing it.
 */

function baseDeps(
  overrides: Partial<DynamoDBLookupDeps> = {},
): DynamoDBLookupDeps {
  return {
    operations: createFakeDynamoDBOperations(),
    signal: undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDynamoDBLookup — happy path", () => {
  it("builds the key from tier.keyField and returns the item on a hit", async () => {
    const getItem = vi
      .fn()
      .mockResolvedValue({ orderId: "ord-1", status: "paid" });
    const lookup = createDynamoDBLookup(
      baseDeps({ operations: createFakeDynamoDBOperations({ getItem }) }),
    );
    const tier = baseLookupTier({ table: "orders", keyField: "orderId" });

    const entity = await lookup.get(tier, "ord-1", undefined);

    expect(getItem).toHaveBeenCalledWith("orders", { orderId: "ord-1" });
    expect(entity).toEqual({ orderId: "ord-1", status: "paid" });
  });

  it("returns undefined on a miss, without treating it as an error", async () => {
    const lookup = createDynamoDBLookup(
      baseDeps({
        operations: createFakeDynamoDBOperations({
          getItem: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    );

    const entity = await lookup.get(baseLookupTier(), "missing-key", undefined);

    expect(entity).toBeUndefined();
  });
});

describe("createDynamoDBLookup — failure path", () => {
  it("wraps a rejecting getItem into LOOKUP_CODE, chaining the cause and naming the tier and table", async () => {
    const cause = new Error("ProvisionedThroughputExceededException");
    const lookup = createDynamoDBLookup(
      baseDeps({
        operations: createFakeDynamoDBOperations({
          getItem: vi.fn().mockRejectedValue(cause),
        }),
      }),
    );
    const tier = baseLookupTier({ label: "primary", table: "orders" });

    let thrown: unknown;
    try {
      await lookup.get(tier, "ord-1", undefined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(LOOKUP_CODE);
    expect((thrown as Core.M3LError).cause).toBe(cause);
    expect((thrown as Core.M3LError).message).toContain("primary");
    expect((thrown as Core.M3LError).message).toContain("orders");
  });
});

describe("createDynamoDBLookup — cancellation (pre-check only)", () => {
  it("throws before getItem is called when deps.signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const getItem = vi.fn();
    const lookup = createDynamoDBLookup(
      baseDeps({
        signal: controller.signal,
        operations: createFakeDynamoDBOperations({ getItem }),
      }),
    );

    await expect(
      lookup.get(baseLookupTier(), "ord-1", undefined),
    ).rejects.toBeInstanceOf(Core.M3LOperationAbortedError);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("throws before getItem is called when the per-call signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const getItem = vi.fn();
    const lookup = createDynamoDBLookup(
      baseDeps({ operations: createFakeDynamoDBOperations({ getItem }) }),
    );

    await expect(
      lookup.get(baseLookupTier(), "ord-1", controller.signal),
    ).rejects.toBeInstanceOf(Core.M3LOperationAbortedError);
    expect(getItem).not.toHaveBeenCalled();
  });
});

describe("createDynamoDBLookup — no logging seam exists (structural guarantee)", () => {
  // `DynamoDBLookupDeps` used to carry a `logger` field the function body
  // never read; a prior test proved "never logs the key" by passing a
  // recording logger and asserting it stayed empty. That vehicle no longer
  // exists — the guarantee is now structural: there is no sink to log to.
  // Pinning `keyof DynamoDBLookupDeps` to exactly its two live members means
  // a `logger` re-added later fails this test immediately, before anyone
  // gets the chance to wire a call into it.
  it("DynamoDBLookupDeps carries no logger member", () => {
    expectTypeOf<keyof DynamoDBLookupDeps>().toEqualTypeOf<
      "operations" | "signal"
    >();
  });

  it("a wrapped lookup failure names the tier and table but never the key or an entity value", async () => {
    const cause = new Error("ProvisionedThroughputExceededException");
    const lookup = createDynamoDBLookup(
      baseDeps({
        operations: createFakeDynamoDBOperations({
          getItem: vi.fn().mockRejectedValue(cause),
        }),
      }),
    );
    const tier = baseLookupTier({ label: "primary", table: "orders" });

    let thrown: unknown;
    try {
      await lookup.get(tier, "sensitive-key-value", undefined);
    } catch (error) {
      thrown = error;
    }

    const message = (thrown as Core.M3LError).message;
    expect(message).toContain("primary");
    expect(message).toContain("orders");
    expect(message).not.toContain("sensitive-key-value");
  });
});
