import { readFileSync } from "node:fs";
import type * as NodeFS from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { M3L_ERROR_CODES, M3LError } from "../src/core/errors/index.js";
import type { M3LErrorCode } from "../src/core/errors/index.js";
import {
  classifyErrorCode,
  isM3LErrorCode,
  M3L_ERROR_CATALOG,
} from "../src/core/errors/catalog.js";
import type {
  M3LErrorClassification,
  M3LErrorOrigin,
  M3LErrorRetryable,
} from "../src/core/errors/catalog.js";
import {
  isM3LErrorOrigin,
  mapErrorToExitCode,
  M3L_EXIT_CODES,
} from "../src/core/diagnostics/exit-codes.js";
import type {
  M3LErrorExitCode,
  M3LExitCode,
} from "../src/core/diagnostics/exit-codes.js";
import type { M3LBreadcrumbScalar } from "../src/core/diagnostics/breadcrumbs.js";
import {
  formatErrorChain,
  scrubUrlsInText,
  serializeErrorChain,
} from "../src/core/diagnostics/format-error.js";
import type {
  M3LFormatErrorChainOptions,
  M3LSerializedError,
} from "../src/core/diagnostics/format-error.js";
import { redactSensitiveLogText } from "../src/core/logging/redact.js";
import { serializeError } from "../src/core/script/process-guards.js";
import { readPackageVersion } from "../src/internal/diagnostics/packageVersion.js";

// ---------------------------------------------------------------------------
// core/errors/catalog.ts
// ---------------------------------------------------------------------------
describe("M3L_ERROR_CATALOG", () => {
  test("has exactly one entry per M3L_ERROR_CODES member (no drift either direction)", () => {
    const declared = new Set<string>(M3L_ERROR_CODES);
    const catalogKeys = new Set<string>(Object.keys(M3L_ERROR_CATALOG));

    const missingFromCatalog = [...declared].filter(
      (code) => !catalogKeys.has(code),
    );
    const staleInCatalog = [...catalogKeys].filter(
      (code) => !declared.has(code),
    );

    expect({ missingFromCatalog, staleInCatalog }).toEqual({
      missingFromCatalog: [],
      staleInCatalog: [],
    });
    expect(Object.keys(M3L_ERROR_CATALOG)).toHaveLength(M3L_ERROR_CODES.length);
  });

  test.each([
    ["ERR_CONFIG_MISSING", { origin: "caller", retryable: false }],
    ["ERR_S3_OPERATION", { origin: "external", retryable: true }],
    [
      "ERR_ATHENA_QUERY_FAILED",
      { origin: "external", retryable: "situational" },
    ],
    ["WRAPPED_ERROR", { origin: "external", retryable: "situational" }],
    ["RESULT_UNWRAP_ON_ERR", { origin: "caller", retryable: false }],
  ] as const)(
    "classifies %s as %o",
    (code, expected: M3LErrorClassification) => {
      expect(M3L_ERROR_CATALOG[code]).toEqual(expected);
    },
  );

  test("no catalog entry has origin 'library'", () => {
    const values: readonly M3LErrorClassification[] =
      Object.values(M3L_ERROR_CATALOG);
    const libraryEntries = values.filter((entry) => entry.origin === "library");
    expect(libraryEntries).toHaveLength(0);
  });

  test("every caller-origin entry is never retryable", () => {
    const entries: ReadonlyArray<[string, M3LErrorClassification]> =
      Object.entries(M3L_ERROR_CATALOG);
    const violations = entries.filter(
      ([, entry]) => entry.origin === "caller" && entry.retryable !== false,
    );
    expect(violations).toEqual([]);
  });
});

describe("classifyErrorCode()", () => {
  test("returns the classification for a known code", () => {
    expect(classifyErrorCode("ERR_CONFIG_MISSING")).toEqual({
      origin: "caller",
      retryable: false,
    });
  });

  test("returns undefined for an unknown code", () => {
    expect(classifyErrorCode("ERR_TOTALLY_MADE_UP")).toBeUndefined();
  });

  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "prototype-pollution guard: %s returns undefined, not an inherited value",
    (code) => {
      expect(classifyErrorCode(code)).toBeUndefined();
    },
  );

  test("never throws for an empty string", () => {
    expect(() => classifyErrorCode("")).not.toThrow();
    expect(classifyErrorCode("")).toBeUndefined();
  });
});

