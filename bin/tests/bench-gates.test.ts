import { describe, expect, test } from "vitest";
import {
  LANES,
  parseArgs,
  buildLaneCommand,
  median,
  isHostBusy,
  parseGnuTimeVerbose,
  parseTimeVElapsed,
  parseBsdTimeDashL,
  computeCpuEfficiency,
  pressureDeltaMs,
} from "../../bin/bench-gates.mjs";

describe("LANES", () => {
  test("is a plain object with exactly the expected lane names", () => {
    expect(typeof LANES).toBe("object");
    expect(Object.keys(LANES).sort()).toEqual(
      [
        "format",
        "lint:library",
        "lint:workspace",
        "turbo:typecheck",
        "tsc:bin",
        "build",
        "test:unit",
        "test:bin",
        "test:web",
        "test:integration",
        "checks",
      ].sort(),
    );
  });

  test("only turbo:typecheck and build are turbo-backed lanes", () => {
    const turboTypecheck = LANES["turbo:typecheck"];
    const build = LANES["build"];
    expect(turboTypecheck?.turbo).toBe(true);
    expect(build?.turbo).toBe(true);
    for (const [name, lane] of Object.entries(LANES)) {
      if (name === "turbo:typecheck" || name === "build") continue;
      expect(lane.turbo).toBe(false);
    }
  });

  // Regression test: `runLaneOnce` spawns each lane's command via
  // `bash -lc "<command>"`, which does NOT source pnpm's shell environment
  // (unlike `pnpm <script>` / `pnpm exec <bin>`, which resolve
  // `node_modules/.bin` themselves) — so a bare `turbo run <task>` command
  // fails with "bash: line 1: turbo: command not found" on any host without
  // a globally-installed `turbo` binary. Every turbo-backed lane's command
  // must go through `pnpm exec` instead.
  test("every turbo-backed lane's command starts with 'pnpm exec turbo run ', never a bare 'turbo run'", () => {
    for (const lane of Object.values(LANES)) {
      if (!lane.turbo) continue;
      expect(lane.command.startsWith("pnpm exec turbo run ")).toBe(true);
    }
  });

  // Regression test: `turbo.json`'s old static `"concurrency": "50%"` field
  // was removed elsewhere, so a turbo-backed lane whose command drops
  // `--concurrency=` silently falls back to turbo's own default of 10
  // concurrent tasks — oversubscribing the host and no longer measuring the
  // same concurrency `pnpm build`/`pnpm typecheck` actually run at. A
  // prefix-only check (above) cannot catch a flag dropped from the middle
  // or end of the command, so this asserts the exact full string.
  test("turbo:typecheck and build always carry --concurrency=, never turbo's bare default", () => {
    expect(LANES["turbo:typecheck"]?.command).toBe(
      "pnpm exec turbo run typecheck --concurrency=$(node bin/print-concurrency.mjs)",
    );
    expect(LANES["build"]?.command).toBe(
      "pnpm exec turbo run build --concurrency=$(node bin/print-concurrency.mjs)",
    );
  });

  // Regression test: `format` is the first (and currently only) lane with a
  // `cacheDir` — `--cold` needs it so the lane measures a true uncached
  // Prettier run rather than silently reusing a previous invocation's cache.
  test("format is the only lane with a cacheDir, and it points at Prettier's default cache location", () => {
    expect(LANES["format"]?.cacheDir).toBe("node_modules/.cache/prettier");
    expect(LANES["format"]?.command).toBe("pnpm format:check");
    expect(LANES["format"]?.turbo).toBe(false);
    for (const [name, lane] of Object.entries(LANES)) {
      if (name === "format") continue;
      expect(lane.cacheDir).toBeUndefined();
    }
  });
});

