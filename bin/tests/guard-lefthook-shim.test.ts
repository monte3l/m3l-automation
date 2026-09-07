import { describe, expect, expectTypeOf, it } from "vitest";
import { shouldBlockPush } from "../../.claude/hooks/guard-lefthook-shim.mjs";

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

describe("allow cases (returns false)", () => {
  it("allows a non-push command regardless of dryRun or shim content", () => {
    expect(shouldBlockPush(false, false, FAIL_OPEN_SHIM)).toBe(false);
  });

  it("allows a non-push dry-run-flagged command with a fail-open shim", () => {
    expect(shouldBlockPush(false, true, FAIL_OPEN_SHIM)).toBe(false);
  });

  it("allows a push dry-run even with a fail-open shim", () => {
    expect(shouldBlockPush(true, true, FAIL_OPEN_SHIM)).toBe(false);
  });

  it("allows a real push when the installed shim asserts closed", () => {
    expect(shouldBlockPush(true, false, ASSERTING_SHIM)).toBe(false);
  });

  it("allows a real push when there is no installed shim at all", () => {
    expect(shouldBlockPush(true, false, null)).toBe(false);
  });

  it("allows a real push when the installed hook is not a lefthook shim", () => {
    expect(shouldBlockPush(true, false, NON_LEFTHOOK_SHIM)).toBe(false);
  });
});

describe("block case (returns true)", () => {
  it("blocks a real push when the installed shim fails open", () => {
    expect(shouldBlockPush(true, false, FAIL_OPEN_SHIM)).toBe(true);
  });
});

expectTypeOf(shouldBlockPush).returns.toBeBoolean();