describe("M3LErrorClassification type", () => {
  test("shape is origin + retryable", () => {
    expectTypeOf<M3LErrorClassification>().toEqualTypeOf<{
      readonly origin: "caller" | "library" | "external";
      readonly retryable: boolean | "situational";
    }>();
  });

  test("catalog is keyed by the full M3LErrorCode union", () => {
    // Assigned through an explicit annotation (not a cast) so the type-level
    // assertion below checks the *declared* catalog shape rather than
    // whatever TypeScript happens to infer for the still-unresolved import.
    const catalog: Readonly<Record<M3LErrorCode, M3LErrorClassification>> =
      M3L_ERROR_CATALOG;
    expect(catalog).toBe(M3L_ERROR_CATALOG);
    expectTypeOf<keyof typeof catalog>().toEqualTypeOf<M3LErrorCode>();
  });
});

// ---------------------------------------------------------------------------
// core/diagnostics/exit-codes.ts
// ---------------------------------------------------------------------------
describe("M3L_EXIT_CODES", () => {
  test("has the six documented numeric values", () => {
    expect(M3L_EXIT_CODES).toEqual({
      SUCCESS: 0,
      UNCLASSIFIED: 1,
      CONFIG_USAGE: 2,
      EXTERNAL: 3,
      LIBRARY: 4,
      INTERRUPTED: 5,
    });
  });

  test("M3LExitCode is the numeric union of its values", () => {
    expectTypeOf<M3LExitCode>().toEqualTypeOf<0 | 1 | 2 | 3 | 4 | 5>();
  });
});

describe("M3LErrorExitCode", () => {
  test("is exactly the 1|2|3|4 subset — never 0 (SUCCESS) or 5 (INTERRUPTED)", () => {
    expectTypeOf<M3LErrorExitCode>().toEqualTypeOf<1 | 2 | 3 | 4>();
  });

  test("mapErrorToExitCode()'s return type is M3LErrorExitCode, not the wider `number`", () => {
    expectTypeOf(mapErrorToExitCode).returns.toEqualTypeOf<M3LErrorExitCode>();
    expectTypeOf(mapErrorToExitCode).returns.not.toEqualTypeOf<number>();
  });
});

describe("isM3LErrorOrigin()", () => {
  test.each(["caller", "external", "library"])(
    "returns true for the known origin %s",
    (origin) => {
      expect(isM3LErrorOrigin(origin)).toBe(true);
    },
  );

  test.each(["some-future-origin", "", "CALLER", null, undefined, 42, {}])(
    "returns false for the non-origin value %o",
    (value) => {
      expect(isM3LErrorOrigin(value)).toBe(false);
    },
  );

  test("narrows to M3LErrorOrigin when true", () => {
    const value: unknown = "external";
    if (isM3LErrorOrigin(value)) {
      expectTypeOf(value).toEqualTypeOf<"caller" | "library" | "external">();
    }
  });
});

describe("isM3LErrorCode()", () => {
  test("returns true for a known built-in code", () => {
    expect(isM3LErrorCode("ERR_S3_OPERATION")).toBe(true);
  });

  test("returns false for an unknown code string", () => {
    expect(isM3LErrorCode("ERR_TOTALLY_MADE_UP")).toBe(false);
  });

  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "prototype-pollution guard: %s returns false, not an inherited value",
    (code) => {
      expect(isM3LErrorCode(code)).toBe(false);
    },
  );

  test("never throws for an empty string", () => {
    expect(() => isM3LErrorCode("")).not.toThrow();
    expect(isM3LErrorCode("")).toBe(false);
  });

  test("narrows to M3LErrorCode when true", () => {
    const code = "ERR_S3_OPERATION" as string;
    if (isM3LErrorCode(code)) {
      expectTypeOf(code).toEqualTypeOf<M3LErrorCode>();
    }
  });
});

