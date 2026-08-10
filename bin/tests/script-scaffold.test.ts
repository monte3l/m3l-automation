/**
 * Tests for the consumer-script scaffold manifest (bin/lib/script-scaffold.mjs)
 * — the single source of truth shared by bin/scaffold-script.mjs (generator)
 * and bin/check-script-scaffold.mjs (conformance checker), so the two cannot
 * drift apart (ADR-0022 fleet conventions).
 *
 * bin/check-script-scaffold.mjs and bin/scaffold-script.mjs are NOT imported
 * directly here: unlike bin/check-cadence-doc.mjs (which guards its CLI body
 * behind `if (process.argv[1] === fileURLToPath(import.meta.url))` so the
 * module is import-safe), both scripts run their full CLI body — including
 * `process.exit()` — unconditionally at module load with no separately
 * exported functions. Importing either would execute the real CLI against
 * this repo's actual `scripts/`/`tsconfig.json` state and can terminate the
 * test worker; no existing bin/tests file spawns a child process or imports
 * an unguarded CLI script either, so this file follows the established
 * convention of exercising only the exported, side-effect-free manifest
 * functions (plus `scriptPackageDirs`, whose only fs reads are mocked).
 */
import { describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors packages/m3l-common's
// exporters.test.ts / script.test.ts pattern.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  BANNED_EXACT_NAMES,
  BANNED_LEADING_SEGMENTS,
  DOC_PAGE_TEMPLATE,
  PACKAGE_TEMPLATE_FILES,
  PURPOSE_MAX_LENGTH,
  REQUIRED_EXACT_FILES,
  REQUIRED_GLOBS,
  SCRIPT_NAME_RE,
  TEMPLATE_DIR,
  docPagePath,
  packageManifestErrors,
  pascalCase,
  purposeErrors,
  readmeExamplesErrors,
  rootTsconfigRef,
  scriptPackageDirs,
  scriptTokens,
  serviceNameErrors,
  substituteTokens,
  tsconfigShapeErrors,
} from "../lib/script-scaffold.mjs";

/**
 * Repo root, resolved from this test file's own location
 * (bin/tests/script-scaffold.test.ts is two directories below the repo
 * root — one more level of nesting than a bin/*.mjs script, which is why
 * this needs three `dirname` calls where `bin/lib/report.mjs`'s own
 * `repoRoot` helper only needs two).
 */
const repoRootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** A minimal fake fs.Dirent — just enough for scriptPackageDirs' own `entry.isDirectory()`/`entry.name` usage. */
function fakeDirent(name: string, isDirectory: boolean): fs.Dirent {
  return { name, isDirectory: () => isDirectory } as fs.Dirent;
}

/** A fully ADR-0022-conformant package.json for a given script name. */
function conformantManifest(name: string) {
  return {
    name: `@m3l-automation/${name}`,
    private: true,
    type: "module",
    engines: { node: ">=24" },
    dependencies: { "@m3l-automation/m3l-common": "workspace:*" },
    scripts: {
      build: "tsc -b tsconfig.build.json",
      typecheck: "tsc -p tsconfig.json",
      start: "node --env-file-if-exists=.env dist/main.js",
    },
  };
}

describe("SCRIPT_NAME_RE", () => {
  test.each([
    ["data-sync", true],
    ["probe", true],
    ["a1-b2", true],
    ["Data-Sync", false],
    ["-x", false],
    ["x-", false],
    ["x_y", false],
    ["", false],
  ])("SCRIPT_NAME_RE.test(%j) === %s", (name, expected) => {
    expect(SCRIPT_NAME_RE.test(name)).toBe(expected);
  });
});

describe("pascalCase", () => {
  test.each([
    ["data-sync", "DataSync"],
    ["probe", "Probe"],
    ["a1-b2", "A1B2"],
    ["report-builder", "ReportBuilder"],
  ])("pascalCase(%j) === %j", (input, expected) => {
    expect(pascalCase(input)).toBe(expected);
  });
});

describe("scriptTokens", () => {
  test("builds the substitution map from the script name and purpose", () => {
    expect(scriptTokens("data-sync", "Sync things")).toEqual({
      __SCRIPT_NAME__: "data-sync",
      __SCRIPT_NAME_PASCAL__: "DataSync",
      __PURPOSE__: "Sync things",
    });
  });
});

