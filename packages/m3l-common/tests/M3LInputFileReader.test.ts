/**
 * Tests for `core/files/M3LInputFileReader` — reading an input file, under
 * `M3LPaths.resolveInput`, as raw text, parsed JSON, or a validated JSON
 * object record.
 *
 * Contract source: docs/reference/core/files.md § "Reading an input file
 * (M3LInputFileReader)".
 *
 * Exports under test: M3LInputFileReader, M3LInputFileReaderOptions.
 *
 * Key behavioral contracts:
 *  - readText/readJSON/readJSONRecord resolve `name` through the injected
 *    M3LPaths.resolveInput, so an escaping name (absolute or `..`) throws
 *    M3LPathResolutionError UNCHANGED — it is not wrapped into the caller's
 *    M3LError/code.
 *  - A missing file wraps the raw fs error into a bare M3LError with the
 *    caller's code and a chained cause.
 *  - Malformed JSON throws a bare M3LError with the caller's code and NO
 *    chained cause (security-relevant: the raw SyntaxError, whose message
 *    can embed a snippet of file content, must never be exposed via cause
 *    or leaked into the thrown message).
 *  - readJSONRecord / asRecord reject non-object JSON values (arrays,
 *    primitives, null) with a dedicated message, distinct from the
 *    malformed-JSON message.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { M3LPaths, M3LPathResolutionError } from "../src/core/utils/index.js";
import { M3LInputFileReader } from "../src/core/files/M3LInputFileReader.js";
import type { M3LInputFileReaderOptions } from "../src/core/files/M3LInputFileReader.js";

const CODE = "ERR_TEST_INPUT";

let inputDir: string;

beforeEach(async () => {
  inputDir = await mkdtemp(path.join(tmpdir(), "m3l-input-reader-"));
  vi.stubEnv("M3L_INPUT_DIR", inputDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(inputDir, { recursive: true, force: true });
});

function makeReader(): M3LInputFileReader {
  const options: M3LInputFileReaderOptions = {
    paths: new M3LPaths(),
    code: CODE,
  };
  return new M3LInputFileReader(options);
}

async function writeFixture(name: string, content: string): Promise<void> {
  await writeFile(path.join(inputDir, name), content, "utf8");
}

/** Invokes `fn`, asserting it rejects with a bare `M3LError` with the given message. */
async function expectM3LError(
  fn: () => Promise<unknown>,
  message: string,
): Promise<unknown> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LError);
  expect((thrown as M3LError).code).toBe(CODE);
  expect((thrown as M3LError).message).toBe(message);
  return thrown;
}

