/**
 * Tests for `src/sessions/ports.ts` — the drift guard between the
 * `sessions/` zone's own declared-not-imported mirror types
 * (`M3LSessionLaunchRequest`/`M3LSessionRunHandle`/`M3LSessionRunEvent`) and
 * the REAL `runs/orchestrator-types.ts`/`runs/events.ts` shapes they mirror
 * (X6 workbench-sessions module, slice 4, Part A, issue #554).
 *
 * `sessions/ports.ts` itself may only import `sessions`, `errors`, `store`
 * (eslint zone rule, `bin/check-eslint-zones.mjs`) — it may NOT import
 * `runs/`, so it cannot prove its own conformance to the real types it
 * mirrors. This test file is NOT inside the `sessions/` zone (it lives under
 * `tests/`), so it is free to import both sides and prove the mirror hasn't
 * drifted — the same role `tests/runs-registry.test.ts` plays for
 * `runs/registry.ts`'s own narrow port (`expectTypeOf<Real>().toExtend<Port>()`
 * for a genuinely narrowed port; here `M3LSessionRunEvent` is documented as a
 * FULL structural mirror of every `M3LRunEvent` variant, not a narrowed
 * subset, so it is checked both ways with `toEqualTypeOf`).
 *
 * `M3LSessionRunHandle.executionMode` uses the real, narrower
 * `RunExecutionMode` ("spawn" | "in-process") union exactly, imported from
 * `store/runs-repository.ts` (within the `sessions` zone's own declared
 * `store` allowance) — so that field is checked with `toEqualTypeOf` against
 * the real `RunExecutionMode`, the same as every other field on this type.
 *
 * RED: `../src/sessions/ports.ts` does not exist yet.
 */
import { describe, expectTypeOf, test } from "vitest";

import type { M3LRunEvent } from "../src/runs/events.js";
import type {
  M3LRunHandle,
  M3LRunLaunchRequest,
} from "../src/runs/orchestrator-types.js";
import type {
  M3LSessionLaunchRequest,
  M3LSessionRunEvent,
  M3LSessionRunHandle,
} from "../src/sessions/ports.js";
import type { RunExecutionMode } from "../src/store/runs-repository.js";

describe("M3LSessionLaunchRequest — mirrors the real M3LRunLaunchRequest field for field", () => {
  test("is an exact structural equal of the real type — no widening on this side", () => {
    expectTypeOf<M3LSessionLaunchRequest>().toEqualTypeOf<M3LRunLaunchRequest>();
  });
});

describe("M3LSessionRunHandle — mirrors the real M3LRunHandle's launch-return shape", () => {
  test("the real M3LRunHandle remains structurally assignable to the port's mirror shape", () => {
    expectTypeOf<M3LRunHandle>().toExtend<M3LSessionRunHandle>();
  });

  test("id/scriptName/status/dryRun are exact, not merely assignable", () => {
    expectTypeOf<M3LSessionRunHandle["id"]>().toEqualTypeOf<
      M3LRunHandle["id"]
    >();
    expectTypeOf<M3LSessionRunHandle["scriptName"]>().toEqualTypeOf<
      M3LRunHandle["scriptName"]
    >();
    expectTypeOf<M3LSessionRunHandle["status"]>().toEqualTypeOf<
      M3LRunHandle["status"]
    >();
    expectTypeOf<M3LSessionRunHandle["dryRun"]>().toEqualTypeOf<
      M3LRunHandle["dryRun"]
    >();
  });

  test("executionMode uses the real, narrower RunExecutionMode union exactly", () => {
    expectTypeOf<
      M3LSessionRunHandle["executionMode"]
    >().toEqualTypeOf<RunExecutionMode>();
    expectTypeOf<M3LRunHandle["executionMode"]>().toEqualTypeOf<
      M3LSessionRunHandle["executionMode"]
    >();
  });
});

describe("M3LSessionRunEvent — a full structural mirror of every M3LRunEvent variant", () => {
  test("is an exact structural equal of the real union, both directions", () => {
    expectTypeOf<M3LSessionRunEvent>().toEqualTypeOf<M3LRunEvent>();
  });

  test("every real M3LRunEvent variant discriminant is present on the mirror", () => {
    expectTypeOf<M3LSessionRunEvent["event"]>().toEqualTypeOf<
      M3LRunEvent["event"]
    >();
  });
});