describe("parseArgs", () => {
  test("empty argv yields every default", () => {
    expect(parseArgs([])).toEqual({
      lanes: [],
      mode: "warm",
      schedule: "isolated",
      repeat: 1,
      sessions: undefined,
      busyThreshold: 0.5,
      force: false,
      printBudget: false,
      out: undefined,
    });
  });

  test("--lane is repeatable and preserves order", () => {
    expect(parseArgs(["--lane=build", "--lane=format"]).lanes).toEqual([
      "build",
      "format",
    ]);
  });

  test("--cold sets mode to cold", () => {
    expect(parseArgs(["--cold"]).mode).toBe("cold");
  });

  test("last-write-wins: --cold followed by --warm resolves to warm", () => {
    expect(parseArgs(["--cold", "--warm"]).mode).toBe("warm");
  });

  test("--concurrent sets schedule to concurrent", () => {
    expect(parseArgs(["--concurrent"]).schedule).toBe("concurrent");
  });

  test("--repeat=5 sets repeat to 5", () => {
    expect(parseArgs(["--repeat=5"]).repeat).toBe(5);
  });

  test.each([["--repeat=0"], ["--repeat=-1"], ["--repeat=abc"]])(
    "%s falls back to repeat: 1",
    (flag) => {
      expect(parseArgs([flag]).repeat).toBe(1);
    },
  );

  test("--sessions=3 sets sessions to 3", () => {
    expect(parseArgs(["--sessions=3"]).sessions).toBe(3);
  });

  test.each([["--sessions=0"], ["--sessions=-2"], ["--sessions=abc"]])(
    "%s leaves sessions undefined",
    (flag) => {
      expect(parseArgs([flag]).sessions).toBeUndefined();
    },
  );

  test("--busy-threshold=0.8 sets busyThreshold to 0.8", () => {
    expect(parseArgs(["--busy-threshold=0.8"]).busyThreshold).toBe(0.8);
  });

  test("--busy-threshold=abc falls back to the default 0.5", () => {
    expect(parseArgs(["--busy-threshold=abc"]).busyThreshold).toBe(0.5);
  });

  test("--force sets force to true", () => {
    expect(parseArgs(["--force"]).force).toBe(true);
  });

  test("--print-budget sets printBudget to true", () => {
    expect(parseArgs(["--print-budget"]).printBudget).toBe(true);
  });

  test("--out=baseline.json sets out to the given path", () => {
    expect(parseArgs(["--out=baseline.json"]).out).toBe("baseline.json");
  });

  test("an unrecognized flag is silently ignored, other defaults intact", () => {
    expect(parseArgs(["--bogus"])).toEqual({
      lanes: [],
      mode: "warm",
      schedule: "isolated",
      repeat: 1,
      sessions: undefined,
      busyThreshold: 0.5,
      force: false,
      printBudget: false,
      out: undefined,
    });
  });
});

