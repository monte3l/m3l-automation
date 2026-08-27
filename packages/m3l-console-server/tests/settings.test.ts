/**
 * Tests for src/config/settings.ts — the coercion-wrapping and non-`M3LError`
 * rethrow machinery `populateConfig`/`wrapConfigRead` provide underneath
 * `loadConsoleConfig` (m3l-console-server X2a contract).
 *
 * `settings.ts` has no composition site of its own today — `loadConsoleConfig`
 * (src/config/env.ts) is the only caller — so every case here still drives
 * `loadConsoleConfig`, not `populateConfig`/`wrapConfigRead` directly. This
 * file covers only the two cross-cutting guarantees the machinery itself
 * provides (a coercion failure's raw value never leaks into the wrapped
 * error, and a non-`M3LError` escaping the accessor propagates unrelabelled);
 * every individual setting's own validation stays in `tests/env.test.ts`.
 *
 * Split out of `env.test.ts` (ADR-0072) alongside the equivalent
 * `handler.test.ts` → `access-log.test.ts` split, both prompted by
 * `handler.test.ts` sitting near this package's test-file size ceiling.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { loadConsoleConfig } from "../src/config/env.js";

/** Dotted config key the port setting is stored under (mirrors `src/config/env.ts`). */
const PORT_KEY = "m3l.console.port";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds a minimal valid env, then applies `overrides` on top. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    ...overrides,
  };
}

describe("loadConsoleConfig — coercion failure surfaces as M3LConsoleError", () => {
  test("a non-integer port raw value never propagates the raw value in the error", () => {
    let thrown: unknown;
    try {
      loadConsoleConfig({
        env: buildEnv({ M3L_CONSOLE_PORT: "super-secret-not-a-port" }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const consoleError = thrown as M3LConsoleError;
    const message = consoleError.message;
    const contextJson = JSON.stringify(consoleError.context);
    expect(message).not.toContain("super-secret-not-a-port");
    expect(contextJson).not.toContain("super-secret-not-a-port");

    // The original coercion failure must still be reachable via `cause` —
    // the raw value is redacted from the message/context, never dropped.
    expect(consoleError.cause).toBeInstanceOf(Core.M3LConfigCoercionError);
    expect(consoleError.context).toMatchObject({ key: PORT_KEY });
  });
});

describe("loadConsoleConfig — wrapConfigRead rethrows a non-M3LError untouched", () => {
  test("a non-M3LError escaping the accessor read propagates unrelabelled, not as M3LConsoleError", () => {
    vi.spyOn(Core.M3LConfigAccessor.prototype, "oneOf").mockImplementation(
      () => {
        throw new RangeError("not an M3LError - simulates a module defect");
      },
    );

    expect(() => loadConsoleConfig({ env: buildEnv() })).toThrow(RangeError);

    let thrown: unknown;
    try {
      loadConsoleConfig({ env: buildEnv() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RangeError);
    expect(thrown).not.toBeInstanceOf(M3LConsoleError);
  });
});