describe("M3LBreadcrumbScalar", () => {
  test("is exactly string | number | boolean | null", () => {
    expectTypeOf<M3LBreadcrumbScalar>().toEqualTypeOf<
      string | number | boolean | null
    >();
  });
});

describe("mapErrorToExitCode()", () => {
  const processExitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);

  afterEach(() => {
    processExitSpy.mockClear();
  });

  test.each([null, undefined, "boom", 42, [], {}])(
    "returns UNCLASSIFIED (1) for %o",
    (value) => {
      expect(mapErrorToExitCode(value)).toBe(1);
    },
  );

  test("returns UNCLASSIFIED (1) for a Symbol", () => {
    expect(mapErrorToExitCode(Symbol("s"))).toBe(1);
  });

  test("returns UNCLASSIFIED (1) for a circular object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(mapErrorToExitCode(circular)).toBe(1);
  });

  test("does not throw and returns 1 for an object with a hostile `origin` getter", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "origin", {
      get(): never {
        throw new Error("nope");
      },
    });
    expect(() => mapErrorToExitCode(hostile)).not.toThrow();
    expect(mapErrorToExitCode(hostile)).toBe(1);
  });

  test("does not throw and returns 1 for an object with a hostile `code` getter", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "code", {
      get(): never {
        throw new Error("nope");
      },
    });
    expect(() => mapErrorToExitCode(hostile)).not.toThrow();
    expect(mapErrorToExitCode(hostile)).toBe(1);
  });

  test.each([
    [{ origin: "caller" }, 2],
    [{ origin: "external" }, 3],
    [{ origin: "library" }, 4],
  ] as const)("structural origin %o maps to exit code %d", (value, code) => {
    expect(mapErrorToExitCode(value)).toBe(code);
  });

  test("origin wins over code when both are present", () => {
    expect(
      mapErrorToExitCode({ origin: "caller", code: "ERR_S3_OPERATION" }),
    ).toBe(2);
  });

  test.each(["CALLER", "", 7, null])(
    "an ill-typed origin (%o) falls through to the code branch, then to 1",
    (origin) => {
      expect(mapErrorToExitCode({ origin })).toBe(1);
    },
  );

  test("classifies a real M3LError with a caller-origin code as CONFIG_USAGE (2)", () => {
    const error = new M3LError("missing config", {
      code: "ERR_CONFIG_MISSING",
    });
    expect(mapErrorToExitCode(error)).toBe(2);
  });

  test("classifies a real M3LError with an external-origin code as EXTERNAL (3)", () => {
    const error = new M3LError("s3 failed", { code: "ERR_S3_OPERATION" });
    expect(mapErrorToExitCode(error)).toBe(3);
  });

  test("classifies a real M3LError with ERR_PROMPT_VALIDATION as CONFIG_USAGE (2)", () => {
    const error = new M3LError("bad prompt", {
      code: "ERR_PROMPT_VALIDATION",
    });
    expect(mapErrorToExitCode(error)).toBe(2);
  });

  test("returns 1 for an unknown code string", () => {
    expect(mapErrorToExitCode({ code: "ERR_NOT_IN_CATALOG" })).toBe(1);
  });

  test.each([42, {}])(
    "returns 1 for a non-string code (%o)",
    (code: unknown) => {
      expect(mapErrorToExitCode({ code })).toBe(1);
    },
  );

  test("returns 1 for a code that collides with a prototype method name", () => {
    expect(mapErrorToExitCode({ code: "toString" })).toBe(1);
  });

  test("never returns 0 (SUCCESS) for any input", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      "x",
      {},
      { origin: "caller" },
      { origin: "external" },
      { origin: "library" },
      new M3LError("e", { code: "ERR_S3_OPERATION" }),
    ];
    for (const input of inputs) {
      expect(mapErrorToExitCode(input)).not.toBe(0);
    }
  });

  test("never returns 5 (INTERRUPTED) for any input", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      "x",
      {},
      { origin: "caller" },
      { origin: "external" },
      { origin: "library" },
      new M3LError("e", { code: "ERR_S3_OPERATION" }),
    ];
    for (const input of inputs) {
      expect(mapErrorToExitCode(input)).not.toBe(5);
    }
  });

  test("an explicit M3LError.origin beats the catalog classification for its code (disagreement case)", () => {
    // Both branches would agree and produce the same code for a
    // well-classified error, which cannot prove the first resolution step
    // (structural `origin`) is actually live rather than dead code. This is
    // deliberately a *disagreement*: ERR_HTTP_REQUEST's catalog origin is
    // "external" (exit code 3), but an explicit `origin: "caller"` option on
    // the M3LError instance must win, producing 2.
    const error = new M3LError("classification override", {
      code: "ERR_HTTP_REQUEST",
      origin: "caller",
    });
    expect(mapErrorToExitCode(error)).toBe(2);
  });

  test("never calls process.exit()", () => {
    mapErrorToExitCode(new M3LError("e", { code: "ERR_S3_OPERATION" }));
    mapErrorToExitCode(null);
    mapErrorToExitCode({ origin: "caller" });
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// core/diagnostics/format-error.ts
// ---------------------------------------------------------------------------
describe("formatErrorChain()", () => {
  test("renders a single-level Error with name and message, no caused-by marker", () => {
    const output = formatErrorChain(new Error("boom"));
    expect(output).toContain("Error");
    expect(output).toContain("boom");
    expect(output).not.toContain("caused by");
  });

  test("renders a chained cause A -> B -> C root-first with two caused-by markers", () => {
    const rootCause = new Error("root cause");
    const middle = new Error("middle failure", { cause: rootCause });
    const top = new Error("top failure", { cause: middle });

    const output = formatErrorChain(top);

    const causedByCount = output.split("caused by").length - 1;
    expect(causedByCount).toBe(2);

    const topIndex = output.indexOf("top failure");
    const middleIndex = output.indexOf("middle failure");
    const rootIndex = output.indexOf("root cause");
    expect(topIndex).toBeGreaterThanOrEqual(0);
    expect(middleIndex).toBeGreaterThan(topIndex);
    expect(rootIndex).toBeGreaterThan(middleIndex);
  });

  test("renders the code for an M3LError level", () => {
    const output = formatErrorChain(
      new M3LError("bad config", { code: "ERR_CONFIG_MISSING" }),
    );
    expect(output).toContain("ERR_CONFIG_MISSING");
  });

  test("omits a code for a level without one", () => {
    const output = formatErrorChain(new Error("plain"));
    expect(output).not.toMatch(/ERR_[A-Z_]+/);
  });

  test("stacks:false omits stack frames", () => {
    const error = new Error("with stack");
    const output = formatErrorChain(error, { stacks: false });
    expect(output).not.toContain("at ");
  });

  test("default (stacks omitted from options) includes stack frames", () => {
    const error = new Error("with stack");
    const output = formatErrorChain(error);
    if (error.stack !== undefined) {
      const firstFrame = error.stack.split("\n")[1];
      if (firstFrame !== undefined) {
        expect(output).toContain(firstFrame.trim());
      }
    }
  });

  test.each([
    ["boom", "Error", "boom"],
    [42, "Error", "42"],
    [{ a: 1 }, "Error", "[object Object]"],
  ])(
    "a non-Error cause (%o) is normalized via toError before rendering",
    (cause, expectedName, expectedMessage) => {
      const top = new Error("top", { cause });
      const output = formatErrorChain(top);
      expect(output).toContain(expectedName);
      expect(output).toContain(expectedMessage);
    },
  );

  test("cause: undefined terminates the walk with a single level", () => {
    const top = new Error("top", { cause: undefined });
    const output = formatErrorChain(top);
    expect(output).not.toContain("caused by");
  });

  test("cause: null terminates the walk with a single level", () => {
    const top = new Error("top");
    Object.defineProperty(top, "cause", { value: null, enumerable: true });
    const output = formatErrorChain(top);
    expect(output).not.toContain("caused by");
  });

  test("a mutual cause cycle terminates, emits [circular], and stays finite (<= 32 levels)", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    const output = formatErrorChain(a);
    expect(output).toContain("[circular]");

    const levels = serializeErrorChain(a);
    expect(levels.length).toBeLessThanOrEqual(32);
  });

  test("a self-referential cause terminates at one level plus [circular]", () => {
    const self = new Error("self");
    (self as { cause?: unknown }).cause = self;

    const output = formatErrorChain(self);
    expect(output).toContain("[circular]");

    const levels = serializeErrorChain(self);
    expect(levels).toHaveLength(1);
  });

  test("a 100-deep cause chain is capped at exactly 32 levels plus the max-depth marker", () => {
    let current = new Error("level-0");
    for (let index = 1; index < 100; index += 1) {
      current = new Error(`level-${index}`, { cause: current });
    }

    const output = formatErrorChain(current);
    expect(output).toContain("[max cause depth reached]");

    const levels = serializeErrorChain(current);
    expect(levels).toHaveLength(32);
  });

  test("redacts a sensitive message by default", () => {
    const secret = "authorization: Bearer abc123";
    // Sanity check the real redactor actually masks this literal before
    // asserting formatErrorChain relies on it.
    expect(redactSensitiveLogText(secret)).not.toContain("abc123");

    const output = formatErrorChain(new Error(secret));
    expect(output).not.toContain("abc123");
  });

  test("redact:false renders the sensitive message verbatim", () => {
    const secret = "authorization: Bearer abc123";
    const output = formatErrorChain(new Error(secret), { redact: false });
    expect(output).toContain("abc123");
  });

  test.each([null, undefined])("never throws for %o", (value) => {
    expect(() => formatErrorChain(value)).not.toThrow();
  });

  test("never throws for a hostile `cause` getter", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "cause", {
      get(): never {
        throw new Error("nope");
      },
    });
    expect(() => formatErrorChain(hostile)).not.toThrow();
  });

  test("never throws for a hostile `stack` getter", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "stack", {
      get(): never {
        throw new Error("nope");
      },
    });
    expect(() => formatErrorChain(hostile)).not.toThrow();
  });

  test("never throws for a frozen error object", () => {
    const frozen = Object.freeze(new Error("frozen"));
    expect(() => formatErrorChain(frozen)).not.toThrow();
  });

  test("a value whose own coercion throws (hostile toString) is caught by safeToError, not the outer handler", () => {
    const hostile = {
      toString(): string {
        throw new Error("cannot stringify");
      },
    };
    const output = formatErrorChain(hostile);
    expect(output).toContain("[unrepresentable error value]");
  });

  test("a non-string `.stack` is treated the same as a missing stack", () => {
    const error = new Error("with weird stack");
    Object.defineProperty(error, "stack", { value: 42, enumerable: true });
    const output = formatErrorChain(error);
    expect(output).not.toContain("42");
  });

  test("a stack containing only the header line (no frames) omits the frame block", () => {
    const error = new Error("no frames");
    Object.defineProperty(error, "stack", {
      value: "Error: no frames",
      enumerable: true,
    });
    const output = formatErrorChain(error);
    expect(output).toBe("Error: no frames");
  });
});

