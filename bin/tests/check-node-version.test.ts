import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  parseNodeVersionFile,
  parseEnginesFloorMajor,
  findEnginesDrift,
  scanWorkflowNodeSetup,
  findWorkflowNodeVersionDrift,
  evaluateRuntimeVersion,
  collectWorkspaceManifests,
  collectGithubNodeSetupFiles,
  findTypesNodeDrift,
} from "../../bin/check-node-version.mjs";

describe("parseNodeVersionFile", () => {
  test("parses a bare major", () => {
    expect(parseNodeVersionFile("24")).toEqual({ major: 24, raw: "24" });
  });

  test("parses a full version", () => {
    expect(parseNodeVersionFile("24.13.3")).toEqual({
      major: 24,
      raw: "24.13.3",
    });
  });

  test("parses a v-prefixed version", () => {
    expect(parseNodeVersionFile("v24")).toEqual({ major: 24, raw: "v24" });
  });

  test("trims surrounding whitespace and a trailing newline", () => {
    expect(parseNodeVersionFile("  24\n")).toEqual({ major: 24, raw: "24" });
  });

  test("null for a floating lts alias", () => {
    expect(parseNodeVersionFile("lts/*")).toBeNull();
  });

  test("null for the bare 'node' alias", () => {
    expect(parseNodeVersionFile("node")).toBeNull();
  });

  test("null for an empty string", () => {
    expect(parseNodeVersionFile("")).toBeNull();
  });

  test("null for garbage", () => {
    expect(parseNodeVersionFile("not-a-version")).toBeNull();
  });
});

describe("parseEnginesFloorMajor", () => {
  test("parses a bare major floor", () => {
    expect(parseEnginesFloorMajor(">=24")).toBe(24);
  });

  test("parses a full-version floor", () => {
    expect(parseEnginesFloorMajor(">=24.0.0")).toBe(24);
  });

  test("parses a floor with a space after '>='", () => {
    expect(parseEnginesFloorMajor(">= 24")).toBe(24);
  });

  test("parses a v-prefixed floor", () => {
    expect(parseEnginesFloorMajor(">=v24")).toBe(24);
  });

  test("null for undefined", () => {
    expect(parseEnginesFloorMajor(undefined)).toBeNull();
  });

  test("null for a caret range", () => {
    expect(parseEnginesFloorMajor("^24")).toBeNull();
  });

  test("null for a bare version with no operator", () => {
    expect(parseEnginesFloorMajor("24")).toBeNull();
  });

  test("null for a strict-greater-than range", () => {
    expect(parseEnginesFloorMajor(">24")).toBeNull();
  });

  test("null for a floor-and-ceiling range", () => {
    expect(parseEnginesFloorMajor(">=24 <25")).toBeNull();
  });
});

