import { join } from "node:path";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  shimsDir,
  isLefthookShim,
  shimFailsOpen,
  classifyShim,
  scanShims,
} from "../lib/lefthook-shim.mjs";
import { runLefthookShimCheck } from "../check-lefthook-shim.mjs";
import { createReporter } from "../lib/report.mjs";

// The ACTUAL installed shim text from this repo (captured live), pre-#1097
// fix: the unresolved-binary branch falls through with no `exit 1`.
const FAIL_OPEN_SHIM = `#!/bin/sh

if [ "$LEFTHOOK_VERBOSE" = "1" -o "$LEFTHOOK_VERBOSE" = "true" ]; then
  set -x
fi

if [ "$LEFTHOOK" = "0" ]; then
  exit 0
fi

call_lefthook()
{
  if test -n "$LEFTHOOK_BIN"
  then
    "$LEFTHOOK_BIN" "$@"
  elif lefthook -h >/dev/null 2>&1
  then
    lefthook "$@"
  else
    dir="$(git rev-parse --show-toplevel)"
    osArch=$(uname | tr '[:upper:]' '[:lower:]')
    cpuArch=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')
    if test -f "$dir/node_modules/lefthook-\${osArch}-\${cpuArch}/bin/lefthook"
    then
      "$dir/node_modules/lefthook-\${osArch}-\${cpuArch}/bin/lefthook" "$@"
    else
      echo "Can't find lefthook in PATH"
    fi
  fi
}

call_lefthook run "pre-push" "$@"
`;

// Same file, post-#1097 fix: `assert_lefthook_installed: true`'s four extra
// lines added right after the echo, still inside the branch's own `fi`.
const ASSERTING_SHIM = `#!/bin/sh

if [ "$LEFTHOOK_VERBOSE" = "1" -o "$LEFTHOOK_VERBOSE" = "true" ]; then
  set -x
fi

if [ "$LEFTHOOK" = "0" ]; then
  exit 0
fi

call_lefthook()
{
  if test -n "$LEFTHOOK_BIN"
  then
    "$LEFTHOOK_BIN" "$@"
  elif lefthook -h >/dev/null 2>&1
  then
    lefthook "$@"
  else
    dir="$(git rev-parse --show-toplevel)"
    osArch=$(uname | tr '[:upper:]' '[:lower:]')
    cpuArch=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')
    if test -f "$dir/node_modules/lefthook-\${osArch}-\${cpuArch}/bin/lefthook"
    then
      "$dir/node_modules/lefthook-\${osArch}-\${cpuArch}/bin/lefthook" "$@"
    else
      echo "Can't find lefthook in PATH"
      echo "ERROR: Operation is aborted due to lefthook settings."
      echo "Make sure lefthook is available in your environment and re-try."
      echo "To skip these checks use --no-verify git argument or set LEFTHOOK=0 env variable."
      exit 1
    fi
  fi
}

call_lefthook run "pre-push" "$@"
`;

const NON_LEFTHOOK_SHIM = "#!/bin/sh\necho husky\n";

describe("shimsDir", () => {
  test("joins the git common dir to hooks/ using path.join semantics", () => {
    expect(shimsDir("/repo/.git")).toBe(join("/repo/.git", "hooks"));
  });

  expectTypeOf(shimsDir).returns.toBeString();
});

describe("isLefthookShim", () => {
  test("true for the fail-open shim fixture", () => {
    expect(isLefthookShim(FAIL_OPEN_SHIM)).toBe(true);
  });

  test("true for the assert-closed shim fixture", () => {
    expect(isLefthookShim(ASSERTING_SHIM)).toBe(true);
  });

  test("false for a plain non-lefthook script", () => {
    expect(isLefthookShim(NON_LEFTHOOK_SHIM)).toBe(false);
  });

  test("false for an empty string", () => {
    expect(isLefthookShim("")).toBe(false);
  });

  expectTypeOf(isLefthookShim).returns.toBeBoolean();
});

