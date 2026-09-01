/**
 * Tests for the ADR-0070 correlation seam on `core/script` (X7b): the
 * four-tier precedence a run's correlation id resolves under, and the
 * `M3LScriptRunOptions` / `M3LRunScriptOptions` fields that feed it.
 *
 * A sibling facet file rather than an addition to `script.test.ts`, which is
 * frozen at its ADR-0072 baseline size — the same reason `script-host.test.ts`
 * and `script-cancellation.test.ts` exist. The two `toEqualTypeOf` shape
 * locks at the bottom MOVED here from `script.test.ts` for that reason: both
 * interfaces gained `correlationId`, so both locks had to change, and the
 * frozen file may only shrink.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  M3LBreadcrumbTrail,
  M3LRunReporter,
} from "../src/core/diagnostics/index.js";
import type { M3LRunReportInput } from "../src/core/diagnostics/index.js";
import { M3LScript, runScript } from "../src/core/script/index.js";
import type {
  M3LRunScriptOptions,
  M3LScriptRunOptions,
} from "../src/core/script/index.js";
import { resolveRunCorrelationId } from "../src/internal/script/correlationId.js";

/**
 * The env var name, spelled out here rather than imported.
 *
 * The resolver uses an inline literal (this library's convention for every
 * env-var name), so this constant is an INDEPENDENT copy: if someone renames
 * the variable in `correlationId.ts`, these tests fail — which is exactly
 * the guard. Importing a shared constant would make the assertion vacuous.
 */
const ENV_VAR = "M3L_CORRELATION_ID";

const METADATA = { name: "correlation-probe", version: "1.0.0" } as const;

/** A bare script; every run below is a dry run, so none touches the disk. */
function script(): M3LScript {
  return new M3LScript({ metadata: METADATA });
}

