import { describe, expect, test } from "vitest";
import {
  parseSessionsFlag,
  buildEarlyoomOverride,
  classifyEarlyoomState,
  buildUserSliceOverride,
  buildClaudeRcOverride,
  extractMemoryMaxGiB,
  extractGiBSuffix,
  shouldSerializePrePush,
  buildLefthookLocalOverride,
} from "../../bin/setup-host-resources.mjs";

describe("parseSessionsFlag", () => {
  test("parses a valid --sessions=N flag", () => {
    expect(parseSessionsFlag(["--sessions=3"])).toBe(3);
  });

  test("defaults to 2 when the flag is absent", () => {
    expect(parseSessionsFlag([])).toBe(2);
  });

  test("defaults to 2 for a non-numeric value", () => {
    expect(parseSessionsFlag(["--sessions=abc"])).toBe(2);
  });

  test("defaults to 2 for zero", () => {
    expect(parseSessionsFlag(["--sessions=0"])).toBe(2);
  });

  test("defaults to 2 for a negative value", () => {
    expect(parseSessionsFlag(["--sessions=-1"])).toBe(2);
  });

  test("finds the flag regardless of its position in argv", () => {
    expect(parseSessionsFlag(["--other=flag", "--sessions=5"])).toBe(5);
  });
});

describe("buildEarlyoomOverride", () => {
  test("produces a systemd override with the tuned ExecStart", () => {
    const unit = buildEarlyoomOverride();
    expect(unit).toContain("[Service]");
    expect(unit).toContain("ExecStart=/usr/bin/earlyoom");
    expect(unit).toContain("--avoid");
    expect(unit).toContain("--prefer");
  });

  test("--prefer regex matches Node's real comm values but not the literal 'node' token", () => {
    const unit = buildEarlyoomOverride();
    const match = /--prefer '([^']+)'/.exec(unit);
    expect(match).not.toBeNull();
    const prefer = new RegExp(match?.[1] ?? "");
    expect(prefer.test("MainThread")).toBe(true);
    expect(prefer.test("node-MainThread")).toBe(true);
    expect(prefer.test("node")).toBe(false);
  });

  test("--prefer regex does not match 'claude' (regression: must not boost the interactive session's own kill-priority)", () => {
    const unit = buildEarlyoomOverride();
    const match = /--prefer '([^']+)'/.exec(unit);
    expect(match).not.toBeNull();
    const prefer = new RegExp(match?.[1] ?? "");
    expect(prefer.test("claude")).toBe(false);
  });

  test("--avoid regex is unaffected by the --prefer fix and still protects sshd/tmux", () => {
    const unit = buildEarlyoomOverride();
    const match = /--avoid '([^']+)'/.exec(unit);
    expect(match).not.toBeNull();
    const avoid = new RegExp(match?.[1] ?? "");
    expect(avoid.test("sshd")).toBe(true);
    expect(avoid.test("tmux")).toBe(true);
  });

  test("--avoid regex matches 'claude' (regression: the interactive session must be protected by avoid, not just by no-longer-preferring it)", () => {
    const unit = buildEarlyoomOverride();
    const match = /--avoid '([^']+)'/.exec(unit);
    expect(match).not.toBeNull();
    const avoid = new RegExp(match?.[1] ?? "");
    expect(avoid.test("claude")).toBe(true);
  });

  test("the -s free-swap floor is raised to at least 50 (was hardcoded to earlyoom's default of 10)", () => {
    const unit = buildEarlyoomOverride();
    const match = /-s (\d+)/.exec(unit);
    expect(match).not.toBeNull();
    const swapFreeMinPercent = Number(match?.[1]);
    expect(swapFreeMinPercent).toBeGreaterThanOrEqual(50);
  });

  test("the -m memory floor stays at 5 (unchanged by the -s fix)", () => {
    const unit = buildEarlyoomOverride();
    const match = /-m (\d+)/.exec(unit);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(5);
  });
});

describe("classifyEarlyoomState", () => {
  test("not active with a null override -> install", () => {
    expect(
      classifyEarlyoomState({ active: false, existingOverride: null }),
    ).toBe("install");
  });

  test("not active, even with an existing override that matches the current build -> install", () => {
    // Regardless of on-disk content, an inactive service must be (re)installed
    // and enabled — content comparison only matters once the service is live.
    expect(
      classifyEarlyoomState({
        active: false,
        existingOverride: buildEarlyoomOverride(),
      }),
    ).toBe("install");
  });

  test("active with an override byte-identical to the current build -> current", () => {
    expect(
      classifyEarlyoomState({
        active: true,
        existingOverride: buildEarlyoomOverride(),
      }),
    ).toBe("current");
  });

  test("active with a null override (service running without this script's drop-in) -> refresh", () => {
    expect(
      classifyEarlyoomState({ active: true, existingOverride: null }),
    ).toBe("refresh");
  });

  test("active with a stale override that differs from the current build -> refresh", () => {
    const staleOverride =
      "# Managed by bin/setup-host-resources.mjs (ADR-0080) — safe to\n" +
      "# regenerate; re-run `--apply` after any of its earlyoom constants change.\n" +
      "[Service]\n" +
      "ExecStart=\n" +
      "ExecStart=/usr/bin/earlyoom -m 5 -s 10 --avoid '^(sshd|systemd|tmux|sudo|dbus-daemon)$' --prefer '^(node|claude|vitest|tsc|esbuild)$'\n";
    expect(
      classifyEarlyoomState({ active: true, existingOverride: staleOverride }),
    ).toBe("refresh");
  });
});