describe("shimFailsOpen", () => {
  test("true for the fail-open shim (no exit 1 in the unresolved-binary branch)", () => {
    expect(shimFailsOpen(FAIL_OPEN_SHIM)).toBe(true);
  });

  test("false for the assert-closed shim (exit 1 present in the branch)", () => {
    expect(shimFailsOpen(ASSERTING_SHIM)).toBe(false);
  });

  test("false when the recognizable echo line is entirely absent", () => {
    const synthetic = [
      "#!/bin/sh",
      "call_lefthook()",
      "{",
      '  echo "something else entirely"',
      "}",
      'call_lefthook run "pre-push" "$@"',
    ].join("\n");
    expect(shimFailsOpen(synthetic)).toBe(false);
  });

  test("branch-bounded: an exit 1 elsewhere in the file (a different, earlier if/fi) does not count", () => {
    const synthetic = [
      "#!/bin/sh",
      'if [ "$SOMETHING" = "1" ]; then',
      "  exit 1",
      "fi",
      "",
      "call_lefthook()",
      "{",
      '  if test -n "$LEFTHOOK_BIN"',
      "  then",
      '    "$LEFTHOOK_BIN" "$@"',
      "  else",
      '    echo "Can\'t find lefthook in PATH"',
      "  fi",
      "}",
      "",
      'call_lefthook run "pre-push" "$@"',
    ].join("\n");
    // The unrelated exit 1 sits above the echo line, in a different branch;
    // the branch actually containing the echo has no exit 1 of its own.
    expect(shimFailsOpen(synthetic)).toBe(true);
  });

  expectTypeOf(shimFailsOpen).returns.toBeBoolean();
});

describe("classifyShim", () => {
  test("null source yields present:false, isLefthook:false, failsOpen:false", () => {
    expect(classifyShim(null)).toEqual({
      present: false,
      isLefthook: false,
      failsOpen: false,
    });
  });

  test("the fail-open fixture classifies as present, lefthook, failing open", () => {
    expect(classifyShim(FAIL_OPEN_SHIM)).toEqual({
      present: true,
      isLefthook: true,
      failsOpen: true,
    });
  });

  test("the assert-closed fixture classifies as present, lefthook, not failing open", () => {
    expect(classifyShim(ASSERTING_SHIM)).toEqual({
      present: true,
      isLefthook: true,
      failsOpen: false,
    });
  });

  test("non-lefthook content classifies isLefthook:false and failsOpen:false, never evaluating failsOpen on it", () => {
    expect(classifyShim(NON_LEFTHOOK_SHIM)).toEqual({
      present: true,
      isLefthook: false,
      failsOpen: false,
    });
  });

  expectTypeOf(classifyShim).returns.toEqualTypeOf<{
    present: boolean;
    isLefthook: boolean;
    failsOpen: boolean;
  }>();
});

/**
 * A dispatch-by-path readFile fixture: throws for any path not explicitly
 * mapped by basename, so an unexpected read in a test surfaces loudly rather
 * than silently returning `undefined`.
 */
function makeReadFile(
  filesByName: Record<string, string | (() => string)>,
): (path: string) => string {
  return (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!Object.hasOwn(filesByName, name)) {
      throw new Error(`unexpected readFile in test fixture: ${path}`);
    }
    const entry = filesByName[name];
    return typeof entry === "function" ? entry() : (entry as string);
  };
}

