// Tests for src/tools/registry.ts (V10b, ADR-0062): TOOL_REGISTRY and the
// GatedToolRegistration brand.
// TOOL_REGISTRY is empty in this slice — the gate that populates it
// (gateTool / GatedToolRegistration producers) ships in slice V10c.
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  type GatedToolRegistration,
  TOOL_REGISTRY,
} from "../src/tools/registry.js";

describe("TOOL_REGISTRY", () => {
  test("is an array", () => {
    expect(Array.isArray(TOOL_REGISTRY)).toBe(true);
  });

  test("is empty in this slice", () => {
    expect(TOOL_REGISTRY).toHaveLength(0);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(TOOL_REGISTRY)).toBe(true);
  });
});

describe("GatedToolRegistration (type level)", () => {
  test("an unbranded object literal with the right shape is NOT assignable to GatedToolRegistration", () => {
    // Same public shape (name/config/handler) as a real registration, but
    // built as a plain object literal rather than through the module's own
    // (not-yet-existing, slice V10c) gate producer — i.e. it carries no
    // brand. If this were assignable, the brand would be unforgeable in
    // name only: any caller could hand-roll a "gated" entry and skip the
    // policy/audit wrapper entirely. This can only be proven at the type
    // level — an unbranded literal has no runtime representation to assert
    // against.
    interface UnbrandedLookalike {
      readonly name: string;
      readonly config: {
        readonly title: string;
        readonly description: string;
        readonly annotations: { readonly readOnlyHint: boolean };
      };
      readonly handler: (args: unknown) => Promise<unknown>;
    }

    expectTypeOf<UnbrandedLookalike>().not.toExtend<GatedToolRegistration>();
  });
});
