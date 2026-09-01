import { describe, expect, test } from "vitest";
import {
  HEADER_PATTERN,
  STALENESS_THRESHOLD_DAYS,
  TRACKER_PATH,
  evaluateFreshness,
  parseHarnessHeader,
  runHarnessFreshnessCheck,
} from "../../bin/check-harness-freshness.mjs";
import { createReporter } from "../../bin/lib/report.mjs";

/** The injected clock every case below is measured against. */
const NOW = new Date("2026-09-01T00:00:00Z");

/**
 * A tracker header comment. The fixture every case departs from — no
 * filesystem, so a case is a string, not a tmpdir.
 */
function tracker(
  overrides: { lastVerified?: string; claudeCodeVersion?: string } = {},
): string {
  return (
    `<!-- harness-refresh: ` +
    `last-verified=${overrides.lastVerified ?? "2026-08-30"} ` +
    `claude-code-version=${overrides.claudeCodeVersion ?? "2.1.4"} -->\n` +
    `\n# Harness refresh tracker\n`
  );
}

/**
 * The YYYY-MM-DD date exactly `days` before NOW. The inverse of the runner's
 * own arithmetic, not a copy of it — and pinned to literals below so a bug
 * here cannot silently agree with a bug there.
 */
function daysBeforeNow(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

describe("the fixture helper itself", () => {
  test("daysBeforeNow is pinned to literal dates, not re-derived", () => {
    expect(daysBeforeNow(0)).toBe("2026-09-01");
    expect(daysBeforeNow(STALENESS_THRESHOLD_DAYS)).toBe("2026-06-03");
    expect(daysBeforeNow(STALENESS_THRESHOLD_DAYS + 1)).toBe("2026-06-02");
  });
});

describe("HEADER_PATTERN", () => {
  test("is not global, so repeated exec calls are stateless", () => {
    expect(HEADER_PATTERN.global).toBe(false);
    const text = tracker();
    expect(HEADER_PATTERN.exec(text)).not.toBeNull();
    expect(HEADER_PATTERN.exec(text)).not.toBeNull();
  });
});

describe("parseHarnessHeader", () => {
  test("extracts both fields", () => {
    expect(parseHarnessHeader(tracker())).toEqual({
      lastVerified: "2026-08-30",
      claudeCodeVersion: "2.1.4",
    });
  });

  test("tolerates extra whitespace around the header's parts", () => {
    expect(
      parseHarnessHeader(
        "<!--   harness-refresh:   last-verified=2026-01-02    " +
          "claude-code-version=9.9.9   -->\n",
      ),
    ).toEqual({ lastVerified: "2026-01-02", claudeCodeVersion: "9.9.9" });
  });

  test("returns null when the header is absent", () => {
    expect(parseHarnessHeader("# Tracker\n\nNo header here.\n")).toBeNull();
  });

  test("returns null when claude-code-version is missing", () => {
    expect(
      parseHarnessHeader(
        "<!-- harness-refresh: last-verified=2026-08-30 -->\n",
      ),
    ).toBeNull();
  });

  test("finds the header even when it is not the first line", () => {
    expect(parseHarnessHeader(`# Title\n\n${tracker()}`)).not.toBeNull();
  });
});

describe("evaluateFreshness", () => {
  test("BRANCH: an unparseable header warns and names the header syntax", () => {
    const result = evaluateFreshness(null, NOW);
    expect(result.summary).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain(TRACKER_PATH);
    expect(result.findings[0]).toContain("no parseable");
    expect(result.payload).toEqual({ lastVerified: null, staleDays: null });
  });

  test("an unparseable header omits claudeCodeVersion — there is none to report", () => {
    expect(evaluateFreshness(null, NOW).payload).not.toHaveProperty(
      "claudeCodeVersion",
    );
  });

  test("BRANCH: last-verified=unset warns rather than reading as fresh", () => {
    const result = evaluateFreshness(
      { lastVerified: "unset", claudeCodeVersion: "unset" },
      NOW,
    );
    expect(result.summary).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain("never been swept");
    expect(result.findings[0]).toContain("last-verified=unset");
    // The never-swept state still reports the version it knows.
    expect(result.payload).toEqual({
      lastVerified: null,
      staleDays: null,
      claudeCodeVersion: "unset",
    });
  });

  test("BRANCH: a non-date last-verified warns and quotes the bad value", () => {
    const result = evaluateFreshness(
      { lastVerified: "last-tuesday", claudeCodeVersion: "2.1.4" },
      NOW,
    );
    expect(result.summary).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain('"last-tuesday"');
    expect(result.findings[0]).toContain("not a parseable YYYY-MM-DD date");
    expect(result.payload.lastVerified).toBeNull();
    expect(result.payload.staleDays).toBeNull();
  });

  test("BRANCH: over the threshold warns and reports the real day count", () => {
    const lastVerified = daysBeforeNow(STALENESS_THRESHOLD_DAYS + 1);
    const result = evaluateFreshness(
      { lastVerified, claudeCodeVersion: "2.1.4" },
      NOW,
    );
    expect(result.summary).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain(
      `last verified ${STALENESS_THRESHOLD_DAYS + 1} day(s) ago`,
    );
    expect(result.findings[0]).toContain(
      `over the ${STALENESS_THRESHOLD_DAYS}-day threshold`,
    );
    expect(result.payload).toEqual({
      lastVerified,
      staleDays: STALENESS_THRESHOLD_DAYS + 1,
      claudeCodeVersion: "2.1.4",
    });
  });

  test("BRANCH: under the threshold succeeds with no findings", () => {
    const result = evaluateFreshness(
      { lastVerified: daysBeforeNow(1), claudeCodeVersion: "2.1.4" },
      NOW,
    );
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("is fresh");
    expect(result.summary).toContain("verified 1 day(s) ago");
    expect(result.payload.staleDays).toBe(1);
  });

  test("BOUNDARY: exactly the threshold is still fresh (strict >, not >=)", () => {
    const result = evaluateFreshness(
      {
        lastVerified: daysBeforeNow(STALENESS_THRESHOLD_DAYS),
        claudeCodeVersion: "2.1.4",
      },
      NOW,
    );
    expect(result.payload.staleDays).toBe(STALENESS_THRESHOLD_DAYS);
    expect(result.findings).toEqual([]);
    expect(result.summary).not.toBeNull();
  });

  test("BOUNDARY: one day past the threshold is stale", () => {
    const result = evaluateFreshness(
      {
        lastVerified: daysBeforeNow(STALENESS_THRESHOLD_DAYS + 1),
        claudeCodeVersion: "2.1.4",
      },
      NOW,
    );
    expect(result.payload.staleDays).toBe(STALENESS_THRESHOLD_DAYS + 1);
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toBeNull();
  });

  test("today's date reads as zero days stale, not as one", () => {
    expect(
      evaluateFreshness(
        { lastVerified: daysBeforeNow(0), claudeCodeVersion: "2.1.4" },
        NOW,
      ).payload.staleDays,
    ).toBe(0);
  });

  test("a partial day floors DOWN — the CLI's `now` is never midnight", () => {
    // Every other case here sits on an exact midnight boundary, where floor
    // and ceil agree. The real CLI passes `new Date()`, so this is the only
    // case that pins which way a fraction of a day rounds: 10 hours after the
    // stamp is still zero days stale, not one.
    const midMorning = new Date("2026-09-01T10:00:00Z");
    expect(
      evaluateFreshness(
        { lastVerified: "2026-09-01", claudeCodeVersion: "2.1.4" },
        midMorning,
      ).payload.staleDays,
    ).toBe(0);

    // Same rounding at the threshold: 90 days and 10 hours is not yet stale.
    const result = evaluateFreshness(
      { lastVerified: "2026-06-03", claudeCodeVersion: "2.1.4" },
      midMorning,
    );
    expect(result.payload.staleDays).toBe(STALENESS_THRESHOLD_DAYS);
    expect(result.findings).toEqual([]);
  });

  test("the clock is injected, so staleness moves with `now` alone", () => {
    const header = { lastVerified: "2026-06-03", claudeCodeVersion: "2.1.4" };
    expect(evaluateFreshness(header, NOW).findings).toEqual([]);
    const laterOnly = new Date("2026-09-02T00:00:00Z");
    expect(evaluateFreshness(header, laterOnly).findings).toHaveLength(1);
  });
});

describe("runHarnessFreshnessCheck", () => {
  /**
   * Deps are typed rather than `Record<string, unknown>` on purpose: a
   * misspelled key (`readTacker`) would otherwise fall back to the default
   * fixture and make the case pass vacuously instead of failing to compile.
   */
  type Deps = Parameters<typeof runHarnessFreshnessCheck>[0];

  function run(overrides: Partial<Deps> = {}) {
    // The runner calls reporter.finish() itself; capture that ONE call rather
    // than calling finish() a second time, which would emit a duplicate JSON
    // line per case in --json mode.
    const reporter = createReporter(true);
    const realFinish = reporter.finish.bind(reporter);
    let payload: Record<string, unknown> = {};
    let finishCalls = 0;

    const outcome = runHarnessFreshnessCheck({
      readTracker: () => tracker(),
      now: NOW,
      ...overrides,
      reporter: {
        ...reporter,
        finish: (extra?: Parameters<typeof realFinish>[0]) => {
          finishCalls++;
          payload = realFinish(extra);
          return payload;
        },
      },
    });
    return { outcome, payload, finishCalls };
  }

  test("the runner reports exactly once per invocation", () => {
    expect(run().finishCalls).toBe(1);
  });

  test("ok on a tracker verified two days ago", () => {
    const { outcome } = run();
    expect(outcome.ok).toBe(true);
    expect(outcome.findings).toEqual([]);
    expect(outcome.staleDays).toBe(2);
    expect(outcome.lastVerified).toBe("2026-08-30");
  });

  test("BRANCH: a missing tracker warns and does not throw", () => {
    const { outcome } = run({
      readTracker: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toContain("not found");
    expect(outcome.findings[0]).toContain("ENOENT");
    expect(outcome.ok).toBe(false);
    expect(outcome.lastVerified).toBeNull();
  });

  test('HONEST CAUSE: only a read failure reports "not found"', () => {
    // The try wraps readTracker() alone. A throw raised after the read - here
    // from a getter on the returned string's own toString path - must not be
    // dressed up as a missing file.
    const exploding = {
      toString() {
        throw new Error("parse exploded");
      },
    } as unknown as string;

    expect(() => run({ readTracker: () => exploding })).toThrowError(
      /parse exploded/,
    );
  });

  test("a non-Error throw is still reported, not swallowed", () => {
    const { outcome } = run({
      readTracker: () => {
        // The whole point of the case: the runner must survive a throw that
        // is not an Error, which is exactly what this rule forbids writing.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "just a string";
      },
    });
    expect(outcome.findings[0]).toContain("just a string");
  });

  test("EVERY branch routes through the reporter as a WARNING, never an error", () => {
    const trackers: Record<string, () => string> = {
      "missing tracker": () => {
        throw new Error("ENOENT");
      },
      "unparseable header": () => "# no header\n",
      "last-verified=unset": () => tracker({ lastVerified: "unset" }),
      "non-date last-verified": () => tracker({ lastVerified: "whenever" }),
      "over the threshold": () =>
        tracker({
          lastVerified: daysBeforeNow(STALENESS_THRESHOLD_DAYS + 1),
        }),
    };

    for (const [label, readTracker] of Object.entries(trackers)) {
      const { outcome, payload } = run({ readTracker });
      expect(outcome.findings, label).toHaveLength(1);
      expect(payload["errors"], label).toEqual([]);
      expect(payload["warnings"], label).toHaveLength(1);
      // report.ok stays true: this gate is advisory and never blocks a push.
      expect(payload["ok"], label).toBe(true);
    }
  });

  test("the healthy branch reports a summary and emits no warning", () => {
    const { payload } = run();
    expect(payload["errors"]).toEqual([]);
    expect(payload["warnings"]).toEqual([]);
    expect(payload["summary"]).toContain("is fresh");
  });

  test("every warning is anchored to the tracker file", () => {
    const reporter = createReporter(false);
    const warn = reporter.warn.bind(reporter);
    type Loc = { file?: string; line?: number } | undefined;
    const seen: Loc[] = [];
    runHarnessFreshnessCheck({
      readTracker: () => tracker({ lastVerified: "unset" }),
      now: NOW,
      reporter: {
        ...reporter,
        warn: (message: string, loc?: Loc) => {
          seen.push(loc);
          return warn(message, loc);
        },
      },
    });
    expect(seen).toEqual([{ file: TRACKER_PATH }]);
  });

  test("the payload fields are spread onto the return value", () => {
    const { outcome } = run({
      readTracker: () => tracker({ claudeCodeVersion: "3.0.0" }),
    });
    expect(outcome.claudeCodeVersion).toBe("3.0.0");
  });
});
