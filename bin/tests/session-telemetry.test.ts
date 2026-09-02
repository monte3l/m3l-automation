import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ANALYZER_SUBPATH,
  DEFAULT_SINCE,
  PLUGIN_CACHE_SUBPATH,
  REQUIRED_KEYS,
  SESSION_NAME_SCAN_BYTE_CAP,
  SESSION_NAME_MAX_LENGTH,
  buildAnalyzerArgs,
  SINCE_PATTERN,
  classifySessionName,
  computeNamingCompliance,
  extractSessionName,
  listRecentTranscripts,
  missingKeys,
  parsePayload,
  parseSince,
  parseTop,
  pickRevision,
  readTranscriptPrefix,
  resolveAnalyzerPath,
  runTelemetry,
  sanitizeNonConformingName,
  shapeFailureMessage,
  sinceToMs,
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

  test("a key present but explicitly UNDEFINED still counts as present", () => {
    // This is the case that distinguishes Object.hasOwn from a
    // `payload[key] !== undefined` check. An empty object would NOT: it is
    // truthy and not undefined, so both implementations agree on it and the
    // assertion would prove nothing. Verified by mutation — swapping
    // Object.hasOwn for `!== undefined` must make this test fail.
    expect(
      missingKeys({ ...parsePayload(fixtureText), by_skill: undefined }),
    ).toEqual([]);
  });

  test("an empty section is not a format break either", () => {
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
  /** First reported error, or "" — the payload is index-signature typed. */
  function firstError(payload: Record<string, unknown>): string {
    return (payload["errors"] as string[])[0] ?? "";
  }

  /**
   * Captures the payload runTelemetry hands to `finish()`. Calling
   * `reporter.finish()` a second time from the test would return the BASE
   * report without the script-specific extras, which is a different object
   * from the one a --json consumer actually sees.
   */
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
      computeNaming: () => ({
        sessions_scanned: 1,
        named: 1,
        conforming: 1,
        non_conforming: 0,
        unnamed: 0,
        non_conforming_names: [],
      }),
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

  test("threads a successful naming report through to the outcome", () => {
    const namingReport = {
      sessions_scanned: 5,
      named: 3,
      conforming: 1,
      non_conforming: 2,
      unnamed: 2,
      non_conforming_names: ["some ai title", "another one"],
    };
    const { outcome, payload } = run({ computeNaming: () => namingReport });
    expect(outcome.ok).toBe(true);
    expect(outcome.naming).toEqual(namingReport);
    expect(payload["naming"]).toEqual(namingReport);
  });

  test("MUTATION: a failed naming scan fails the run but still returns the payload", () => {
    const { outcome, payload } = run({
      computeNaming: () => {
        throw new Error("transcript format drift detected");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.payload).not.toBeNull();
    expect(outcome.naming).toBeNull();
    expect(firstError(payload)).toContain("transcript format drift detected");
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

describe("resolveAnalyzerPath", () => {
  const enoent = Object.assign(new Error("ENOENT: no such directory"), {
    code: "ENOENT",
  });
  const eacces = Object.assign(new Error("EACCES: permission denied"), {
    code: "EACCES",
  });
  const dir = (name: string) => ({ name, isDirectory: () => true });

  test("returns the newest revision's analyzer path", () => {
    const path = resolveAnalyzerPath("/cache", {
      readdir: () => [dir("old"), dir("new")],
      stat: (p: string) => ({ mtimeMs: p.endsWith("new") ? 2 : 1 }),
    });
    expect(path).toBe(`/cache/new/${ANALYZER_SUBPATH}`);
  });

  test("an ABSENT cache is a normal outcome, returning null", () => {
    expect(
      resolveAnalyzerPath("/cache", {
        readdir: () => {
          throw enoent;
        },
        stat: () => ({ mtimeMs: 0 }),
      }),
    ).toBeNull();
  });

  test("an empty cache returns null rather than a bogus path", () => {
    expect(
      resolveAnalyzerPath("/cache", {
        readdir: () => [],
        stat: () => ({ mtimeMs: 0 }),
      }),
    ).toBeNull();
  });

  test("MUTATION: an UNREADABLE cache throws — it is not an absent plugin", () => {
    expect(() =>
      resolveAnalyzerPath("/cache", {
        readdir: () => {
          throw eacces;
        },
        stat: () => ({ mtimeMs: 0 }),
      }),
    ).toThrow(/broken\s+installation, not a missing plugin/);
  });

  test("the unreadable-cache error chains the original errno via cause", () => {
    try {
      resolveAnalyzerPath("/cache", {
        readdir: () => {
          throw eacces;
        },
        stat: () => ({ mtimeMs: 0 }),
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).cause).toBe(eacces);
      expect((error as Error).message).toContain("EACCES");
    }
  });

  test("MUTATION: an unstattable revision throws rather than being skipped", () => {
    expect(() =>
      resolveAnalyzerPath("/cache", {
        readdir: () => [dir("a"), dir("b")],
        stat: (p: string) => {
          if (p.endsWith("b")) throw eacces;
          return { mtimeMs: 1 };
        },
      }),
    ).toThrow(/partially readable cache/);
  });

  test("non-directory entries are ignored", () => {
    const path = resolveAnalyzerPath("/cache", {
      readdir: () => [
        { name: "README.md", isDirectory: () => false },
        dir("r"),
      ],
      stat: () => ({ mtimeMs: 1 }),
    });
    expect(path).toBe(`/cache/r/${ANALYZER_SUBPATH}`);
  });
});

describe("parseSince", () => {
  test.each(["7d", "30d", "48h", "1h"])("accepts the bounded form %s", (v) => {
    expect(parseSince(v)).toBe(v);
  });

  test("the default passes its own validator", () => {
    expect(parseSince(DEFAULT_SINCE)).toBe(DEFAULT_SINCE);
    expect(SINCE_PATTERN.test(DEFAULT_SINCE)).toBe(true);
  });

  test.each(["garbage", "", "7", "d", "-7d", "7.5d", "7 d", "7dd", "7w"])(
    "MUTATION: rejects the unbounded/malformed value %j",
    (v) => {
      expect(() => parseSince(v)).toThrow(/not a bounded window/);
    },
  );

  test("the rejection explains WHY forwarding it is unsafe", () => {
    expect(() => parseSince("garbage")).toThrow(/scan the whole store/);
  });
});

describe("parseTop", () => {
  test("undefined stays undefined — the flag is optional", () => {
    expect(parseTop(undefined)).toBeUndefined();
  });

  test("parses a positive integer", () => {
    expect(parseTop("25")).toBe(25);
  });

  test.each(["abc", "", "0", "-5", "2.5", "NaN", "Infinity"])(
    "MUTATION: rejects %j rather than forwarding it as a literal",
    (v) => {
      expect(() => parseTop(v)).toThrow(/not a positive integer/);
    },
  );
});

describe("extractSessionName", () => {
  test("returns the agent-name value when present", () => {
    expect(
      extractSessionName('{"type":"agent-name","agentName":"feat-widget"}\n'),
    ).toBe("feat-widget");
  });

  test("returns the ai-title value when agent-name is absent", () => {
    expect(
      extractSessionName('{"type":"ai-title","aiTitle":"Some auto title"}\n'),
    ).toBe("Some auto title");
  });

  test("agent-name takes precedence over ai-title when both appear", () => {
    const prefix =
      '{"type":"ai-title","aiTitle":"Some auto title"}\n' +
      '{"type":"agent-name","agentName":"feat-widget"}\n';
    expect(extractSessionName(prefix)).toBe("feat-widget");
  });

  test("returns null when neither record type appears", () => {
    expect(extractSessionName('{"type":"user","message":{}}\n')).toBeNull();
  });

  test("skips malformed/non-JSON lines without throwing", () => {
    const prefix =
      "not json at all\n" +
      '{"type":"agent-name","agentName":"feat-widget"}\n' +
      "{truncated\n";
    expect(extractSessionName(prefix)).toBe("feat-widget");
  });

  test("uses the LAST agent-name record when renamed more than once", () => {
    const prefix =
      '{"type":"agent-name","agentName":"feat-first"}\n' +
      '{"type":"agent-name","agentName":"feat-second"}\n';
    expect(extractSessionName(prefix)).toBe("feat-second");
  });

  test("empty prefix returns null", () => {
    expect(extractSessionName("")).toBeNull();
  });
});

describe("classifySessionName", () => {
  test("null is unnamed", () => {
    expect(classifySessionName(null)).toBe("unnamed");
  });

  test.each([
    "feat",
    "fix",
    "audit",
    "research",
    "docs",
    "review",
    "ci",
    "merge",
  ])("%s-example-slug conforms", (kind) => {
    expect(classifySessionName(`${kind}-example-slug`)).toBe("conforming");
  });

  test("an AI-generated title does not conform", () => {
    expect(
      classifySessionName("Statusline context pressure security review"),
    ).toBe("non_conforming");
  });

  test("a conforming-shaped name over SESSION_NAME_MAX_LENGTH is non_conforming", () => {
    const overLong = `feat-${"a".repeat(SESSION_NAME_MAX_LENGTH)}`;
    expect(classifySessionName(overLong)).toBe("non_conforming");
  });

  test("an undeclared kind is non_conforming", () => {
    expect(classifySessionName("wip-example-slug")).toBe("non_conforming");
  });
});

describe("sinceToMs", () => {
  test("converts days", () => {
    expect(sinceToMs("7d")).toBe(7 * 86_400_000);
  });

  test("converts hours", () => {
    expect(sinceToMs("48h")).toBe(48 * 3_600_000);
  });

  test("a single-unit day window", () => {
    expect(sinceToMs("1d")).toBe(86_400_000);
  });
});

describe("readTranscriptPrefix", () => {
  test("reads and decodes the file's content", () => {
    const buf = Buffer.from(
      '{"type":"agent-name","agentName":"feat-x"}\n',
      "utf8",
    );
    const fs = {
      open: () => 3,
      read: (
        _fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const bytesToCopy = Math.min(length, buf.length - position);
        if (bytesToCopy <= 0) return 0;
        buf.copy(buffer, offset, position, position + bytesToCopy);
        return bytesToCopy;
      },
      close: () => {},
    };
    expect(readTranscriptPrefix("/p", fs)).toContain('"agentName":"feat-x"');
  });

  test("returns null when the file cannot be opened", () => {
    const fs = {
      open: () => {
        throw new Error("EACCES");
      },
      read: () => 0,
      close: () => {},
    };
    expect(readTranscriptPrefix("/p", fs)).toBeNull();
  });

  test("never requests more than SESSION_NAME_SCAN_BYTE_CAP bytes", () => {
    let requestedLength = 0;
    const fs = {
      open: () => 3,
      read: (_fd: number, _buffer: Buffer, _offset: number, length: number) => {
        requestedLength = length;
        return 0;
      },
      close: () => {},
    };
    readTranscriptPrefix("/p", fs);
    expect(requestedLength).toBe(SESSION_NAME_SCAN_BYTE_CAP);
  });
});

function entry(name: string, isFile = true) {
  return { name, isFile: () => isFile };
}

describe("listRecentTranscripts", () => {
  test("keeps only .jsonl files within the window", () => {
    const fs = {
      readdir: () => [entry("a.jsonl"), entry("b.txt"), entry("c.jsonl")],
      stat: (p: string) => ({ mtimeMs: p.endsWith("a.jsonl") ? 5000 : 1000 }),
    };
    expect(listRecentTranscripts("/dir", 2000, 6000, fs)).toEqual([
      "/dir/a.jsonl",
    ]);
  });

  test("excludes non-file directory entries", () => {
    const fs = {
      readdir: () => [entry("d.jsonl", false), entry("e.jsonl", true)],
      stat: () => ({ mtimeMs: 5000 }),
    };
    expect(listRecentTranscripts("/dir", 10000, 6000, fs)).toEqual([
      "/dir/e.jsonl",
    ]);
  });

  test("MUTATION: an unlistable directory throws, naming the path", () => {
    const fs = {
      readdir: () => {
        throw new Error("ENOENT");
      },
      stat: () => ({ mtimeMs: 0 }),
    };
    expect(() => listRecentTranscripts("/missing", 1000, 2000, fs)).toThrow(
      /\/missing/,
    );
  });

  test("a file that vanishes between readdir and stat is skipped, not fatal", () => {
    const fs = {
      readdir: () => [entry("a.jsonl"), entry("b.jsonl")],
      stat: (p: string) => {
        if (p.endsWith("b.jsonl")) throw new Error("ENOENT");
        return { mtimeMs: 5000 };
      },
    };
    expect(listRecentTranscripts("/dir", 10000, 6000, fs)).toEqual([
      "/dir/a.jsonl",
    ]);
  });
});

function fakeNamingFs(files: Record<string, string>) {
  const names = Object.keys(files);
  const contents = names.map((n) => files[n] ?? "");
  return {
    readdir: () => names.map((name) => ({ name, isFile: () => true })),
    stat: () => ({ mtimeMs: 5000 }),
    open: (path: string) => names.findIndex((n) => path.endsWith(n)),
    read: (
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const buf = Buffer.from(contents[fd] ?? "", "utf8");
      const bytesToCopy = Math.min(length, Math.max(0, buf.length - position));
      if (bytesToCopy <= 0) return 0;
      buf.copy(buffer, offset, position, position + bytesToCopy);
      return bytesToCopy;
    },
    close: () => {},
  };
}

describe("computeNamingCompliance", () => {
  const now = () => 10_000;

  test("classifies conforming, non-conforming, and unnamed sessions", () => {
    const fs = fakeNamingFs({
      "a.jsonl": '{"type":"agent-name","agentName":"feat-widget"}\n',
      "b.jsonl": '{"type":"ai-title","aiTitle":"Some auto title"}\n',
      "c.jsonl": '{"type":"user","message":{"content":"hi"}}\n',
    });
    const report = computeNamingCompliance({ dir: "/p", since: "7d", now, fs });
    expect(report.sessions_scanned).toBe(3);
    expect(report.named).toBe(2);
    expect(report.conforming).toBe(1);
    expect(report.non_conforming).toBe(1);
    expect(report.unnamed).toBe(1);
    expect(report.non_conforming_names).toEqual(["Some auto title"]);
  });

  test("MUTATION: an empty window throws rather than reporting zeros", () => {
    const fs = fakeNamingFs({});
    expect(() =>
      computeNamingCompliance({ dir: "/p", since: "7d", now, fs }),
    ).toThrow(/No transcript files found/);
  });

  test("MUTATION: transcripts present but zero name records throws, naming ADR-0084", () => {
    const fs = fakeNamingFs({ "a.jsonl": '{"type":"user","message":{}}\n' });
    expect(() =>
      computeNamingCompliance({ dir: "/p", since: "7d", now, fs }),
    ).toThrow(/ADR-0084/);
  });

  test("a file that cannot be opened is skipped, not fatal, when others carry records", () => {
    const fs = {
      readdir: () => [entry("a.jsonl"), entry("b.jsonl")],
      stat: () => ({ mtimeMs: 5000 }),
      open: (path: string) => {
        if (path.endsWith("b.jsonl")) throw new Error("EACCES");
        return 0;
      },
      read: (
        _fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const buf = Buffer.from(
          '{"type":"agent-name","agentName":"feat-x"}\n',
          "utf8",
        );
        const bytesToCopy = Math.min(length, buf.length - position);
        if (bytesToCopy <= 0) return 0;
        buf.copy(buffer, offset, position, position + bytesToCopy);
        return bytesToCopy;
      },
      close: () => {},
    };
    const report = computeNamingCompliance({ dir: "/p", since: "7d", now, fs });
    expect(report.sessions_scanned).toBe(2);
    expect(report.conforming).toBe(1);
    expect(report.unnamed).toBe(0);
  });
});

describe("sanitizeNonConformingName", () => {
  test("passes a short, clean name through unchanged", () => {
    expect(sanitizeNonConformingName("short title")).toBe("short title");
  });

  test("truncates a name over SESSION_NAME_MAX_LENGTH with an ellipsis marker", () => {
    const long = "a".repeat(SESSION_NAME_MAX_LENGTH + 20);
    const result = sanitizeNonConformingName(long);
    expect(result.length).toBe(SESSION_NAME_MAX_LENGTH + 1);
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("a".repeat(SESSION_NAME_MAX_LENGTH))).toBe(true);
  });

  test("strips C0 control characters and DEL", () => {
    expect(sanitizeNonConformingName("hello\x00\x1bworld\x7f")).toBe(
      "helloworld",
    );
  });

  test("a name at exactly SESSION_NAME_MAX_LENGTH is not truncated", () => {
    const exact = "a".repeat(SESSION_NAME_MAX_LENGTH);
    expect(sanitizeNonConformingName(exact)).toBe(exact);
  });
});

describe("readTranscriptPrefix — read failure after a successful open", () => {
  test("returns null (not a throw) when read() itself throws", () => {
    const fs = {
      open: () => 3,
      read: () => {
        throw new Error("EIO: i/o error");
      },
      close: () => {},
    };
    expect(readTranscriptPrefix("/p", fs)).toBeNull();
  });

  test("still closes the fd when read() throws", () => {
    let closed = false;
    const fs = {
      open: () => 3,
      read: () => {
        throw new Error("EIO");
      },
      close: () => {
        closed = true;
      },
    };
    readTranscriptPrefix("/p", fs);
    expect(closed).toBe(true);
  });
});

describe("listRecentTranscripts — path containment", () => {
  test("drops an entry whose resolved path escapes the project directory", () => {
    const fs = {
      readdir: () => [
        { name: "../../../../etc/passwd.jsonl", isFile: () => true },
        { name: "good.jsonl", isFile: () => true },
      ],
      stat: () => ({ mtimeMs: 5000 }),
    };
    expect(listRecentTranscripts("/safe/dir", 10000, 6000, fs)).toEqual([
      "/safe/dir/good.jsonl",
    ]);
  });
});
