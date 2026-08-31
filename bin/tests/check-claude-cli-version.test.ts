import { describe, expect, test } from "vitest";
import {
  CLI_PACKAGE,
  VERSION_FILE,
  findClaudeCliVersionDrift,
  parseClaudeCodeVersionFile,
  scanClaudeCliInstalls,
} from "../../bin/check-claude-cli-version.mjs";

const PIN = "2.1.251";
const pinnedWorkflow = `jobs:
  evals:
    steps:
      - name: Install Claude Code CLI
        run: npm install -g ${CLI_PACKAGE}@${PIN}
`;

describe("VERSION_FILE and CLI_PACKAGE", () => {
  test("name the single authority and the package it pins", () => {
    expect(VERSION_FILE).toBe(".claude-code-version");
    expect(CLI_PACKAGE).toBe("@anthropic-ai/claude-code");
  });
});

describe("parseClaudeCodeVersionFile", () => {
  test("accepts an exact x.y.z version, ignoring surrounding whitespace", () => {
    expect(parseClaudeCodeVersionFile(" 2.1.251\n")).toEqual({
      version: "2.1.251",
    });
  });

  test.each([
    { label: "a caret range", text: "^2.1.251" },
    { label: "a tilde range", text: "~2.1.251" },
    { label: "a bare major", text: "2" },
    { label: "a major.minor", text: "2.1" },
    { label: "the latest tag", text: "latest" },
    { label: "a v prefix", text: "v2.1.251" },
    { label: "an empty file", text: "" },
    { label: "undefined", text: undefined },
  ])("rejects $label — it would pin nothing", ({ text }) => {
    expect(parseClaudeCodeVersionFile(text as string)).toBeNull();
  });
});

describe("scanClaudeCliInstalls", () => {
  test("finds a pinned global install and reads the version after the package name", () => {
    // The package name itself contains an "@", so a naive split would read
    // "anthropic-ai/claude-code" as the version.
    expect(scanClaudeCliInstalls(pinnedWorkflow)).toEqual([
      {
        line: 5,
        spec: PIN,
        text: `run: npm install -g ${CLI_PACKAGE}@${PIN}`,
      },
    ]);
  });

  test("reports an unpinned install with a null spec", () => {
    const found = scanClaudeCliInstalls(
      `        run: npm install -g ${CLI_PACKAGE}\n`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.spec).toBeNull();
  });

  test("ignores a line that mentions the package without installing it", () => {
    expect(
      scanClaudeCliInstalls(`      # see ${CLI_PACKAGE} release notes\n`),
    ).toEqual([]);
  });

  test("finds every install site, not just the first", () => {
    expect(
      scanClaudeCliInstalls(
        `        run: npm install -g ${CLI_PACKAGE}@${PIN}\n` +
          `        run: npm install -g ${CLI_PACKAGE}@1.0.0\n`,
      ),
    ).toHaveLength(2);
  });
});

describe("findClaudeCliVersionDrift", () => {
  test("accepts a workflow whose literal matches the pin", () => {
    expect(
      findClaudeCliVersionDrift(PIN, [
        { file: "skill-evals.yml", text: pinnedWorkflow },
      ]),
    ).toEqual([]);
  });

  test("rejects an unpinned install, naming the Scorecard alert", () => {
    const errors = findClaudeCliVersionDrift(PIN, [
      {
        file: "skill-evals.yml",
        text: `        run: npm install -g ${CLI_PACKAGE}\n`,
      },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("without a version");
    expect(errors[0]).toContain("PinnedDependenciesID");
  });

  test("rejects a shell-substituted version, which still reads as unpinned", () => {
    // The whole reason the literal is required rather than `@$(cat FILE)`.
    const errors = findClaudeCliVersionDrift(PIN, [
      {
        file: "skill-evals.yml",
        text:
          "        run: npm install -g " +
          CLI_PACKAGE +
          "@$(cat .claude-code-version)\n",
      },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("shell substitution");
    expect(errors[0]).toContain("parses the command text");
  });

  test("rejects a literal that disagrees with the pin", () => {
    const errors = findClaudeCliVersionDrift(PIN, [
      {
        file: "skill-evals.yml",
        text: `        run: npm install -g ${CLI_PACKAGE}@9.9.9\n`,
      },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("9.9.9");
    expect(errors[0]).toContain("the two drifted");
  });

  test("rejects a pin no workflow reads at all", () => {
    // A pin that is authoritative for nobody is the failure ADR-0003's
    // amendment caught with .node-version.
    const errors = findClaudeCliVersionDrift(PIN, [
      { file: "ci.yml", text: "jobs:\n  build:\n" },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no workflow installs it");
  });

  test("reports every drifting site independently", () => {
    const errors = findClaudeCliVersionDrift(PIN, [
      {
        file: "skill-evals.yml",
        text: `        run: npm install -g ${CLI_PACKAGE}\n`,
      },
      {
        file: "maintain-scan.yml",
        text: `        run: npm install -g ${CLI_PACKAGE}@9.9.9\n`,
      },
    ]);

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("skill-evals.yml");
    expect(errors[1]).toContain("maintain-scan.yml");
  });
});

describe("the committed repo state", () => {
  // The live-artifact guard: every real workflow install site agrees with the
  // real .claude-code-version. A fixture cannot catch a new workflow adding
  // an unpinned install — this can (and did, for maintain-scan.yml).
  test("every workflow install site matches .claude-code-version", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");

    const root = fileURLToPath(new URL("../../", import.meta.url));
    const pin = parseClaudeCodeVersionFile(
      readFileSync(`${root}${VERSION_FILE}`, "utf8"),
    );
    // Narrowed with a throw rather than a non-null assertion: if the
    // committed file ever stops naming an exact version, this test must fail
    // loudly here instead of silently comparing against undefined.
    if (pin === null) {
      throw new Error(`${VERSION_FILE} does not name an exact version`);
    }

    const dir = `${root}.github/workflows`;
    const files = readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => ({
        file: `.github/workflows/${name}`,
        text: readFileSync(`${dir}/${name}`, "utf8"),
      }));

    expect(findClaudeCliVersionDrift(pin.version, files)).toEqual([]);
  });
});
