/**
 * Tests for src/core/config/deriveEnvVarName.ts — the SCREAMING_SNAKE_CASE
 * environment-variable name derivation, promoted out of
 * `M3LEnvironmentConfigProvider`'s module privacy by ADR-0085 so the m3l CLI
 * can compute the same key when it injects a `secret: true` parameter into a
 * spawned script's environment instead of its argv.
 *
 * A sibling of `config.test.ts` rather than an addition to it: that file is
 * baselined at its current size in `bin/file-budget-baseline.json`, and
 * ADR-0072's slicing rules say not to grow a baselined file.
 */
import { describe, expect, test } from "vitest";

import {
  deriveEnvVarName,
  M3LEnvironmentConfigProvider,
} from "../src/core/config/index.js";

// =============================================================================
// deriveEnvVarName
// =============================================================================
describe("deriveEnvVarName", () => {
  test("uppercases a plain lowercase key", () => {
    expect(deriveEnvVarName("region")).toBe("REGION");
  });

  test("replaces a dot with an underscore and uppercases", () => {
    expect(deriveEnvVarName("canonical.name")).toBe("CANONICAL_NAME");
  });

  test("replaces a dash with an underscore and uppercases", () => {
    expect(deriveEnvVarName("license-code")).toBe("LICENSE_CODE");
  });

  test("replaces every dot and dash in a mixed key, not just the first", () => {
    expect(deriveEnvVarName("a.b-c.d-e")).toBe("A_B_C_D_E");
  });

  test("passes an already-SCREAMING_SNAKE_CASE key through unchanged", () => {
    expect(deriveEnvVarName("ALREADY_UPPER")).toBe("ALREADY_UPPER");
  });

  test("is idempotent — deriving from its own output returns that output", () => {
    const once = deriveEnvVarName("api.token-value");
    expect(deriveEnvVarName(once)).toBe(once);
  });

  test("leaves an empty key empty", () => {
    expect(deriveEnvVarName("")).toBe("");
  });

  test("preserves an underscore that is already present", () => {
    expect(deriveEnvVarName("already_snake.case")).toBe("ALREADY_SNAKE_CASE");
  });

  // The reason this function was promoted out of M3LEnvironmentConfigProvider's
  // module privacy (ADR-0085): an out-of-process caller (the m3l CLI, injecting
  // a secret-flagged parameter into a spawned child's environment instead of
  // its argv) must land on the exact key the provider will later look up. The
  // cross-check drives the two sides from OPPOSITE directions — the key goes in
  // through deriveEnvVarName and comes back out through the provider's own
  // lookup — so it cannot pass vacuously the way a same-source reconciliation
  // would.
  test.each([
    ["region", "eu-west-1"],
    ["canonical.name", "Ada"],
    ["license-code", "S3CR3T"],
    ["a.b-c", "mixed"],
  ])(
    "a value set under deriveEnvVarName(%j) is readable back through M3LEnvironmentConfigProvider",
    (key, value) => {
      const provider = new M3LEnvironmentConfigProvider({
        env: { [deriveEnvVarName(key)]: value },
      });
      expect(provider.getRawValue(key)).toBe(value);
    },
  );

  test("a value set under a DIFFERENT derivation is NOT readable back — the cross-check can fail", () => {
    // Mutation-proof for the test above: had the provider's derivation drifted
    // (e.g. to kebab-preserving, or lowercase), the round-trip would break.
    const provider = new M3LEnvironmentConfigProvider({
      env: { "license-code": "S3CR3T" },
    });
    expect(provider.getRawValue("license.code")).toBeUndefined();
  });
});
