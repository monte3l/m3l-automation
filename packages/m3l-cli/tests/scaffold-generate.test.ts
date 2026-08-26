/**
 * Tests for src/scaffold/generate.ts — validates scaffold options, emits the
 * package + doc page files for a new consumer script, and wires the root
 * tsconfig reference (U9 contract). Pure-logic test: `node:fs` is mocked
 * throughout, never touched for real.
 */
import * as fs from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors discover.test.ts /
// cache.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { generateScript } from "../src/scaffold/generate.js";
import type {
  GenerateScriptChange,
  GenerateScriptOptions,
  GenerateScriptResult,
} from "../src/scaffold/generate.js";
import type { ScaffoldVariant } from "../src/scaffold/manifest.js";
import { M3LCliError } from "../src/cli/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const WORKSPACE_ROOT = "/repo";
const NAME = "data-sync";
const PURPOSE = "Sync it";

const packageDir = join(WORKSPACE_ROOT, "scripts", NAME);
const docPageAbs = join(
  WORKSPACE_ROOT,
  "docs",
  "reference",
  "scripts",
  `${NAME}.md`,
);
const rootTsconfigAbs = join(WORKSPACE_ROOT, "tsconfig.json");

const CLI_TEMPLATE_NAMES = [
  "package.json.tmpl",
  "tsconfig.json.tmpl",
  "tsconfig.build.json.tmpl",
  "src/main.ts.tmpl",
  "src/config.ts.tmpl",
  "src/hooks.ts.tmpl",
  "src/steps/run-__SCRIPT_NAME__.ts.tmpl",
  "tests/config.test.ts.tmpl",
  "README.md.tmpl",
];

const LAMBDA_TEMPLATE_NAMES = CLI_TEMPLATE_NAMES.map((name) =>
  name === "src/main.ts.tmpl"
    ? "src/main.lambda.ts.tmpl"
    : name === "README.md.tmpl"
      ? "README.lambda.md.tmpl"
      : name,
);

const EXPECTED_CREATED_PATHS = [
  join("scripts", NAME, "package.json"),
  join("scripts", NAME, "tsconfig.json"),
  join("scripts", NAME, "tsconfig.build.json"),
  join("scripts", NAME, "src", "main.ts"),
  join("scripts", NAME, "src", "config.ts"),
  join("scripts", NAME, "src", "hooks.ts"),
  join("scripts", NAME, "src", "steps", `run-${NAME}.ts`),
  join("scripts", NAME, "tests", "config.test.ts"),
  join("scripts", NAME, "README.md"),
  join("docs", "reference", "scripts", `${NAME}.md`),
];

function baseOptions(
  overrides: Partial<GenerateScriptOptions> = {},
): GenerateScriptOptions {
  return {
    workspaceRoot: WORKSPACE_ROOT,
    name: NAME,
    purpose: PURPOSE,
    variant: "cli",
    dryRun: false,
    force: false,
    ...overrides,
  };
}

/** Fixed, distinguishable template body per template name, keyed by substring. */
function templateBodyFor(templateName: string): string {
  return `TEMPLATE-BODY:${templateName}`;
}

/**
 * Wires `readFileSync` to answer template reads (matched by TEMPLATE_DIR +
 * template-name substrings) and the root tsconfig.json read exactly; throws
 * for anything else so an unexpected read surfaces immediately.
 */
function mockTemplateReads(
  variant: ScaffoldVariant,
  rootTsconfigJson: string,
): void {
  const templateNames =
    variant === "lambda" ? LAMBDA_TEMPLATE_NAMES : CLI_TEMPLATE_NAMES;

  vi.spyOn(fs, "readFileSync").mockImplementation(
    (path: fs.PathOrFileDescriptor) => {
      const value = String(path);
      if (value === rootTsconfigAbs) {
        return rootTsconfigJson;
      }
      const matchedTemplate = [...templateNames, "docs-page.md.tmpl"].find(
        (templateName) => value.includes(templateName),
      );
      if (matchedTemplate !== undefined && value.includes("templates")) {
        return templateBodyFor(matchedTemplate);
      }
      throw new Error(`unexpected readFileSync call: ${value}`);
    },
  );
}

