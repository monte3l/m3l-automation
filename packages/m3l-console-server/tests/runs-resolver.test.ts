/**
 * Tests for src/runs/resolver.ts — `resolveScript` (m3l-console-server X4
 * run-governor contract). Mocks `node:fs`'s `existsSync` via the
 * async-factory form so real exports still resolve; each test spies on
 * `existsSync` individually.
 *
 * The "symlink containment" and "name-echo truncation" describe blocks
 * below (X10b security fixes A and C) use REAL temp directories and real
 * symlinks rather than the mocked `existsSync` — containment must be
 * exercised end-to-end through `fs.realpathSync`, which a stubbed
 * `existsSync` cannot simulate. `mkdtempSync`/`mkdirSync`/`rmSync`/
 * `symlinkSync` are imported by name (not `fs.mkdtempSync` etc.) — the
 * same escape valve `runs-catalog.test.ts` already established for real
 * filesystem shape being the behavior under test, not an implementation
 * detail to stub around.
 */
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { resolveScript } from "../src/runs/resolver.js";
import type { M3LResolvedScript } from "../src/runs/resolver.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

const SCRIPTS_ROOT = "/scripts";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Builds a `NodeJS.ErrnoException` the way a real `fs` failure would carry
 * one, mirroring `packages/m3l-cli/tests/report-lookup.test.ts`'s
 * `errnoError` helper.
 */
function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Stubs `fs.lstatSync` to report a plain (non-symlink) directory entry —
 * the fixture every mocked happy-path test below needs once the guard stops
 * trusting an un-stat-able path by default: these tests assert an ordinary
 * directory resolves, so they must say so explicitly rather than relying on
 * a thrown `lstatSync` (which the fictional `SCRIPTS_ROOT = "/scripts"`
 * would otherwise produce, since no such path exists on disk).
 */
function mockLstatSyncNotSymlink(): void {
  vi.spyOn(fs, "lstatSync").mockImplementation((() => ({
    isSymbolicLink: () => false,
  })) as unknown as typeof fs.lstatSync);
}

describe("resolveScript — happy path", () => {
  test("resolves a script with a command module present", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    mockLstatSyncNotSymlink();

    const resolved = resolveScript("sqs-etl", SCRIPTS_ROOT);

    expect(resolved).toEqual({
      name: "sqs-etl",
      scriptsRoot: SCRIPTS_ROOT,
      scriptDir: path.join(SCRIPTS_ROOT, "sqs-etl"),
      hasCommandModule: true,
    });
  });

  test("calls existsSync exactly twice: once for the dir, once for command.ts", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    mockLstatSyncNotSymlink();

    resolveScript("sqs-etl", SCRIPTS_ROOT);

    expect(existsSyncSpy).toHaveBeenCalledTimes(2);
    expect(existsSyncSpy).toHaveBeenNthCalledWith(
      1,
      path.join(SCRIPTS_ROOT, "sqs-etl"),
    );
    expect(existsSyncSpy).toHaveBeenNthCalledWith(
      2,
      path.join(SCRIPTS_ROOT, "sqs-etl", "dist", "command.js"),
    );
  });
});

describe("resolveScript — script without a command module", () => {
  test("hasCommandModule is false when dist/command.js is absent", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (target: fs.PathLike) => !String(target).endsWith("command.js"),
    );
    mockLstatSyncNotSymlink();

    const resolved = resolveScript("json-etl", SCRIPTS_ROOT);

    expect(resolved.hasCommandModule).toBe(false);
  });
});

