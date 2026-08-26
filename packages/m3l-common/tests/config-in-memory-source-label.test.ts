/**
 * `core/config/M3LInMemoryConfigProvider` — the optional `sourceLabel`
 * constructor option (U7 PR1).
 *
 * ADR-0072 slice split: this file owns the additive second constructor
 * argument and nothing else. The provider's pre-existing behaviour — value
 * lookup, `Map` seeding, the prototype-pollution guard, the `"in-memory"`
 * default — is covered by `config.test.ts`'s own `M3LInMemoryConfigProvider`
 * block, which stays exactly as it was; the two arms re-asserted here exist
 * only as regression locks scoped to the widening.
 *
 * Why the option exists: a caller other than a test — a hosted script's
 * config loader, binding already-resolved parameter values in place of the
 * command-line provider — needs to report the SAME source label the spawn
 * path would have used. Without it, a hosted run's `run-report.json` records
 * `"in-memory"` where an identical spawned run records `"cli"`, and the two
 * runs stop being indistinguishable in the very artifact ADR-0054's parity
 * clause is about.
 */

import { describe, expect, test } from "vitest";

import {
  M3LInMemoryConfigProvider,
  M3LUnsafeConfigKeyError,
} from "../src/core/config/index.js";

describe("M3LInMemoryConfigProvider — the default source label", () => {
  // Regression lock on every existing call site: they all pass one argument,
  // and the widening must leave every one of them behaving exactly as before.
  test("getSourceLabel() still returns 'in-memory' when the option is omitted", () => {
    const provider = new M3LInMemoryConfigProvider({ a: 1 });
    expect(provider.getSourceLabel()).toBe("in-memory");
  });

  test("getSourceLabel() still returns 'in-memory' for an explicitly empty options bag", () => {
    const provider = new M3LInMemoryConfigProvider({ a: 1 }, {});
    expect(provider.getSourceLabel()).toBe("in-memory");
  });
});

describe("M3LInMemoryConfigProvider — an explicit source label", () => {
  test("getSourceLabel() returns the supplied label verbatim", () => {
    const provider = new M3LInMemoryConfigProvider(
      { a: 1 },
      { sourceLabel: "cli" },
    );
    expect(provider.getSourceLabel()).toBe("cli");
  });

  test("applies to a Map-seeded provider too", () => {
    const provider = new M3LInMemoryConfigProvider(
      new Map<string, unknown>([["region", "eu-west-1"]]),
      { sourceLabel: "cli" },
    );
    expect(provider.getSourceLabel()).toBe("cli");
    expect(provider.getRawValue("region")).toBe("eu-west-1");
  });

  test("does not disturb value resolution", () => {
    const provider = new M3LInMemoryConfigProvider(
      { "canonical.name": "Ada" },
      { sourceLabel: "cli" },
    );
    expect(provider.getRawValue("canonical.name")).toBe("Ada");
    expect(provider.getRawValue("missing")).toBeUndefined();
  });

  // The guard runs over `values`, so a second argument must not divert
  // construction around it.
  test("the prototype-pollution guard still fires when a sourceLabel is supplied", () => {
    const dangerousPayload = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    ) as Record<string, unknown>;

    expect(
      () =>
        new M3LInMemoryConfigProvider(dangerousPayload, { sourceLabel: "cli" }),
    ).toThrow(M3LUnsafeConfigKeyError);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