describe("buildLaneCommand", () => {
  // Fixtures use the real "pnpm exec turbo run <task>" shape every LANES
  // entry actually has — `buildLaneCommand`'s --force-insertion regex is
  // anchored on that full literal prefix (not a bare "turbo run"), so a
  // bare-"turbo run" fixture no longer matches and would silently return
  // unchanged.
  test("cold + turbo lane appends --force", () => {
    expect(
      buildLaneCommand(
        { command: "pnpm exec turbo run build", turbo: true },
        "cold",
      ),
    ).toBe("pnpm exec turbo run build --force");
  });

  test("warm + turbo lane is unchanged", () => {
    expect(
      buildLaneCommand(
        { command: "pnpm exec turbo run build", turbo: true },
        "warm",
      ),
    ).toBe("pnpm exec turbo run build");
  });

  test("cold + non-turbo lane is unchanged", () => {
    expect(
      buildLaneCommand({ command: "pnpm lint:library", turbo: false }, "cold"),
    ).toBe("pnpm lint:library");
  });

  test("--force is inserted right after the task name, not appended at the end", () => {
    expect(
      buildLaneCommand(
        { command: "pnpm exec turbo run build --filter=foo", turbo: true },
        "cold",
      ),
    ).toBe("pnpm exec turbo run build --force --filter=foo");
  });

  // The anchor is on the literal "pnpm exec turbo run" substring, not on
  // string-start position 0 — this proves the regex still finds and
  // augments it when preceded by other text (e.g. an env-var assignment),
  // distinct from the tests above where the anchor happens to sit at index
  // 0 of the whole command.
  test("finds and augments 'pnpm exec turbo run <task>' when it is not at the start of the command", () => {
    expect(
      buildLaneCommand(
        { command: "FOO=bar pnpm exec turbo run build", turbo: true },
        "cold",
      ),
    ).toBe("FOO=bar pnpm exec turbo run build --force");
  });

  // Regression test for the bot-flagged Nit that motivated anchoring the
  // regex on the full "pnpm exec turbo run" prefix: an unanchored
  // `/(turbo run \S+)/` would match the FIRST "turbo run <word>" substring
  // anywhere in the command — including one sitting inside an unrelated
  // quoted argument — and append --force there instead of (or in addition
  // to) the real invocation. The anchored form must only ever touch the
  // real "pnpm exec turbo run <task>" occurrence.
  test("does not append --force to an unrelated 'turbo run' substring inside a quoted argument", () => {
    expect(
      buildLaneCommand(
        {
          command: "echo 'turbo run fake' && pnpm exec turbo run build",
          turbo: true,
        },
        "cold",
      ),
    ).toBe("echo 'turbo run fake' && pnpm exec turbo run build --force");
  });

  // Regression tests for the `cacheDir` prefixing transform: `--cold` on a
  // lane with a `cacheDir` (currently only `format`) must remove that
  // directory before the lane's own command runs, so a stale Prettier cache
  // from a previous invocation can't silently make a "cold" run behave like
  // a warm one.
  test("cold + cacheDir lane is prefixed with 'rm -rf <cacheDir> && ' followed by the original command verbatim", () => {
    expect(
      buildLaneCommand(
        {
          command: "pnpm format:check",
          turbo: false,
          cacheDir: "node_modules/.cache/prettier",
        },
        "cold",
      ),
    ).toBe("rm -rf node_modules/.cache/prettier && pnpm format:check");
  });

  test("warm + cacheDir lane is unchanged (no rm -rf prefix)", () => {
    expect(
      buildLaneCommand(
        {
          command: "pnpm format:check",
          turbo: false,
          cacheDir: "node_modules/.cache/prettier",
        },
        "warm",
      ),
    ).toBe("pnpm format:check");
  });

  // Regression guard: a lane with no `cacheDir` at all (every existing
  // turbo-backed lane) must never gain an `rm -rf` prefix in cold mode — the
  // new branch is guarded on `lane.cacheDir` being truthy, not merely on
  // `mode === "cold"`.
  test("cold + turbo lane with no cacheDir gets --force but never an rm -rf prefix", () => {
    const result = buildLaneCommand(
      { command: "pnpm exec turbo run build", turbo: true },
      "cold",
    );
    expect(result).toBe("pnpm exec turbo run build --force");
    expect(result.startsWith("rm -rf")).toBe(false);
  });

  // No real LANES entry is both turbo-backed and cacheDir-bearing today, but
  // the source's own doc comment says both transforms can apply to the same
  // lane and are independent — this proves that combination, using a
  // synthetic fixture rather than inventing a new LANES entry.
  test("cold lane with both turbo and cacheDir applies both transforms: --force append AND rm -rf prefix", () => {
    expect(
      buildLaneCommand(
        {
          command: "pnpm exec turbo run build",
          turbo: true,
          cacheDir: "node_modules/.cache/fake",
        },
        "cold",
      ),
    ).toBe(
      "rm -rf node_modules/.cache/fake && pnpm exec turbo run build --force",
    );
  });
});

