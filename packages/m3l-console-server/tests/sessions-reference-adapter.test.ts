/**
 * Tests for `src/sessions/reference.ts`'s own adapter behavior — the private
 * `rethrowAsConsoleError` branch that distinguishes a caught
 * `Core.M3LStepReferenceError` (wrap as `M3LConsoleError`,
 * `ERR_CONSOLE_SESSION_REFERENCE_INVALID`) from any other thrown value
 * (rethrow untouched, by identity).
 *
 * `sessions-reference.test.ts` and
 * `packages/m3l-common/tests/orchestration.test.ts` already cover the
 * underlying step-reference grammar and reach the WRAP branch through real
 * malformed input — this file adds the PASSTHROUGH branch, which real
 * inputs cannot reach because the only errors the real
 * `Core.parseStepReference`/`Core.formatStepReference`/
 * `Core.resolveStepReference` ever throw are `Core.M3LStepReferenceError`.
 * To exercise PASSTHROUGH, the underlying `Core` functions are forced to
 * throw something else via a scoped partial mock.
 *
 * This file is intentionally separate from, and does not modify,
 * `sessions-reference.test.ts` / `sessions-binding.test.ts` — those stay
 * byte-unchanged as evidence that promoting the grammar into
 * `Core.orchestration` preserved behavior.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import type * as M3LCommonModule from "@m3l-automation/m3l-common";

// Partial mock: only the three step-reference functions become `vi.fn()`s
// (each defaulting to the REAL implementation, so unmocked calls behave
// exactly as before); everything else on `Core` — including the real
// `M3LError`/`M3LStepReferenceError` classes used for `instanceof` checks —
// passes through untouched. Scoped this narrowly so it cannot bleed into
// any other collaborator this suite or the module under test reaches.
vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommonModule>();
  return {
    ...actual,
    Core: {
      ...actual.Core,
      parseStepReference: vi.fn(actual.Core.parseStepReference),
      formatStepReference: vi.fn(actual.Core.formatStepReference),
      resolveStepReference: vi.fn(actual.Core.resolveStepReference),
    },
  };
});

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  formatStepReference,
  parseStepReference,
  resolveStepReference,
} from "../src/sessions/reference.js";
import type { M3LStepReference } from "../src/sessions/reference.js";

afterEach(() => {
  // vi.fn(impl) restores to `impl` (the real function) on mockReset — see
  // @vitest/spy's MockInstance#mockReset docs — so this both clears call
  // history/one-off throw implementations AND undoes the leak `vi.mock`'s
  // module-scoped `vi.fn()`s would otherwise cause across tests in this
  // file (mockReset does not merely restoreAllMocks-style no-op here,
  // because these are plain `vi.fn()`s created inside the mock factory,
  // not `vi.spyOn` spies).
  vi.mocked(Core.parseStepReference).mockReset();
  vi.mocked(Core.formatStepReference).mockReset();
  vi.mocked(Core.resolveStepReference).mockReset();
});

/**
 * Values a hostile/foreign collaborator could throw that are NOT
 * `Core.M3LStepReferenceError`. The adapter must rethrow every one of these
 * by identity — never wrapped, never reclassified — proving the branch keys
 * on the error's concrete TYPE, not merely on "is some kind of Error" or
 * "is some kind of M3LError".
 */
const PASSTHROUGH_PROBES: [string, unknown][] = [
  ["a plain TypeError", new TypeError("not a step reference at all")],
  [
    "a foreign Core.M3LError with a different code",
    new Core.M3LError("unrelated failure", { code: "ERR_UNRELATED" }),
  ],
  ["a non-Error string value", "boom"],
  ["a non-Error plain object value", { weird: true }],
];

describe("parseStepReference — adapter's rethrowAsConsoleError branch", () => {
  test("WRAP: a real malformed input's M3LStepReferenceError is wrapped as M3LConsoleError with the cause chained", () => {
    let thrown: unknown;
    try {
      parseStepReference("not-a-reference");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const consoleError = thrown as M3LConsoleError;
    expect(consoleError.code).toBe("ERR_CONSOLE_SESSION_REFERENCE_INVALID");
    expect(consoleError.cause).toBeInstanceOf(Core.M3LStepReferenceError);
  });

  test.each(PASSTHROUGH_PROBES)(
    "PASSTHROUGH: rethrows %s by identity, not wrapped or reclassified",
    (_description, sentinel) => {
      vi.mocked(Core.parseStepReference).mockImplementationOnce(() => {
        throw sentinel;
      });

      let caught: unknown;
      try {
        parseStepReference("step-1.output");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(sentinel);
    },
  );

  test("happy path: returns the same value Core.parseStepReference resolves for valid input", () => {
    const reference = parseStepReference("step-3.output.messages");

    expect(reference).toEqual({
      ordinal: 3,
      segments: [{ kind: "property", name: "messages" }],
    });
  });
});

describe("formatStepReference — adapter's rethrowAsConsoleError branch", () => {
  test("WRAP: a real malformed M3LStepReference's M3LStepReferenceError is wrapped as M3LConsoleError with the cause chained", () => {
    const malformed: M3LStepReference = { ordinal: 0, segments: [] };

    let thrown: unknown;
    try {
      formatStepReference(malformed);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const consoleError = thrown as M3LConsoleError;
    expect(consoleError.code).toBe("ERR_CONSOLE_SESSION_REFERENCE_INVALID");
    expect(consoleError.cause).toBeInstanceOf(Core.M3LStepReferenceError);
  });

  test.each(PASSTHROUGH_PROBES)(
    "PASSTHROUGH: rethrows %s by identity, not wrapped or reclassified",
    (_description, sentinel) => {
      vi.mocked(Core.formatStepReference).mockImplementationOnce(() => {
        throw sentinel;
      });

      const validReference: M3LStepReference = { ordinal: 1, segments: [] };
      let caught: unknown;
      try {
        formatStepReference(validReference);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(sentinel);
    },
  );

  test("happy path: returns the same value Core.formatStepReference resolves for valid input", () => {
    const reference: M3LStepReference = {
      ordinal: 3,
      segments: [{ kind: "property", name: "messages" }],
    };

    expect(formatStepReference(reference)).toBe("step-3.output.messages");
  });
});

describe("resolveStepReference — adapter's rethrowAsConsoleError branch", () => {
  test("WRAP: a real forbidden-segment walk's M3LStepReferenceError is wrapped as M3LConsoleError with the cause chained", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [{ kind: "property", name: "__proto__" }],
    };
    const source = { safe: "value" };

    let thrown: unknown;
    try {
      resolveStepReference(reference, source);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const consoleError = thrown as M3LConsoleError;
    expect(consoleError.code).toBe("ERR_CONSOLE_SESSION_REFERENCE_INVALID");
    expect(consoleError.cause).toBeInstanceOf(Core.M3LStepReferenceError);
  });

  test.each(PASSTHROUGH_PROBES)(
    "PASSTHROUGH: rethrows %s by identity, not wrapped or reclassified",
    (_description, sentinel) => {
      vi.mocked(Core.resolveStepReference).mockImplementationOnce(() => {
        throw sentinel;
      });

      const reference: M3LStepReference = { ordinal: 1, segments: [] };
      let caught: unknown;
      try {
        resolveStepReference(reference, { anything: true });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(sentinel);
    },
  );

  test("happy path: returns the same value Core.resolveStepReference resolves for valid input", () => {
    const reference: M3LStepReference = {
      ordinal: 1,
      segments: [{ kind: "property", name: "userId" }],
    };
    const source = { userId: "abc-123" };

    expect(resolveStepReference(reference, source)).toBe("abc-123");
  });
});
