/**
 * Tests for src/runs/governor.ts — `createRunGovernor` (m3l-console-server X4
 * run-governor contract). `decide` is read-only: it never mutates counters
 * by itself. A decision is only committed by calling `accept`/`enqueue`, and
 * undone by `release`/`dequeue`.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { createRunGovernor } from "../src/runs/governor.js";
import type {
  M3LRunGovernor,
  M3LRunGovernorDecision,
  M3LRunGovernorOptions,
} from "../src/runs/governor.js";

/** Builds a governor with the given knobs, defaulting to generous limits. */
function buildGovernor(
  overrides: Partial<M3LRunGovernorOptions> = {},
): M3LRunGovernor {
  return createRunGovernor({
    maxConcurrency: 4,
    maxPerScript: 1,
    queueCapacity: 16,
    ...overrides,
  });
}

describe("createRunGovernor — fresh governor", () => {
  test("decide accepts any script when every slot is free", () => {
    const governor = buildGovernor();

    expect(governor.decide("any-script")).toEqual({ kind: "accept" });
    expect(governor.activeCount).toBe(0);
    expect(governor.queuedCount).toBe(0);
  });
});

describe("createRunGovernor — accept and release", () => {
  test("accepting then releasing returns counters to zero", () => {
    const governor = buildGovernor();

    governor.accept("a");
    expect(governor.activeCount).toBe(1);

    governor.release("a");
    expect(governor.activeCount).toBe(0);
  });
});

describe("createRunGovernor — per-script mutex", () => {
  test("a second run of the same script queues while a different script is accepted", () => {
    const governor = buildGovernor({ maxPerScript: 1, maxConcurrency: 4 });

    governor.accept("a");

    expect(governor.decide("a")).toEqual({ kind: "queue" });
    expect(governor.decide("b")).toEqual({ kind: "accept" });
  });
});

describe("createRunGovernor — global concurrency", () => {
  test("a new script queues once maxConcurrency active slots are filled", () => {
    const governor = buildGovernor({ maxConcurrency: 2, maxPerScript: 1 });

    governor.accept("a");
    governor.accept("b");

    expect(governor.activeCount).toBe(2);
    expect(governor.decide("c")).toEqual({ kind: "queue" });
  });
});

describe("createRunGovernor — queue full", () => {
  test("rejects once the queue is at capacity", () => {
    const governor = buildGovernor({ maxConcurrency: 1, queueCapacity: 1 });

    governor.accept("a");
    governor.enqueue();

    expect(governor.queuedCount).toBe(1);
    expect(governor.decide("b")).toEqual({ kind: "reject" });
  });
});

describe("createRunGovernor — zero queue capacity", () => {
  test("rejects immediately with no queue when slots are busy", () => {
    const governor = buildGovernor({ maxConcurrency: 1, queueCapacity: 0 });

    governor.accept("a");

    expect(governor.decide("b")).toEqual({ kind: "reject" });
    expect(governor.queuedCount).toBe(0);
  });
});

describe("createRunGovernor — enqueue/dequeue", () => {
  test("enqueue increments queuedCount and dequeue decrements it", () => {
    const governor = buildGovernor({ maxConcurrency: 1 });

    governor.accept("a");
    governor.enqueue();
    expect(governor.queuedCount).toBe(1);

    governor.dequeue();
    expect(governor.queuedCount).toBe(0);
  });
});

describe("createRunGovernor — activeCount tracks only accepted runs", () => {
  test("enqueue does not affect activeCount", () => {
    const governor = buildGovernor({ maxConcurrency: 1 });

    governor.accept("a");
    governor.enqueue();

    expect(governor.activeCount).toBe(1);
  });
});

describe("createRunGovernor — release on a non-accepted script", () => {
  test("is a safe no-op that does not throw or go negative", () => {
    const governor = buildGovernor();

    expect(() => {
      governor.release("never-accepted");
    }).not.toThrow();
    expect(governor.activeCount).toBe(0);
  });
});

describe("createRunGovernor — decide is read-only", () => {
  test("calling decide repeatedly without accept/enqueue never changes the counters", () => {
    const governor = buildGovernor({ maxConcurrency: 1, maxPerScript: 1 });

    governor.accept("a");
    const activeBefore = governor.activeCount;
    const queuedBefore = governor.queuedCount;

    governor.decide("a");
    governor.decide("b");
    governor.decide("a");

    expect(governor.activeCount).toBe(activeBefore);
    expect(governor.queuedCount).toBe(queuedBefore);
  });
});

describe("M3LRunGovernorDecision", () => {
  test("is a readonly discriminated kind union", () => {
    expectTypeOf<M3LRunGovernorDecision>().toEqualTypeOf<{
      readonly kind: "accept" | "queue" | "reject";
    }>();
  });
});
