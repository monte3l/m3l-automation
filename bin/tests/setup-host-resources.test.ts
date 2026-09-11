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
  platformStepSkips,
} from "../../bin/setup-host-resources.mjs";
import { recommendToolMemoryLimitGiB } from "../../bin/check-host-resources.mjs";

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
  test("derives MemoryMax from the tool memory limit plus a 2 GiB margin (23 GiB / 2 sessions)", () => {
    // recommendToolMemoryLimitGiB(23, 2) = floor((23-2)/2 - 1) = floor(9.5) = 9
    // MemoryMax = 9 + 2 = 11
    expect(buildClaudeRcOverride(23, 2)).toBe(
      "[Service]\nMemoryMax=11G\nOOMPolicy=kill\n",
    );
  });

  test("derives MemoryMax from the tool memory limit plus a 2 GiB margin (24 GiB / 2 sessions)", () => {
    // recommendToolMemoryLimitGiB(24, 2) = floor((24-2)/2 - 1) = floor(10) = 10
    // MemoryMax = 10 + 2 = 12
    expect(buildClaudeRcOverride(24, 2)).toBe(
      "[Service]\nMemoryMax=12G\nOOMPolicy=kill\n",
    );
  });
});

describe("buildClaudeRcOverride — invariant", () => {
  test.each([
    [16, 1],
    [23, 2],
    [24, 2],
    [32, 2],
    [64, 4],
    // Hits recommendToolMemoryLimitGiB's Math.max(2, ...) clamp: raw =
    // floor((4-2)/1 - 1) = floor(1) = 1, which is < 2 and clamps to 2.
    [4, 1],
  ])(
    "MemoryMax stays above the tool memory limit for %i GiB / %i session(s)",
    (totalMemGiB, sessions) => {
      const toolLimitGiB = recommendToolMemoryLimitGiB(totalMemGiB, sessions);
      const rcMemoryMaxGiB = extractMemoryMaxGiB(
        buildClaudeRcOverride(totalMemGiB, sessions),
      );
      expect(rcMemoryMaxGiB).toBeGreaterThan(toolLimitGiB);
    },
  );
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

// HostBudget-shaped fixtures (bin/lib/host-profile.mjs's deriveBudget()
// return shape) — shouldSerializePrePush/buildLefthookLocalOverride now read
// the same live host-budget signal bin/verify-all.mjs's --jobs default uses
// (concurrentLaneWorkers), not a raw totalMemGiB number.
const isolatedBudget = {
  effectiveCores: 4,
  sessions: 2,
  perSessionCores: 2,
  memoryBoundWorkers: 1,
  workers: 1,
  limitedBy: "memory" as const,
  concurrentLaneWorkers: 1,
};
const concurrentBudget = {
  effectiveCores: 4,
  sessions: 1,
  perSessionCores: 4,
  memoryBoundWorkers: 8,
  workers: 4,
  limitedBy: "cpu" as const,
  concurrentLaneWorkers: 2,
};

describe("shouldSerializePrePush", () => {
  test("returns true when concurrentLaneWorkers is 1", () => {
    expect(shouldSerializePrePush(isolatedBudget)).toBe(true);
  });

  test("returns false when concurrentLaneWorkers is 2", () => {
    expect(shouldSerializePrePush(concurrentBudget)).toBe(false);
  });
});

describe("buildLefthookLocalOverride", () => {
  test("produces the exact serialization drop-in for a given host budget", () => {
    expect(buildLefthookLocalOverride(isolatedBudget)).toBe(
      "# Generated by bin/setup-host-resources.mjs (ADR-0080 / P3.5 of\n" +
        "# adaptive-host-budgeting) — gitignored, per-machine. This host's derived\n" +
        "# lane budget is 1 concurrent lane worker(s) (effectiveCores=4, sessions=2, " +
        "limitedBy=memory);\n" +
        "# pre-push's heavy lanes (test/typecheck/build-exports) run SERIALLY here\n" +
        "# instead of lefthook.yml's shared `parallel: true`, to avoid oversubscribing\n" +
        "# this host — the same signal `pnpm verify --isolated` names explicitly\n" +
        "# (bin/lib/host-profile.mjs's deriveBudget().concurrentLaneWorkers). Delete\n" +
        "# this file, or re-run `node bin/setup-host-resources.mjs --apply` after\n" +
        "# conditions change (more RAM, fewer concurrent sessions), to restore the\n" +
        "# default parallel behavior.\n" +
        "pre-push:\n" +
        "  parallel: false\n",
    );
  });

  test("contains the load-bearing markers regardless of exact wording", () => {
    const override = buildLefthookLocalOverride(isolatedBudget);
    expect(override).toContain("parallel: false");
    expect(override).toContain("pre-push:");
    expect(override).toContain("bin/setup-host-resources.mjs");
  });

  test("output ends with the exact YAML block setup-host-resources.mjs step 7 compares byte-for-byte for idempotency", () => {
    const override = buildLefthookLocalOverride(concurrentBudget);
    expect(override.endsWith("pre-push:\n  parallel: false\n")).toBe(true);
  });

  test("interpolates the budget's concurrentLaneWorkers/effectiveCores/sessions/limitedBy into the comment text", () => {
    const override = buildLefthookLocalOverride(concurrentBudget);
    expect(override).toContain("lane budget is 2 concurrent lane worker(s)");
    expect(override).toContain("effectiveCores=4");
    expect(override).toContain("sessions=1");
    expect(override).toContain("limitedBy=cpu");
  });
});

describe("platformStepSkips", () => {
  const linuxOnlyKeys = [
    "earlyoom",
    "zram",
    "swappiness",
    "userSlice",
    "claudeRc",
  ] as const;
  const allKeys = [
    "earlyoom",
    "zram",
    "swappiness",
    "userSlice",
    "claudeRc",
    "toolMemoryLimit",
    "lefthookLocal",
  ] as const;

  test.each(allKeys)("%s is null on linux", (key) => {
    expect(platformStepSkips("linux")[key]).toBeNull();
  });

  test.each([
    ["earlyoom", /jetsam/i],
    ["zram", /compressor/i],
    ["swappiness", /swappiness|dynamic_pager/i],
    ["userSlice", /cgroup/i],
    ["claudeRc", /systemd|launchd/i],
  ] as const)(
    "%s is a non-empty, topic-appropriate reason on darwin",
    (key, topicPattern) => {
      const reason = platformStepSkips("darwin")[key];
      expect(typeof reason).toBe("string");
      expect(reason).toMatch(topicPattern);
    },
  );

  test("lefthookLocal is null on darwin (step 7 has no OS dependency)", () => {
    expect(platformStepSkips("darwin").lefthookLocal).toBeNull();
  });

  test("toolMemoryLimit is non-null on darwin and explains the cgroup-enforcement gap", () => {
    const reason = platformStepSkips("darwin").toolMemoryLimit;
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/cgroup/i);
  });

  test.each(linuxOnlyKeys)(
    "%s is non-null on an unrecognized platform (win32) and interpolates the platform name",
    (key) => {
      const reason = platformStepSkips("win32")[key];
      expect(reason).not.toBeNull();
      expect(reason).toContain("win32");
    },
  );

  test("win32's lefthookLocal is null, same as every platform", () => {
    expect(platformStepSkips("win32").lefthookLocal).toBeNull();
  });

  test("win32 and darwin reasons genuinely differ per key (not both falling through to the same generic text)", () => {
    for (const key of linuxOnlyKeys) {
      expect(platformStepSkips("win32")[key]).not.toBe(
        platformStepSkips("darwin")[key],
      );
    }
  });

  test.each([["darwin"], ["win32"]] as const)(
    "%s: no Linux-only reason silently claims 'nothing to do' or is empty",
    (platform) => {
      for (const key of linuxOnlyKeys) {
        const reason = platformStepSkips(platform)[key];
        expect(reason).not.toBeNull();
        expect(reason).not.toMatch(/nothing to do/i);
        expect(reason).not.toBe("");
      }
    },
  );
});