describe("substituteTokens", () => {
  test("replaces every occurrence of every token in the text", () => {
    const tokens = scriptTokens("data-sync", "Sync things");
    const text = [
      "export function run__SCRIPT_NAME_PASCAL__() {}",
      "// __PURPOSE__",
      "// again: __PURPOSE__",
      'const dir = "scripts/__SCRIPT_NAME__/src";',
    ].join("\n");

    expect(substituteTokens(text, tokens)).toBe(
      [
        "export function runDataSync() {}",
        "// Sync things",
        "// again: Sync things",
        'const dir = "scripts/data-sync/src";',
      ].join("\n"),
    );
  });

  test("leaves text with no matching tokens unchanged", () => {
    expect(substituteTokens("no tokens here", scriptTokens("x", "y"))).toBe(
      "no tokens here",
    );
  });

  test("returns the substituted text unchanged when every token in the map is replaced (happy path)", () => {
    expect(substituteTokens("Hello __NAME__", { __NAME__: "World" })).toBe(
      "Hello World",
    );
  });

  // Pins the real, exhaustive 3-token set: if a 4th token is ever added to a
  // template without a matching entry in scriptTokens(), this test (and the
  // real-template read-through tests below) is exactly what needs updating —
  // and what would catch the omission if it weren't.
  test("substitutes cleanly against the real scriptTokens() map with all three tokens present", () => {
    const tokens = scriptTokens("data-sync", "Sync things");
    const text = "__SCRIPT_NAME__ __SCRIPT_NAME_PASCAL__ __PURPOSE__";
    expect(substituteTokens(text, tokens)).toBe(
      "data-sync DataSync Sync things",
    );
  });

  test("throws when a token-shaped span survives substitution because it is absent from the tokens map", () => {
    expect(() => {
      substituteTokens("Hello __UNKNOWN__", { __NAME__: "World" });
    }).toThrow(
      'substituteTokens: unreplaced token "__UNKNOWN__" survived substitution — add it to scriptTokens() in bin/lib/script-scaffold.mjs.',
    );
  });

  test("returns an empty tokens map's input unchanged (nothing token-shaped to trip the guard)", () => {
    expect(substituteTokens("plain text, no tokens here", {})).toBe(
      "plain text, no tokens here",
    );
  });

  test("does not throw when a mapped token is simply unused — the guard only fires on a surviving token-shaped span in the text, not an unused map entry", () => {
    expect(substituteTokens("plain text", { __UNUSED__: "x" })).toBe(
      "plain text",
    );
  });

  test.each([
    ["a_b__c", "double underscore not preceded by two leading underscores"],
    ["__lowercase__", "lowercase character right after the leading __"],
  ])(
    "does not throw on the near-miss %j (%s), since it does not match the __[A-Z][A-Z0-9_]*__ shape",
    (text) => {
      expect(substituteTokens(text, {})).toBe(text);
    },
  );
});

describe("substituteTokens against the real templates/script/*.tmpl files", () => {
  const templateRelativePaths = [
    ...PACKAGE_TEMPLATE_FILES.map(
      (entry: { template: string }) => entry.template,
    ),
    DOC_PAGE_TEMPLATE,
  ];

  test.each(templateRelativePaths)(
    "substitutes %s's content cleanly with a realistic scriptTokens() map (no unreplaced token)",
    (templateRelativePath: string) => {
      const templatePath = join(
        repoRootDir,
        TEMPLATE_DIR,
        templateRelativePath,
      );
      const templateText = fs.readFileSync(templatePath, "utf8");
      const tokens = scriptTokens("test-script-name", "A test purpose.");
      expect(() => {
        substituteTokens(templateText, tokens);
      }).not.toThrow();
    },
  );
});

describe("docPagePath", () => {
  test("builds the repo-relative contract page path", () => {
    expect(docPagePath("data-sync")).toBe(
      "docs/reference/scripts/data-sync.md",
    );
  });
});

describe("rootTsconfigRef", () => {
  test("builds the root tsconfig project reference path", () => {
    expect(rootTsconfigRef("data-sync")).toBe(
      "./scripts/data-sync/tsconfig.build.json",
    );
  });
});

