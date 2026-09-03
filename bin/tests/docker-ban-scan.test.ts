import { describe, expect, test } from "vitest";
import {
  ALLOWLIST_DIR_PREFIXES,
  SELF_EXEMPT_PATHS,
  isAllowlisted,
  scanFilenames,
  scanPackageJsonScripts,
  scanRawInvocations,
} from "../lib/docker-ban-scan.mjs";
import {
  isInvocationScanCandidate,
  listTrackedFiles,
  runDockerBanCheck,
} from "../check-no-docker.mjs";

// The scan functions are pure, so they are driven with synthetic path/content
// fixtures rather than the live repo — `.claude/rules/tests.md` requires
// exactly this of a `bin/` checker, because a gate exercised only against
// today's tree proves nothing about tomorrow's violation (a Dockerfile
// dropped back in by a dependency's scaffold, a stray `docker build` copied
// into a new workflow step).

interface FakeReporter {
  errors: string[];
  warnings: string[];
  infos: string[];
  changes: { kind: string; file: string }[];
  succeeded: string[];
  finishedWith: Record<string, unknown>;
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  change: (
    kind: "updated" | "created" | "removed",
    file: string,
    note?: string,
  ) => void;
  succeed: (message: string) => void;
  finish: (extra?: Record<string, unknown>) => Record<string, unknown>;
}

function createFakeReporter(): FakeReporter {
  const reporter: FakeReporter = {
    errors: [],
    warnings: [],
    infos: [],
    changes: [],
    succeeded: [],
    finishedWith: {},
    error(message) {
      reporter.errors.push(message);
    },
    warn(message) {
      reporter.warnings.push(message);
    },
    info(message) {
      reporter.infos.push(message);
    },
    change(kind, file) {
      reporter.changes.push({ kind, file });
    },
    succeed(message) {
      reporter.succeeded.push(message);
    },
    finish(extra = {}) {
      reporter.finishedWith = extra;
      return { ...extra };
    },
  };
  return reporter;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`docker-ban-scan.test.ts: expected ${what}`);
  }
  return value;
}

describe("ALLOWLIST_DIR_PREFIXES", () => {
  test("names the historical-record directories exempt from every check", () => {
    expect(ALLOWLIST_DIR_PREFIXES).toEqual([
      "docs/adr/",
      "docs/logs/",
      "docs/plans/archive/",
    ]);
  });
});

describe("SELF_EXEMPT_PATHS", () => {
  test("names this gate's own source and test as self-exempt", () => {
    expect(SELF_EXEMPT_PATHS.has("bin/check-no-docker.mjs")).toBe(true);
    expect(SELF_EXEMPT_PATHS.has("bin/lib/docker-ban-scan.mjs")).toBe(true);
    expect(SELF_EXEMPT_PATHS.has("bin/tests/docker-ban-scan.test.ts")).toBe(
      true,
    );
  });

  test("does not exempt an arbitrary path", () => {
    expect(SELF_EXEMPT_PATHS.has("bin/check-control-chars.mjs")).toBe(false);
  });
});

describe("isAllowlisted", () => {
  test.each([
    ["docs/adr/0091-no-docker.md", true],
    ["docs/logs/2026-09-03-no-docker.md", true],
    ["docs/plans/archive/old-plan.md", true],
    ["docs/contributing/style-guide.md", false],
    ["packages/m3l-common/src/index.ts", false],
    ["docs/adr-index.md", false],
  ])("isAllowlisted(%s) is %s", (path, expected) => {
    expect(isAllowlisted(path)).toBe(expected);
  });
});

