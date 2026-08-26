/**
 * Tests for src/scaffold/manifest.ts — pure validation rules, token
 * substitution, and the template-file manifest for `m3l new` (U9 contract).
 *
 * This module does no fs access, so no `node:fs` mocking is needed here.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  BANNED_EXACT_NAMES,
  BANNED_LEADING_SEGMENTS,
  DOC_PAGE_TEMPLATE,
  PACKAGE_TEMPLATE_FILES,
  PURPOSE_MAX_LENGTH,
  REQUIRED_EXACT_FILES,
  REQUIRED_GLOBS,
  RESERVED_CLI_NAMES,
  SCRIPT_DOCS_DIR,
  SCRIPT_NAME_RE,
  TEMPLATE_DIR,
  docPagePath,
  packageTemplateFiles,
  pascalCase,
  purposeErrors,
  rootTsconfigRef,
  scriptTokens,
  serviceNameErrors,
  substituteTokens,
} from "../src/scaffold/manifest.js";
import type {
  ScaffoldRequiredGlob,
  ScaffoldTemplateFile,
  ScaffoldTokens,
  ScaffoldVariant,
} from "../src/scaffold/manifest.js";

describe("SCRIPT_NAME_RE", () => {
  test.each([
    ["data-sync", true],
    ["x", true],
    ["cloudwatch-logs-analysis", true],
    ["a1-b2", true],
    ["Data-Sync", false],
    ["data_sync", false],
    ["-data-sync", false],
    ["data-sync-", false],
    ["data--sync", false],
    ["", false],
    ["1data", false],
  ])("SCRIPT_NAME_RE.test(%s) -> %s", (candidate, expected) => {
    // Reset lastIndex defensively in case the exported regex carries the
    // global flag; a shared RegExp with `g` would otherwise be stateful
    // across test.each iterations.
    SCRIPT_NAME_RE.lastIndex = 0;
    expect(SCRIPT_NAME_RE.test(candidate)).toBe(expected);
  });
});

describe("BANNED_LEADING_SEGMENTS", () => {
  test("maps each banned leading segment to its full-service replacement", () => {
    expect(Array.from(BANNED_LEADING_SEGMENTS.entries())).toEqual([
      ["dynamo", "dynamodb"],
      ["cfn", "cloudformation"],
      ["apigw", "api-gateway"],
    ]);
  });
});

describe("BANNED_EXACT_NAMES", () => {
  test("maps each banned exact name to its full-service replacement", () => {
    expect(Array.from(BANNED_EXACT_NAMES.entries())).toEqual([
      ["logs-insights", "cloudwatch-logs-insights"],
    ]);
  });
});

describe("RESERVED_CLI_NAMES", () => {
  test("contains exactly the reserved top-level command names", () => {
    expect(Array.from(RESERVED_CLI_NAMES)).toEqual([
      "list",
      "inspect",
      "run",
      "doctor",
      "presets",
      "history",
      "wizard",
      "new",
      "help",
    ]);
  });
});

describe("serviceNameErrors", () => {
  test("flags a banned leading segment, naming both the segment and its replacement", () => {
    const problems = serviceNameErrors("dynamo-backup");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("dynamo");
    expect(problems[0]).toContain("dynamodb");
  });

  test("flags a banned exact name, naming its replacement", () => {
    const problems = serviceNameErrors("logs-insights");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("cloudwatch-logs-insights");
  });

  test("flags a reserved CLI name, mentioning 'reserved' and the name", () => {
    const problems = serviceNameErrors("new");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reserved");
    expect(problems[0]).toContain("new");
  });

  test("returns [] for a compliant name", () => {
    expect(serviceNameErrors("data-sync")).toEqual([]);
  });

  // The three checks are independent and their results are concatenated, but
  // given the current finite BANNED_LEADING_SEGMENTS / BANNED_EXACT_NAMES /
  // RESERVED_CLI_NAMES data, no single name can trigger more than one check
  // simultaneously (e.g. no banned leading segment is itself a reserved name,
  // and no BANNED_EXACT_NAMES key shares a leading segment with
  // BANNED_LEADING_SEGMENTS). Each check is therefore exercised independently
  // above rather than forcing an unreachable multi-fire case.
  test.each([
    ["cfn-deploy", "cloudformation"],
    ["apigw-sync", "api-gateway"],
  ])(
    "flags every banned leading segment, not only 'dynamo' (%s)",
    (name, target) => {
      const problems = serviceNameErrors(name);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(target);
    },
  );

  test.each([
    "list",
    "inspect",
    "run",
    "doctor",
    "presets",
    "history",
    "wizard",
    "help",
  ])("flags every reserved CLI name, not only 'new' (%s)", (name) => {
    const problems = serviceNameErrors(name);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reserved");
  });
});

describe("PURPOSE_MAX_LENGTH", () => {
  test("is 200", () => {
    expect(PURPOSE_MAX_LENGTH).toBe(200);
  });
});

describe("purposeErrors", () => {
  test("empty string produces exactly one problem with the documented message", () => {
    expect(purposeErrors("")).toEqual(["purpose must be a non-empty string"]);
  });

  test("whitespace-only string produces exactly one problem with the documented message", () => {
    expect(purposeErrors("   ")).toEqual([
      "purpose must be a non-empty string",
    ]);
  });

  test("a purpose longer than PURPOSE_MAX_LENGTH produces a problem mentioning the limit", () => {
    const tooLong = "a".repeat(PURPOSE_MAX_LENGTH + 1);

    const problems = purposeErrors(tooLong);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem: string) => problem.includes("200"))).toBe(
      true,
    );
  });

  test("a control character in the purpose produces a problem", () => {
    const problems = purposeErrors("bad\npurpose");

    expect(problems.length).toBeGreaterThan(0);
  });

  test.each([
    ['Sync "data" for reporting', 1],
    ["Sync data\\legacy exports", 1],
    ["Sync * everything", 1],
    ["Sync data / exports", 1],
  ])(
    "a single offending character type ('%s') produces exactly %i problem(s)",
    (purpose, expectedCount) => {
      expect(purposeErrors(purpose)).toHaveLength(expectedCount);
    },
  );

  test("'\"' and '/' both present produce exactly 2 problems (checked independently)", () => {
    const problems = purposeErrors('Sync "data" / exports');

    expect(problems).toHaveLength(2);
  });

  test("a valid purpose produces []", () => {
    expect(purposeErrors("Sync S3 exports to Dynamo")).toEqual([]);
  });
});

describe("TEMPLATE_DIR and SCRIPT_DOCS_DIR", () => {
  test("TEMPLATE_DIR is templates/script", () => {
    expect(TEMPLATE_DIR).toBe("templates/script");
  });

  test("SCRIPT_DOCS_DIR is docs/reference/scripts", () => {
    expect(SCRIPT_DOCS_DIR).toBe("docs/reference/scripts");
  });
});

describe("pascalCase", () => {
  test.each([
    ["data-sync", "DataSync"],
    ["x", "X"],
    ["cloudwatch-logs-analysis", "CloudwatchLogsAnalysis"],
  ])("pascalCase(%s) -> %s", (input, expected) => {
    expect(pascalCase(input)).toBe(expected);
  });
});

describe("scriptTokens", () => {
  test("builds the three documented tokens from name and purpose", () => {
    expect(scriptTokens("data-sync", "Sync it")).toEqual({
      __SCRIPT_NAME__: "data-sync",
      __SCRIPT_NAME_PASCAL__: "DataSync",
      __PURPOSE__: "Sync it",
    });
  });

  test("fails for the right reason when name is empty (documents the seam, not a runtime guard)", () => {
    // scriptTokens is a pure formatter, not a validator — validation is
    // serviceNameErrors' job. This asserts scriptTokens still produces a
    // deterministic (if semantically empty) result rather than throwing.
    expect(scriptTokens("", "Sync it").__SCRIPT_NAME_PASCAL__).toBe("");
  });
});

describe("substituteTokens", () => {
  const tokens: ScaffoldTokens = scriptTokens("data-sync", "Sync it");

  test("replaces every occurrence of every token key", () => {
    expect(substituteTokens("__SCRIPT_NAME__ says __PURPOSE__", tokens)).toBe(
      "data-sync says Sync it",
    );
  });

  test("replaces repeated occurrences of the same token (replaceAll semantics)", () => {
    expect(
      substituteTokens("__SCRIPT_NAME__ and __SCRIPT_NAME__ again", tokens),
    ).toBe("data-sync and data-sync again");
  });

  test("throws when a __TOKEN__-shaped span survives substitution", () => {
    expect(() => substituteTokens("hello __UNKNOWN__", tokens)).toThrowError(
      /__UNKNOWN__/,
    );
  });
});

describe("packageTemplateFiles", () => {
  // ADR-0054's commandModule seam (U6) is CLI-only: a Lambda-variant script
  // has no dist/main.js CLI process for an in-process host to be an
  // alternative to, so src/command.ts / tests/command.test.ts are emitted
  // for variant "cli" only, inserted after hooks.ts and after
  // config.test.ts respectively (matching the pre-U9 ordering on
  // origin/main's bin/lib/script-scaffold.mjs).
  const CLI_EXPECTED: readonly ScaffoldTemplateFile[] = [
    { template: "package.json.tmpl", target: "package.json" },
    { template: "tsconfig.json.tmpl", target: "tsconfig.json" },
    { template: "tsconfig.build.json.tmpl", target: "tsconfig.build.json" },
    { template: "src/main.ts.tmpl", target: "src/main.ts" },
    { template: "src/config.ts.tmpl", target: "src/config.ts" },
    { template: "src/hooks.ts.tmpl", target: "src/hooks.ts" },
    { template: "src/command.ts.tmpl", target: "src/command.ts" },
    {
      template: "src/steps/run-__SCRIPT_NAME__.ts.tmpl",
      target: "src/steps/run-__SCRIPT_NAME__.ts",
    },
    { template: "tests/config.test.ts.tmpl", target: "tests/config.test.ts" },
    {
      template: "tests/command.test.ts.tmpl",
      target: "tests/command.test.ts",
    },
    { template: "README.md.tmpl", target: "README.md" },
  ];

  const LAMBDA_EXPECTED: readonly ScaffoldTemplateFile[] = [
    { template: "package.json.tmpl", target: "package.json" },
    { template: "tsconfig.json.tmpl", target: "tsconfig.json" },
    { template: "tsconfig.build.json.tmpl", target: "tsconfig.build.json" },
    { template: "src/main.lambda.ts.tmpl", target: "src/main.ts" },
    { template: "src/config.ts.tmpl", target: "src/config.ts" },
    { template: "src/hooks.ts.tmpl", target: "src/hooks.ts" },
    {
      template: "src/steps/run-__SCRIPT_NAME__.ts.tmpl",
      target: "src/steps/run-__SCRIPT_NAME__.ts",
    },
    { template: "tests/config.test.ts.tmpl", target: "tests/config.test.ts" },
    { template: "README.lambda.md.tmpl", target: "README.md" },
  ];

  test("cli variant returns the exact 11-entry manifest", () => {
    expect(packageTemplateFiles("cli")).toEqual(CLI_EXPECTED);
  });

  test("lambda variant returns the exact 9-entry manifest (unchanged; no command.ts/command.test.ts)", () => {
    expect(packageTemplateFiles("lambda")).toEqual(LAMBDA_EXPECTED);
  });

  test("lambda variant is cli's manifest with command.ts/command.test.ts removed and the main-entry/README templates swapped", () => {
    const cli = packageTemplateFiles("cli");
    const lambda = packageTemplateFiles("lambda");

    // Isolate the entries every variant shares (i.e. drop the two entries
    // ONLY the cli variant carries) so the remaining, shared-length arrays
    // can be compared position-by-position — this is what makes both arms
    // of the "swap" (main.ts, README.md) AND the "removed" (command.ts,
    // command.test.ts) claims reachable in one test.
    const cliShared = cli.filter(
      (entry) =>
        entry.target !== "src/command.ts" &&
        entry.target !== "tests/command.test.ts",
    );
    expect(cliShared).toHaveLength(lambda.length);

    for (const [index, cliEntry] of cliShared.entries()) {
      const lambdaEntry = lambda[index];
      if (lambdaEntry === undefined) {
        throw new Error(`expected lambda manifest entry at index ${index}`);
      }

      if (cliEntry.target === "src/main.ts") {
        expect(lambdaEntry.template).toBe("src/main.lambda.ts.tmpl");
        expect(lambdaEntry.target).toBe("src/main.ts");
      } else if (cliEntry.target === "README.md") {
        expect(lambdaEntry.template).toBe("README.lambda.md.tmpl");
        expect(lambdaEntry.target).toBe("README.md");
      } else {
        expect(lambdaEntry).toEqual(cliEntry);
      }
    }
  });

  test("cli has exactly two entries lambda entirely lacks: src/command.ts and tests/command.test.ts", () => {
    const cli = packageTemplateFiles("cli");
    const lambda = packageTemplateFiles("lambda");

    expect(cli.length - lambda.length).toBe(2);

    const lambdaTargets = new Set(lambda.map((entry) => entry.target));
    const cliOnlyEntries = cli.filter(
      (entry) => !lambdaTargets.has(entry.target),
    );

    expect(cliOnlyEntries).toEqual([
      { template: "src/command.ts.tmpl", target: "src/command.ts" },
      {
        template: "tests/command.test.ts.tmpl",
        target: "tests/command.test.ts",
      },
    ]);
  });

  test("cli variant includes src/command.ts and tests/command.test.ts; lambda variant does not", () => {
    const cliTargets = packageTemplateFiles("cli").map((entry) => entry.target);
    const lambdaTargets = packageTemplateFiles("lambda").map(
      (entry) => entry.target,
    );

    expect(cliTargets).toContain("src/command.ts");
    expect(cliTargets).toContain("tests/command.test.ts");
    expect(lambdaTargets).not.toContain("src/command.ts");
    expect(lambdaTargets).not.toContain("tests/command.test.ts");
  });
});

describe("PACKAGE_TEMPLATE_FILES", () => {
  test("equals packageTemplateFiles('cli')", () => {
    expect(PACKAGE_TEMPLATE_FILES).toEqual(packageTemplateFiles("cli"));
  });
});

describe("DOC_PAGE_TEMPLATE", () => {
  test("is docs-page.md.tmpl", () => {
    expect(DOC_PAGE_TEMPLATE).toBe("docs-page.md.tmpl");
  });
});

describe("docPagePath", () => {
  test("builds the doc page path under SCRIPT_DOCS_DIR", () => {
    expect(docPagePath("data-sync")).toBe(
      "docs/reference/scripts/data-sync.md",
    );
  });

  test("varies with the script name", () => {
    expect(docPagePath("other-script")).toBe(
      "docs/reference/scripts/other-script.md",
    );
  });
});

describe("REQUIRED_EXACT_FILES", () => {
  test("lists exactly the seven always-present output files", () => {
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
  test("declares the steps/ and tests/ glob requirements", () => {
    expect(REQUIRED_GLOBS).toEqual([
      { dir: "src/steps", suffix: ".ts", what: "a steps/ module" },
      { dir: "tests", suffix: ".test.ts", what: "the config smoke test" },
    ]);
  });
});

describe("rootTsconfigRef", () => {
  test("builds the workspace tsconfig reference path for a script", () => {
    expect(rootTsconfigRef("data-sync")).toBe(
      "./scripts/data-sync/tsconfig.build.json",
    );
  });

  test("varies with the script name", () => {
    expect(rootTsconfigRef("other-script")).toBe(
      "./scripts/other-script/tsconfig.build.json",
    );
  });
});

describe("type contracts", () => {
  test("ScaffoldVariant is the closed 'cli' | 'lambda' union", () => {
    expectTypeOf<ScaffoldVariant>().toEqualTypeOf<"cli" | "lambda">();
  });

  test("ScaffoldTokens declares the three documented readonly token fields", () => {
    expectTypeOf<ScaffoldTokens>().toEqualTypeOf<{
      readonly __SCRIPT_NAME__: string;
      readonly __SCRIPT_NAME_PASCAL__: string;
      readonly __PURPOSE__: string;
    }>();
  });

  test("ScaffoldTemplateFile declares the documented readonly shape", () => {
    expectTypeOf<ScaffoldTemplateFile>().toEqualTypeOf<{
      readonly template: string;
      readonly target: string;
    }>();
  });

  test("ScaffoldRequiredGlob declares the documented readonly shape", () => {
    expectTypeOf<ScaffoldRequiredGlob>().toEqualTypeOf<{
      readonly dir: string;
      readonly suffix: string;
      readonly what: string;
    }>();
  });
});