describe("PACKAGE_TEMPLATE_FILES", () => {
  test("maps every known template to its target inside the package dir", () => {
    expect(PACKAGE_TEMPLATE_FILES).toContainEqual({
      template: "package.json.tmpl",
      target: "package.json",
    });
    const stepsEntry = PACKAGE_TEMPLATE_FILES.find(
      (entry: { template: string }) =>
        entry.template === "src/steps/run-__SCRIPT_NAME__.ts.tmpl",
    );
    expect(stepsEntry?.target).toBe("src/steps/run-__SCRIPT_NAME__.ts");
  });

  test("substituting tokens into every target resolves the __SCRIPT_NAME__ placeholder", () => {
    const tokens = scriptTokens("data-sync", "purpose");
    const resolvedTargets: string[] = PACKAGE_TEMPLATE_FILES.map(
      (entry: { target: string }) =>
        String(substituteTokens(entry.target, tokens)),
    );
    expect(resolvedTargets).toContain("src/steps/run-data-sync.ts");
    expect(
      resolvedTargets.every((target: string) => !target.includes("__")),
    ).toBe(true);
  });
});

describe("REQUIRED_EXACT_FILES", () => {
  test("lists the fixed files every script package must have", () => {
    expect(REQUIRED_EXACT_FILES).toEqual([
      "package.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "src/main.ts",
      "src/config.ts",
      "src/hooks.ts",
      "README.md",
    ]);
  });
});

describe("REQUIRED_GLOBS", () => {
  test("requires at least one steps/ module and one test file", () => {
    expect(REQUIRED_GLOBS).toEqual([
      { dir: "src/steps", suffix: ".ts", what: "a steps/ module" },
      { dir: "tests", suffix: ".test.ts", what: "the config smoke test" },
    ]);
  });
});

describe("packageManifestErrors", () => {
  test("returns no errors for a fully conformant manifest", () => {
    expect(
      packageManifestErrors(conformantManifest("data-sync"), "data-sync"),
    ).toEqual([]);
  });

  test("flags a package name that does not match @m3l-automation/<name>", () => {
    const pkg = { ...conformantManifest("data-sync"), name: "wrong-name" };
    expect(packageManifestErrors(pkg, "data-sync")).toEqual([
      '"name" must be "@m3l-automation/data-sync" (got "wrong-name")',
    ]);
  });

  test("flags private !== true", () => {
    const pkg = { ...conformantManifest("data-sync"), private: false };
    expect(packageManifestErrors(pkg, "data-sync")).toEqual([
      '"private" must be true (scripts are never published)',
    ]);
  });

  test("flags a missing type field", () => {
    const { type: _type, ...rest } = conformantManifest("data-sync");
    expect(packageManifestErrors(rest, "data-sync")).toEqual([
      '"type" must be "module" (ESM only)',
    ]);
  });

  test("flags engines.node that does not declare >=24", () => {
    const pkg = {
      ...conformantManifest("data-sync"),
      engines: { node: "^18" },
    };
    expect(packageManifestErrors(pkg, "data-sync")).toEqual([
      '"engines.node" must declare ">=24"',
    ]);
  });

  test("flags a missing workspace dependency on m3l-common", () => {
    const pkg = { ...conformantManifest("data-sync"), dependencies: {} };
    expect(packageManifestErrors(pkg, "data-sync")).toEqual([
      'dependencies must include "@m3l-automation/m3l-common": "workspace:*"',
    ]);
  });

  test.each(["build", "typecheck", "start"])(
    "flags a missing scripts.%s entry",
    (scriptName) => {
      const pkg = conformantManifest("data-sync");
      const scripts: Record<string, string> = { ...pkg.scripts };
      delete scripts[scriptName];
      const errors = packageManifestErrors({ ...pkg, scripts }, "data-sync");
      expect(errors).toEqual([`"scripts.${scriptName}" must be declared`]);
    },
  );

  test("collects one error per violated field when several are wrong at once", () => {
    const pkg = { name: "wrong-name", private: false, scripts: {} };
    const errors = packageManifestErrors(pkg, "data-sync");
    expect(errors).toEqual([
      '"name" must be "@m3l-automation/data-sync" (got "wrong-name")',
      '"private" must be true (scripts are never published)',
      '"type" must be "module" (ESM only)',
      '"engines.node" must declare ">=24"',
      'dependencies must include "@m3l-automation/m3l-common": "workspace:*"',
      '"scripts.build" must be declared',
      '"scripts.typecheck" must be declared',
      '"scripts.start" must be declared',
    ]);
  });
});