describe("generateScript — invalid input rejected before any fs write", () => {
  test.each([
    ["bad name shape", baseOptions({ name: "Data_Sync" })],
    ["reserved name", baseOptions({ name: "new" })],
    ["banned leading segment", baseOptions({ name: "dynamo-backup" })],
    ["invalid purpose", baseOptions({ purpose: "" })],
    [
      "invalid variant (runtime check, bypasses TS)",
      baseOptions({ variant: "foo" as unknown as ScaffoldVariant }),
    ],
  ])("%s -> M3LCliError ERR_CLI_SCAFFOLD_INVALID", (_label, options) => {
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    expect(() => generateScript(options)).toThrowError(M3LCliError);

    let thrown: unknown;
    try {
      generateScript(options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_SCAFFOLD_INVALID");

    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("generateScript — pre-existing target without force", () => {
  test("package directory already exists -> ERR_CLI_SCAFFOLD_EXISTS mentioning 'already exists'", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === packageDir,
    );

    let thrown: unknown;
    try {
      generateScript(baseOptions());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_SCAFFOLD_EXISTS");
    expect((thrown as M3LCliError).message).toContain("already exists");
    expect((thrown as M3LCliError).message).toContain(`scripts/${NAME}/`);
  });

  test("doc page already exists -> ERR_CLI_SCAFFOLD_EXISTS mentioning the doc page path", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === docPageAbs,
    );

    let thrown: unknown;
    try {
      generateScript(baseOptions());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_SCAFFOLD_EXISTS");
    expect((thrown as M3LCliError).message).toContain(
      `docs/reference/scripts/${NAME}.md`,
    );
  });
});

describe("generateScript — happy path (variant: cli, dryRun: false)", () => {
  test("emits every package file plus the doc page, and adds the new root tsconfig reference", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockTemplateReads("cli", JSON.stringify({ references: [] }));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const result: GenerateScriptResult = generateScript(baseOptions());

    expect(result.scriptName).toBe(NAME);
    expect(result.variant).toBe("cli");
    expect(result.dryRun).toBe(false);

    // 9 package files + 1 doc page + 1 tsconfig.json rewrite.
    expect(writeSpy).toHaveBeenCalledTimes(11);

    const createdPaths = result.changes
      .filter((change: GenerateScriptChange) => change.action === "created")
      .map((change: GenerateScriptChange) => change.path)
      .sort();
    expect(createdPaths).toEqual([...EXPECTED_CREATED_PATHS].sort());
    expect(result.changes).toContainEqual({
      action: "updated",
      path: "tsconfig.json",
    });
    expect(result.changes).toHaveLength(11);
  });

  test("reads every template through TEMPLATE_DIR, including the doc page template and the root tsconfig", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const readSpy = vi.spyOn(fs, "readFileSync");
    mockTemplateReads("cli", JSON.stringify({ references: [] }));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    generateScript(baseOptions());

    const readPaths = readSpy.mock.calls.map((call) => String(call[0]));
    for (const templateName of [...CLI_TEMPLATE_NAMES, "docs-page.md.tmpl"]) {
      expect(
        readPaths.some(
          (path) =>
            path.includes("templates/script") && path.includes(templateName),
        ),
      ).toBe(true);
    }
    expect(readPaths).toContain(rootTsconfigAbs);
  });
});

describe("generateScript — dryRun: true", () => {
  test("never writes or creates directories, but still reports the changes that would occur", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockTemplateReads("cli", JSON.stringify({ references: [] }));
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const result: GenerateScriptResult = generateScript(
      baseOptions({ dryRun: true }),
    );

    expect(writeSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);

    const createdPaths = result.changes
      .filter((change: GenerateScriptChange) => change.action === "created")
      .map((change: GenerateScriptChange) => change.path)
      .sort();
    expect(createdPaths).toEqual([...EXPECTED_CREATED_PATHS].sort());
    expect(result.changes).toContainEqual({
      action: "updated",
      path: "tsconfig.json",
    });
    expect(result.changes).toHaveLength(11);
  });
});

describe("generateScript — variant: lambda", () => {
  test("reads the lambda main-entry and README templates, but still targets src/main.ts", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const readSpy = vi.spyOn(fs, "readFileSync");
    mockTemplateReads("lambda", JSON.stringify({ references: [] }));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const result: GenerateScriptResult = generateScript(
      baseOptions({ variant: "lambda" }),
    );

    const readPaths = readSpy.mock.calls.map((call) => String(call[0]));
    expect(
      readPaths.some((path) => path.includes("src/main.lambda.ts.tmpl")),
    ).toBe(true);
    expect(
      readPaths.some((path) => path.includes("README.lambda.md.tmpl")),
    ).toBe(true);
    expect(readPaths.some((path) => path.includes("src/main.ts.tmpl"))).toBe(
      false,
    );

    expect(result.variant).toBe("lambda");
    expect(
      result.changes.some(
        (change: GenerateScriptChange) =>
          change.action === "created" &&
          change.path === join("scripts", NAME, "src", "main.ts"),
      ),
    ).toBe(true);
  });
});