describe("scanFilenames", () => {
  test.each<[string, string]>([
    ["Dockerfile", "Dockerfile"],
    ["dockerfile", "Dockerfile"],
    ["DOCKERFILE", "Dockerfile"],
    ["packages/foo/Dockerfile", "Dockerfile"],
    ["foo.dockerfile", "*.dockerfile"],
    ["Foo.DOCKERFILE", "*.dockerfile"],
    [".dockerignore", ".dockerignore"],
    ["docker-compose.yml", "docker-compose.y*ml"],
    ["docker-compose.yaml", "docker-compose.y*ml"],
    ["DOCKER-COMPOSE.YML", "docker-compose.y*ml"],
  ])(
    "%s is flagged as a banned Docker artifact (matches %s)",
    (path, label) => {
      const findings = scanFilenames([path]);
      expect(findings).toHaveLength(1);
      expect(required(findings[0], "finding")).toContain(path);
      expect(required(findings[0], "finding")).toContain(label);
    },
  );

  test.each(["Containerfile", "console-pod.yaml", ".containerignore"])(
    "%s is never flagged — it is the Podman-native replacement",
    (path) => {
      expect(scanFilenames([path])).toEqual([]);
    },
  );

  test.each([
    "docs/adr/Dockerfile",
    "docs/logs/docker-compose.yml",
    "docs/plans/archive/.dockerignore",
  ])("%s under an allowlisted directory is not flagged", (path) => {
    expect(scanFilenames([path])).toEqual([]);
  });

  test("one finding per offending file, not per scanned path", () => {
    const findings = scanFilenames([
      "a/Dockerfile",
      "b/README.md",
      "c/docker-compose.yaml",
      "d/Containerfile",
    ]);

    expect(findings).toHaveLength(2);
  });
});

describe("scanRawInvocations", () => {
  test.each<[string, string]>([
    ["docker build -t app .", "docker"],
    ["docker compose up -d", "docker"],
    ["docker-compose up -d", "docker-compose"],
  ])("content invoking %s is flagged (token %s)", (content, expectedToken) => {
    const findings = scanRawInvocations([{ path: "bin/deploy.mjs", content }]);
    expect(findings).toHaveLength(1);
    expect(required(findings[0], "finding")).toContain("bin/deploy.mjs");
    expect(required(findings[0], "finding")).toContain(expectedToken);
  });

  test("a docker.io/ registry hostname reference is never flagged", () => {
    expect(
      scanRawInvocations([
        {
          path: "bin/build.mjs",
          content: "podman pull docker.io/library/node:24\n",
        },
      ]),
    ).toEqual([]);
  });

  test("a podman invocation is never flagged", () => {
    expect(
      scanRawInvocations([
        { path: "bin/build.mjs", content: "podman build -t app .\n" },
      ]),
    ).toEqual([]);
  });

  test("a self-exempt path is not scanned even when it invokes docker", () => {
    expect(
      scanRawInvocations([
        {
          path: "bin/check-no-docker.mjs",
          content: "// this file discusses docker build extensively\n",
        },
      ]),
    ).toEqual([]);
  });

  test("an allowlisted historical-record path is not scanned", () => {
    expect(
      scanRawInvocations([
        { path: "docs/adr/0091-no-docker.md", content: "docker build .\n" },
      ]),
    ).toEqual([]);
  });

  test("one finding per offending FILE, with the occurrence count in the message", () => {
    const findings = scanRawInvocations([
      {
        path: ".github/workflows/ci.yml",
        content: "docker build .\ndocker push app\ndocker rmi app\n",
      },
    ]);

    expect(findings).toHaveLength(1);
    expect(required(findings[0], "finding")).toContain("3 occurrence(s)");
  });

  test("multiple offending files each get their own finding", () => {
    const findings = scanRawInvocations([
      { path: "bin/a.mjs", content: "docker build .\n" },
      { path: "bin/b.mjs", content: "podman build .\n" },
      { path: "bin/c.mjs", content: "docker-compose up\n" },
    ]);

    expect(findings).toHaveLength(2);
  });
});