describe("resolveScript — script directory not found", () => {
  test("throws ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND when the script directory does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    let thrown: unknown;
    try {
      resolveScript("missing-script", SCRIPTS_ROOT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
  });
});

// --- X10b: fail-closed on an un-stat-able scriptDir -----------------------
//
// `isSymlinkEntry` currently swallows a thrown `lstatSync` and reports
// `false` ("not a symlink"), which `isContained` then trusts immediately —
// skipping the containment check entirely. That is the guard FAILING OPEN:
// an un-stat-able path is treated as safe rather than untrusted. These
// tests isolate the `lstatSync` arm specifically (via `existsSync` mocked
// `true` so `isContained` is actually reached) and assert the fail-CLOSED
// contract: any `lstatSync` failure must reject with
// "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND", never fall through to trust the path.
//
// Both tests are expected to FAIL against the currently-shipped guard,
// which returns `true` ("resolves", i.e. does not throw) instead.
describe("resolveScript — fails closed when lstatSync cannot be trusted", () => {
  test("an ENOENT-style lstatSync failure still rejects rather than trusting the path", () => {
    // This is the TOCTOU race the source's own comment rationalizes as
    // "safe to fail open, since nothing remains at the path to import" —
    // but failing CLOSED is still the correct default here too: the guard
    // should never rely on a race window being safe by construction, and a
    // caller cannot distinguish "genuinely gone" from "briefly un-stat-able
    // for some other reason" from the outside.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw errnoError("ENOENT");
    });

    let thrown: unknown;
    try {
      resolveScript("sqs-etl", SCRIPTS_ROOT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
  });

  test("an EACCES-style lstatSync failure still rejects rather than trusting the path", () => {
    // Unlike ENOENT, an EACCES failure means something DOES still exist at
    // scriptDir — it just could not be stat'd (e.g. a permission-denied
    // intermediate directory). "Nothing remains to import" is therefore not
    // a valid reason to fail open here: whatever is actually at that path
    // (which the guard never got to inspect) is exactly what containment
    // exists to check, so trusting it by default is the fail-open bug, not
    // a benign degradation.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw errnoError("EACCES");
    });

    let thrown: unknown;
    try {
      resolveScript("sqs-etl", SCRIPTS_ROOT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
  });
});

describe("resolveScript — scriptDir composition", () => {
  test("scriptDir is path.join(scriptsRoot, scriptName)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    mockLstatSyncNotSymlink();

    const resolved = resolveScript("sqs-etl", "/some/other/root");

    expect(resolved.scriptDir).toBe(path.join("/some/other/root", "sqs-etl"));
  });
});

describe("resolveScript — invalid scriptName pattern", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST without calling existsSync", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    let thrown: unknown;
    try {
      resolveScript("MyScript", SCRIPTS_ROOT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(existsSyncSpy).not.toHaveBeenCalled();
  });
});

describe("M3LResolvedScript", () => {
  test("has the exact readonly field shape the contract declares", () => {
    expectTypeOf<M3LResolvedScript>().toEqualTypeOf<{
      readonly name: string;
      readonly scriptsRoot: string;
      readonly scriptDir: string;
      readonly hasCommandModule: boolean;
    }>();
  });
});