describe("tsconfigShapeErrors", () => {
  // Matches templates/script/tsconfig.json.tmpl and
  // tsconfig.build.json.tmpl verbatim: both templates share the same
  // `extends` and `references` shape.
  const EXPECTED_EXTENDS = "../../tsconfig.base.json";
  const EXPECTED_REFERENCE_PATH =
    "../../packages/m3l-common/tsconfig.build.json";

  function conformantTsconfig(): {
    extends: string;
    references: { path: string }[];
  } {
    return {
      extends: EXPECTED_EXTENDS,
      references: [{ path: EXPECTED_REFERENCE_PATH }],
    };
  }

  test.each(["tsconfig.json.tmpl", "tsconfig.build.json.tmpl"] as const)(
    "returns no errors for a conformant tsconfig checked against %s",
    (templateName) => {
      expect(tsconfigShapeErrors(conformantTsconfig(), templateName)).toEqual(
        [],
      );
    },
  );

  test("flags a wrong extends value, naming the expected value", () => {
    const tsconfig = { ...conformantTsconfig(), extends: "../wrong/base.json" };
    expect(tsconfigShapeErrors(tsconfig, "tsconfig.json.tmpl")).toEqual([
      `"extends" must be ${JSON.stringify(EXPECTED_EXTENDS)} (got ${JSON.stringify("../wrong/base.json")})`,
    ]);
  });

  test("flags an empty references array, naming the expected reference path", () => {
    const tsconfig = { ...conformantTsconfig(), references: [] };
    expect(tsconfigShapeErrors(tsconfig, "tsconfig.json.tmpl")).toEqual([
      `"references" must include { "path": ${JSON.stringify(EXPECTED_REFERENCE_PATH)} } (from tsconfig.json.tmpl) so tsc -b resolves the library`,
    ]);
  });

  test("flags a references array whose only entry points at a different path", () => {
    const tsconfig = {
      ...conformantTsconfig(),
      references: [{ path: "../wrong/tsconfig.build.json" }],
    };
    expect(tsconfigShapeErrors(tsconfig, "tsconfig.build.json.tmpl")).toEqual([
      `"references" must include { "path": ${JSON.stringify(EXPECTED_REFERENCE_PATH)} } (from tsconfig.build.json.tmpl) so tsc -b resolves the library`,
    ]);
  });

  test("does not throw when references is entirely absent, treating it as empty and reporting the missing-reference error", () => {
    const { references: _references, ...rest } = conformantTsconfig();
    expect(() => tsconfigShapeErrors(rest, "tsconfig.json.tmpl")).not.toThrow();
    expect(tsconfigShapeErrors(rest, "tsconfig.json.tmpl")).toEqual([
      `"references" must include { "path": ${JSON.stringify(EXPECTED_REFERENCE_PATH)} } (from tsconfig.json.tmpl) so tsc -b resolves the library`,
    ]);
  });

  test("collects both the extends and references errors when both are wrong at once", () => {
    const tsconfig = { extends: "wrong", references: [] };
    expect(tsconfigShapeErrors(tsconfig, "tsconfig.build.json.tmpl")).toEqual([
      `"extends" must be ${JSON.stringify(EXPECTED_EXTENDS)} (got ${JSON.stringify("wrong")})`,
      `"references" must include { "path": ${JSON.stringify(EXPECTED_REFERENCE_PATH)} } (from tsconfig.build.json.tmpl) so tsc -b resolves the library`,
    ]);
  });
});

