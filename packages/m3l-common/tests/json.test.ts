/**
 * Tests for core/json submodule.
 *
 * Contract source: docs/reference/core/json.md
 * Exports: parseFieldPath, navigateFieldPath, extractAll,
 *   M3LJSONFieldExtractor, M3LJSONFormatDetector, M3LJSONFormatDetectionError,
 *   M3LJSONFormat, M3LJSONDetectionDepth, M3LJSONDetectorOptions,
 *   M3LJSONDetectionResult, M3LConfidence (11 symbols).
 *
 * Key behavioral contracts:
 *  - parseFieldPath: pure, never throws; splits on '.', drops empty segments;
 *    numeric segments stay strings.
 *  - navigateFieldPath: never throws; undefined is in-band for "missing" and
 *    for a dangerous segment; single-valued; a numeric segment indexes an
 *    array when the current value is an array, and stays an object-key
 *    lookup on a plain object; does NOT expand `*` wildcards; intermediate
 *    primitive/null blocks traversal.
 *  - extractAll: never throws; multi-valued (`readonly unknown[]`); expands
 *    `*` over array elements / own enumerable object values in document
 *    order; a plain (wildcard-free) path yields 0 or 1 element.
 *  - M3LJSONFieldExtractor: thin wrapper over navigateFieldPath (`extract`,
 *    single-value) and extractAll (`extractAll`, multi-value) with a fixed
 *    field path baked in at construction.
 *  - Prototype-pollution guard: navigateFieldPath, extractAll, and
 *    M3LJSONFieldExtractor never traverse `__proto__` / `constructor` /
 *    `prototype`, and wildcards never expand onto those keys.
 *  - M3LJSONFormatDetector.detect(): async; opens the file via bounded
 *    `FileHandle` reads (never loads the whole file); resolves a
 *    { format, confidence, method, details } result; rejects with
 *    M3LJSONFormatDetectionError (an M3LError subclass, chaining a cause)
 *    when the path cannot be opened; default depth is "standard";
 *    "extension" depth never touches the filesystem.
 *  - M3LConfidence: a branded number in [0, 1]; readable off a result but not
 *    publicly constructible.
 */

import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// Make the 'node:fs/promises' module configurable so vi.spyOn can intercept
// individual functions (ESM namespace objects are non-writable by default).
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  return { ...actual };
});

import { M3LError } from "../src/core/errors/index.js";
import {
  extractAll,
  M3LJSONFieldExtractor,
  M3LJSONFormatDetectionError,
  M3LJSONFormatDetector,
  navigateFieldPath,
  parseFieldPath,
} from "../src/core/json/index.js";

import type {
  M3LConfidence,
  M3LJSONDetectionDepth,
  M3LJSONDetectionResult,
  M3LJSONDetectorOptions,
  M3LJSONFormat,
} from "../src/core/json/index.js";

// =============================================================================
// parseFieldPath
// =============================================================================
describe("parseFieldPath()", () => {
  test("splits a two-segment dot path", () => {
    expect(parseFieldPath("metadata.author")).toEqual(["metadata", "author"]);
  });

  test("returns a single-element array for a bare field name", () => {
    expect(parseFieldPath("author")).toEqual(["author"]);
  });

  test("keeps a numeric segment as a string, not coerced to a number", () => {
    const result = parseFieldPath("items.0.name");
    expect(result).toEqual(["items", "0", "name"]);
    expect(typeof result[1]).toBe("string");
  });

  test.each<[string, readonly string[]]>([
    ["", []],
    [".", []],
    ["a..b", ["a", "b"]],
    [".a", ["a"]],
    ["a.", ["a"]],
  ])("degenerate input %j parses to %j", (input, expected) => {
    expect(parseFieldPath(input)).toEqual(expected);
  });

  test("never throws for an arbitrary string", () => {
    expect(() => parseFieldPath("...")).not.toThrow();
    expect(() => parseFieldPath("a.b.c.d.e.f")).not.toThrow();
    expect(() => parseFieldPath("x".repeat(10_000))).not.toThrow();
  });

  describe("type-level contract", () => {
    test("accepts a string and returns readonly string[]", () => {
      expectTypeOf(parseFieldPath).parameter(0).toBeString();
      expectTypeOf(parseFieldPath).returns.toEqualTypeOf<readonly string[]>();
    });
  });
});