// --- X10b Fix A: symlink containment (confirmed exploit) ----------------
//
// `resolveScript` currently uses `fs.existsSync(scriptDir)`, which FOLLOWS
// symlinks, and rebuilds the path with a bare `path.join` — a symlinked
// directory inside `scriptsRoot` pointing anywhere on disk resolves
// successfully today. The fix (not yet landed) is to `fs.realpathSync` both
// `scriptsRoot` and the resolved `scriptDir`, and require the real script
// directory to be a direct child of the real scripts root.
//
// These tests use REAL directories and REAL symlinks (see file header):
// the containment guarantee is a filesystem-realpath property that a
// mocked `existsSync` cannot exercise.
describe("resolveScript — symlink containment (Fix A)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "m3l-resolver-symlink-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a symlinked directory inside scriptsRoot pointing OUTSIDE it throws ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "m3l-resolver-outside-"));
    try {
      symlinkSync(outside, path.join(root, "escaped"));

      let thrown: unknown;
      try {
        resolveScript("escaped", root);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a symlink pointing to another real directory INSIDE the same scriptsRoot is also rejected", () => {
    // Reasoning: the fix's rule ("realpath'd script directory must be a
    // direct child of the realpath'd scripts root") is strictest — and
    // consistent with catalog.ts's existing fail-closed exclusion of ANY
    // symlinked entry — when read as requiring the FULL resolved path to
    // match, not just its parent directory: `fs.realpathSync(scriptDir)`
    // must equal `path.join(realpathSync(scriptsRoot), scriptName)`.
    // Here `fs.realpathSync(join(root, "link-to-real-target"))` resolves to
    // `<root>/real-target` (a different basename than the requested name),
    // so the equality fails and the request is rejected — even though
    // "real-target"'s own parent directory IS `root`. A looser check that
    // only compared parent directories would let this one through, but
    // that would make `resolveScript` treat a symlink alias to a sibling
    // script as equivalent to the real thing, which `listScriptSummaries`
    // never lists in the first place (Dirent.isSymbolicLink() exclusion) —
    // list and detail would disagree again, the exact defect Fix A closes.
    mkdirSync(path.join(root, "real-target"));
    symlinkSync(
      path.join(root, "real-target"),
      path.join(root, "link-to-real-target"),
    );

    let thrown: unknown;
    try {
      resolveScript("link-to-real-target", root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
  });

  test("a real directory still resolves normally (regression guard)", () => {
    mkdirSync(path.join(root, "real-script"));

    const resolved = resolveScript("real-script", root);

    expect(resolved.scriptDir).toBe(path.join(root, "real-script"));
    expect(resolved.scriptsRoot).toBe(root);
  });

  test("the scripts root itself reached through a symlinked parent path still resolves its real children", () => {
    // The case a naive startsWith(realpath) check breaks: scriptsRoot is
    // itself a symlink to `root`. realpathSync(scriptsRoot) === root, and
    // realpathSync(join(scriptsRoot, "real-script")) === join(root,
    // "real-script") too (no symlink at the entry level, only at the root),
    // so the direct-child check must hold and this must resolve — NOT throw.
    mkdirSync(path.join(root, "real-script"));
    const rootLink = mkdtempSync(
      path.join(tmpdir(), "m3l-resolver-root-holder-"),
    );
    rmSync(rootLink, { recursive: true, force: true });
    symlinkSync(root, rootLink);

    try {
      const resolved = resolveScript("real-script", rootLink);

      expect(resolved.scriptDir).toBe(path.join(rootLink, "real-script"));
      expect(resolved.scriptsRoot).toBe(rootLink);
    } finally {
      rmSync(rootLink, { force: true });
    }
  });

  test("a symlink whose target vanishes between existsSync and realpathSync still rejects (dangling symlink)", () => {
    // Exercises `isContainedSymlink`'s own `catch { return false; }` — a
    // branch no other test reaches. A GENUINELY dangling symlink (target
    // already gone before `resolveScript` runs) never gets here at all:
    // `fs.existsSync` follows the link and already reports `false` for a
    // dangling target, so `resolveScript` rejects at its own `existsSync`
    // check before `isContained` is ever called. To reach the
    // `realpathSync` catch specifically, the target must still exist when
    // `resolveScript`'s `existsSync(scriptDir)` check runs, and vanish only
    // afterwards but before `isContainedSymlink`'s `realpathSync(scriptDir)`
    // call — a real TOCTOU race. `fs.lstatSync` inspects the symlink entry
    // itself (never the target), so it stays real and untouched here; only
    // it is wrapped to trigger the target's removal at the exact right
    // moment, using real `rmSync` on a real directory.
    const target = mkdtempSync(path.join(tmpdir(), "m3l-resolver-target-"));
    const scriptDir = path.join(root, "vanishing");
    symlinkSync(target, scriptDir);

    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation((candidate: fs.PathLike) => {
      const stats = realLstatSync(candidate);
      if (String(candidate) === scriptDir) {
        rmSync(target, { recursive: true, force: true });
      }
      return stats;
    });

    let thrown: unknown;
    try {
      resolveScript("vanishing", root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
  });
});

// --- X10b Fix C: untruncated name echo (should-fix) ----------------------
//
// `resolveScript`'s "not found" message interpolates `scriptName`
// untruncated. A caller-controlled, pattern-valid but very long name is
// reflected in full into the 404 body today. The fix caps the echoed
// portion the same way `http/routes/runs.ts`'s `MAX_ECHOED_STATUS_LENGTH`
// caps `?status=` — 32 characters.
describe("resolveScript — script name is bounded when echoed into the not-found message (Fix C)", () => {
  test("a 4000-character valid-pattern name is echoed to at most 32 characters", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // Matches SCRIPT_NAME_PATTERN (^[a-z][a-z0-9-]*$) fine: 4000 lowercase
    // characters, no uppercase/whitespace/punctuation to trip the guard
    // that runs before the filesystem check.
    const longName = "a" + "b".repeat(3999);
    expect(longName).toHaveLength(4000);

    let thrown: unknown;
    try {
      resolveScript(longName, SCRIPTS_ROOT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    // Bound, not an exact string — the fix owns the exact phrasing. The
    // full 4000-char name, and even 33 contiguous characters of it, must
    // never appear; the whole message must stay well short of the
    // untruncated ~4040-byte body the audit measured.
    expect(message).not.toContain(longName);
    expect(message).not.toContain(longName.slice(0, 33));
    expect(message.length).toBeLessThan(150);
  });

  test("a normal short script name is still echoed in full (no over-truncation)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    let thrown: unknown;
    try {
      resolveScript("missing-script", SCRIPTS_ROOT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).toContain("missing-script");
  });
});