describe("purposeErrors", () => {
  test("returns no errors for a valid one-line purpose", () => {
    expect(purposeErrors("Sync S3 exports to Dynamo")).toEqual([]);
  });

  test.each([
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
  ])("flags %s as not a non-empty string", (_label, value) => {
    expect(purposeErrors(value)).toEqual([
      "purpose must be a non-empty string",
    ]);
  });

  test("flags a purpose longer than PURPOSE_MAX_LENGTH characters", () => {
    const purpose = "a".repeat(PURPOSE_MAX_LENGTH + 1);
    expect(purposeErrors(purpose)).toEqual([
      `purpose must be at most ${PURPOSE_MAX_LENGTH} characters (got ${purpose.length})`,
    ]);
  });

  test("accepts a purpose exactly at PURPOSE_MAX_LENGTH characters", () => {
    const purpose = "a".repeat(PURPOSE_MAX_LENGTH);
    expect(purposeErrors(purpose)).toEqual([]);
  });

  test.each([
    ["a newline", "line one\nline two"],
    ["a tab", "purpose\twith a tab"],
    ["a null byte", "purpose here"],
    ["a DEL control character", "purposehere"],
  ])("rejects a purpose containing %s", (_label, purpose) => {
    expect(purposeErrors(purpose)).toEqual([
      "purpose must not contain newlines or control characters",
    ]);
  });

  test.each([
    ['"', "it terminates the package.json description string"],
    ["\\", "it escapes inside the package.json description string"],
    ["*", "it can terminate the doc comment the purpose is emitted into"],
    ["/", "it can terminate the doc comment the purpose is emitted into"],
  ])(
    "rejects a purpose containing the banned character %j, naming it in the error",
    (char, why) => {
      const purpose = `Sync things ${char} more things`;
      expect(purposeErrors(purpose)).toEqual([
        `purpose must not contain ${JSON.stringify(char)} — ${why}`,
      ]);
    },
  );

  test("collects one error per violated rule when several are wrong at once", () => {
    const purpose = `${"a".repeat(PURPOSE_MAX_LENGTH + 1)}"/`;
    expect(purposeErrors(purpose)).toEqual([
      `purpose must be at most ${PURPOSE_MAX_LENGTH} characters (got ${purpose.length})`,
      `purpose must not contain ${JSON.stringify('"')} — it terminates the package.json description string`,
      `purpose must not contain ${JSON.stringify("/")} — it can terminate the doc comment the purpose is emitted into`,
    ]);
  });
});

describe("scriptPackageDirs", () => {
  test("passes vacuously (empty array) when scripts/ does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(scriptPackageDirs("/fake/root")).toEqual([]);
  });

  test("returns only directories that contain a package.json, skipping files and manifest-less directories", () => {
    const root = "/fake/root";
    const scriptsDir = join(root, "scripts");

    vi.spyOn(fs, "existsSync").mockImplementation((path: fs.PathLike) => {
      const target = String(path);
      if (target === scriptsDir) return true;
      if (target === join(scriptsDir, "data-sync", "package.json")) {
        return true;
      }
      return false;
    });
    // `readdirSync` is overloaded on its `options` shape; scriptPackageDirs
    // always calls it with `{ withFileTypes: true }`, which resolves to the
    // string-Dirent overload. The implementation is narrowed through
    // `unknown` first, the standard escape hatch for an intentionally
    // narrower mock against an overloaded Node API.
    vi.spyOn(fs, "readdirSync").mockImplementation(((
      dir: fs.PathLike,
    ): fs.Dirent[] => {
      if (String(dir) === scriptsDir) {
        return [
          fakeDirent("data-sync", true),
          fakeDirent("no-manifest", true),
          fakeDirent("README.md", false),
        ];
      }
      return [];
    }) as unknown as typeof fs.readdirSync);

    expect(scriptPackageDirs(root)).toEqual(["data-sync"]);
  });
});

describe("BANNED_LEADING_SEGMENTS", () => {
  test("maps each known abbreviated AWS service token to its full name", () => {
    expect(BANNED_LEADING_SEGMENTS.get("dynamo")).toBe("dynamodb");
    expect(BANNED_LEADING_SEGMENTS.get("cfn")).toBe("cloudformation");
    expect(BANNED_LEADING_SEGMENTS.get("apigw")).toBe("api-gateway");
  });
});

describe("BANNED_EXACT_NAMES", () => {
  test("maps each known bare capability name to its full service-qualified name", () => {
    expect(BANNED_EXACT_NAMES.get("logs-insights")).toBe(
      "cloudwatch-logs-insights",
    );
  });
});