describe("serializeErrorChain()", () => {
  test("mirrors formatErrorChain's walk: same level count and order", () => {
    const rootCause = new Error("root cause");
    const middle = new Error("middle failure", { cause: rootCause });
    const top = new Error("top failure", { cause: middle });

    const levels = serializeErrorChain(top);
    expect(levels).toHaveLength(3);
    expect(levels[0]?.message).toBe("top failure");
    expect(levels[1]?.message).toBe("middle failure");
    expect(levels[2]?.message).toBe("root cause");
  });

  test("includes the code for an M3LError level, omits it otherwise", () => {
    const inner = new Error("plain inner");
    const outer = new M3LError("outer", {
      code: "ERR_CONFIG_MISSING",
      cause: inner,
    });

    const levels = serializeErrorChain(outer);
    expect(levels[0]?.code).toBe("ERR_CONFIG_MISSING");
    expect(levels[1]?.code).toBeUndefined();
  });

  test("carries origin/retryable for an M3LError level (ADR-0035 phase 2)", () => {
    const error = new M3LError("s3 op failed", { code: "ERR_S3_OPERATION" });
    const [level] = serializeErrorChain(error);
    expect(level?.origin).toBe("external");
    expect(level?.retryable).toBe(true);
  });

  test("a plain Error level has NO origin/retryable keys at all — not present-and-undefined", () => {
    const [level] = serializeErrorChain(new Error("plain failure"));
    // toBeUndefined() cannot distinguish an absent key from a
    // present-but-undefined one; a present-and-undefined key would change
    // the persisted JSON shape, which is a real defect.
    expect(level).not.toHaveProperty("origin");
    expect(level).not.toHaveProperty("retryable");
  });

  test("redacts sensitive messages by default; redact:false renders verbatim", () => {
    const secret = "authorization: Bearer abc123";
    const redactedLevels = serializeErrorChain(new Error(secret));
    expect(redactedLevels[0]?.message).not.toContain("abc123");

    const verbatimLevels = serializeErrorChain(new Error(secret), {
      redact: false,
    });
    expect(verbatimLevels[0]?.message).toContain("abc123");
  });

  test("never throws for null or undefined", () => {
    expect(() => serializeErrorChain(null)).not.toThrow();
    expect(() => serializeErrorChain(undefined)).not.toThrow();
  });

  test("returns a non-empty array for any input", () => {
    expect(serializeErrorChain(null).length).toBeGreaterThan(0);
    expect(serializeErrorChain("plain string").length).toBeGreaterThan(0);
  });

  test("stacks:false omits the stack field from every level", () => {
    const levels = serializeErrorChain(new Error("no stack wanted"), {
      stacks: false,
    });
    expect(levels[0]?.stack).toBeUndefined();
  });

  test("redact:false renders an M3LError level's context verbatim", () => {
    const error = new M3LError("bad config", {
      code: "ERR_CONFIG_MISSING",
      context: { token: "authorization: Bearer abc123" },
    });

    const redactedLevels = serializeErrorChain(error);
    expect(JSON.stringify(redactedLevels[0]?.context)).not.toContain("abc123");

    const verbatimLevels = serializeErrorChain(error, { redact: false });
    expect(JSON.stringify(verbatimLevels[0]?.context)).toContain("abc123");
  });
});