describe("buildUserSliceOverride", () => {
  test("reserves a fixed 2 GiB for the OS and gives the rest to the user-slice ceiling", () => {
    // totalBudgetGiB = max(4, floor(16 - 2)) = 14; MemoryHigh = max(2, 13) = 13.
    expect(buildUserSliceOverride(16)).toBe(
      "[Slice]\nMemoryMax=14G\nMemoryHigh=13G\n",
    );
  });

  test("floors MemoryMax to the minimum of 4 on a small host where the OS reserve would leave less", () => {
    // totalBudgetGiB = max(4, floor(4 - 2)) = max(4, 2) = 4; MemoryHigh = max(2, 3) = 3.
    expect(buildUserSliceOverride(4)).toBe(
      "[Slice]\nMemoryMax=4G\nMemoryHigh=3G\n",
    );
  });

  // No case exercises the Math.max(2, totalBudgetGiB - 1) floor on MemoryHigh:
  // totalBudgetGiB is already floored at 4 by the check above, so
  // totalBudgetGiB - 1 >= 3 always holds and the MemoryHigh floor of 2 is
  // unreachable given the MemoryMax floor's own minimum.
});

describe("buildClaudeRcOverride", () => {
  test("produces the fixed MemoryMax + OOMPolicy drop-in", () => {
    expect(buildClaudeRcOverride()).toBe(
      "[Service]\nMemoryMax=6G\nOOMPolicy=kill\n",
    );
  });
});

describe("extractMemoryMaxGiB", () => {
  test("extracts the integer GiB value from a MemoryMax=<N>G line", () => {
    expect(
      extractMemoryMaxGiB("[Slice]\nMemoryMax=14G\nMemoryHigh=13G\n"),
    ).toBe(14);
  });

  test("returns null when no MemoryMax line is present", () => {
    expect(extractMemoryMaxGiB("[Slice]\nMemoryHigh=13G\n")).toBeNull();
  });

  test("returns null (not 0) for an unparseable MemoryMax value like infinity", () => {
    expect(extractMemoryMaxGiB("[Slice]\nMemoryMax=infinity\n")).toBeNull();
  });
});

describe("extractGiBSuffix", () => {
  test("extracts the integer GiB value from a plain <N>G string", () => {
    expect(extractGiBSuffix("6G")).toBe(6);
  });

  test("returns null for a value that isn't the exact <N>G shape", () => {
    expect(extractGiBSuffix("infinity")).toBeNull();
    expect(extractGiBSuffix("6")).toBeNull();
    expect(extractGiBSuffix("6GB")).toBeNull();
  });
});

describe("shouldSerializePrePush", () => {
  test("returns true when total memory is well under the threshold", () => {
    expect(shouldSerializePrePush(16)).toBe(true);
  });

  test("returns false when total memory is well over the threshold", () => {
    expect(shouldSerializePrePush(23.4)).toBe(false);
  });

  test("returns false exactly at the threshold (strict less-than)", () => {
    expect(shouldSerializePrePush(20)).toBe(false);
  });

  test("returns true just under the threshold", () => {
    expect(shouldSerializePrePush(19.9)).toBe(true);
  });
});

describe("buildLefthookLocalOverride", () => {
  test("produces the exact serialization drop-in for a given host RAM size", () => {
    expect(buildLefthookLocalOverride(16)).toBe(
      "# Generated by bin/setup-host-resources.mjs (ADR-0080) — gitignored,\n" +
        "# per-machine. This host has 16 GiB RAM (< 20 GiB);\n" +
        "# pre-push's heavy lanes (test/typecheck/build-exports) run SERIALLY here\n" +
        "# instead of lefthook.yml's shared `parallel: true`, to avoid oversubscribing\n" +
        "# a memory-constrained box. Delete this file, or re-run\n" +
        "# `node bin/setup-host-resources.mjs --apply` after a RAM upgrade, to\n" +
        "# restore the default parallel behavior.\n" +
        "pre-push:\n" +
        "  parallel: false\n",
    );
  });

  test("contains the load-bearing markers regardless of exact wording", () => {
    const override = buildLefthookLocalOverride(16);
    expect(override).toContain("parallel: false");
    expect(override).toContain("pre-push:");
    expect(override).toContain("bin/setup-host-resources.mjs");
  });

  test("interpolates a non-integer memory value correctly", () => {
    expect(buildLefthookLocalOverride(15.5)).toContain("15.5 GiB RAM");
  });
});
