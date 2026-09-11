import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  PACKAGE_MANAGER_NAME,
  collectContainerfiles,
  collectGithubPnpmSetupFiles,
  findContainerfileDrift,
  findPackageManagerPinErrors,
  findUnreadPin,
  findWorkflowPnpmVersionDrift,
  parsePackageManagerField,
  scanContainerfilePnpmInstalls,
  scanWorkflowPnpmSetup,
} from "../../bin/check-pnpm-version.mjs";

const PIN = "12.4.1";
const pinnedContainerfile = `FROM node:24-slim
RUN npm install --global pnpm@${PIN}
`;
const plainActionSetupStep = `runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10

    - name: Install
      run: pnpm install --frozen-lockfile
`;

describe("PACKAGE_MANAGER_NAME", () => {
  test("names the pinned manager", () => {
    expect(PACKAGE_MANAGER_NAME).toBe("pnpm");
  });
});

describe("parsePackageManagerField", () => {
  test("splits name, version, and integrity suffix", () => {
    expect(parsePackageManagerField(`pnpm@${PIN}`)).toEqual({
      name: "pnpm",
      version: PIN,
      integrity: null,
    });
  });

  test("captures the integrity suffix separately from the version", () => {
    expect(parsePackageManagerField(`pnpm@${PIN}+sha512.abc123`)).toEqual({
      name: "pnpm",
      version: PIN,
      integrity: "sha512.abc123",
    });
  });

  test.each([
    { label: "undefined", text: undefined },
    { label: "an empty string", text: "" },
    { label: "a bare name with no version", text: "pnpm" },
  ])("returns null for $label — it has no name@version shape", ({ text }) => {
    expect(parsePackageManagerField(text as string)).toBeNull();
  });
});