describe("median", () => {
  test("odd-length array: middle value after sorting", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test("even-length array: average of the two middle values", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("empty array returns null", () => {
    expect(median([])).toBeNull();
  });

  test("non-finite values are excluded before computing the median", () => {
    expect(median([1, NaN, 3])).toBe(2);
  });

  test("array of all non-finite values returns null", () => {
    expect(median([NaN, Infinity, -Infinity])).toBeNull();
  });
});

describe("isHostBusy", () => {
  test("exactly at the boundary is NOT busy (strict greater-than)", () => {
    expect(isHostBusy({ loadAvg1: 2.0, logicalCores: 4, threshold: 0.5 })).toBe(
      false,
    );
  });

  test("just over the boundary IS busy", () => {
    expect(
      isHostBusy({ loadAvg1: 2.01, logicalCores: 4, threshold: 0.5 }),
    ).toBe(true);
  });

  test("well under the boundary is not busy", () => {
    expect(isHostBusy({ loadAvg1: 0.1, logicalCores: 4, threshold: 0.5 })).toBe(
      false,
    );
  });
});

describe("parseGnuTimeVerbose", () => {
  const fixture =
    '\tCommand being timed: "bash -lc pnpm lint:library"\n' +
    "\tUser time (seconds): 1.23\n" +
    "\tSystem time (seconds): 0.45\n" +
    "\tPercent of CPU this job got: 67%\n" +
    "\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:02.50\n" +
    "\tMaximum resident set size (kbytes): 123456\n";

  test("parses a well-formed m:ss.ss fixture", () => {
    expect(parseGnuTimeVerbose(fixture)).toEqual({
      userSeconds: 1.23,
      systemSeconds: 0.45,
      wallSeconds: 2.5,
      peakRssKiB: 123456,
    });
  });

  test("parses an h:mm:ss elapsed format end to end", () => {
    const hourFixture = fixture.replace("0:02.50", "1:02:03");
    expect(parseGnuTimeVerbose(hourFixture)).toEqual({
      userSeconds: 1.23,
      systemSeconds: 0.45,
      wallSeconds: 3723,
      peakRssKiB: 123456,
    });
  });

  test("null input returns null", () => {
    expect(parseGnuTimeVerbose(null)).toBeNull();
  });

  test("missing a required field (peak RSS) returns null", () => {
    const missingRss = fixture.replace(
      "\tMaximum resident set size (kbytes): 123456\n",
      "",
    );
    expect(parseGnuTimeVerbose(missingRss)).toBeNull();
  });
});

describe("parseTimeVElapsed", () => {
  test("m:ss.ss format", () => {
    expect(parseTimeVElapsed("0:02.50")).toBe(2.5);
  });

  test("h:mm:ss format", () => {
    expect(parseTimeVElapsed("1:02:03")).toBe(3723);
  });

  test("single component (no colon)", () => {
    expect(parseTimeVElapsed("45")).toBe(45);
  });

  test("unparseable input returns NaN", () => {
    expect(Number.isNaN(parseTimeVElapsed("abc"))).toBe(true);
  });
});

describe("parseBsdTimeDashL", () => {
  const fixture =
    "        2.50 real         1.23 user         0.45 sys\n" +
    "   123456789  maximum resident set size\n";

  test("parses a well-formed BSD time -l fixture", () => {
    expect(parseBsdTimeDashL(fixture)).toEqual({
      wallSeconds: 2.5,
      userSeconds: 1.23,
      systemSeconds: 0.45,
      peakRssKiB: Math.round(123456789 / 1024),
    });
  });

  test("null input returns null", () => {
    expect(parseBsdTimeDashL(null)).toBeNull();
  });

  test("missing a required field (maximum resident set size) returns null", () => {
    const missingRss = "        2.50 real         1.23 user         0.45 sys\n";
    expect(parseBsdTimeDashL(missingRss)).toBeNull();
  });
});

describe("computeCpuEfficiency", () => {
  test("computes (user + system) / wall", () => {
    expect(computeCpuEfficiency(1, 0.5, 3)).toBe(0.5);
  });

  test("returns 0 (not Infinity/NaN) when wall time is zero", () => {
    expect(computeCpuEfficiency(1, 0.5, 0)).toBe(0);
  });

  test("returns 0 when wall time is negative", () => {
    expect(computeCpuEfficiency(1, 0.5, -3)).toBe(0);
  });
});

describe("pressureDeltaMs", () => {
  test("converts a microsecond delta to rounded milliseconds", () => {
    expect(pressureDeltaMs(1_000_000, 3_500_000)).toBe(2500);
  });

  test("undefined before returns null", () => {
    expect(pressureDeltaMs(undefined, 3_500_000)).toBeNull();
  });

  test("undefined after returns null", () => {
    expect(pressureDeltaMs(1_000_000, undefined)).toBeNull();
  });

  test("NaN input returns null", () => {
    expect(pressureDeltaMs(NaN, 3_500_000)).toBeNull();
  });
});