describe("generateScript — root tsconfig reference already present", () => {
  test("does not rewrite tsconfig.json and reports no 'updated' change", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockTemplateReads(
      "cli",
      JSON.stringify({
        references: [{ path: `./scripts/${NAME}/tsconfig.build.json` }],
      }),
    );
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const result: GenerateScriptResult = generateScript(baseOptions());

    const tsconfigWrites = writeSpy.mock.calls.filter(
      (call) => String(call[0]) === rootTsconfigAbs,
    );
    expect(tsconfigWrites).toHaveLength(0);
    expect(
      result.changes.some(
        (change: GenerateScriptChange) => change.action === "updated",
      ),
    ).toBe(false);
    expect(result.changes).toHaveLength(10);
  });
});

describe("generateScript — root tsconfig rewrite is a minimal, line-preserving diff", () => {
  // Matches the real repo's committed root tsconfig.json style: single-line
  // entries, 4-space indent, alphabetically sorted, no trailing commas.
  const ROOT_TSCONFIG_FIXTURE = `{
  "files": [],
  "references": [
    { "path": "./packages/m3l-common/tsconfig.build.json" },
    { "path": "./scripts/json-etl/tsconfig.build.json" },
    { "path": "./scripts/sqs-etl/tsconfig.build.json" }
  ]
}
`;

  const ORIGINAL_ENTRY_LINES = [
    '{ "path": "./packages/m3l-common/tsconfig.build.json" }',
    '{ "path": "./scripts/json-etl/tsconfig.build.json" }',
    '{ "path": "./scripts/sqs-etl/tsconfig.build.json" }',
  ];

  /**
   * Runs `generateScript` for a new script named `name` against
   * `ROOT_TSCONFIG_FIXTURE` and returns the text written to `tsconfig.json`.
   */
  function generateAndCaptureTsconfigWrite(name: string): string {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockTemplateReads("cli", ROOT_TSCONFIG_FIXTURE);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    generateScript(baseOptions({ name }));

    const tsconfigWrite = writeSpy.mock.calls.find(
      (call) => String(call[0]) === rootTsconfigAbs,
    );
    const written = tsconfigWrite?.[1];
    if (typeof written !== "string") {
      throw new Error("expected tsconfig.json to be written as a string");
    }
    return written;
  }

  test("preserves every pre-existing reference entry's exact text unchanged, appending the new one in sorted order", () => {
    // "./scripts/kafka-extra/tsconfig.build.json" sorts strictly between
    // "./scripts/json-etl/..." and "./scripts/sqs-etl/..." — verified with
    // Array#sort()/localeCompare against all four resulting paths — so this
    // lands the new entry in the middle of the 4-entry array, not an edge.
    const written = generateAndCaptureTsconfigWrite("kafka-extra");

    const parsed = JSON.parse(written) as { references: { path: string }[] };
    expect(
      parsed.references
        .map((entry) => entry.path)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      [
        "./packages/m3l-common/tsconfig.build.json",
        "./scripts/json-etl/tsconfig.build.json",
        "./scripts/kafka-extra/tsconfig.build.json",
        "./scripts/sqs-etl/tsconfig.build.json",
      ].sort((a, b) => a.localeCompare(b)),
    );

    for (const line of ORIGINAL_ENTRY_LINES) {
      expect(written).toContain(line);
    }
    expect(written).toContain(
      '{ "path": "./scripts/kafka-extra/tsconfig.build.json" }',
    );
    expect(written).toContain('"files": []');
  });

  test("inserting at the start of the sorted order still preserves every other entry", () => {
    // "./packages/..." always sorts before "./scripts/..." ("p" < "s"), so
    // no new script reference can ever precede the fixture's first entry —
    // verified with localeCompare. The earliest reachable position for a
    // new entry is immediately after it, ahead of every other
    // "./scripts/..." entry; "./scripts/api-gateway-extra/..." sorts before
    // both "./scripts/json-etl/..." and "./scripts/sqs-etl/...".
    const written = generateAndCaptureTsconfigWrite("api-gateway-extra");

    const parsed = JSON.parse(written) as { references: { path: string }[] };
    expect(parsed.references).toHaveLength(4);

    for (const line of ORIGINAL_ENTRY_LINES) {
      expect(written).toContain(line);
    }
    expect(written).toContain(
      '{ "path": "./scripts/api-gateway-extra/tsconfig.build.json" }',
    );
    expect(written).toContain('"files": []');
  });

  test("inserting at the end of the sorted order still preserves every other entry", () => {
    // "./scripts/zzz-service/..." sorts strictly after all three fixture
    // entries — verified with localeCompare.
    const written = generateAndCaptureTsconfigWrite("zzz-service");

    const parsed = JSON.parse(written) as { references: { path: string }[] };
    expect(parsed.references).toHaveLength(4);

    for (const line of ORIGINAL_ENTRY_LINES) {
      expect(written).toContain(line);
    }
    expect(written).toContain(
      '{ "path": "./scripts/zzz-service/tsconfig.build.json" }',
    );
    expect(written).toContain('"files": []');
  });
});

