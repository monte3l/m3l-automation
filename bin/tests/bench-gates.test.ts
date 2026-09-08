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
  test("cold + turbo lane appends --force", () => {
    expect(
      buildLaneCommand({ command: "turbo run build", turbo: true }, "cold"),
    ).toBe("turbo run build --force");
  });

  test("warm + turbo lane is unchanged", () => {
    expect(
      buildLaneCommand({ command: "turbo run build", turbo: true }, "warm"),
    ).toBe("turbo run build");
  });

  test("cold + non-turbo lane is unchanged", () => {
    expect(
      buildLaneCommand({ command: "pnpm lint:library", turbo: false }, "cold"),
    ).toBe("pnpm lint:library");
  });

  test("--force is inserted right after the task name, not appended at the end", () => {
    expect(
      buildLaneCommand(
        { command: "turbo run build --filter=foo", turbo: true },
        "cold",
      ),
    ).toBe("turbo run build --force --filter=foo");
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