afterEach(() => {
  vi.restoreAllMocks();
  // A leaked non-zero exit code corrupts the whole suite's exit status even
  // when every test passes — the same isolation `script.test.ts` applies.
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// The mirrored literal
// ---------------------------------------------------------------------------

describe("the environment variable name", () => {
  // GUARD: this exact string is also written by the console server's
  // `runs/executor.ts` onto a spawned run's environment. The two copies are
  // deliberate (neither package needs the other's compile-time surface), so
  // this assertion — and its twin in the console server's
  // `runs-executor.test.ts` — is what makes a rename fail loudly instead of
  // silently breaking correlation across the process boundary.
  test("a value under M3L_CORRELATION_ID is picked up verbatim", () => {
    // Exercises the literal end to end rather than comparing a constant to
    // itself: this fails if the resolver reads any other variable name.
    expect(
      resolveRunCorrelationId({ env: { M3L_CORRELATION_ID: "from-the-env" } }),
    ).toBe("from-the-env");
  });
});

// ---------------------------------------------------------------------------
// Precedence, one arm at a time
// ---------------------------------------------------------------------------

describe("resolveRunCorrelationId precedence", () => {
  // Each case supplies EVERY lower tier as well, so it proves the winning
  // tier actually outranks them rather than merely being the only one set.
  test("tier 1: the configured id beats every other tier", () => {
    const resolved = resolveRunCorrelationId({
      configured: "configured-id",
      preferred: "preferred-id",
      env: { [ENV_VAR]: "env-id" },
    });

    expect(resolved).toBe("configured-id");
  });

  test("tier 2: the per-run/platform id beats env and generation", () => {
    const resolved = resolveRunCorrelationId({
      preferred: "preferred-id",
      env: { [ENV_VAR]: "env-id" },
    });

    expect(resolved).toBe("preferred-id");
  });

  test("tier 3: the environment is used when no explicit value was passed", () => {
    const resolved = resolveRunCorrelationId({
      env: { [ENV_VAR]: "env-id" },
    });

    expect(resolved).toBe("env-id");
  });

  test("tier 4: a UUID is generated when nothing set an id", () => {
    const resolved = resolveRunCorrelationId({ env: {} });

    expect(resolved).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  test("env never overrides an explicit value — ambient context loses", () => {
    // The `--log-level` beats `M3L_LOG_LEVEL` precedent, restated as a
    // behavioural lock: an inherited environment must not silently retag a
    // run whose caller wrote an id down.
    expect(
      resolveRunCorrelationId({
        configured: "explicit",
        env: { [ENV_VAR]: "ambient" },
      }),
    ).toBe("explicit");
  });
});

describe("what counts as an absent id", () => {
  test("an empty string falls through to the next tier", () => {
    expect(
      resolveRunCorrelationId({
        configured: "",
        preferred: "preferred-id",
        env: {},
      }),
    ).toBe("preferred-id");
  });

  test("an empty env value falls through to generation", () => {
    const resolved = resolveRunCorrelationId({
      env: { [ENV_VAR]: "" },
    });

    expect(resolved).not.toBe("");
    expect(resolved.length).toBeGreaterThan(0);
  });

  // REGRESSION LOCK: the check is `length > 0`, NOT `trim()`. A
  // whitespace-only id is used verbatim, which is the rule
  // `M3LScriptOptions.correlationId` has always applied. This test exists to
  // fail if someone "fixes" the resolver by adding a `trim()` — that would
  // silently change a shipped behaviour for every tier at once.
  test("a whitespace-only id is used verbatim, not trimmed away", () => {
    expect(
      resolveRunCorrelationId({ configured: "   ", preferred: "other" }),
    ).toBe("   ");
  });
});

// ---------------------------------------------------------------------------
// The payoff: an id supplied per-run reaches the persisted report
// ---------------------------------------------------------------------------

describe("end to end through runScript", () => {
  test("a per-run correlationId lands in the persisted run report", async () => {
    // Spy on `persist` rather than reading the file back: every sibling
    // `runScript` test in `script.test.ts` does the same, because a real
    // persist resolves `script.paths` against the repo and writes
    // `data/output/<timestamp>/run-report.json` outside the test's tmpdir.
    // The assertion is still end-to-end — this is the exact input the
    // reporter serializes.
    const persisted: M3LRunReportInput[] = [];
    vi.spyOn(M3LRunReporter.prototype, "persist").mockImplementation(
      (input: M3LRunReportInput) => {
        persisted.push(input);
        return Promise.resolve("/fake/report.json");
      },
    );

    await runScript(script(), () => {}, {
      correlationId: "trace-from-the-caller",
      dryRun: true,
      trail: new M3LBreadcrumbTrail(),
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.correlationId).toBe("trace-from-the-caller");
  });

  test("script.correlationId reflects the per-run id", async () => {
    const instance = script();

    await instance.run(() => {}, {
      correlationId: "id-for-this-run",
      dryRun: true,
    });

    expect(instance.correlationId).toBe("id-for-this-run");
  });

  test("a constructor id still outranks a per-run one", async () => {
    const instance = new M3LScript({
      metadata: METADATA,
      correlationId: "from-the-constructor",
    });

    await instance.run(() => {}, {
      correlationId: "from-the-run",
      dryRun: true,
    });

    expect(instance.correlationId).toBe("from-the-constructor");
  });
});

// ---------------------------------------------------------------------------
// Shape locks (relocated from script.test.ts, which may not grow)
// ---------------------------------------------------------------------------

describe("type-level contract", () => {
  test("M3LRunScriptOptions: every field is optional", () => {
    expectTypeOf<M3LRunScriptOptions>().toEqualTypeOf<{
      readonly dryRun?: boolean;
      readonly correlationId?: string;
      readonly report?: boolean;
      readonly trail?: Pick<M3LBreadcrumbTrail, "entries">;
    }>();
  });

  test("M3LScriptRunOptions: every field is optional", () => {
    expectTypeOf<M3LScriptRunOptions>().toEqualTypeOf<{
      readonly dryRun?: boolean;
      readonly correlationId?: string;
    }>();
  });

  // EXHAUSTIVENESS GUARD for `run-script.ts`'s `forwardedRunOptions`. That
  // forwarding used to be an inline `Required<M3LScriptRunOptions>` literal,
  // so a newly-added field failed to compile rather than being silently
  // dropped (the ADR-0035 phase-2 `wrapError` defect). `correlationId` has
  // no total default, so it can no longer be `Required<>` — this assertion
  // carries the guarantee instead: add a field to `M3LScriptRunOptions` and
  // this fails until `forwardedRunOptions` forwards it too.
  test("every M3LScriptRunOptions field is forwarded by runScript", () => {
    expectTypeOf<keyof Required<M3LScriptRunOptions>>().toEqualTypeOf<
      "correlationId" | "dryRun"
    >();
  });

  // A per-call options bag is exactly the shape `M3LCommandContext.signal`'s
  // TSDoc excludes from the required-holding-`undefined` convention, so
  // omission must stay legal and `undefined` must not be writable.
  test("correlationId is an optional key, not required-holding-undefined", () => {
    const omitted: M3LScriptRunOptions = { dryRun: true };
    expect(omitted.correlationId).toBeUndefined();

    // @ts-expect-error -- an OPTIONAL key under exactOptionalPropertyTypes
    // cannot be written as `undefined`; contrast `M3LCommandContext.signal`,
    // which is required-holding-`undefined` and therefore can.
    const explicitUndefined: M3LScriptRunOptions = { correlationId: undefined };
    expect(explicitUndefined).toBeDefined();
  });
});