describe("scanPackageJsonScripts", () => {
  test("a package.json with no scripts block reports nothing", () => {
    expect(
      scanPackageJsonScripts([
        { path: "package.json", content: '{"name":"pkg","version":"1.0.0"}' },
      ]),
    ).toEqual([]);
  });

  test("a scripts block with no banned tokens reports nothing", () => {
    expect(
      scanPackageJsonScripts([
        {
          path: "package.json",
          content: '{"scripts":{"build":"tsc","test":"vitest run"}}',
        },
      ]),
    ).toEqual([]);
  });

  test("prose elsewhere in the file mentioning docker is not scanned — only scripts", () => {
    expect(
      scanPackageJsonScripts([
        {
          path: "package.json",
          content:
            '{"description":"a docker wrapper","scripts":{"build":"tsc"}}',
        },
      ]),
    ).toEqual([]);
  });

  test("a banned token inside a script value is flagged, naming the script", () => {
    const findings = scanPackageJsonScripts([
      {
        path: "package.json",
        content: '{"scripts":{"build":"docker build ."}}',
      },
    ]);

    expect(findings).toHaveLength(1);
    expect(required(findings[0], "finding")).toContain("scripts.build");
    expect(required(findings[0], "finding")).toContain("package.json");
  });

  test("multiple offending scripts in one file each get their own finding", () => {
    const findings = scanPackageJsonScripts([
      {
        path: "package.json",
        content:
          '{"scripts":{"build":"docker build .","up":"docker-compose up"}}',
      },
    ]);

    expect(findings).toHaveLength(2);
  });

  test("a non-string script value is skipped, not an error", () => {
    expect(
      scanPackageJsonScripts([
        { path: "package.json", content: '{"scripts":{"build":5}}' },
      ]),
    ).toEqual([]);
  });

  test("malformed JSON is REPORTED as an error finding, never silently skipped", () => {
    const findings = scanPackageJsonScripts([
      { path: "package.json", content: "{ this is not valid json" },
    ]);

    expect(findings).toHaveLength(1);
    expect(required(findings[0], "finding")).toContain(
      "could not be parsed as JSON",
    );
    expect(required(findings[0], "finding")).toContain("package.json");
  });

  test("an allowlisted historical-record path is not scanned even with malformed JSON", () => {
    expect(
      scanPackageJsonScripts([
        { path: "docs/logs/old-package.json", content: "{ not json" },
      ]),
    ).toEqual([]);
  });
});