describe("scanShims", () => {
  test("a mixed directory returns only real hook names, sorted, excluding dotted filenames (git samples and .old backups)", () => {
    const readdir = () => [
      "pre-push",
      "commit-msg",
      "pre-push.sample",
      "post-rewrite.old",
    ];
    const readFile = makeReadFile({
      "pre-push": FAIL_OPEN_SHIM,
      "commit-msg": ASSERTING_SHIM,
      "pre-push.sample": "# git sample hook, not installed\n",
      // reuses FAIL_OPEN_SHIM as content — proves a still-lefthook-shaped,
      // still-fail-open backup is excluded on filename alone, not content.
      "post-rewrite.old": FAIL_OPEN_SHIM,
    });

    const result = scanShims("/fake/.git/hooks", { readdir, readFile });

    expect(result).toEqual([
      {
        hookName: "commit-msg",
        present: true,
        isLefthook: true,
        failsOpen: false,
      },
      {
        hookName: "pre-push",
        present: true,
        isLefthook: true,
        failsOpen: true,
      },
    ]);
  });

  test("a missing directory (readdir throws) returns []", () => {
    const readdir = () => {
      throw new Error("ENOENT: no such directory");
    };
    const readFile = () => {
      throw new Error("should not be called");
    };
    expect(scanShims("/fake/missing", { readdir, readFile })).toEqual([]);
  });

  test("an entry whose readFile throws (e.g. a directory entry) is skipped, not thrown from scanShims", () => {
    const readdir = () => ["pre-push", "a-subdir"];
    const readFile = (path: string) => {
      if (path.endsWith("a-subdir")) {
        throw new Error("EISDIR: illegal operation on a directory");
      }
      return ASSERTING_SHIM;
    };
    expect(() =>
      scanShims("/fake/.git/hooks", { readdir, readFile }),
    ).not.toThrow();
    expect(scanShims("/fake/.git/hooks", { readdir, readFile })).toEqual([
      {
        hookName: "pre-push",
        present: true,
        isLefthook: true,
        failsOpen: false,
      },
    ]);
  });

  test("a non-lefthook file (e.g. a husky hook) is excluded from results", () => {
    const readdir = () => ["pre-push", "pre-commit"];
    const readFile = makeReadFile({
      "pre-push": ASSERTING_SHIM,
      "pre-commit": NON_LEFTHOOK_SHIM,
    });
    const result = scanShims("/fake/.git/hooks", { readdir, readFile });
    expect(result).toEqual([
      {
        hookName: "pre-push",
        present: true,
        isLefthook: true,
        failsOpen: false,
      },
    ]);
  });

  expectTypeOf(scanShims).returns.toBeArray();
});

describe("runLefthookShimCheck", () => {
  test("a fail-open pre-push shim yields ok:false and warns once", () => {
    const reporter = createReporter(false);
    const outcome = runLefthookShimCheck({
      runGit: () => "/fake/common/dir\n",
      readdir: () => ["pre-push"],
      readFile: () => FAIL_OPEN_SHIM,
      reporter,
    });

    expect(outcome).toEqual({
      ok: false,
      shims: [
        {
          hookName: "pre-push",
          present: true,
          isLefthook: true,
          failsOpen: true,
        },
      ],
    });
    expect((reporter.finish({})["warnings"] as string[]).length).toBe(1);
  });

  test("all shims assert closed yields ok:true, zero warnings, and a succeed summary", () => {
    const reporter = createReporter(false);
    const outcome = runLefthookShimCheck({
      runGit: () => "/fake/common/dir\n",
      readdir: () => ["pre-push"],
      readFile: () => ASSERTING_SHIM,
      reporter,
    });

    expect(outcome).toEqual({
      ok: true,
      shims: [
        {
          hookName: "pre-push",
          present: true,
          isLefthook: true,
          failsOpen: false,
        },
      ],
    });
    const payload = reporter.finish({});
    expect(payload["warnings"]).toEqual([]);
    expect(payload["summary"]).toBe(
      "1 installed lefthook shim(s) all fail closed.",
    );
  });

  test("no shims found at all yields ok:true with the 'nothing to check' summary, distinct from the 'all fail closed' summary", () => {
    const reporter = createReporter(false);
    const outcome = runLefthookShimCheck({
      runGit: () => "/fake/common/dir\n",
      readdir: () => [],
      readFile: () => {
        throw new Error("should not be called");
      },
      reporter,
    });

    expect(outcome).toEqual({ ok: true, shims: [] });
    const payload = reporter.finish({});
    expect(payload["summary"]).toBe(
      "No installed lefthook shims found (nothing to check).",
    );
    expect(payload["summary"]).not.toBe(
      "1 installed lefthook shim(s) all fail closed.",
    );
  });

  test("runGit throwing is treated as skip-not-error: does not throw, warns once, returns ok:true with no shims", () => {
    const reporter = createReporter(false);
    let outcome: ReturnType<typeof runLefthookShimCheck> | undefined;
    expect(() => {
      outcome = runLefthookShimCheck({
        runGit: () => {
          throw new Error("git: command not found");
        },
        readdir: () => {
          throw new Error("should not be called");
        },
        readFile: () => {
          throw new Error("should not be called");
        },
        reporter,
      });
    }).not.toThrow();

    expect(outcome).toEqual({ ok: true, shims: [] });
    expect((reporter.finish({})["warnings"] as string[]).length).toBe(1);
  });

  expectTypeOf(runLefthookShimCheck).returns.toMatchTypeOf<{
    ok: boolean;
    shims: unknown[];
  }>();
});
