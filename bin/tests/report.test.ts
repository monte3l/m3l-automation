import { afterEach, describe, expect, test, vi } from "vitest";
import { createReporter, parseJsonFlag, repoRoot } from "../lib/report.mjs";

describe("repoRoot", () => {
  test("resolves two levels above a bin/*.mjs script's own import.meta.url (string)", () => {
    expect(repoRoot("file:///home/x/repo/bin/foo.mjs")).toBe("/home/x/repo");
  });

  test("resolves the repo root given a URL instance", () => {
    expect(repoRoot(new URL("file:///home/x/repo/bin/foo.mjs"))).toBe(
      "/home/x/repo",
    );
  });
});

describe("parseJsonFlag", () => {
  test("detects and strips --json", () => {
    const result = parseJsonFlag(["--json"]);
    expect(result).toEqual({ json: true, argv: [] });
  });

  test("returns json: false and an unchanged argv when --json is absent", () => {
    const argv = ["--update", "x"];
    expect(parseJsonFlag(argv)).toEqual({
      json: false,
      argv: ["--update", "x"],
    });
  });

  test("defaults to process.argv.slice(2) when called without args", () => {
    const originalArgv = process.argv;
    process.argv = ["node", "script.mjs", "--json", "--update"];
    try {
      expect(parseJsonFlag()).toEqual({ json: true, argv: ["--update"] });
    } finally {
      process.argv = originalArgv;
    }
  });

  test("preserves other flags and positionals around --json", () => {
    expect(parseJsonFlag(["--update", "--json", "x"])).toEqual({
      json: true,
      argv: ["--update", "x"],
    });
  });
});

describe("createReporter — human mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("error() prints ✗ via console.error and flips ok to false", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.error("boom");

    expect(errorSpy).toHaveBeenCalledWith("✗  boom");
    const report = reporter.finish();
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(["boom"]);
  });

  test("warn() prints ⚠ via console.error and leaves ok true", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.warn("careful");

    expect(errorSpy).toHaveBeenCalledWith("⚠  careful");
    const report = reporter.finish();
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(["careful"]);
  });

  test.each([
    ["updated", "Updated:"],
    ["created", "Created:"],
    ["removed", "Removed:"],
  ] as const)(
    "change(%s, file) prints '%s file' via console.log and records the file",
    (kind, label) => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const reporter = createReporter(false);

      reporter.change(kind, "some/file.ts");

      expect(logSpy).toHaveBeenCalledWith(`${label} some/file.ts`);
      const report = reporter.finish();
      expect(report[kind]).toEqual(["some/file.ts"]);
    },
  );

  test("change() appends an optional note after the file", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.change("updated", "some/file.ts", "(implemented-list block)");

    expect(logSpy).toHaveBeenCalledWith(
      "Updated: some/file.ts (implemented-list block)",
    );
  });

  test("info() prints the raw message with no decoration", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.info("scanning files...");

    expect(logSpy).toHaveBeenCalledWith("scanning files...");
  });

  test("succeed() prints ✓ and records the summary", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.succeed("all good");

    expect(logSpy).toHaveBeenCalledWith("✓  all good");
    const report = reporter.finish();
    expect(report.summary).toBe("all good");
  });

  test("finish(extra) returns the base report merged with extra", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(false);

    const result = reporter.finish({ counts: { total: 25 } });

    expect(result).toMatchObject({
      ok: true,
      summary: "",
      errors: [],
      warnings: [],
      updated: [],
      created: [],
      removed: [],
      counts: { total: 25 },
    });
  });

  test("finish() prints nothing extra and returns the report object", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.succeed("done");
    logSpy.mockClear();
    errorSpy.mockClear();

    const report = reporter.finish();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(report).toEqual({
      ok: true,
      summary: "done",
      errors: [],
      warnings: [],
      updated: [],
      created: [],
      removed: [],
    });
  });
});