describe("generateScript — write failure mid-emission", () => {
  test("rolls back the package dir and doc page, then throws ERR_CLI_SCAFFOLD_FAILED with the original cause", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockTemplateReads("cli", JSON.stringify({ references: [] }));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const rmSpy = vi.spyOn(fs, "rmSync").mockReturnValue(undefined);

    const originalError = new Error("disk full");
    let callCount = 0;
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      callCount += 1;
      if (callCount === 3) {
        throw originalError;
      }
      return undefined;
    });

    let thrown: unknown;
    try {
      generateScript(baseOptions());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_SCAFFOLD_FAILED");
    const cause = (thrown as M3LCliError).cause;
    expect(cause).toBeDefined();
    if (cause instanceof Error) {
      expect(cause.message).toBe("disk full");
    }

    const rollbackPaths = rmSpy.mock.calls.map((call) => String(call[0]));
    expect(rollbackPaths).toContain(packageDir);
    expect(rollbackPaths).toContain(docPageAbs);

    const packageDirRmCall = rmSpy.mock.calls.find(
      (call) => String(call[0]) === packageDir,
    );
    expect(packageDirRmCall?.[1]).toMatchObject({
      recursive: true,
      force: true,
    });
  });
});

describe("generateScript — write failure when a target pre-existed under force", () => {
  test("rolls back only the target that did NOT pre-exist, when packageDir pre-existed", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === packageDir,
    );
    mockTemplateReads("cli", JSON.stringify({ references: [] }));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const rmSpy = vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });

    let thrown: unknown;
    try {
      generateScript(baseOptions({ force: true }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect(rmSpy).toHaveBeenCalledTimes(1);
    const docPageRmCall = rmSpy.mock.calls[0];
    expect(String(docPageRmCall?.[0])).toBe(docPageAbs);
    expect(docPageRmCall?.[1]).toMatchObject({ force: true });
    expect((thrown as M3LCliError).message.toLowerCase()).toMatch(
      /not.*rolled back/,
    );
  });

  test("rolls back only the target that did NOT pre-exist, when docPage pre-existed", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === docPageAbs,
    );
    mockTemplateReads("cli", JSON.stringify({ references: [] }));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const rmSpy = vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });

    let thrown: unknown;
    try {
      generateScript(baseOptions({ force: true }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect(rmSpy).toHaveBeenCalledTimes(1);
    const packageDirRmCall = rmSpy.mock.calls[0];
    expect(String(packageDirRmCall?.[0])).toBe(packageDir);
    expect(packageDirRmCall?.[1]).toMatchObject({
      recursive: true,
      force: true,
    });
    expect((thrown as M3LCliError).message.toLowerCase()).toMatch(
      /not.*rolled back/,
    );
  });
});

describe("GenerateScriptChange / GenerateScriptResult contract", () => {
  test("GenerateScriptChange.action is the closed 'created' | 'updated' union", () => {
    expectTypeOf<GenerateScriptChange>().toEqualTypeOf<{
      readonly action: "created" | "updated";
      readonly path: string;
    }>();
  });

  test("GenerateScriptResult declares the documented readonly shape", () => {
    expectTypeOf<GenerateScriptResult>().toEqualTypeOf<{
      readonly scriptName: string;
      readonly variant: ScaffoldVariant;
      readonly dryRun: boolean;
      readonly changes: readonly GenerateScriptChange[];
    }>();
  });
});
