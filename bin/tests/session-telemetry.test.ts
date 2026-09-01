import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ANALYZER_SUBPATH,
  DEFAULT_SINCE,
  PLUGIN_CACHE_SUBPATH,
  REQUIRED_KEYS,
  buildAnalyzerArgs,
  missingKeys,
  parsePayload,
  pickRevision,
  runTelemetry,
  shapeFailureMessage,
} from "../../bin/session-telemetry.mjs";
import { createReporter } from "../../bin/lib/report.mjs";

/**
 * A recorded `analyze-sessions.mjs --json` payload, trimmed and scrubbed of
 * every prompt, session id and real path — it pins the SHAPE, which is the
 * only thing this adapter contracts on. Regenerate with:
 *   node <analyzer> --json --dir <project-dir> --since 2d --top 3
 */
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "session-telemetry.fixture.json",
);
const fixtureText = readFileSync(FIXTURE_PATH, "utf8");

describe("the recorded fixture", () => {
  test("is a real analyzer payload carrying every required key", () => {
    expect(missingKeys(parsePayload(fixtureText))).toEqual([]);
  });

  test("carries no session content — no real prompt text or session id", () => {
    expect(fixtureText).not.toMatch(/"context": "(?!null)/);
    const uuids = new Set(
      fixtureText.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      ) ?? [],
    );
    expect([...uuids]).toEqual(["00000000-0000-4000-8000-000000000000"]);
  });
});

describe("pickRevision", () => {
  test("returns null when the plugin cache holds nothing", () => {
    expect(pickRevision([])).toBeNull();
  });

  test("picks the most recently modified revision", () => {
    expect(
      pickRevision([
        { name: "old", mtimeMs: 1 },
        { name: "new", mtimeMs: 3 },
        { name: "mid", mtimeMs: 2 },
      ]),
    ).toBe("new");
  });

  test("breaks an mtime tie by name, so the choice is deterministic", () => {
    expect(
      pickRevision([
        { name: "bbb", mtimeMs: 5 },
        { name: "aaa", mtimeMs: 5 },
      ]),
    ).toBe("aaa");
  });

  test("does not mutate its input", () => {
    const revisions = [
      { name: "b", mtimeMs: 1 },
      { name: "a", mtimeMs: 2 },
    ];
    pickRevision(revisions);
    expect(revisions.map((r) => r.name)).toEqual(["b", "a"]);
  });
});

describe("buildAnalyzerArgs", () => {
  test("ALWAYS pins --dir and --since, and always asks for --json", () => {
    const args = buildAnalyzerArgs({ dir: "/p", since: "7d" });
    expect(args).toEqual(["--json", "--dir", "/p", "--since", "7d"]);
  });

  test("a caller cannot widen the scan by omitting --dir", () => {
    // There is no code path that produces an argv without --dir; the type
    // requires it and the array is built unconditionally.
    expect(buildAnalyzerArgs({ dir: "", since: DEFAULT_SINCE })).toContain(
      "--dir",
    );
  });

  test("appends --top only when asked", () => {
    expect(buildAnalyzerArgs({ dir: "/p", since: "7d" })).not.toContain(
      "--top",
    );
    expect(buildAnalyzerArgs({ dir: "/p", since: "7d", top: 5 })).toEqual([
      ...buildAnalyzerArgs({ dir: "/p", since: "7d" }),
      "--top",
      "5",
    ]);
  });
});

describe("parsePayload", () => {
  test("parses a JSON object", () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
  });

  test("MUTATION: non-JSON output names the format instability, not SyntaxError", () => {
    expect(() => parsePayload("not json at all")).toThrow(
      /internal to Claude Code/,
    );
  });

  test("MUTATION: a JSON ARRAY is rejected — the contract is an object", () => {
    expect(() => parsePayload("[]")).toThrow(/did not emit a JSON object/);
  });

  test("MUTATION: a bare JSON scalar is rejected", () => {
    expect(() => parsePayload("42")).toThrow(/did not emit a JSON object/);
  });

  test("MUTATION: empty output is rejected rather than read as empty telemetry", () => {
    expect(() => parsePayload("")).toThrow(/did not emit a JSON object/);
  });
});