describe("createReporter — GitHub Actions workflow annotations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test.each([
    ["error", "✗"],
    ["warn", "⚠"],
  ] as const)(
    "%s() without a loc behaves exactly as before when GITHUB_ACTIONS is unset",
    (method, prefix) => {
      vi.stubEnv("GITHUB_ACTIONS", undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const reporter = createReporter(false);

      reporter[method]("boom");

      expect(errorSpy).toHaveBeenCalledWith(`${prefix}  boom`);
      expect(logSpy).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["error", "::error"],
    ["warn", "::warning"],
  ] as const)(
    "%s(message) with GITHUB_ACTIONS=true and no loc emits a bare %s:: annotation",
    (method, tag) => {
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const reporter = createReporter(false);

      reporter[method]("boom");

      expect(logSpy).toHaveBeenCalledWith(`${tag}::boom`);
    },
  );

  test.each([
    ["error", "::error"],
    ["warn", "::warning"],
  ] as const)(
    "%s(message, {file, line}) emits '%s file=...,line=...::message'",
    (method, tag) => {
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const reporter = createReporter(false);

      reporter[method]("boom", { file: "src/foo.ts", line: 42 });

      expect(logSpy).toHaveBeenCalledWith(
        `${tag} file=src/foo.ts,line=42::boom`,
      );
    },
  );

  test.each([
    ["error", "::error"],
    ["warn", "::warning"],
  ] as const)(
    "%s(message, {file}) with no line omits the line property ('%s file=...::message')",
    (method, tag) => {
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const reporter = createReporter(false);

      reporter[method]("boom", { file: "src/foo.ts" });

      expect(logSpy).toHaveBeenCalledWith(`${tag} file=src/foo.ts::boom`);
    },
  );

  test("annotation is suppressed when GITHUB_ACTIONS is 'false' even with a loc provided", () => {
    vi.stubEnv("GITHUB_ACTIONS", "false");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.error("boom", { file: "src/foo.ts", line: 1 });

    expect(logSpy).not.toHaveBeenCalled();
  });

  test("annotation is suppressed in --json mode even when GITHUB_ACTIONS=true and a loc is provided", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(true);

    reporter.error("boom", { file: "src/foo.ts", line: 1 });

    expect(logSpy).not.toHaveBeenCalled();
  });

  test("escapes % before CR/LF in the annotation message, without double-escaping", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.error("100% done\r\n");

    expect(logSpy).toHaveBeenCalledWith("::error::100%25 done%0D%0A");
  });

  test("escapes , and : in loc.file, more strictly than the message body", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.error("boom", { file: "src/foo,bar:baz.ts", line: 1 });

    expect(logSpy).toHaveBeenCalledWith(
      "::error file=src/foo%2Cbar%3Abaz.ts,line=1::boom",
    );
  });

  test("the human-mode ✗/⚠ console.error line still fires alongside the annotation", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(false);

    reporter.error("boom", { file: "src/foo.ts", line: 1 });

    expect(errorSpy).toHaveBeenCalledWith("✗  boom");
    expect(logSpy).toHaveBeenCalledWith("::error file=src/foo.ts,line=1::boom");
  });
});

describe("createReporter — JSON mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("error/warn/change/info/succeed produce no console output", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = createReporter(true);

    reporter.error("boom");
    reporter.warn("careful");
    reporter.change("created", "some/file.ts");
    reporter.info("scanning...");
    reporter.succeed("done");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("finish() console.logs exactly one JSON.parse-able payload", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(true);

    reporter.succeed("done");
    reporter.finish();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [payload] = logSpy.mock.calls[0] as [string];
    const parsed: unknown = JSON.parse(payload);
    expect(parsed).toMatchObject({
      ok: true,
      summary: "done",
      errors: [],
      warnings: [],
      updated: [],
      created: [],
      removed: [],
    });
  });

  test("finish(extra) merges extra fields into the payload", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(true);

    reporter.finish({ counts: { total: 25 } });

    const [payload] = logSpy.mock.calls[0] as [string];
    const parsed: unknown = JSON.parse(payload);
    expect(parsed).toMatchObject({ counts: { total: 25 } });
  });

  test("finish(extra) returns the base report merged with extra", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(true);

    const result = reporter.finish({ counts: { total: 25 } });

    expect(result).toMatchObject({
      ok: true,
      summary: "",
      errors: [],
      warnings: [],
      updated: [],
      created: [],
      removed: [],
      counts: { total: 25 },
    });
  });

  test("finish(extra) throws a TypeError naming the colliding base key", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(true);

    expect(() => reporter.finish({ errors: [] })).toThrow(TypeError);
    expect(() => reporter.finish({ errors: [] })).toThrow(/errors/);
  });

  test("info() lines never appear in the JSON payload", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(true);

    reporter.info("this is human-only progress output");
    reporter.finish();

    const [payload] = logSpy.mock.calls[0] as [string];
    expect(payload).not.toContain("human-only progress output");
  });

  test("ok is false in the payload after an error()", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = createReporter(true);

    reporter.error("boom");
    reporter.finish();

    const [payload] = logSpy.mock.calls[0] as [string];
    const parsed: unknown = JSON.parse(payload);
    expect(parsed).toMatchObject({ ok: false, errors: ["boom"] });
  });
});
