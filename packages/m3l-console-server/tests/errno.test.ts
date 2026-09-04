/**
 * Tests for `errnoCodeOf` (src/errors/errno.ts) — the hoisted, hardened
 * `code`-extraction helper (X8 telemetry follow-up). `errnoCodeOf` now
 * lives in `src/errors/errno.ts`; it was formerly duplicated in
 * `src/telemetry/store-size.ts` and `src/runs/report.ts`.
 *
 * The guard this module exists for — an `Error` with NO own `code` while
 * `Error.prototype.code` is polluted — can never be produced by a real
 * `node:fs` call (Node's own errno errors always set `code` as an own
 * property), so it is only reachable by calling the helper directly. Hence
 * this is a direct unit-test file rather than a fixture built through a
 * consumer such as `createRunReportReader`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { errnoCodeOf } from "../src/errors/errno.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = dirname(THIS_FILE);

// A path guaranteed not to exist on any filesystem this suite runs on.
const MISSING_PATH = join(THIS_DIR, "does-not-exist-errno-fixture-3f9c1a7e");

describe("errnoCodeOf", () => {
  describe("real errno errors", () => {
    test("returns the code from a genuine ENOENT raised by fs.readFileSync on a missing path", () => {
      let caught: unknown;
      try {
        readFileSync(MISSING_PATH, "utf8");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(errnoCodeOf(caught)).toBe("ENOENT");
    });

    test("returns the code from a genuine ENOENT raised by fs.statSync on a missing path", () => {
      let caught: unknown;
      try {
        statSync(MISSING_PATH);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(errnoCodeOf(caught)).toBe("ENOENT");
    });

    test("returns the code from a genuine ENOTDIR raised by fs.readdirSync on a non-directory path", () => {
      // THIS_FILE is a real file, not a directory — reading it as a
      // directory is a genuine Node SystemError, not a hand-made object.
      let caught: unknown;
      try {
        readdirSync(THIS_FILE);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(errnoCodeOf(caught)).toBe("ENOTDIR");
    });

    test("returns the code from a hand-made Error with an own code property", () => {
      const cause = Object.assign(new Error("boom"), { code: "ECUSTOM" });
      expect(errnoCodeOf(cause)).toBe("ECUSTOM");
    });
  });

  describe("non-Error inputs", () => {
    test.each<[string, unknown]>([
      ["a string", "ENOENT"],
      ["a number", 42],
      ["null", null],
      ["undefined", undefined],
      // Proves the `instanceof Error` half is load-bearing: this object HAS
      // an own `code` and would pass the ownership check alone.
      ["a plain object with an own code property", { code: "ENOENT" }],
    ])("returns undefined for %s", (_label, value) => {
      expect(errnoCodeOf(value)).toBeUndefined();
    });
  });

  describe("the hardening branch — inherited code is never honoured", () => {
    afterEach(() => {
      Reflect.deleteProperty(Error.prototype, "code");
      expect(Object.hasOwn(Error.prototype, "code")).toBe(false);
    });

    test("returns undefined for an Error with no own code, even when Error.prototype.code is set", () => {
      Object.defineProperty(Error.prototype, "code", {
        value: "ENOENT",
        configurable: true,
        writable: true,
      });

      const cause = new Error("no own code here");
      expect(Object.hasOwn(cause, "code")).toBe(false);

      expect(errnoCodeOf(cause)).toBeUndefined();
    });
  });

  describe("own code of the wrong type", () => {
    test.each<[string, unknown]>([
      ["a number", 42],
      ["null", null],
      ["a symbol", Symbol("ENOENT")],
      ["an object", { toString: () => "ENOENT" }],
    ])("returns undefined when the own code is %s", (_label, code) => {
      const cause = Object.assign(new Error("boom"), { code });
      expect(errnoCodeOf(cause)).toBeUndefined();
    });
  });

  describe("read-once", () => {
    test("reads an own accessor code exactly once and returns the first value", () => {
      let reads = 0;
      const values = ["ENOENT", "ESOMETHINGELSE"];
      const cause = new Error("accessor code");
      Object.defineProperty(cause, "code", {
        configurable: true,
        get() {
          const value = values[reads];
          reads += 1;
          return value;
        },
      });

      const result = errnoCodeOf(cause);

      expect(result).toBe("ENOENT");
      expect(reads).toBe(1);
    });
  });
});