// THE central guard: this is what stops a Claude Code upgrade degrading the
// sweep to silent zeros.
describe("the shape assertion", () => {
  test("a complete payload has no missing keys", () => {
    expect(missingKeys(parsePayload(fixtureText))).toEqual([]);
  });

  test.each([...REQUIRED_KEYS])(
    "MUTATION: removing the top-level %s key is detected",
    (key) => {
      const payload = parsePayload(fixtureText);
      delete payload[key];
      expect(missingKeys(payload)).toEqual([key]);
    },
  );

  test("MUTATION: removing several keys reports all of them", () => {
    const payload = parsePayload(fixtureText);
    delete payload["overall"];
    delete payload["by_day"];
    expect(missingKeys(payload).sort()).toEqual(["by_day", "overall"]);
  });

  test("a key present but explicitly undefined still counts as present", () => {
    // Object.hasOwn, not a truthiness check: an analyzer that legitimately
    // emits an empty section must not be reported as a format break.
    expect(missingKeys({ ...parsePayload(fixtureText), by_skill: {} })).toEqual(
      [],
    );
  });

  test("the failure message names the instability and the ADR", () => {
    const message = shapeFailureMessage(["overall"]);
    expect(message).toContain("officially unsupported");
    expect(message).toContain("degrade silently to zeros");
    expect(message).toContain("ADR-0084");
    expect(message).toContain("overall");
  });
});

describe("runTelemetry", () => {
  /**
   * Captures the payload runTelemetry hands to `finish()`. Calling
   * `reporter.finish()` a second time from the test would return the BASE
   * report without the script-specific extras, which is a different object
   * from the one a --json consumer actually sees.
   */
  /** First reported error, or "" — the payload is index-signature typed. */
  function firstError(payload: Record<string, unknown>): string {
    return (payload["errors"] as string[])[0] ?? "";
  }

  function run(overrides: Record<string, unknown> = {}) {
    const reporter = createReporter(true);
    let payload: Record<string, unknown> = {};
    const finish = reporter.finish.bind(reporter);
    reporter.finish = (extra?: Record<string, unknown>) => {
      payload = finish(extra);
      return payload;
    };

    const outcome = runTelemetry({
      analyzerPath: "/plugins/session-report/rev/analyze-sessions.mjs",
      dir: "/home/u/.claude/projects/-home-u-workspaces-proj",
      since: DEFAULT_SINCE,
      runAnalyzer: () => fixtureText,
      reporter,
      ...overrides,
    });
    return { outcome, payload };
  }

  test("returns the parsed payload for a well-shaped analyzer run", () => {
    const { outcome } = run();
    expect(outcome.ok).toBe(true);
    expect(Object.keys(outcome.payload ?? {})).toEqual(
      expect.arrayContaining([...REQUIRED_KEYS]),
    );
  });

  test("hands the analyzer the pinned --dir and --since, never a bare invocation", () => {
    let seen: string[] = [];
    run({
      since: "7d",
      runAnalyzer: (_path: string, args: string[]) => {
        seen = args;
        return fixtureText;
      },
    });
    expect(seen).toEqual([
      "--json",
      "--dir",
      "/home/u/.claude/projects/-home-u-workspaces-proj",
      "--since",
      "7d",
    ]);
  });

  test("MUTATION: a missing analyzer is an ERROR, not an empty report", () => {
    const { outcome, payload } = run({ analyzerPath: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.payload).toBeNull();
    expect(firstError(payload)).toContain(PLUGIN_CACHE_SUBPATH);
    expect(firstError(payload)).toContain("Not falling back to a wider scan");
  });

  test("MUTATION: a top-level key removed from the analyzer output fails the run", () => {
    const broken = parsePayload(fixtureText);
    delete broken["by_subagent_type"];
    const { outcome, payload } = run({
      runAnalyzer: () => JSON.stringify(broken),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.payload).toBeNull();
    expect(firstError(payload)).toContain("by_subagent_type");
    expect(firstError(payload)).toContain("ADR-0084");
  });

  test("MUTATION: unparseable analyzer output fails the run", () => {
    const { outcome } = run({ runAnalyzer: () => "<html>oops</html>" });
    expect(outcome.ok).toBe(false);
  });

  test("an analyzer that throws does not crash the adapter", () => {
    const { outcome, payload } = run({
      runAnalyzer: () => {
        throw new Error("ENOENT: analyzer vanished");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(firstError(payload)).toContain("analyzer vanished");
  });

  test("reports which analyzer revision produced the numbers", () => {
    const { payload } = run();
    expect(payload["analyzerPath"]).toBe(
      "/plugins/session-report/rev/analyze-sessions.mjs",
    );
  });
});

describe("path constants", () => {
  test("the cache subpath points at the official plugin namespace", () => {
    expect(PLUGIN_CACHE_SUBPATH).toContain("claude-plugins-official");
    expect(PLUGIN_CACHE_SUBPATH).toContain("session-report");
  });

  test("the analyzer subpath is the plugin's bundled skill script", () => {
    expect(ANALYZER_SUBPATH).toContain("analyze-sessions.mjs");
  });

  test("the default window is bounded, never unlimited", () => {
    expect(DEFAULT_SINCE).toMatch(/^\d+[dh]$/);
  });
});