// =============================================================================
// formatErrorChain / serializeErrorChain — raw URL scrubbing across message,
// stack, and context (security Must-fix): a raw request URL embedding
// userinfo or a presigned-signature query param must never survive into any
// of the three surfaces, even though the name-based redactor doesn't
// recognize a URL-shaped leak by key or literal name.
// =============================================================================
describe("formatErrorChain / serializeErrorChain — raw URL scrubbing (security Must-fix)", () => {
  const RAW =
    "https://svc-user:hunter2SUPERPASS@api.example.com/v1/data?X-Amz-Signature=DEADBEEFSIGSECRET&sig=OTHERSECRET";
  const SCRUBBED = "https://api.example.com/v1/data";
  const SECRETS = ["hunter2SUPERPASS", "DEADBEEFSIGSECRET", "OTHERSECRET"];

  function buildErrorWithRawUrl(): M3LError {
    const error = new M3LError(`request to ${RAW} failed`, {
      code: "ERR_CONFIG_MISSING",
      context: { url: RAW },
    });
    Object.defineProperty(error, "stack", {
      value: `M3LError: request to ${RAW} failed\n    at fetchThing (${RAW}:1:1)`,
      enumerable: true,
    });
    return error;
  }

  test("formatErrorChain scrubs the URL from both the message and the stack frames", () => {
    const output = formatErrorChain(buildErrorWithRawUrl());
    for (const secret of SECRETS) expect(output).not.toContain(secret);
    expect(output).toContain(SCRUBBED);
  });

  test("serializeErrorChain scrubs the URL from message, stack, and context.url", () => {
    const [level] = serializeErrorChain(buildErrorWithRawUrl());
    const serialized = JSON.stringify(level);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(level?.context?.url).toBe(SCRUBBED);
    expect(serialized).toContain(SCRUBBED);
  });
});