describe("findPackageManagerPinErrors", () => {
  test("accepts an exact pnpm pin", () => {
    expect(findPackageManagerPinErrors({ name: "pnpm", version: PIN })).toEqual(
      [],
    );
  });

  test("rejects a null field (missing or unparseable)", () => {
    const errors = findPackageManagerPinErrors(null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing or unparseable");
  });

  test("rejects a non-pnpm manager", () => {
    const errors = findPackageManagerPinErrors({
      name: "yarn",
      version: "4.0.0",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('names "yarn"');
  });

  test.each([
    { label: "a caret range", version: "^12.4.0" },
    { label: "a tilde range", version: "~12.4.0" },
    { label: "a bare major", version: "12" },
    { label: "a major.minor", version: "12.4" },
    { label: "the latest tag", version: "latest" },
  ])("rejects $label — it would re-drift silently", ({ version }) => {
    const errors = findPackageManagerPinErrors({ name: "pnpm", version });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("is a range");
  });
});

describe("scanContainerfilePnpmInstalls", () => {
  test("finds a pinned global install", () => {
    expect(scanContainerfilePnpmInstalls(pinnedContainerfile)).toEqual([
      { line: 2, version: PIN },
    ]);
  });

  test("reports an unpinned install with a null version", () => {
    const found = scanContainerfilePnpmInstalls(
      "RUN npm install --global pnpm\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.version).toBeNull();
  });

  test("recognizes the short -i / -g flag form too", () => {
    expect(scanContainerfilePnpmInstalls(`RUN npm i -g pnpm@${PIN}\n`)).toEqual(
      [{ line: 1, version: PIN }],
    );
  });

  test("ignores a line that mentions pnpm without a global install", () => {
    expect(
      scanContainerfilePnpmInstalls(`RUN corepack use pnpm@${PIN}\n`),
    ).toEqual([]);
  });
});

describe("findContainerfileDrift", () => {
  test("accepts a Containerfile whose literal matches the pin", () => {
    expect(
      findContainerfileDrift(PIN, [
        {
          file: "packages/m3l-console-web/Containerfile",
          text: pinnedContainerfile,
        },
      ]),
    ).toEqual({ errors: [], siteCount: 1 });
  });

  test("rejects an unpinned install", () => {
    const { errors, siteCount } = findContainerfileDrift(PIN, [
      { file: "Containerfile", text: "RUN npm install --global pnpm\n" },
    ]);
    expect(siteCount).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("without a version");
  });

  test("rejects a shell-substituted version, which still reads as unpinned", () => {
    const { errors } = findContainerfileDrift(PIN, [
      {
        file: "Containerfile",
        text: "RUN npm install --global pnpm@$(cat .pnpm-version)\n",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("shell substitution");
  });

  test("rejects a literal that disagrees with the pin", () => {
    const { errors } = findContainerfileDrift(PIN, [
      {
        file: "Containerfile",
        text: "RUN npm install --global pnpm@11.9.0\n",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("11.9.0");
    expect(errors[0]).toContain("different resolver than CI");
  });

  test("reports every drifting Containerfile independently", () => {
    const { errors, siteCount } = findContainerfileDrift(PIN, [
      {
        file: "packages/a/Containerfile",
        text: "RUN npm install --global pnpm@11.9.0\n",
      },
      {
        file: "packages/b/Containerfile",
        text: "RUN npm install --global pnpm@11.8.0\n",
      },
    ]);
    expect(siteCount).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("packages/a/Containerfile");
    expect(errors[1]).toContain("packages/b/Containerfile");
  });
});

describe("scanWorkflowPnpmSetup", () => {
  test("counts a plain action-setup step with no version override", () => {
    expect(scanWorkflowPnpmSetup(plainActionSetupStep)).toEqual({
      actionSetupCount: 1,
      versionOverrides: [],
    });
  });

  test("finds an explicit version: input nested under with:", () => {
    const text = `runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
      with:
        version: 12
`;
    expect(scanWorkflowPnpmSetup(text)).toEqual({
      actionSetupCount: 1,
      versionOverrides: [{ line: 6, value: "12" }],
    });
  });

  test("stops scanning a step's block at the next step, not later in the file", () => {
    const text = `steps:
  - uses: pnpm/action-setup@abc
  - name: something else
    with:
      version: unrelated
`;
    expect(scanWorkflowPnpmSetup(text)).toEqual({
      actionSetupCount: 1,
      versionOverrides: [],
    });
  });

  test("counts every action-setup site in the file", () => {
    const text = plainActionSetupStep + plainActionSetupStep;
    expect(scanWorkflowPnpmSetup(text).actionSetupCount).toBe(2);
  });

  test("counts a name-first step and still finds its version override", () => {
    // Regression for the Should-fix #1 rewrite: the step's `uses:` line no
    // longer shares the `- ` marker's own line (name-first form), which the
    // old dash-anchored regex missed entirely. Verified against the real
    // source via a live `node -e` run rather than assumed: the "with:" line
    // shifts the "version:" line down one more, landing on line 4.
    const text =
      "- name: Setup pnpm\n" +
      "  uses: pnpm/action-setup@abc\n" +
      "  with:\n" +
      "    version: 12\n";
    expect(scanWorkflowPnpmSetup(text)).toEqual({
      actionSetupCount: 1,
      versionOverrides: [{ line: 4, value: "12" }],
    });
  });
});

describe("findWorkflowPnpmVersionDrift", () => {
  test("accepts a file with no version override", () => {
    expect(
      findWorkflowPnpmVersionDrift([
        { file: "action.yml", text: plainActionSetupStep },
      ]),
    ).toEqual({ errors: [], actionSetupCount: 1 });
  });

  test("rejects an explicit version override, naming the site", () => {
    const text = `steps:
  - uses: pnpm/action-setup@abc
    with:
      version: 12
`;
    const { errors, actionSetupCount } = findWorkflowPnpmVersionDrift([
      { file: "action.yml", text },
    ]);
    // Should-fix #2: an overridden site demonstrably does NOT read
    // packageManager, so it is excluded from actionSetupCount (one site
    // total, minus the one override, is zero) rather than counted alongside
    // clean sites.
    expect(actionSetupCount).toBe(0);
    expect(errors).toHaveLength(1);
    // Verified against the real source rather than assumed: the "with:"
    // line shifts the "version:" line down one, so the override lands on
    // line 4, not line 3.
    expect(errors[0]).toContain("action.yml:4");
    expect(errors[0]).toContain("overrides packageManager");
  });

  test("excludes an overridden site from actionSetupCount while still counting a clean one", () => {
    // Regression for the Should-fix #2 overcounting fix: across two files,
    // only the clean site should be counted as "reading the pin" — the
    // overridden site in the second file must not inflate the total.
    const overriddenText = `steps:
  - uses: pnpm/action-setup@abc
    with:
      version: 12
`;
    const { actionSetupCount } = findWorkflowPnpmVersionDrift([
      { file: "clean.yml", text: plainActionSetupStep },
      { file: "overridden.yml", text: overriddenText },
    ]);
    expect(actionSetupCount).toBe(1);
  });
});

describe("findUnreadPin", () => {
  test("accepts when at least one Containerfile site reads the pin", () => {
    expect(findUnreadPin(PIN, 1, 0)).toEqual([]);
  });

  test("accepts when at least one action-setup site reads the pin", () => {
    expect(findUnreadPin(PIN, 0, 1)).toEqual([]);
  });

  test("rejects when nothing reads the pin at all", () => {
    const errors = findUnreadPin(PIN, 0, 0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no Containerfile or workflow reads it");
  });
});

describe("collectContainerfiles", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns every packages/<name>/Containerfile, sorted and POSIX-separated", () => {
    dir = mktemp();
    mkdirSync(join(dir, "packages", "a"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "Containerfile"), "FROM node\n");
    mkdirSync(join(dir, "packages", "b"), { recursive: true });
    mkdirSync(join(dir, "packages", "c"), { recursive: true });
    writeFileSync(join(dir, "packages", "c", "Containerfile"), "FROM node\n");

    const result = collectContainerfiles(dir);
    expect(result).toEqual([
      "packages/a/Containerfile",
      "packages/c/Containerfile",
    ]);
    for (const path of result) {
      expect(path).not.toContain("\\");
    }
  });

  test("returns an empty array when packages/ does not exist", () => {
    dir = mktemp();
    expect(collectContainerfiles(dir)).toEqual([]);
  });

  test("skips a non-directory entry under packages/", () => {
    dir = mktemp();
    mkdirSync(join(dir, "packages"), { recursive: true });
    writeFileSync(join(dir, "packages", "README.md"), "not a package\n");

    expect(collectContainerfiles(dir)).toEqual([]);
  });
});

describe("collectGithubPnpmSetupFiles", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns workflow yml/yaml files and composite action.yml files, sorted", () => {
    dir = mktemp();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
    writeFileSync(
      join(dir, ".github", "workflows", "other.yaml"),
      "name: Other\n",
    );
    writeFileSync(
      join(dir, ".github", "workflows", "README.md"),
      "not a workflow\n",
    );
    mkdirSync(join(dir, ".github", "actions", "setup"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "actions", "setup", "action.yml"),
      "name: Setup\n",
    );

    expect(collectGithubPnpmSetupFiles(dir)).toEqual([
      ".github/actions/setup/action.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/other.yaml",
    ]);
  });

  test("degrades to whatever exists when workflows or actions is missing", () => {
    dir = mktemp();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");

    expect(collectGithubPnpmSetupFiles(dir)).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });

  test("returns an empty array when .github does not exist at all", () => {
    dir = mktemp();
    expect(collectGithubPnpmSetupFiles(dir)).toEqual([]);
  });
});

describe("the committed repo state", () => {
  test("every Containerfile and workflow site agrees with packageManager", async () => {
    const { readFileSync, readdirSync, existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");

    const root = fileURLToPath(new URL("../../", import.meta.url));
    const manifest = JSON.parse(
      readFileSync(`${root}package.json`, "utf8"),
    ) as {
      packageManager?: string;
    };
    const field = parsePackageManagerField(manifest.packageManager);
    if (field === null) {
      throw new Error("package.json's packageManager is not name@version");
    }

    const containerfiles: Array<{ file: string; text: string }> = [];
    const packagesDir = `${root}packages`;
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `packages/${entry.name}/Containerfile`;
      if (existsSync(`${root}${rel}`)) {
        containerfiles.push({
          file: rel,
          text: readFileSync(`${root}${rel}`, "utf8"),
        });
      }
    }
    expect(
      findContainerfileDrift(field.version, containerfiles).errors,
    ).toEqual([]);

    const githubFiles: Array<{ file: string; text: string }> = [];
    const workflowsDir = `${root}.github/workflows`;
    for (const name of readdirSync(workflowsDir)) {
      if (/\.ya?ml$/.test(name)) {
        githubFiles.push({
          file: `.github/workflows/${name}`,
          text: readFileSync(`${workflowsDir}/${name}`, "utf8"),
        });
      }
    }
    const actionsDir = `${root}.github/actions`;
    for (const entry of readdirSync(actionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `.github/actions/${entry.name}/action.yml`;
      if (existsSync(`${root}${rel}`)) {
        githubFiles.push({
          file: rel,
          text: readFileSync(`${root}${rel}`, "utf8"),
        });
      }
    }
    expect(findWorkflowPnpmVersionDrift(githubFiles).errors).toEqual([]);
  });
});

/** Create a fresh temp directory for one test; caller removes it in afterEach. */
function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "m3l-check-pnpm-version-"));
}
