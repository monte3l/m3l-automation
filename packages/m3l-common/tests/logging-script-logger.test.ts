/**
 * `internal/logging/buildScriptLogger` — the extracted default-logger policy
 * (U7 PR1).
 *
 * ADR-0072 slice split: this file owns `buildScriptLogger` and nothing else.
 * It follows the convention `logging.test.ts` already established for an
 * `internal/` helper — a direct relative import, since `internal/` is private
 * API and reaches no barrel — but lives in its own file so `logging.test.ts`
 * stays at its frozen `check:file-budget` baseline.
 *
 * The policy under test is the one `M3LScript`'s constructor applied inline
 * until U7 extracted it: one {@link M3LConsoleLoggerHandler}, `minLevel` from
 * the ambient `resolveLogLevelFloor()` chain, `secrets` from the script's own
 * derived specifier — each conditionally spread, never passed as an explicit
 * `undefined` (`exactOptionalPropertyTypes`).
 *
 * `script.test.ts`'s constructor-level coverage of the same policy is
 * deliberately KEPT rather than moved: this file proves the helper, that one
 * proves the wiring still reaches it. Deleting either leaves half the claim
 * unasserted.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { M3LLogger } from "../src/core/logging/index.js";
import type { M3LSecretNamesPort } from "../src/core/logging/index.js";
import { buildScriptLogger } from "../src/internal/logging/buildScriptLogger.js";

// `isTTY` is absent (not merely `false`) on a non-TTY CI stream, and
// `M3LConsoleLoggerHandler` reads it to decide whether to emit ANSI. Pinning
// it to `false` keeps the rendered text this file asserts on deterministic.
beforeAll(() => {
  for (const stream of [process.stdout, process.stderr]) {
    if (!Object.prototype.hasOwnProperty.call(stream, "isTTY")) {
      Object.defineProperty(stream, "isTTY", {
        value: false,
        configurable: true,
        writable: true,
      });
    }
  }
});

const originalArgv = process.argv;

/** Replaces `process.argv.slice(2)` — the ambient tier the helper reads. */
function stubArgv(...args: string[]): void {
  process.argv = [
    originalArgv[0] ?? "node",
    originalArgv[1] ?? "script",
    ...args,
  ];
}

beforeEach(() => {
  stubArgv();
  // A developer machine may genuinely export these; clearing them per test
  // makes "no floor" mean no floor rather than "whatever the shell had".
  vi.stubEnv("M3L_LOG_LEVEL", undefined);
  vi.stubEnv("M3L_DEBUG", undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The handler wiring
// ---------------------------------------------------------------------------

describe("buildScriptLogger — the console handler", () => {
  test("returns an M3LLogger wired to a console handler (info reaches stdout)", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const logger = buildScriptLogger(undefined);
    expect(logger).toBeInstanceOf(M3LLogger);
    logger.info("an info line");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  test("routes error events to stderr, matching M3LConsoleLoggerHandler's own split", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    buildScriptLogger(undefined).error("an error line");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test("builds a fresh logger on every call", () => {
    expect(buildScriptLogger(undefined)).not.toBe(buildScriptLogger(undefined));
  });
});

// ---------------------------------------------------------------------------
// The ambient log-level floor
// ---------------------------------------------------------------------------

describe("buildScriptLogger — the resolved log-level floor", () => {
  test("with no floor set, an info event is admitted (the additive no-floor default)", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    buildScriptLogger(undefined).info("admitted with no floor configured");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  test("M3L_LOG_LEVEL=error drops an info event and admits an error event", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "error");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const logger = buildScriptLogger(undefined);
    logger.info("dropped by the error floor");
    expect(stdoutSpy).not.toHaveBeenCalled();

    logger.error("admitted by the error floor");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  // Both tiers are genuinely set in this test's own setup, so the env arm is
  // reachable and loses on purpose — the ordering claim is not a tautology.
  test("a --log-level flag in process.argv wins over a set M3L_LOG_LEVEL", () => {
    stubArgv("--log-level=info");
    vi.stubEnv("M3L_LOG_LEVEL", "error");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    buildScriptLogger(undefined).info("admitted only under the CLI floor");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  test("an out-of-vocabulary M3L_LOG_LEVEL throws M3LError coded ERR_INVALID_ARGUMENT", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "verbose");

    let thrown: unknown;
    try {
      buildScriptLogger(undefined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });
});

// ---------------------------------------------------------------------------
// The secrets port — asserted differentially
// ---------------------------------------------------------------------------

describe("buildScriptLogger — the derived secrets port", () => {
  const secrets: M3LSecretNamesPort = {
    isSecret: (name: string) => name === "tenantRef",
  };

  // The secret rides the MESSAGE, not the `data` bag. `M3LConsoleLoggerHandler`
  // renders `event.message` alone and never serializes `event.data`, so a
  // payload-borne value cannot reach the stream under ANY implementation —
  // asserting on it would pass vacuously whether or not the port was attached.
  // `redactSensitiveLogText` runs the same declared-names port over a bare
  // `key=value` pair in the message, so these arms exercise the identical seam
  // through the one channel this handler actually writes.
  //
  // The `undefined` arm proves the declared-but-unheuristic key genuinely
  // leaks without a specifier, so the redacted arm below cannot be passing by
  // way of the built-in key-name heuristic.
  test("with no secrets port, a declared-but-unheuristic key survives unredacted", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    buildScriptLogger(undefined).info("resolved tenantRef=secret-value");

    const output = stdoutSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(output).toContain("secret-value");
  });

  test("with a secrets port, the same key is redacted in the rendered output", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    buildScriptLogger(secrets).info("resolved tenantRef=secret-value");

    const output = stdoutSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(output).not.toContain("secret-value");
    expect(output).toContain("[REDACTED]");
  });

  test("the floor and the secrets port compose — a redacted error event still passes an error floor", () => {
    vi.stubEnv("M3L_LOG_LEVEL", "error");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    buildScriptLogger(secrets).error("failed tenantRef=secret-value");

    const output = stderrSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(output).not.toContain("secret-value");
    expect(output).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("buildScriptLogger — type-level contract", () => {
  test("the signature is pinned to (secrets | undefined) => M3LLogger", () => {
    expectTypeOf(buildScriptLogger).returns.toEqualTypeOf<M3LLogger>();
    expectTypeOf(buildScriptLogger)
      .parameter(0)
      .toEqualTypeOf<M3LSecretNamesPort | undefined>();
  });
});