describe("scrubUrlsInText()", () => {
  test("reduces an http(s) URL to origin+pathname, dropping userinfo and the query string", () => {
    const result = scrubUrlsInText(
      "request to https://u:p@api.example.com/v1/data?token=x failed",
    );
    expect(result).toBe("request to https://api.example.com/v1/data failed");
  });

  test("a non-http(s) scheme is never matched — left verbatim rather than mangled", () => {
    const text = "see data:text/plain;base64,AAAA for details";
    expect(scrubUrlsInText(text)).toBe(text);
  });

  test("an http(s)-prefixed match that fails to parse as a URL is left verbatim", () => {
    const text = "malformed https://[ url here";
    expect(scrubUrlsInText(text)).toBe(text);
  });
});

// =============================================================================
// scrubUrlsInText() — round-4 security fix regressions (lock-in). Round 3's
// fix only handled CLOSED quote delimiters (`token="secret" rest`); an
// unclosed quote let the URL match consume and drop the `key=` anchor while
// the raw, unterminated value survived outside the match — unrecognizable to
// any anchor-based redactor once the anchor was gone. This is the regression
// guard for that stranded-value defect.
// =============================================================================
describe("scrubUrlsInText() — round-4 (unterminated quote, lock-in)", () => {
  test('an unterminated " quote value is scrubbed, not stranded outside the match', () => {
    const result = scrubUrlsInText('GET https://h/p?token="QSEC failed');
    expect(result).not.toContain("QSEC");
  });

  test("an unterminated ' quote value is scrubbed, not stranded outside the match", () => {
    const result = scrubUrlsInText("GET https://h/p?token='QSEC failed");
    expect(result).not.toContain("QSEC");
  });

  test('a CLOSED quoted query value ("QSEC") still scrubs correctly', () => {
    const result = scrubUrlsInText('GET https://h/p?token="QSEC" ok');
    expect(result).not.toContain("QSEC");
  });

  test("an unquoted query value still scrubs correctly", () => {
    const result = scrubUrlsInText("GET https://h/p?token=QSEC ok");
    expect(result).not.toContain("QSEC");
  });

  test("a bare key= at the very end of the string does not crash", () => {
    expect(() => scrubUrlsInText("https://h/p?token=")).not.toThrow();
  });

  test("a sentence with no URL at all is returned unchanged", () => {
    const text = "this is just a plain sentence with no url in it";
    expect(scrubUrlsInText(text)).toBe(text);
  });

  test("unrelated markup immediately after a query param survives untouched — the angle-bracket branch was removed precisely to avoid mangling it", () => {
    const text = "https://api.example.com/v1?a=<div>keepme</div>";
    expect(scrubUrlsInText(text)).toContain("<div>keepme</div>");
  });
});