describe("serviceNameErrors", () => {
  test.each([
    ["dynamo-crud", "dynamo", "dynamodb"],
    ["cfn-stacks", "cfn", "cloudformation"],
    ["apigw-client", "apigw", "api-gateway"],
  ])(
    "flags %j for abbreviating the AWS service name, suggesting the full name",
    (name, abbrev, fullName) => {
      const errors = serviceNameErrors(name);
      expect(errors).toEqual([
        `"${name}" abbreviates the AWS service name (uses "${abbrev}") — ADR-0028 requires the full official service name ("${fullName}") as the leading segment.`,
      ]);
    },
  );

  test("flags the exact bare-capability name, suggesting the service-qualified name", () => {
    expect(serviceNameErrors("logs-insights")).toEqual([
      '"logs-insights" names an AWS capability without its owning service — ADR-0028 requires "cloudwatch-logs-insights".',
    ]);
  });

  test.each(["dynamodb-crud", "cloudwatch-logs-insights", "sqs-etl"])(
    "passes a compliant full AWS service name %j (empty array)",
    (name) => {
      expect(serviceNameErrors(name)).toEqual([]);
    },
  );

  test("passes a non-AWS name that never comes close to a banned token", () => {
    expect(serviceNameErrors("json-etl")).toEqual([]);
  });

  test("does not flag a banned token that appears in a non-leading segment", () => {
    // "dynamo" is only banned as the FIRST hyphen segment; here it's second.
    expect(serviceNameErrors("crud-dynamo")).toEqual([]);
  });

  test("does not flag a name that merely contains the banned exact name as a substring", () => {
    // BANNED_EXACT_NAMES is an exact whole-name Map lookup, not substring search.
    expect(serviceNameErrors("foo-logs-insights")).toEqual([]);
    expect(serviceNameErrors("logs-insights-extra")).toEqual([]);
  });
});

describe("readmeExamplesErrors", () => {
  test("returns no errors for a heading immediately followed by a runnable bash fence", () => {
    const readme = [
      "### Examples",
      "",
      "```bash",
      "node dist/main.js --foo",
      "```",
      "",
    ].join("\n");
    expect(readmeExamplesErrors(readme)).toEqual([]);
  });

  test("returns no errors when the runnable fence appears later, under a different heading (sibling-headings shape)", () => {
    const readme = [
      "### Examples",
      "",
      "Some introductory prose about the examples below.",
      "",
      "### 1. Something",
      "",
      "```bash",
      "node dist/main.js --foo",
      "```",
      "",
    ].join("\n");
    expect(readmeExamplesErrors(readme)).toEqual([]);
  });

  test("returns exactly the missing-heading message and returns early when there is no Examples heading at all", () => {
    const readme = ["## Something Else", "", "No examples here.", ""].join(
      "\n",
    );
    expect(readmeExamplesErrors(readme)).toEqual([
      'must have an "### Examples" heading with 2-4 runnable examples (ADR-0022 fleet convention).',
    ]);
  });

  test("returns exactly the no-runnable-fence message when the heading exists but only prose follows it", () => {
    const readme = [
      "### Examples",
      "",
      "Just prose here, no code fence at all.",
      "",
    ].join("\n");
    expect(readmeExamplesErrors(readme)).toEqual([
      '"### Examples" section has no runnable ```bash fence invoking `node dist/main.js`.',
    ]);
  });

  test("returns exactly the no-runnable-fence message when a bash fence exists but never invokes node dist/main.js", () => {
    const readme = [
      "### Examples",
      "",
      "```bash",
      "pnpm build",
      "```",
      "",
    ].join("\n");
    expect(readmeExamplesErrors(readme)).toEqual([
      '"### Examples" section has no runnable ```bash fence invoking `node dist/main.js`.',
    ]);
  });

  test("returns both the placeholder and no-runnable-fence messages, in that order, for the literal scaffold placeholder", () => {
    const readme = [
      "### Examples",
      "",
      "<!-- Add 2-4 examples here: Minimal / Common / Production / Edge case -->",
      "",
      "## Environment",
    ].join("\n");
    expect(readmeExamplesErrors(readme)).toEqual([
      'still carries the scaffold placeholder comment under "### Examples" — fill in 2-4 real examples.',
      '"### Examples" section has no runnable ```bash fence invoking `node dist/main.js`.',
    ]);
  });

  test("flags a placeholder-shaped comment anywhere in the file, even outside the Examples section, because the placeholder scan is not heading-scoped", () => {
    // EXAMPLES_PLACEHOLDER_RE.test(readmeText) runs against the FULL text,
    // not just the slice after the heading — so a stray placeholder-shaped
    // comment in unrelated front-matter still trips the placeholder check
    // even though the Examples section itself is fully and correctly filled in.
    const readme = [
      "<!-- Add later: revisit this front-matter note -->",
      "",
      "### Examples",
      "",
      "```bash",
      "node dist/main.js --foo",
      "```",
      "",
    ].join("\n");
    expect(readmeExamplesErrors(readme)).toEqual([
      'still carries the scaffold placeholder comment under "### Examples" — fill in 2-4 real examples.',
    ]);
  });
});