describe("findEnginesDrift", () => {
  test("empty when every manifest's floor agrees with the pin", () => {
    const errors = findEnginesDrift(24, [
      { file: "package.json", engines: { node: ">=24" } },
      { file: "packages/m3l-common/package.json", engines: { node: ">=24" } },
    ]);
    expect(errors).toEqual([]);
  });

  test("errors when engines is entirely absent", () => {
    const errors = findEnginesDrift(24, [
      { file: "scripts/foo/package.json", engines: undefined },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/scripts\/foo\/package\.json/);
    expect(errors[0]).toMatch(/engines\.node/);
  });

  test("errors when engines.node is absent", () => {
    const errors = findEnginesDrift(24, [
      { file: "scripts/bar/package.json", engines: {} },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/scripts\/bar\/package\.json/);
  });

  test("errors when the range is unparseable", () => {
    const errors = findEnginesDrift(24, [
      { file: "packages/m3l-cli/package.json", engines: { node: "^24" } },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/packages\/m3l-cli\/package\.json/);
  });

  test("errors when the parsed floor major differs from the pin", () => {
    const errors = findEnginesDrift(24, [
      { file: "scripts/baz/package.json", engines: { node: ">=22" } },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/scripts\/baz\/package\.json/);
    expect(errors[0]).toMatch(/22/);
    expect(errors[0]).toMatch(/24/);
  });

  test("one error per offending manifest, none for agreeing ones", () => {
    const errors = findEnginesDrift(24, [
      { file: "package.json", engines: { node: ">=24" } },
      { file: "scripts/a/package.json", engines: { node: ">=22" } },
      { file: "scripts/b/package.json", engines: undefined },
    ]);
    expect(errors).toHaveLength(2);
  });
});

describe("scanWorkflowNodeSetup", () => {
  test("counts a setup-node step with a leading dash", () => {
    const result = scanWorkflowNodeSetup(
      "steps:\n  - uses: actions/setup-node@v4\n",
    );
    expect(result.setupNodeCount).toBe(1);
  });

  test("counts a setup-node step without a leading dash", () => {
    const result = scanWorkflowNodeSetup("  uses: actions/setup-node@v4\n");
    expect(result.setupNodeCount).toBe(1);
  });

  test("a setup-node@sha line is counted and not also treated as a literal or version-file line", () => {
    const result = scanWorkflowNodeSetup(
      "  - uses: actions/setup-node@abcdef0123456789\n",
    );
    expect(result.setupNodeCount).toBe(1);
    expect(result.literals).toEqual([]);
    expect(result.versionFiles).toEqual([]);
  });

  test("records a literal node-version with its 1-indexed line number", () => {
    const result = scanWorkflowNodeSetup(
      "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: 24\n",
    );
    expect(result.literals).toEqual([{ line: 4, value: "24" }]);
  });

  test("records a node-version-file value and strips surrounding double quotes", () => {
    const result = scanWorkflowNodeSetup(
      '      node-version-file: ".node-version"\n',
    );
    expect(result.versionFiles).toEqual([{ line: 1, value: ".node-version" }]);
  });

  test("records a node-version-file value and strips surrounding single quotes", () => {
    const result = scanWorkflowNodeSetup(
      "      node-version-file: '.node-version'\n",
    );
    expect(result.versionFiles).toEqual([{ line: 1, value: ".node-version" }]);
  });

  test("returns empty arrays and a zero count for text with none of the markers", () => {
    const result = scanWorkflowNodeSetup("name: CI\non: push\n");
    expect(result.setupNodeCount).toBe(0);
    expect(result.literals).toEqual([]);
    expect(result.versionFiles).toEqual([]);
  });
});

describe("findWorkflowNodeVersionDrift", () => {
  test("a literal node-version is an error", () => {
    const errors = findWorkflowNodeVersionDrift([
      {
        file: ".github/workflows/ci.yml",
        text:
          "steps:\n  - uses: actions/setup-node@v4\n    with:\n" +
          "      node-version: 24\n",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\.github\/workflows\/ci\.yml:4/);
    expect(errors[0]).toMatch(/node-version: 24/);
  });

  test("a node-version-file not pointed at .node-version is an error", () => {
    const errors = findWorkflowNodeVersionDrift([
      {
        file: ".github/workflows/release.yml",
        text:
          "steps:\n  - uses: actions/setup-node@v4\n    with:\n" +
          "      node-version-file: .nvmrc\n",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\.github\/workflows\/release\.yml:4/);
    expect(errors[0]).toMatch(/\.nvmrc/);
  });

  test("a setup-node step with neither key declared is an error", () => {
    const errors = findWorkflowNodeVersionDrift([
      {
        file: ".github/workflows/lint.yml",
        text: "steps:\n  - uses: actions/setup-node@v4\n",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\.github\/workflows\/lint\.yml/);
    expect(errors[0]).toMatch(/actions\/setup-node/);
  });

  test("node-version-file: .node-version yields no errors", () => {
    const errors = findWorkflowNodeVersionDrift([
      {
        file: ".github/workflows/ci.yml",
        text:
          "steps:\n  - uses: actions/setup-node@v4\n    with:\n" +
          "      node-version-file: .node-version\n",
      },
    ]);
    expect(errors).toEqual([]);
  });

  test("a file with no setup-node and no keys at all yields no errors", () => {
    const errors = findWorkflowNodeVersionDrift([
      { file: ".github/workflows/docs.yml", text: "name: Docs\non: push\n" },
    ]);
    expect(errors).toEqual([]);
  });
});

describe("evaluateRuntimeVersion", () => {
  test("empty when the running major matches a bare-major pin", () => {
    expect(evaluateRuntimeVersion(24, "24")).toEqual([]);
  });

  test("empty when the running major matches a full-version runtime string", () => {
    expect(evaluateRuntimeVersion(24, "24.13.3")).toEqual([]);
  });

  test("one warning mentioning both versions when the major differs", () => {
    const warnings = evaluateRuntimeVersion(24, "26.8.1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/26\.8\.1/);
    expect(warnings[0]).toMatch(/24/);
  });

  test("empty (fails open) when the runtime version is unparseable", () => {
    expect(evaluateRuntimeVersion(24, "not-a-version")).toEqual([]);
  });
});

describe("collectWorkspaceManifests", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("always includes the root package.json", () => {
    dir = mktemp();
    writeFileSync(join(dir, "package.json"), "{}\n");
    expect(collectWorkspaceManifests(dir)).toEqual(["package.json"]);
  });

  test("picks up packages/<name>/package.json and scripts/<name>/package.json", () => {
    dir = mktemp();
    writeFileSync(join(dir, "package.json"), "{}\n");
    mkdirSync(join(dir, "packages", "m3l-common"), { recursive: true });
    writeFileSync(join(dir, "packages", "m3l-common", "package.json"), "{}\n");
    mkdirSync(join(dir, "scripts", "run-export"), { recursive: true });
    writeFileSync(join(dir, "scripts", "run-export", "package.json"), "{}\n");

    expect(collectWorkspaceManifests(dir)).toEqual([
      "package.json",
      "packages/m3l-common/package.json",
      "scripts/run-export/package.json",
    ]);
  });

  test("skips a directory with no package.json", () => {
    dir = mktemp();
    writeFileSync(join(dir, "package.json"), "{}\n");
    mkdirSync(join(dir, "packages", "empty-dir"), { recursive: true });

    expect(collectWorkspaceManifests(dir)).toEqual(["package.json"]);
  });

  test("skips a non-directory entry inside packages/", () => {
    dir = mktemp();
    writeFileSync(join(dir, "package.json"), "{}\n");
    mkdirSync(join(dir, "packages"), { recursive: true });
    writeFileSync(join(dir, "packages", "README.md"), "not a dir\n");

    expect(collectWorkspaceManifests(dir)).toEqual(["package.json"]);
  });

  test("tolerates a missing packages/ or scripts/ directory entirely", () => {
    dir = mktemp();
    writeFileSync(join(dir, "package.json"), "{}\n");

    expect(collectWorkspaceManifests(dir)).toEqual(["package.json"]);
  });

  test("returns POSIX-separated, sorted paths", () => {
    dir = mktemp();
    writeFileSync(join(dir, "package.json"), "{}\n");
    mkdirSync(join(dir, "scripts", "zeta"), { recursive: true });
    writeFileSync(join(dir, "scripts", "zeta", "package.json"), "{}\n");
    mkdirSync(join(dir, "packages", "alpha"), { recursive: true });
    writeFileSync(join(dir, "packages", "alpha", "package.json"), "{}\n");

    const result = collectWorkspaceManifests(dir);
    expect(result).toEqual([...result].sort());
    for (const path of result) {
      expect(path).not.toContain("\\");
    }
  });
});

describe("collectGithubNodeSetupFiles", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("picks up .github/workflows/*.yml and *.yaml", () => {
    dir = mktemp();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
    writeFileSync(
      join(dir, ".github", "workflows", "release.yaml"),
      "name: Release\n",
    );

    expect(collectGithubNodeSetupFiles(dir)).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
    ]);
  });

  test("ignores a non-YAML file in .github/workflows", () => {
    dir = mktemp();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
    writeFileSync(join(dir, ".github", "workflows", "README.md"), "notes\n");

    expect(collectGithubNodeSetupFiles(dir)).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });

  test("picks up a composite action's action.yml and action.yaml", () => {
    dir = mktemp();
    mkdirSync(join(dir, ".github", "actions", "setup"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "actions", "setup", "action.yml"),
      "name: Setup\n",
    );
    mkdirSync(join(dir, ".github", "actions", "build"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "actions", "build", "action.yaml"),
      "name: Build\n",
    );

    expect(collectGithubNodeSetupFiles(dir)).toEqual([
      ".github/actions/build/action.yaml",
      ".github/actions/setup/action.yml",
    ]);
  });

  test("tolerates both .github/workflows and .github/actions missing", () => {
    dir = mktemp();
    mkdirSync(join(dir, ".github"), { recursive: true });

    expect(collectGithubNodeSetupFiles(dir)).toEqual([]);
  });

  test("returns sorted paths", () => {
    dir = mktemp();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "zeta.yml"), "name: Z\n");
    writeFileSync(join(dir, ".github", "workflows", "alpha.yml"), "name: A\n");

    const result = collectGithubNodeSetupFiles(dir);
    expect(result).toEqual([...result].sort());
  });
});

describe("findTypesNodeDrift", () => {
  test("returns no errors when the range is undefined (absent is not an error)", () => {
    expect(findTypesNodeDrift(24, undefined)).toEqual([]);
  });

  test.each([
    ["24.13.3"],
    ["24"],
    ["^24.13.3"],
    ["~24.0.0"],
    ["v24"],
    ["  24.13.3  "],
  ])("parses %j as major 24 and agrees with a pin of 24", (range) => {
    expect(findTypesNodeDrift(24, range)).toEqual([]);
  });

  test.each([["*"], [">=24"], ["24.x"], ["latest"], [""]])(
    "reports exactly one unparseable error for %j",
    (range) => {
      const errors = findTypesNodeDrift(24, range);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        new RegExp(
          JSON.stringify(range).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      );
      expect(errors[0]).toMatch(/cannot compare/u);
    },
  );

  test("reports exactly one drift error naming both majors when they disagree", () => {
    const errors = findTypesNodeDrift(24, "26.1.1");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/26/u);
    expect(errors[0]).toMatch(/24/u);
  });

  test("uses the default manifestRel of package.json in the unparseable message", () => {
    const errors = findTypesNodeDrift(24, "latest");
    expect(errors[0]).toMatch(/package\.json/u);
  });

  test("uses the default manifestRel of package.json in the drift message", () => {
    const errors = findTypesNodeDrift(24, "26.1.1");
    expect(errors[0]).toMatch(/package\.json/u);
  });

  test("uses a custom manifestRel in the unparseable message instead of the default", () => {
    const errors = findTypesNodeDrift(
      24,
      "latest",
      "packages/foo/package.json",
    );
    expect(errors[0]).toMatch(/packages\/foo\/package\.json/u);
    expect(errors[0]).not.toMatch(/^package\.json/u);
  });

  test("uses a custom manifestRel in the drift message instead of the default", () => {
    const errors = findTypesNodeDrift(
      24,
      "26.1.1",
      "packages/foo/package.json",
    );
    expect(errors[0]).toMatch(/packages\/foo\/package\.json/u);
    expect(errors[0]).not.toMatch(/^package\.json/u);
  });
});

/** Create a fresh temp directory for one test; caller removes it in afterEach. */
function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "m3l-check-node-version-"));
}