describe("M3LFormatErrorChainOptions / M3LSerializedError types", () => {
  test("both stacks and redact default to true (documented as optional booleans)", () => {
    expectTypeOf<M3LFormatErrorChainOptions>().toEqualTypeOf<{
      readonly stacks?: boolean;
      readonly redact?: boolean;
    }>();
  });

  test("M3LSerializedError shape", () => {
    expectTypeOf<M3LSerializedError>().toEqualTypeOf<{
      readonly name: string;
      readonly message: string;
      readonly code?: string;
      readonly stack?: string;
      readonly context?: Record<string, unknown>;
      readonly origin?: M3LErrorOrigin;
      readonly retryable?: M3LErrorRetryable;
    }>();
  });
});

// ---------------------------------------------------------------------------
// Regression guard — core/script/process-guards' serializeError is untouched
// ---------------------------------------------------------------------------
describe("serializeError (regression guard, core/script/process-guards)", () => {
  test("remains exported and functional after the diagnostics module lands", () => {
    expect(typeof serializeError).toBe("function");
    const result = serializeError(new Error("still works"));
    expect(result.message).toBe("still works");
  });
});

// ---------------------------------------------------------------------------
// src/internal/diagnostics/packageVersion.ts
// ---------------------------------------------------------------------------
describe("readPackageVersion()", () => {
  function readDeclaredVersion(): string {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(testDir, "..", "package.json");
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version !== "string") {
      throw new Error("package.json is missing a string version field");
    }
    return parsed.version;
  }

  test("returns the version declared in packages/m3l-common/package.json", () => {
    expect(readPackageVersion()).toBe(readDeclaredVersion());
  });

  test("memoizes across calls — repeated calls return an identical value", () => {
    const first = readPackageVersion();
    const second = readPackageVersion();
    expect(second).toBe(first);
  });

  test("never throws", () => {
    expect(() => readPackageVersion()).not.toThrow();
  });

  test("returns a non-empty string", () => {
    expect(typeof readPackageVersion()).toBe("string");
    expect(readPackageVersion().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// src/internal/diagnostics/packageVersion.ts — computeVersion()'s defensive
// never-throw guards. The module memoizes on first call, so each case below
// forces `vi.resetModules()` and re-imports the module dynamically (a fresh
// module instance, with its own unmemoized `cachedVersion`) after mocking
// `node:fs`'s `readFileSync` for that one case.
// ---------------------------------------------------------------------------
describe("readPackageVersion() — computeVersion()'s defensive branches", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
  });

  test("returns 'unknown' when readFileSync throws (e.g. package.json missing)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof NodeFS>("node:fs");
      return {
        ...actual,
        readFileSync: vi.fn(() => {
          throw new Error("ENOENT: no such file or directory");
        }),
      };
    });

    const mod = await import("../src/internal/diagnostics/packageVersion.js");
    expect(mod.readPackageVersion()).toBe("unknown");
  });

  test("returns 'unknown' when the file contains malformed JSON", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof NodeFS>("node:fs");
      return { ...actual, readFileSync: vi.fn(() => "{ not valid json") };
    });

    const mod = await import("../src/internal/diagnostics/packageVersion.js");
    expect(mod.readPackageVersion()).toBe("unknown");
  });

  test.each([
    ["an array", "[1,2,3]"],
    ["null", "null"],
    ["a bare string", '"just a string"'],
  ])(
    "returns 'unknown' when the parsed JSON is %s, not an object",
    async (_label, json) => {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof NodeFS>("node:fs");
        return { ...actual, readFileSync: vi.fn(() => json) };
      });

      const mod = await import("../src/internal/diagnostics/packageVersion.js");
      expect(mod.readPackageVersion()).toBe("unknown");
    },
  );

  test.each([
    ["missing entirely", JSON.stringify({ name: "m3l-common" })],
    ["not a string", JSON.stringify({ version: 123 })],
    ["an empty string", JSON.stringify({ version: "" })],
  ])("returns 'unknown' when the version field is %s", async (_label, json) => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof NodeFS>("node:fs");
      return { ...actual, readFileSync: vi.fn(() => json) };
    });

    const mod = await import("../src/internal/diagnostics/packageVersion.js");
    expect(mod.readPackageVersion()).toBe("unknown");
  });

  test("still memoizes per module instance even on the 'unknown' fallback path", async () => {
    vi.resetModules();
    const readFileSyncMock = vi.fn(() => "{ not valid json");
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof NodeFS>("node:fs");
      return { ...actual, readFileSync: readFileSyncMock };
    });

    const mod = await import("../src/internal/diagnostics/packageVersion.js");
    expect(mod.readPackageVersion()).toBe("unknown");
    expect(mod.readPackageVersion()).toBe("unknown");
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks();
});