describe("listTrackedFiles", () => {
  test("parses NUL-delimited output into an array of paths", () => {
    expect(listTrackedFiles(() => "a.ts\0b.ts\0c.ts\0")).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  test("survives a filename containing a literal newline", () => {
    const weird = "dir/we\nird.ts";
    expect(listTrackedFiles(() => `a.ts\0${weird}\0`)).toEqual(["a.ts", weird]);
  });

  test("empty git output yields [] rather than ['']", () => {
    expect(listTrackedFiles(() => "")).toEqual([]);
  });
});

describe("isInvocationScanCandidate", () => {
  test.each([
    [".github/workflows/ci.yml", true],
    [".github/workflows/nested/reusable.yml", true],
    ["bin/check-no-docker.mjs", true],
    ["bin/lib/docker-ban-scan.mjs", true],
    ["lefthook.yml", true],
    ["docs/adr/0091-no-docker.md", false],
    ["packages/m3l-common/src/index.ts", false],
    ["sub/lefthook.yml", false],
  ])("isInvocationScanCandidate(%s) is %s", (path, expected) => {
    expect(isInvocationScanCandidate(path)).toBe(expected);
  });
});

describe("runDockerBanCheck", () => {
  function seams(
    tracked: string[],
    contents: Record<string, string> = {},
  ): {
    runGit: () => string;
    readFile: (path: string) => string;
  } {
    return {
      runGit: () => tracked.join("\0") + (tracked.length > 0 ? "\0" : ""),
      readFile: (path: string) =>
        required(contents[path], `contents for ${path}`),
    };
  }

  test("a clean tree passes and reports the scanned count", () => {
    const reporter = createFakeReporter();
    const outcome = runDockerBanCheck({
      ...seams(
        [
          "README.md",
          "src/index.ts",
          ".github/workflows/ci.yml",
          "package.json",
        ],
        {
          ".github/workflows/ci.yml": "steps:\n  - run: podman build .\n",
          "package.json": '{"scripts":{"build":"tsc"}}',
        },
      ),
      reporter,
    });

    expect(outcome).toMatchObject({ ok: true, findings: [], scanned: 4 });
    expect(reporter.errors).toEqual([]);
    expect(required(reporter.succeeded[0], "success")).toContain("4");
  });

  test("a banned Dockerfile fails the gate", () => {
    const reporter = createFakeReporter();
    const outcome = runDockerBanCheck({
      ...seams(["README.md", "packages/foo/Dockerfile"]),
      reporter,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    expect(required(outcome.findings[0], "finding")).toContain("Dockerfile");
    expect(reporter.errors).toHaveLength(1);
  });

  test("a banned invocation in a workflow file fails the gate", () => {
    const reporter = createFakeReporter();
    const outcome = runDockerBanCheck({
      ...seams(["README.md", ".github/workflows/ci.yml"], {
        ".github/workflows/ci.yml": "steps:\n  - run: docker build -t app .\n",
      }),
      reporter,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    expect(required(outcome.findings[0], "finding")).toContain(
      ".github/workflows/ci.yml",
    );
  });

  test("a banned invocation inside package.json's scripts fails the gate", () => {
    const reporter = createFakeReporter();
    const outcome = runDockerBanCheck({
      ...seams(["README.md", "package.json"], {
        "package.json": '{"scripts":{"up":"docker-compose up"}}',
      }),
      reporter,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    expect(required(outcome.findings[0], "finding")).toContain("scripts.up");
  });

  test("an empty tracked file list fails rather than reporting a clean scan of nothing", () => {
    const reporter = createFakeReporter();
    const outcome = runDockerBanCheck({
      runGit: () => "",
      readFile: () => "",
      reporter,
    });

    expect(outcome).toMatchObject({ ok: false, scanned: 0 });
    expect(required(reporter.errors[0], "error")).toMatch(
      /refusing to report a clean scan of nothing/,
    );
  });

  test("a runGit throw fails the gate with the cause in the error message", () => {
    const reporter = createFakeReporter();
    const outcome = runDockerBanCheck({
      runGit: () => {
        throw new Error("fatal: not a git repository");
      },
      readFile: () => "",
      reporter,
    });

    expect(outcome.ok).toBe(false);
    expect(required(reporter.errors[0], "error")).toMatch(
      /fatal: not a git repository/,
    );
  });

  test("an unreadable candidate file is REPORTED, never skipped silently", () => {
    const reporter = createFakeReporter();
    const outcome = runDockerBanCheck({
      runGit: () => "bin/check-foo.mjs\0",
      readFile: () => {
        throw new Error("EACCES: permission denied");
      },
      reporter,
    });

    expect(outcome.ok).toBe(false);
    const finding = required(
      outcome.findings.find((entry) => entry.includes("bin/check-foo.mjs")),
      "finding",
    );
    expect(finding).toMatch(/EACCES/);
    expect(finding).toMatch(/Not skipping silently/);
  });

  test("every finish() payload carries findings and scanned regardless of outcome", () => {
    const scenarios: {
      runGit: () => string;
      readFile: (path: string) => string;
    }[] = [
      seams(["README.md", "src/index.ts"]),
      seams(["README.md", "packages/foo/Dockerfile"]),
      { runGit: () => "", readFile: () => "" },
      {
        runGit: () => {
          throw new Error("boom");
        },
        readFile: () => "",
      },
    ];

    for (const scenario of scenarios) {
      const reporter = createFakeReporter();
      runDockerBanCheck({ ...scenario, reporter });
      expect(reporter.finishedWith).toHaveProperty("findings");
      expect(reporter.finishedWith).toHaveProperty("scanned");
    }
  });
});