// ---------------------------------------------------------------------------
// readText
// ---------------------------------------------------------------------------
describe("readText", () => {
  test("resolves the exact UTF-8 text content of an existing file", async () => {
    await writeFixture("greeting.txt", "héllo wörld\n");
    const reader = makeReader();
    await expect(reader.readText("greeting.txt")).resolves.toBe(
      "héllo wörld\n",
    );
  });

  test("throws a bare M3LError chaining the raw fs cause for a nonexistent file", async () => {
    const reader = makeReader();
    const thrown = await expectM3LError(
      () => reader.readText("does-not-exist.txt"),
      "failed reading input file 'does-not-exist.txt'",
    );
    expect((thrown as M3LError).cause).toBeTruthy();
  });

  test("a name escaping the input directory throws M3LPathResolutionError, NOT the caller's M3LError", async () => {
    const reader = makeReader();
    let thrown: unknown;
    try {
      await reader.readText("../../etc/passwd");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LPathResolutionError);
  });

  test("an absolute path name throws M3LPathResolutionError, NOT the caller's M3LError", async () => {
    const reader = makeReader();
    let thrown: unknown;
    try {
      await reader.readText(path.join(inputDir, "..", "outside.txt"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LPathResolutionError);
  });
});

// ---------------------------------------------------------------------------
// readJSON
// ---------------------------------------------------------------------------
describe("readJSON", () => {
  test("resolves the parsed value of a well-formed JSON file", async () => {
    await writeFixture("data.json", JSON.stringify({ a: 1 }));
    const reader = makeReader();
    await expect(reader.readJSON("data.json")).resolves.toEqual({ a: 1 });
  });

  test("throws a bare M3LError with NO chained cause for malformed JSON", async () => {
    await writeFixture("bad.json", "{ not: valid json");
    const reader = makeReader();
    const thrown = await expectM3LError(
      () => reader.readJSON("bad.json"),
      "'bad.json' must be valid JSON (SyntaxError)",
    );
    expect((thrown as M3LError).cause).toBeUndefined();
  });

  test("does not leak a sentinel from the malformed region into the error message or cause (security-relevant)", async () => {
    // An unquoted bareword is a JSON syntax error positioned right where the
    // sentinel sits, mirroring how a real secret could land in a malformed
    // input file.
    await writeFixture("secret.json", '{"key": SECRET_TOKEN_MARKER_1234}');
    const reader = makeReader();
    let thrown: unknown;
    try {
      await reader.readJSON("secret.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).message).not.toContain(
      "SECRET_TOKEN_MARKER_1234",
    );
    expect((thrown as M3LError).cause).toBeUndefined();
  });

  test("throws the same 'failed reading input file' error for a nonexistent file", async () => {
    const reader = makeReader();
    const thrown = await expectM3LError(
      () => reader.readJSON("missing.json"),
      "failed reading input file 'missing.json'",
    );
    expect((thrown as M3LError).cause).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// readJSONRecord
// ---------------------------------------------------------------------------
describe("readJSONRecord", () => {
  test("resolves a JSON object as a record", async () => {
    await writeFixture("record.json", JSON.stringify({ a: 1, b: "x" }));
    const reader = makeReader();
    await expect(reader.readJSONRecord("record.json")).resolves.toEqual({
      a: 1,
      b: "x",
    });
  });

  test("throws when the decoded JSON is an array", async () => {
    await writeFixture("array.json", JSON.stringify([1, 2, 3]));
    const reader = makeReader();
    await expectM3LError(
      () => reader.readJSONRecord("array.json"),
      "'array.json' must decode to a JSON object",
    );
  });

  test("throws the malformed-JSON message (not the object-shape message) for invalid JSON", async () => {
    await writeFixture("bad-record.json", "[not json");
    const reader = makeReader();
    const thrown = await expectM3LError(
      () => reader.readJSONRecord("bad-record.json"),
      "'bad-record.json' must be valid JSON (SyntaxError)",
    );
    expect((thrown as M3LError).cause).toBeUndefined();
  });

  test("throws a bare M3LError for a top-level '__proto__' key read through the full read+parse+narrow path", async () => {
    await writeFixture(
      "dangerous-record.json",
      '{"__proto__":{"polluted":true}}',
    );
    const reader = makeReader();
    let thrown: unknown;
    try {
      await reader.readJSONRecord("dangerous-record.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe(CODE);
    expect(typeof (thrown as M3LError).message).toBe("string");
    expect((thrown as M3LError).message.length).toBeGreaterThan(0);
  });

  describe("type-level contract", () => {
    test("resolves to a Readonly<Record<string, unknown>>", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LInputFileReader["readJSONRecord"]>>
      >().toEqualTypeOf<Readonly<Record<string, unknown>>>();
    });
  });
});

// ---------------------------------------------------------------------------
// asRecord (synchronous)
// ---------------------------------------------------------------------------
describe("asRecord", () => {
  test("returns the SAME reference for a plain object", () => {
    const reader = makeReader();
    const value = { a: 1 };
    expect(reader.asRecord(value, "payload")).toBe(value);
  });

  test("throws for null", () => {
    const reader = makeReader();
    let thrown: unknown;
    try {
      reader.asRecord(null, "payload");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe(CODE);
    expect((thrown as M3LError).message).toBe(
      "'payload' must decode to a JSON object",
    );
  });

  test.each([[1, 2, 3], "a string", 42, true])("throws for %j", (value) => {
    const reader = makeReader();
    let thrown: unknown;
    try {
      reader.asRecord(value, "payload");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe(CODE);
    expect((thrown as M3LError).message).toBe(
      "'payload' must decode to a JSON object",
    );
  });

  describe("prototype-pollution guard (top-level dangerous keys)", () => {
    test.each(["__proto__", "constructor", "prototype"])(
      "throws a bare M3LError for a top-level %j key",
      (key) => {
        const reader = makeReader();
        // Parsed via JSON.parse (not an object literal) so the dangerous key
        // lands as an own enumerable property, matching how untrusted JSON
        // input actually arrives — an object-literal `{ __proto__: ... }`
        // would instead set the prototype itself rather than an own key.
        const value = JSON.parse(`{"${key}":{"polluted":true}}`) as Record<
          string,
          unknown
        >;
        let thrown: unknown;
        try {
          reader.asRecord(value, "cfg");
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe(CODE);
        expect(typeof (thrown as M3LError).message).toBe("string");
        expect((thrown as M3LError).message.length).toBeGreaterThan(0);
      },
    );

    test.each([{ protoType: "x" }, { myConstructor: "x" }])(
      "does NOT throw for a merely suspicious-looking key %j (exact match only)",
      (value) => {
        const reader = makeReader();
        expect(reader.asRecord(value, "cfg")).toEqual(value);
      },
    );
  });

  describe("type-level contract", () => {
    test("returns a Readonly<Record<string, unknown>>", () => {
      const reader = makeReader();
      expectTypeOf(reader.asRecord({}, "x")).toEqualTypeOf<
        Readonly<Record<string, unknown>>
      >();
    });
  });
});