// =============================================================================
// navigateFieldPath
// =============================================================================
describe("navigateFieldPath()", () => {
  test("returns the nested value for a matching dot path", () => {
    expect(
      navigateFieldPath({ metadata: { author: "Ada" } }, "metadata.author"),
    ).toBe("Ada");
  });

  test("returns the value for a bare field name", () => {
    expect(navigateFieldPath({ author: "Ada" }, "author")).toBe("Ada");
  });

  test("returns undefined when a segment is missing", () => {
    expect(navigateFieldPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  test("returns undefined when an intermediate segment is a primitive", () => {
    expect(navigateFieldPath({ a: 1 }, "a.b")).toBeUndefined();
  });

  test("returns undefined when an intermediate segment is null", () => {
    expect(navigateFieldPath({ a: null }, "a.b")).toBeUndefined();
  });

  describe("prototype-pollution guard", () => {
    test.each(["__proto__", "constructor", "prototype"])(
      "a trailing dangerous segment %j resolves to undefined",
      (dangerousKey) => {
        expect(
          navigateFieldPath({ a: {} }, `a.${dangerousKey}`),
        ).toBeUndefined();
      },
    );

    test("a dangerous key mid-path short-circuits to undefined", () => {
      expect(
        navigateFieldPath({ a: { __proto__: { b: "leak" } } }, "a.__proto__.b"),
      ).toBeUndefined();
    });

    test("does not leak Object.prototype members through __proto__", () => {
      expect(
        navigateFieldPath({ a: {} }, "a.__proto__.toString"),
      ).toBeUndefined();
    });
  });

  describe("numeric segments address object keys, not array indices", () => {
    test("a numeric-string object key is reachable", () => {
      expect(navigateFieldPath({ items: { "0": "x" } }, "items.0")).toBe("x");
    });

    test("an array IS indexed by a numeric segment", () => {
      expect(navigateFieldPath({ items: ["x"] }, "items.0")).toBe("x");
    });
  });

  describe("array indexing", () => {
    test("indexes into an array with a digit-only segment", () => {
      expect(navigateFieldPath({ items: ["x", "y"] }, "items.1")).toBe("y");
    });

    test("an out-of-range index resolves to undefined", () => {
      expect(navigateFieldPath({ items: ["x"] }, "items.5")).toBeUndefined();
    });

    test("a non-digit segment against an array resolves to undefined", () => {
      expect(navigateFieldPath({ items: ["x"] }, "items.name")).toBeUndefined();
    });

    test("a negative-number segment against an array resolves to undefined", () => {
      expect(navigateFieldPath({ items: ["x"] }, "items.-1")).toBeUndefined();
    });

    test("a negative-number-shaped literal key on an object is a normal key lookup", () => {
      expect(navigateFieldPath({ items: { "-1": "x" } }, "items.-1")).toBe("x");
    });

    test("chains through nested array-of-object-of-array paths", () => {
      expect(
        navigateFieldPath({ rows: [{ cells: ["a", "b"] }] }, "rows.0.cells.1"),
      ).toBe("b");
    });

    test("a leading-zero digit segment is normalized as an array index", () => {
      expect(
        navigateFieldPath(
          { items: ["a", "b", "c", "d", "e", "f", "g", "h"] },
          "items.007",
        ),
      ).toBe("h");
    });
  });

  describe("wildcard segments are not expanded", () => {
    test("a `*` segment against an array resolves to undefined (no expansion)", () => {
      expect(
        navigateFieldPath({ items: [{ id: 1 }] }, "items.*.id"),
      ).toBeUndefined();
    });

    test("a literal '*' object key is reachable as a normal single value", () => {
      expect(navigateFieldPath({ "*": 7 }, "*")).toBe(7);
    });
  });

  test("never throws for any input shape", () => {
    expect(() => navigateFieldPath(null, "a.b")).not.toThrow();
    expect(() => navigateFieldPath(undefined, "a.b")).not.toThrow();
    expect(() => navigateFieldPath("string", "a.b")).not.toThrow();
    expect(() => navigateFieldPath(42, "a.b")).not.toThrow();
    expect(() => navigateFieldPath({}, "")).not.toThrow();
  });

  describe("type-level contract", () => {
    test("accepts (unknown, string) and returns unknown", () => {
      expectTypeOf(navigateFieldPath).parameter(0).toBeUnknown();
      expectTypeOf(navigateFieldPath).parameter(1).toBeString();
      expectTypeOf(navigateFieldPath).returns.toBeUnknown();
    });
  });
});

// =============================================================================
// M3LJSONFieldExtractor
// =============================================================================
describe("M3LJSONFieldExtractor", () => {
  test("extract() returns the nested value for the configured field path", () => {
    const extractor = new M3LJSONFieldExtractor("metadata.author");
    expect(extractor.extract({ metadata: { author: "Ada" } })).toBe("Ada");
  });

  test("extract() returns undefined when the field path segment is missing", () => {
    const extractor = new M3LJSONFieldExtractor("metadata.author");
    expect(extractor.extract({ metadata: {} })).toBeUndefined();
  });

  test("extract() returns undefined for a dangerous field path (inherits navigate semantics)", () => {
    const extractor = new M3LJSONFieldExtractor("a.__proto__");
    expect(extractor.extract({ a: {} })).toBeUndefined();
  });

  test("extract() returns the array element for an array-index-shaped path", () => {
    const extractor = new M3LJSONFieldExtractor("items.0");
    expect(extractor.extract({ items: ["x"] })).toBe("x");
  });

  test("extract() never throws for a non-object record", () => {
    const extractor = new M3LJSONFieldExtractor("a.b");
    expect(() => extractor.extract(null)).not.toThrow();
    expect(() => extractor.extract("not an object")).not.toThrow();
  });

  describe("type-level contract", () => {
    test("constructor takes a string; extract takes unknown and returns unknown", () => {
      expectTypeOf<M3LJSONFieldExtractor["extract"]>()
        .parameter(0)
        .toBeUnknown();
      expectTypeOf<M3LJSONFieldExtractor["extract"]>().returns.toBeUnknown();
    });
  });

  describe("extractAll()", () => {
    test("returns every wildcard match over an array in document order", () => {
      const extractor = new M3LJSONFieldExtractor("items.*.id");
      expect(extractor.extractAll({ items: [{ id: 1 }, { id: 2 }] })).toEqual([
        1, 2,
      ]);
    });

    test("returns exactly one element for a resolved wildcard-free path", () => {
      const extractor = new M3LJSONFieldExtractor("metadata.author");
      expect(extractor.extractAll({ metadata: { author: "Ada" } })).toEqual([
        "Ada",
      ]);
    });

    test("returns an empty array for an unresolved wildcard-free path", () => {
      const extractor = new M3LJSONFieldExtractor("metadata.author");
      expect(extractor.extractAll({ metadata: {} })).toEqual([]);
    });

    test("inherits the prototype-pollution guard from extractAll()", () => {
      const extractor = new M3LJSONFieldExtractor("a.__proto__");
      expect(extractor.extractAll({ a: {} })).toEqual([]);
    });

    test("never throws for a non-object record", () => {
      const extractor = new M3LJSONFieldExtractor("a.b");
      expect(() => extractor.extractAll(null)).not.toThrow();
      expect(() => extractor.extractAll("not an object")).not.toThrow();
    });

    describe("type-level contract", () => {
      test("extractAll takes unknown and returns readonly unknown[]", () => {
        expectTypeOf<M3LJSONFieldExtractor["extractAll"]>()
          .parameter(0)
          .toBeUnknown();
        expectTypeOf<
          M3LJSONFieldExtractor["extractAll"]
        >().returns.toEqualTypeOf<readonly unknown[]>();
      });
    });
  });
});

// =============================================================================
// extractAll
// =============================================================================
describe("extractAll()", () => {
  describe("array indexing", () => {
    test("indexes into an array with a digit-only segment", () => {
      expect(extractAll({ items: ["x", "y"] }, "items.1")).toEqual(["y"]);
    });

    test("an out-of-range index yields no match", () => {
      expect(extractAll({ items: ["x"] }, "items.5")).toEqual([]);
    });

    test("a leading-zero digit segment is normalized as an array index", () => {
      expect(
        extractAll(
          { items: ["a", "b", "c", "d", "e", "f", "g", "h"] },
          "items.007",
        ),
      ).toEqual(["h"]);
    });
  });

  describe("wildcard expansion", () => {
    test("expands `*` over an array, in index order", () => {
      expect(
        extractAll({ items: [{ id: 1 }, { id: 2 }] }, "items.*.id"),
      ).toEqual([1, 2]);
    });

    test("expands `*` over a plain object's own enumerable values, in insertion order", () => {
      expect(extractAll({ a: { v: 1 }, b: { v: 2 } }, "*.v")).toEqual([1, 2]);
    });

    test("a trailing `*` over an array yields every element", () => {
      expect(extractAll({ a: [1, 2, 3] }, "a.*")).toEqual([1, 2, 3]);
    });

    test("a trailing `*` over an object yields every own value", () => {
      expect(extractAll({ o: { x: 1, y: 2 } }, "o.*")).toEqual([1, 2]);
    });

    test("a `*` over a primitive drops silently, without throwing", () => {
      expect(extractAll({ a: 1 }, "a.*")).toEqual([]);
    });

    test("a `*` over null drops silently, without throwing", () => {
      expect(extractAll({ a: null }, "a.*")).toEqual([]);
    });

    test("nested chained wildcards preserve document order", () => {
      expect(
        extractAll(
          { groups: [{ items: [1, 2] }, { items: [3] }] },
          "groups.*.items.*",
        ),
      ).toEqual([1, 2, 3]);
    });
  });

  describe("cardinality", () => {
    test("a resolved wildcard-free path yields exactly one element", () => {
      expect(
        extractAll({ metadata: { author: "Ada" } }, "metadata.author"),
      ).toEqual(["Ada"]);
    });

    test("an unresolved wildcard-free path yields an empty array", () => {
      expect(extractAll({ metadata: {} }, "metadata.author")).toEqual([]);
    });

    test("a present nullish value on a resolved path is included", () => {
      expect(extractAll({ a: { b: null } }, "a.b")).toEqual([null]);
    });

    test("an empty path returns the whole record as one element", () => {
      expect(extractAll({ x: 1 }, "")).toEqual([{ x: 1 }]);
    });
  });

  describe("schema tolerance — never throws", () => {
    test("never throws for a non-object record", () => {
      expect(() => extractAll(null, "a.b")).not.toThrow();
      expect(() => extractAll(undefined, "a.b")).not.toThrow();
      expect(() => extractAll("string", "a.b")).not.toThrow();
      expect(() => extractAll(42, "a.b")).not.toThrow();
    });

    test("never throws for an empty path against a primitive record", () => {
      expect(() => extractAll(42, "")).not.toThrow();
    });

    test("a shape mismatch yields fewer/no results rather than throwing", () => {
      expect(() => extractAll({ a: 1 }, "a.b.c")).not.toThrow();
      expect(extractAll({ a: 1 }, "a.b.c")).toEqual([]);
    });
  });

  describe("prototype-pollution guard", () => {
    test.each(["__proto__", "constructor", "prototype"])(
      "a trailing dangerous segment %j yields no match",
      (dangerousKey) => {
        expect(extractAll({ a: {} }, `a.${dangerousKey}`)).toEqual([]);
      },
    );

    test("a dangerous key mid-path short-circuits to no match", () => {
      expect(
        extractAll({ a: { __proto__: { b: "leak" } } }, "a.__proto__.b"),
      ).toEqual([]);
    });

    test("a `*` expansion over an empty object yields no matches", () => {
      expect(extractAll({}, "*")).toEqual([]);
    });

    test("a `*` expansion over a plain object never surfaces inherited members like 'toString'", () => {
      const results = extractAll({ a: 1, b: 2 }, "*");
      expect(
        results.some((value: unknown) => typeof value === "function"),
      ).toBe(false);
      expect(results).toEqual([1, 2]);
    });
  });

  describe("type-level contract", () => {
    test("accepts (unknown, string) and returns readonly unknown[]", () => {
      expectTypeOf(extractAll).parameter(0).toBeUnknown();
      expectTypeOf(extractAll).parameter(1).toBeString();
      expectTypeOf(extractAll).returns.toEqualTypeOf<readonly unknown[]>();
    });
  });
});

// =============================================================================
// M3LJSONFormatDetector
// =============================================================================
describe("M3LJSONFormatDetector", () => {
  const JSON_ARRAY_PATH = "/fixtures/records.json";
  const JSON_ARRAY_CONTENT = Buffer.from(
    JSON.stringify([
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ]),
    "utf8",
  );
  const JSONL_PATH = "/fixtures/records.jsonl";
  const JSONL_CONTENT = Buffer.from(
    [
      JSON.stringify({ id: 1, name: "Ada" }),
      JSON.stringify({ id: 2, name: "Grace" }),
    ].join("\n"),
    "utf8",
  );

  /**
   * Builds a fake `FileHandle` backed by `content`. `read` copies bytes from
   * `content` starting at `position`, up to `length`, into the
   * caller-supplied buffer, mirroring the real `FileHandle.read` contract.
   */
  function fakeHandle(content: Buffer): FileHandle {
    return {
      read: vi.fn(
        (buffer: Buffer, offset: number, length: number, position: number) => {
          const slice = content.subarray(position, position + length);
          slice.copy(buffer, offset);
          return Promise.resolve({ bytesRead: slice.length, buffer });
        },
      ),
      stat: vi.fn(() => Promise.resolve({ size: content.length })),
      close: vi.fn(() => Promise.resolve()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake satisfying only the three FileHandle members the detector calls
    } as any as FileHandle;
  }

  /**
   * Builds a fake `FileHandle` whose `read()` rejects with `readError` and
   * whose `stat()` and `close()` behave as configured. Used to exercise the
   * post-open read/stat failure path and the close-suppression `finally`.
   */
  function fakeFailingHandle(options: {
    readonly readError?: unknown;
    readonly statError?: unknown;
    readonly statSize?: number;
    readonly closeError?: unknown;
  }): FileHandle {
    return {
      read: vi.fn(() =>
        options.readError !== undefined
          ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- options.readError is typed `unknown` to allow testing the fs-error channel un-normalized; every call site here happens to pass a real Error
            Promise.reject(options.readError)
          : Promise.resolve({ bytesRead: 0, buffer: Buffer.alloc(0) }),
      ),
      stat: vi.fn(() =>
        options.statError !== undefined
          ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- options.statError is typed `unknown` to allow testing the fs-error channel un-normalized; every call site here happens to pass a real Error
            Promise.reject(options.statError)
          : Promise.resolve({ size: options.statSize ?? 0 }),
      ),
      close: vi.fn(() =>
        options.closeError !== undefined
          ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- options.closeError is typed `unknown` to allow testing the fs-error channel un-normalized; every call site here happens to pass a real Error
            Promise.reject(options.closeError)
          : Promise.resolve(),
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake satisfying only the three FileHandle members the detector calls
    } as any as FileHandle;
  }

  const notFoundError = () =>
    Object.assign(
      new Error("ENOENT: no such file or directory, open 'missing'"),
      {
        code: "ENOENT",
      },
    );

  const eioError = () =>
    Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });

  beforeEach(() => {
    // Route opens for known fixture paths to a fake FileHandle backed by the
    // fixture bytes; anything else rejects, mirroring a real missing-file open.
    vi.spyOn(fs, "open").mockImplementation((path) => {
      if (path === JSON_ARRAY_PATH) {
        return Promise.resolve(fakeHandle(JSON_ARRAY_CONTENT));
      }
      if (path === JSONL_PATH) {
        return Promise.resolve(fakeHandle(JSONL_CONTENT));
      }
      return Promise.reject(notFoundError());
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("detects a .json file containing a JSON array as format 'json'", async () => {
    const detector = new M3LJSONFormatDetector();
    const result = await detector.detect(JSON_ARRAY_PATH);
    expect(result.format).toBe("json");
  });

  test("detects a .jsonl file containing newline-delimited objects as format 'jsonl'", async () => {
    const detector = new M3LJSONFormatDetector();
    const result = await detector.detect(JSONL_PATH);
    expect(result.format).toBe("jsonl");
  });

  test("default detector (no options) uses depth 'standard'", async () => {
    const detector = new M3LJSONFormatDetector();
    const result = await detector.detect(JSON_ARRAY_PATH);
    expect(result.method).toBe("standard");
  });

  describe.each<M3LJSONDetectionDepth>([
    "extension",
    "shallow",
    "standard",
    "deep",
  ])("depth level %j", (depth) => {
    test(`reports method '${depth}' and a well-formed result`, async () => {
      const detector = new M3LJSONFormatDetector({ depth });
      const result = await detector.detect(JSON_ARRAY_PATH);

      expect(result.method).toBe(depth);
      expect(["json", "jsonl", "unknown"]).toContain(result.format);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.details.bytesInspected).toBeGreaterThanOrEqual(0);
      expect(result.details.linesInspected).toBeGreaterThanOrEqual(0);
      expect(typeof result.details.bytesInspected).toBe("number");
      expect(typeof result.details.linesInspected).toBe("number");
    });
  });

  test("'extension' depth decides format from the file extension alone", async () => {
    const detector = new M3LJSONFormatDetector({ depth: "extension" });
    const jsonResult = await detector.detect(JSON_ARRAY_PATH);
    const jsonlResult = await detector.detect(JSONL_PATH);

    expect(jsonResult.format).toBe("json");
    expect(jsonlResult.format).toBe("jsonl");
  });

  test("'extension' depth inspects 0 bytes and 0 lines (never touches the file)", async () => {
    const detector = new M3LJSONFormatDetector({ depth: "extension" });
    const result = await detector.detect(JSON_ARRAY_PATH);

    expect(result.details.bytesInspected).toBe(0);
    expect(result.details.linesInspected).toBe(0);
    expect(fs.open).not.toHaveBeenCalled();
  });

  test("'shallow' depth reports the exact UTF-8 byte count of its 1-byte sample", async () => {
    const detector = new M3LJSONFormatDetector({ depth: "shallow" });
    const result = await detector.detect(JSON_ARRAY_PATH);

    expect(result.details.bytesInspected).toBe(1);
  });

  test("detect() rejects with M3LJSONFormatDetectionError for a nonexistent path", async () => {
    const detector = new M3LJSONFormatDetector();
    await expect(
      detector.detect("/fixtures/does-not-exist.json"),
    ).rejects.toBeInstanceOf(M3LJSONFormatDetectionError);
  });

  test("the M3LJSONFormatDetectionError is also an M3LError", async () => {
    const detector = new M3LJSONFormatDetector();
    await expect(
      detector.detect("/fixtures/does-not-exist.json"),
    ).rejects.toBeInstanceOf(M3LError);
  });

  test("the rejected error carries code 'ERR_JSON_DETECT_READ' and chains the underlying fs error as its cause", async () => {
    const detector = new M3LJSONFormatDetector();
    let thrown: unknown;
    try {
      await detector.detect("/fixtures/does-not-exist.json");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(M3LJSONFormatDetectionError);
    const error = thrown as M3LJSONFormatDetectionError;
    expect(error.code).toBe("ERR_JSON_DETECT_READ");
    expect(error.cause).toBeDefined();
  });

  describe("post-open read/stat failure", () => {
    test("a raw read() error after a successful open() is wrapped in M3LJSONFormatDetectionError", async () => {
      const readError = eioError();
      vi.spyOn(fs, "open").mockResolvedValueOnce(
        fakeFailingHandle({ readError }),
      );
      const detector = new M3LJSONFormatDetector({ depth: "shallow" });

      const thrown = await detector
        .detect("/fixtures/anything.json")
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(M3LJSONFormatDetectionError);
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LJSONFormatDetectionError).cause).toBe(readError);
    });

    test("a raw stat() error under 'deep' depth is wrapped in M3LJSONFormatDetectionError", async () => {
      const statError = eioError();
      vi.spyOn(fs, "open").mockResolvedValueOnce(
        fakeFailingHandle({ statError }),
      );
      const detector = new M3LJSONFormatDetector({ depth: "deep" });

      const thrown = await detector
        .detect("/fixtures/anything.json")
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(M3LJSONFormatDetectionError);
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LJSONFormatDetectionError).cause).toBe(statError);
    });
  });

  describe("best-effort close() in the finally block", () => {
    test("a close() failure does not shadow a real read() failure", async () => {
      const readError = eioError();
      const closeError = new Error("close failed");
      vi.spyOn(fs, "open").mockResolvedValueOnce(
        fakeFailingHandle({ readError, closeError }),
      );
      const detector = new M3LJSONFormatDetector({ depth: "shallow" });

      const thrown = await detector
        .detect("/fixtures/anything.json")
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(M3LJSONFormatDetectionError);
      expect((thrown as M3LJSONFormatDetectionError).cause).toBe(readError);
    });

    test("a close() failure after a successful read does not fail detect()", async () => {
      vi.spyOn(fs, "open").mockResolvedValueOnce(
        fakeHandle(JSON_ARRAY_CONTENT),
      );
      const handle = await fs.open("/fixtures/whatever.json", "r");
      vi.spyOn(handle, "close").mockRejectedValueOnce(
        new Error("close failed"),
      );
      vi.spyOn(fs, "open").mockResolvedValueOnce(handle);

      const detector = new M3LJSONFormatDetector({ depth: "shallow" });
      const result = await detector.detect("/fixtures/whatever.json");

      expect(result.format).toBe("json");
    });
  });

  describe("'deep' depth dedup across overlapping windows", () => {
    const DEEP_LARGE_PATH = "/fixtures/large.jsonl";
    const DEEP_SUBSUMED_PATH = "/fixtures/subsumed.jsonl";
    const DEEP_UNKNOWN_PATH = "/fixtures/unknown.bin";

    /**
     * Builds an 800-byte JSONL fixture. At this size the start/middle/end
     * 512-byte sample windows the detector reads are contiguous and their
     * union covers the whole file exactly once, so `bytesInspected` for
     * `deep` depth on this fixture must equal exactly 800 — proving
     * `dedupeWindows()` neither double-counts overlap nor drops bytes.
     */
    function buildLargeJSONLFixture(): Buffer {
      const lines: string[] = [];
      let i = 1;
      while (true) {
        const line = JSON.stringify({
          id: i,
          name: `Person${String(i)}`,
          active: i % 2 === 0,
        });
        const candidate = [...lines, line].join("\n");
        if (Buffer.byteLength(candidate, "utf8") > 780) break;
        lines.push(line);
        i += 1;
      }
      const joined = lines.join("\n");
      const pad = 800 - Buffer.byteLength(joined, "utf8");
      return Buffer.from(joined + " ".repeat(pad), "utf8");
    }

    const LARGE_CONTENT = buildLargeJSONLFixture();

    /**
     * At exactly 513 bytes, the middle 512-byte window (`floor(513/2) - 256 =
     * 0`) is byte-for-byte identical to the start window `[0, 512)`, so it is
     * fully subsumed by coverage already accumulated from the start window.
     * This exercises `dedupeWindows()`'s "skip a window with no new bytes"
     * branch (`window.end > sliceStart` false).
     */
    function buildSubsumedFixture(): Buffer {
      const lines: string[] = [];
      let i = 1;
      while (true) {
        const line = JSON.stringify({ id: i, v: `x${String(i)}` });
        const candidate = [...lines, line].join("\n");
        if (Buffer.byteLength(candidate, "utf8") > 500) break;
        lines.push(line);
        i += 1;
      }
      const joined = lines.join("\n");
      const pad = 513 - Buffer.byteLength(joined, "utf8");
      return Buffer.from(joined + " ".repeat(pad), "utf8");
    }

    const SUBSUMED_CONTENT = buildSubsumedFixture();

    /** Content that is neither a JSON document nor multi-line JSONL. */
    const UNKNOWN_CONTENT = Buffer.from("not json content at all", "utf8");

    beforeEach(() => {
      expect(LARGE_CONTENT.length).toBe(800);
      expect(SUBSUMED_CONTENT.length).toBe(513);
      vi.spyOn(fs, "open").mockImplementation((path) => {
        if (path === DEEP_LARGE_PATH) {
          return Promise.resolve(fakeHandle(LARGE_CONTENT));
        }
        if (path === DEEP_SUBSUMED_PATH) {
          return Promise.resolve(fakeHandle(SUBSUMED_CONTENT));
        }
        if (path === DEEP_UNKNOWN_PATH) {
          return Promise.resolve(fakeHandle(UNKNOWN_CONTENT));
        }
        if (path === JSON_ARRAY_PATH) {
          return Promise.resolve(fakeHandle(JSON_ARRAY_CONTENT));
        }
        if (path === JSONL_PATH) {
          return Promise.resolve(fakeHandle(JSONL_CONTENT));
        }
        return Promise.reject(notFoundError());
      });
    });

    test("a file larger than one 512-byte window is inspected via overlapping start/middle/end windows without double-counting bytes", async () => {
      const detector = new M3LJSONFormatDetector({ depth: "deep" });
      const result = await detector.detect(DEEP_LARGE_PATH);

      expect(result.format).toBe("jsonl");
      expect(result.details.bytesInspected).toBeGreaterThan(0);
      expect(result.details.bytesInspected).toBeLessThanOrEqual(
        LARGE_CONTENT.length,
      );
      // For this 800-byte fixture the three 512-byte windows are contiguous
      // and their union covers the file exactly, so the unique byte count is
      // exactly the file size — not 3 * 512, which would indicate
      // double-counting.
      expect(result.details.bytesInspected).toBe(LARGE_CONTENT.length);
    });

    test("a file no larger than one 512-byte window reports bytesInspected equal to its true (small) byte length", async () => {
      const detector = new M3LJSONFormatDetector({ depth: "deep" });
      const result = await detector.detect(JSONL_PATH);

      expect(result.details.bytesInspected).toBe(JSONL_CONTENT.length);
    });

    test("a window fully subsumed by prior coverage contributes no duplicate bytes", async () => {
      const detector = new M3LJSONFormatDetector({ depth: "deep" });
      const result = await detector.detect(DEEP_SUBSUMED_PATH);

      expect(result.format).toBe("jsonl");
      expect(result.details.bytesInspected).toBe(SUBSUMED_CONTENT.length);
    });

    test("deep depth reports 'unknown' with zero confidence for inconclusive sampled content", async () => {
      const detector = new M3LJSONFormatDetector({ depth: "deep" });
      const result = await detector.detect(DEEP_UNKNOWN_PATH);

      expect(result.format).toBe("unknown");
      expect(result.confidence).toBe(0);
    });
  });

  test("an invalid depth value throws the raw M3LError with code 'ERR_JSON_DETECT_DEPTH', not wrapped as a detection error", async () => {
    // Deliberately bypasses the M3LJSONDetectionDepth union (via an
    // `unknown`-mediated cast on the whole options bag, not the property in
    // isolation) to exercise the constructor's runtime exhaustiveness guard.
    const bogusOptions = {
      depth: "bogus",
    } as unknown as M3LJSONDetectorOptions;
    const detector = new M3LJSONFormatDetector(bogusOptions);

    const thrown = await detector
      .detect(JSON_ARRAY_PATH)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(M3LError);
    expect(thrown).not.toBeInstanceOf(M3LJSONFormatDetectionError);
    expect((thrown as M3LError).code).toBe("ERR_JSON_DETECT_DEPTH");
  });

  describe("type-level contract", () => {
    test("M3LJSONFormat is the 'json' | 'jsonl' | 'unknown' union", () => {
      expectTypeOf<M3LJSONFormat>().toEqualTypeOf<
        "json" | "jsonl" | "unknown"
      >();
    });

    test("M3LJSONDetectionDepth is the four-level union", () => {
      expectTypeOf<M3LJSONDetectionDepth>().toEqualTypeOf<
        "extension" | "shallow" | "standard" | "deep"
      >();
    });

    test("M3LJSONDetectorOptions has an optional depth field", () => {
      expectTypeOf<M3LJSONDetectorOptions>().toEqualTypeOf<{
        readonly depth?: M3LJSONDetectionDepth;
      }>();
    });

    test("M3LJSONDetectionResult has the format/confidence/method/details shape", () => {
      expectTypeOf<M3LJSONDetectionResult>().toEqualTypeOf<{
        readonly format: M3LJSONFormat;
        readonly confidence: M3LConfidence;
        readonly method: M3LJSONDetectionDepth;
        readonly details: {
          readonly bytesInspected: number;
          readonly linesInspected: number;
        };
      }>();
    });

    test("M3LConfidence is assignable to a plain number", () => {
      expectTypeOf<M3LConfidence>().toMatchTypeOf<number>();
    });

    test("detect() returns a Promise<M3LJSONDetectionResult>", () => {
      expectTypeOf<M3LJSONFormatDetector["detect"]>().returns.toEqualTypeOf<
        Promise<M3LJSONDetectionResult>
      >();
    });

    test("a confidence value read off a real result is usable as M3LConfidence", async () => {
      const detector = new M3LJSONFormatDetector();
      const result = await detector.detect(JSON_ARRAY_PATH);
      expectTypeOf(result.confidence).toEqualTypeOf<M3LConfidence>();
    });
  });
});
