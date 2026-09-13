/**
 * Tests for `errnoCodeOf` and `underlyingErrnoCodeOf` (src/errors/errno.ts)
 * — the hoisted, hardened `code`-extraction helpers (X8 telemetry follow-up,
 * X8c cleanup-errno follow-up). `errnoCodeOf` now lives in
 * `src/errors/errno.ts`; it was formerly duplicated in
 * `src/telemetry/store-size.ts` and `src/runs/report.ts`.
 *
 * `underlyingErrnoCodeOf` (X8c, issue #1058) exists because `errnoCodeOf`
 * only ever reads a caught value's OWN `code` — for any driver that wraps a
 * real filesystem failure inside one or more `Core.M3LError` layers (e.g.
 * `M3LConsoleError` → `Core.M3LAppendOnlyStreamReadError` → a `node:fs`
 * error), `errnoCodeOf` on the outermost caught value just returns the M3L
 * code (e.g. `"ERR_CONSOLE_INTERNAL"`), never the underlying errno.
 * `underlyingErrnoCodeOf` walks `.cause`, skipping every `Core.M3LError`
 * link (its own `code` is an M3L code, never an errno) and returning the
 * first non-M3LError `Error` link's own code.
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

import { Core } from "@monte3l/m3l-common";

import { errnoCodeOf, underlyingErrnoCodeOf } from "../src/errors/errno.js";
import { M3LConsoleError } from "../src/errors/console-error.js";

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

describe("underlyingErrnoCodeOf", () => {
  describe("real errno errors", () => {
    test("returns the code from a genuine ENOTDIR raised by fs.readdirSync on a non-directory path, passed directly", () => {
      let caught: unknown;
      try {
        readdirSync(THIS_FILE);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(underlyingErrnoCodeOf(caught)).toBe("ENOTDIR");
    });
  });

  describe("M3LError wrapping", () => {
    test("walks past one M3LConsoleError layer to the fs error it wraps", () => {
      let fsCause: unknown;
      try {
        readdirSync(THIS_FILE);
      } catch (error) {
        fsCause = error;
      }
      const wrapped = new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        "audit listing failed",
        { cause: fsCause },
      );
      expect(underlyingErrnoCodeOf(wrapped)).toBe("ENOTDIR");
    });

    test("walks past two nested M3LConsoleError layers to the first non-M3LError link's own code", () => {
      const sqliteFailure = Object.assign(new Error("no such table: runs"), {
        code: "ECUSTOM_INNER",
      });
      const inner = new M3LConsoleError(
        "ERR_CONSOLE_STORE_QUERY_FAILED",
        "query failed",
        { cause: sqliteFailure },
      );
      const outer = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "wrapped", {
        cause: inner,
      });
      expect(underlyingErrnoCodeOf(outer)).toBe("ECUSTOM_INNER");
    });

    // Proves the walk does not require the underlying code to LOOK like a
    // real POSIX errno (an "E…" name) — it returns whatever own `code` the
    // first non-M3LError link carries, verbatim.
    test("returns a non-errno Node code (e.g. ERR_SQLITE_ERROR) unmodified when it sits on the first non-M3LError link", () => {
      const sqliteFailure = Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
      });
      const wrapped = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "wrapped", {
        cause: sqliteFailure,
      });
      expect(underlyingErrnoCodeOf(wrapped)).toBe("ERR_SQLITE_ERROR");
    });

    test("returns undefined when an M3LError chain's last link has no cause", () => {
      const noCause = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "dead end");
      expect(underlyingErrnoCodeOf(noCause)).toBeUndefined();
    });

    // The FIRST non-M3LError link decides and the walk stops there — it does
    // NOT continue past it to look for a code deeper in the chain.
    test("returns undefined for a non-M3L Error with no own code, even though its own cause has one", () => {
      const innerWithCode = Object.assign(new Error("inner"), {
        code: "ENOENT",
      });
      const outerNoCode = new Error("outer, no own code", {
        cause: innerWithCode,
      });
      expect(Object.hasOwn(outerNoCode, "code")).toBe(false);
      expect(underlyingErrnoCodeOf(outerNoCode)).toBeUndefined();
    });
  });

  describe("cycle safety", () => {
    test("returns undefined and terminates for a cyclic chain of M3LError links", () => {
      const a = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "a");
      const b = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "b");
      // `cause` is declared readonly on M3LError, but that is a compile-time
      // guarantee only — Object.defineProperty is the only way to build a
      // genuine cycle for this fixture, matching the pattern the contract
      // calls out.
      Object.defineProperty(a, "cause", { value: b, configurable: true });
      Object.defineProperty(b, "cause", { value: a, configurable: true });

      // If the walk were not bounded, this call would loop forever and the
      // test would time out rather than fail an assertion — the call
      // returning at all is part of what this test proves.
      expect(underlyingErrnoCodeOf(a)).toBeUndefined();
    });
  });

  describe("walk bound", () => {
    // A cyclic chain (see "cycle safety" above) proves only that the walk
    // TERMINATES — a correct 10-link bound and an off-by-one bound both
    // terminate on a cycle, so that test alone cannot tell them apart. This
    // pair instead builds a LINEAR, non-cyclic chain to pin the exact bound:
    // the caught value itself counts as link 1, so nine M3LConsoleError
    // wrappers plus the innermost errno error make exactly ten links
    // (mirroring MAX_CAUSE_CHAIN_WALK = 10 in src/errors/errno.ts), and ten
    // wrappers push the errno error to an eleventh, unreached link.
    function wrapInM3LErrors(
      innermost: unknown,
      wrapperCount: number,
    ): unknown {
      let link: unknown = innermost;
      for (let index = 0; index < wrapperCount; index += 1) {
        link = new M3LConsoleError(
          "ERR_CONSOLE_INTERNAL",
          `wrapper layer ${String(index)}`,
          { cause: link },
        );
      }
      return link;
    }

    test("finds the errno on the tenth link (nine M3LError wrappers)", () => {
      let fsCause: unknown;
      try {
        readdirSync(THIS_FILE);
      } catch (error) {
        fsCause = error;
      }
      const chain = wrapInM3LErrors(fsCause, 9);
      expect(underlyingErrnoCodeOf(chain)).toBe("ENOTDIR");
    });

    test("returns undefined when the errno sits on the eleventh link (ten M3LError wrappers)", () => {
      let fsCause: unknown;
      try {
        readdirSync(THIS_FILE);
      } catch (error) {
        fsCause = error;
      }
      const chain = wrapInM3LErrors(fsCause, 10);
      expect(underlyingErrnoCodeOf(chain)).toBeUndefined();
    });
  });

  describe("a throwing cause getter", () => {
    test("returns undefined and does not throw when reading .cause throws", () => {
      const poisoned = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "boom");
      Object.defineProperty(poisoned, "cause", {
        configurable: true,
        get() {
          throw new Error("cause getter blew up");
        },
      });

      // Call once, capturing the result inside the `not.toThrow` callback —
      // a prior version of this test called `underlyingErrnoCodeOf(poisoned)`
      // twice (once per assertion), which is wasteful and, for a stateful
      // poisoned getter, can even observe two different outcomes.
      let result: string | undefined;
      expect(() => {
        result = underlyingErrnoCodeOf(poisoned);
      }).not.toThrow();
      expect(result).toBeUndefined();
    });
  });

  // [X8c review finding, issue #1058 follow-up] `underlyingErrnoCodeOf`
  // originally guarded only the `.cause` read; the `instanceof
  // Core.M3LError` / `instanceof Error` checks on each link, and the call to
  // `errnoCodeOf(link)` (which itself runs `Object.hasOwn(cause, "code")`
  // plus a `.code` read), were not — so a hostile link escaped as a raw
  // throw instead of ending the walk with `undefined`. This block locks the
  // fix: every read on a link now happens inside `inspectCauseLink`'s single
  // `try`/`catch`, so any throw while inspecting a link ends the walk with
  // `undefined` rather than escaping. This is reachable from
  // `src/cleanup.ts`, whose `failures.map(toCleanupFailure)` runs outside
  // any try, so a raw throw here would replace `runCleanup`'s intended
  // `M3LConsoleError("ERR_CONSOLE_INTERNAL")` (see `cleanup.test.ts`'s
  // "hostile cause" lock).
  describe("hostile links — the walk must never itself throw", () => {
    test("returns undefined and does not throw when the input Error's own code getter throws", () => {
      const hostile = new Error("hostile");
      Object.defineProperty(hostile, "code", {
        configurable: true,
        get() {
          throw new Error("hostile code getter blew up");
        },
      });

      let result: string | undefined;
      expect(() => {
        result = underlyingErrnoCodeOf(hostile);
      }).not.toThrow();
      expect(result).toBeUndefined();
    });

    test("returns undefined and does not throw when the first non-M3L link's own code getter throws", () => {
      const hostile = new Error("hostile");
      Object.defineProperty(hostile, "code", {
        configurable: true,
        get() {
          throw new Error("hostile code getter blew up");
        },
      });
      // The M3L link is skipped, then the hostile first non-M3L link is
      // inspected — this exercises `errnoCodeOf`'s unguarded `.code` read.
      const wrapped = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "wrapped", {
        cause: hostile,
      });

      let result: string | undefined;
      expect(() => {
        result = underlyingErrnoCodeOf(wrapped);
      }).not.toThrow();
      expect(result).toBeUndefined();
    });

    test("returns undefined and does not throw when the first non-M3L link is a Proxy whose getOwnPropertyDescriptor trap throws", () => {
      const target: Error = new Error("x");
      const hostile: Error = new Proxy(target, {
        getOwnPropertyDescriptor() {
          throw new Error("getOwnPropertyDescriptor trap blew up");
        },
      });
      // Confirms this Proxy actually makes Object.hasOwn throw — the
      // mechanism errnoCodeOf's ownership guard relies on.
      expect(() => Object.hasOwn(hostile, "code")).toThrow();

      const wrapped = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "wrapped", {
        cause: hostile,
      });

      let result: string | undefined;
      expect(() => {
        result = underlyingErrnoCodeOf(wrapped);
      }).not.toThrow();
      expect(result).toBeUndefined();
    });

    test("returns undefined and does not throw when the first non-M3L link is a Proxy whose getPrototypeOf trap throws", () => {
      const target: Error = new Error("x");
      const hostile: Error = new Proxy(target, {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap blew up");
        },
      });
      // Confirms this Proxy actually makes `instanceof` itself throw.
      expect(() => hostile instanceof Error).toThrow();

      const wrapped = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "wrapped", {
        cause: hostile,
      });

      let result: string | undefined;
      expect(() => {
        result = underlyingErrnoCodeOf(wrapped);
      }).not.toThrow();
      expect(result).toBeUndefined();
    });
  });

  describe("non-Error inputs", () => {
    test.each<[string, unknown]>([
      ["a string", "ENOENT"],
      ["null", null],
      ["undefined", undefined],
      ["a plain object with an own code property", { code: "ENOENT" }],
    ])("returns undefined for %s", (_label, value) => {
      expect(underlyingErrnoCodeOf(value)).toBeUndefined();
    });
  });

  describe("inherited code on a non-M3L Error subclass", () => {
    class CustomError extends Error {}

    afterEach(() => {
      Reflect.deleteProperty(CustomError.prototype, "code");
    });

    test("returns undefined when the first non-M3LError link's code is only inherited via a prototype getter", () => {
      Object.defineProperty(CustomError.prototype, "code", {
        value: "ENOENT",
        configurable: true,
      });
      const instance = new CustomError("boom");
      expect(Object.hasOwn(instance, "code")).toBe(false);

      expect(underlyingErrnoCodeOf(instance)).toBeUndefined();
    });
  });

  // Sanity: a real Core.M3LError instance (not just M3LConsoleError) is
  // recognised by the `instanceof Core.M3LError` check and skipped the same
  // way — the contract is keyed on the base class, not the console-server
  // subclass.
  describe("a Core.M3LError-derived class other than M3LConsoleError", () => {
    test("skips a bare Core.M3LError link on the way to the first non-M3LError link's code", () => {
      const fsLike = Object.assign(new Error("boom"), { code: "EACCES" });
      const coreError = new Core.M3LError("core failure", {
        code: "ERR_CORE_SOMETHING",
        cause: fsLike,
      });
      expect(coreError).toBeInstanceOf(Core.M3LError);
      expect(underlyingErrnoCodeOf(coreError)).toBe("EACCES");
    });
  });
});
