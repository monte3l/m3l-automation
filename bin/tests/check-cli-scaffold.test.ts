/**
 * Tests for the CLI package-shape checker (bin/check-cli-scaffold.mjs) —
 * covers the exported pure validators and the three filesystem-reading
 * reverse checks. The module's CLI main block is guarded behind
 * `if (process.argv[1] === fileURLToPath(import.meta.url))`, so importing it
 * here executes nothing (the bin/check-script-deps.mjs convention).
 *
 * Every validator gets at least one synthetic FAILING fixture, not just a
 * "the repo passes today" assertion: three count/index gates have shipped in
 * this repo as latent no-ops precisely because only the passing direction was
 * ever exercised (see .claude/rules/tests.md).
 */
import { describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — the script-scaffold.test.ts pattern.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  CLI_BIN_ENTRY_FILE,
  CLI_BIN_NAME,
  CLI_EXPECTED_SCRIPTS,
  CLI_LIBRARY_DEPENDENCY,
  CLI_PACKAGE_DIR,
  CLI_PACKAGE_NAME,
  CLI_REQUIRED_EXACT_FILES,
  CLI_REQUIRED_GLOBS,
  CLI_SRC_LAYERS,
  CLI_SRC_ROOT_FILE,
  WORKSPACE_SCOPE,
  cliBinEntryErrors,
  cliPackageManifestErrors,
  cliSrcLayoutErrors,
  cliTsconfigErrors,
  scriptsDependingOnCliErrors,
} from "../check-cli-scaffold.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** A minimal manifest that satisfies every rule — the base for negative cases. */
function conformantCliManifest(): Record<string, unknown> {
  return {
    name: CLI_PACKAGE_NAME,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: ">=24" },
    bin: { [CLI_BIN_NAME]: `./bin/${CLI_BIN_ENTRY_FILE}` },
    scripts: { ...CLI_EXPECTED_SCRIPTS },
    dependencies: { [CLI_LIBRARY_DEPENDENCY]: "workspace:*" },
  };
}

/** Build a manifest with one field replaced (or removed, when value is undefined). */
function manifestWith(patch: Record<string, unknown>): Record<string, unknown> {
  const pkg = conformantCliManifest();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete pkg[key];
    else pkg[key] = value;
  }
  return pkg;
}

describe("exported constants", () => {
  test("required files name the two manifests, both entry points and the README", () => {
    expect(CLI_REQUIRED_EXACT_FILES).toEqual([
      "package.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "README.md",
      `bin/${CLI_BIN_ENTRY_FILE}`,
      "src/main.ts",
    ]);
  });

  test("required files pin no individual command module", () => {
    // Pinning src/commands/<name>.ts by name would make the gate a changelog:
    // U9/U10/U12 each add one.
    expect(
      CLI_REQUIRED_EXACT_FILES.filter((file) =>
        file.startsWith("src/commands/"),
      ),
    ).toEqual([]);
  });

  test("the required globs cover the four load-bearing layers plus tests", () => {
    expect(CLI_REQUIRED_GLOBS.map((glob) => glob.dir)).toEqual([
      "src/cli",
      "src/commands",
      "src/discovery",
      "src/run",
      "tests",
    ]);
  });

  test("history and presets are allowed layers but are not required to exist", () => {
    // ADR-0054/U7 may relocate the 8f feature stores; requiring them would
    // make this gate fight that refactor.
    expect(CLI_SRC_LAYERS).toContain("history");
    expect(CLI_SRC_LAYERS).toContain("presets");
    expect(CLI_REQUIRED_GLOBS.map((glob) => glob.dir)).not.toContain(
      "src/history",
    );
    expect(CLI_REQUIRED_GLOBS.map((glob) => glob.dir)).not.toContain(
      "src/presets",
    );
  });

  test("every required glob directory that lives under src/ is a sanctioned layer", () => {
    for (const { dir } of CLI_REQUIRED_GLOBS) {
      if (!dir.startsWith("src/")) continue;
      expect(CLI_SRC_LAYERS).toContain(dir.slice("src/".length));
    }
  });
});

describe("cliPackageManifestErrors — the real committed manifest", () => {
  test("packages/m3l-cli/package.json is conformant", () => {
    const pkg = JSON.parse(
      fs.readFileSync(join(repoRoot, CLI_PACKAGE_DIR, "package.json"), "utf8"),
    );
    expect(cliPackageManifestErrors(pkg)).toEqual([]);
  });
});

describe("cliPackageManifestErrors — synthetic fixtures", () => {
  test("a conformant synthetic manifest produces no problems", () => {
    expect(cliPackageManifestErrors(conformantCliManifest())).toEqual([]);
  });

  test.each([
    ["a wrong name", { name: "@m3l-automation/m3l-clii" }, "name"],
    ["a missing name", { name: undefined }, "name"],
    ["private false", { private: false }, "private"],
    ["a missing private flag", { private: undefined }, "private"],
    ["a commonjs type", { type: "commonjs" }, "type"],
    ["a Node 22 floor", { engines: { node: ">=22" } }, "engines.node"],
    ["missing engines", { engines: undefined }, "engines.node"],
    ["a missing version", { version: undefined }, "version"],
    ["an empty version", { version: "" }, "version"],
    ["a non-string version", { version: 1 }, "version"],
  ])("flags %s", (_label, patch, expectedField) => {
    const errors = cliPackageManifestErrors(manifestWith(patch));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain(expectedField);
  });

  test("flags a missing bin block", () => {
    const errors = cliPackageManifestErrors(manifestWith({ bin: undefined }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"bin" must be an object');
  });

  test("flags a string bin shorthand", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({ bin: "./bin/m3l.mjs" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"bin" must be an object');
  });

  test("flags a second bin entry", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({
        bin: {
          [CLI_BIN_NAME]: `./bin/${CLI_BIN_ENTRY_FILE}`,
          m3lx: "./bin/m3lx.mjs",
        },
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("exactly one entry");
  });

  test("flags a bin entry pointing somewhere other than bin/m3l.mjs", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({ bin: { [CLI_BIN_NAME]: "./dist/main.js" } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`bin.${CLI_BIN_NAME}`);
  });

  test("flags a declared scripts.start — the CLI has no dist process entry", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({
        scripts: { ...CLI_EXPECTED_SCRIPTS, start: "node dist/main.js" },
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"scripts.start" must NOT be declared');
  });

  test("flags a declared exports map — the package is bin-first", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({ exports: { ".": "./dist/main.js" } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"exports" must NOT be declared');
  });

  test("flags declared devDependencies", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({ devDependencies: { vitest: "4.1.10" } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("devDependencies");
  });

  test.each([
    ["build", "tsc -b"],
    ["typecheck", "tsc -p"],
  ])("flags a wrong scripts.%s value, not merely its absence", (script) => {
    const errors = cliPackageManifestErrors(
      manifestWith({
        scripts: { ...CLI_EXPECTED_SCRIPTS, [script]: "echo nope" },
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`"scripts.${script}" must be`);
  });

  test("flags a missing scripts block", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({ scripts: undefined }),
    );
    expect(errors).toHaveLength(Object.keys(CLI_EXPECTED_SCRIPTS).length);
  });

  test("flags a missing library dependency", () => {
    const errors = cliPackageManifestErrors(manifestWith({ dependencies: {} }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(CLI_LIBRARY_DEPENDENCY);
  });

  test("flags the library pinned to a version range instead of workspace:*", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({ dependencies: { [CLI_LIBRARY_DEPENDENCY]: "^2.0.0" } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("workspace:*");
  });

  test("flags a third-party runtime dependency", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({
        dependencies: {
          [CLI_LIBRARY_DEPENDENCY]: "workspace:*",
          commander: "12.0.0",
        },
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("third-party");
  });

  // The two U7 forward-compatibility cases: "CLI declares script packages as
  // dependencies" must keep passing, while the zero-third-party guarantee and
  // the workspace pin still bite.
  test("accepts an additional @m3l-automation/* workspace dependency (U7)", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({
        dependencies: {
          [CLI_LIBRARY_DEPENDENCY]: "workspace:*",
          [`${WORKSPACE_SCOPE}json-etl`]: "workspace:*",
        },
      }),
    );
    expect(errors).toEqual([]);
  });

  test("flags an @m3l-automation/* dependency that is not workspace-pinned", () => {
    const errors = cliPackageManifestErrors(
      manifestWith({
        dependencies: {
          [CLI_LIBRARY_DEPENDENCY]: "workspace:*",
          [`${WORKSPACE_SCOPE}json-etl`]: "^1.0.0",
        },
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('must be pinned to "workspace:*"');
  });

  test("reports every violation at once rather than stopping at the first", () => {
    const errors = cliPackageManifestErrors({});
    expect(errors.length).toBeGreaterThan(5);
  });
});

describe("cliTsconfigErrors — the real committed tsconfigs", () => {
  test.each([["tsconfig.json"], ["tsconfig.build.json"]] as const)(
    "packages/m3l-cli/%s is conformant",
    (which) => {
      const parsed = JSON.parse(
        fs.readFileSync(join(repoRoot, CLI_PACKAGE_DIR, which), "utf8"),
      );
      expect(cliTsconfigErrors(parsed, which)).toEqual([]);
    },
  );
});

describe("cliTsconfigErrors — synthetic fixtures", () => {
  const toolingBase = {
    extends: "../../tsconfig.base.json",
    compilerOptions: { composite: false, declaration: false, noEmit: true },
    references: [{ path: "../m3l-common/tsconfig.build.json" }],
    include: ["src/**/*.ts", "tests/**/*.ts"],
    exclude: ["dist", "node_modules"],
  };
  const buildBase = {
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      rootDir: "src",
      outDir: "dist",
      isolatedDeclarations: true,
    },
    references: [{ path: "../m3l-common/tsconfig.build.json" }],
    include: ["src/**/*.ts"],
    exclude: ["dist", "node_modules", "tests"],
  };

  test.each([
    ["tsconfig.json", toolingBase],
    ["tsconfig.build.json", buildBase],
  ] as const)(
    "a conformant synthetic %s produces no problems",
    (which, base) => {
      expect(cliTsconfigErrors(base, which)).toEqual([]);
    },
  );

  test.each([
    ["tsconfig.json", toolingBase],
    ["tsconfig.build.json", buildBase],
  ] as const)("flags a wrong extends in %s", (which, base) => {
    const errors = cliTsconfigErrors(
      { ...base, extends: "../../tsconfig.json" },
      which,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("extends");
  });

  test.each([
    ["tsconfig.json", toolingBase],
    ["tsconfig.build.json", buildBase],
  ] as const)(
    "flags a missing library project reference in %s",
    (which, base) => {
      const errors = cliTsconfigErrors({ ...base, references: [] }, which);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("references");
    },
  );

  test.each([["noEmit"], ["composite"], ["declaration"]])(
    "flags a wrong compilerOptions.%s in the tooling config",
    (option) => {
      const errors = cliTsconfigErrors(
        {
          ...toolingBase,
          compilerOptions: {
            ...toolingBase.compilerOptions,
            [option]: option === "noEmit" ? false : true,
          },
        },
        "tsconfig.json",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(option);
    },
  );

  test("flags a tooling include that drops the tests glob", () => {
    // The load-bearing case: dropping it silently un-type-checks the CLI's
    // whole test tree while `pnpm typecheck` still reports green.
    const errors = cliTsconfigErrors(
      { ...toolingBase, include: ["src/**/*.ts"] },
      "tsconfig.json",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tests/**/*.ts");
  });

  test("flags a tooling include that drops the src glob", () => {
    const errors = cliTsconfigErrors(
      { ...toolingBase, include: ["tests/**/*.ts"] },
      "tsconfig.json",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("src/**/*.ts");
  });

  test.each([
    ["rootDir", "."],
    ["outDir", "build"],
    ["isolatedDeclarations", false],
  ])(
    "flags a wrong compilerOptions.%s in the build config",
    (option, value) => {
      const errors = cliTsconfigErrors(
        {
          ...buildBase,
          compilerOptions: { ...buildBase.compilerOptions, [option]: value },
        },
        "tsconfig.build.json",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(option);
    },
  );

  test("flags a build include that admits the test tree", () => {
    const errors = cliTsconfigErrors(
      { ...buildBase, include: ["src/**/*.ts", "tests/**/*.ts"] },
      "tsconfig.build.json",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("src/**/*.ts");
  });

  test("flags a build config that does not exclude tests", () => {
    const errors = cliTsconfigErrors(
      { ...buildBase, exclude: ["dist", "node_modules"] },
      "tsconfig.build.json",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tests");
  });
});

/** Minimal Dirent stand-in for the readdirSync(withFileTypes) reverse checks. */
function dirent(name: string, directory: boolean): fs.Dirent {
  return { name, isDirectory: () => directory } as unknown as fs.Dirent;
}

describe("cliSrcLayoutErrors", () => {
  test("the real src/ tree conforms", () => {
    expect(cliSrcLayoutErrors(repoRoot)).toEqual([]);
  });

  test("accepts the sanctioned layers plus the one composition root", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      ...CLI_SRC_LAYERS.map((layer) => dirent(layer, true)),
      dirent(CLI_SRC_ROOT_FILE, false),
    ] as never);
    expect(cliSrcLayoutErrors(repoRoot)).toEqual([]);
    vi.restoreAllMocks();
  });

  test("flags an unsanctioned top-level layer", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      dirent("cli", true),
      dirent("plugins", true),
      dirent(CLI_SRC_ROOT_FILE, false),
    ] as never);
    const problems = cliSrcLayoutErrors(repoRoot);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("plugins");
    expect(problems[0]?.message).toContain("not a sanctioned CLI layer");
    vi.restoreAllMocks();
  });

  test("flags a second file sitting directly under src/", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      dirent(CLI_SRC_ROOT_FILE, false),
      dirent("helpers.ts", false),
    ] as never);
    const problems = cliSrcLayoutErrors(repoRoot);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("helpers.ts");
    expect(problems[0]?.message).toContain("composition root");
    vi.restoreAllMocks();
  });

  test("reports an unreadable src/ directory rather than passing vacuously", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const problems = cliSrcLayoutErrors(repoRoot);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("could not be read");
    vi.restoreAllMocks();
  });
});

describe("cliBinEntryErrors", () => {
  test("the real bin/ directory holds exactly the process entry", () => {
    expect(cliBinEntryErrors(repoRoot)).toEqual([]);
  });

  test("flags a stray file beside the process entry", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      CLI_BIN_ENTRY_FILE,
      "legacy.mjs",
    ] as never);
    const problems = cliBinEntryErrors(repoRoot);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("legacy.mjs");
    vi.restoreAllMocks();
  });

  test("flags a missing process entry", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([] as never);
    const problems = cliBinEntryErrors(repoRoot);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("is missing");
    vi.restoreAllMocks();
  });

  test("reports an unreadable bin/ directory", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const problems = cliBinEntryErrors(repoRoot);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("could not be read");
    vi.restoreAllMocks();
  });
});

describe("scriptsDependingOnCliErrors", () => {
  test("no shipped script depends on the CLI", () => {
    expect(scriptsDependingOnCliErrors(repoRoot)).toEqual([]);
  });

  test("flags a script that declares the CLI as a runtime dependency", () => {
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((
      path: Parameters<typeof fs.readFileSync>[0],
      ...rest: unknown[]
    ) => {
      if (String(path).endsWith("package.json")) {
        return JSON.stringify({
          dependencies: {
            "@m3l-automation/m3l-common": "workspace:*",
            [CLI_PACKAGE_NAME]: "workspace:*",
          },
        });
      }
      return (realReadFileSync as (...args: unknown[]) => unknown)(
        path,
        ...rest,
      );
    }) as typeof fs.readFileSync);
    const problems = scriptsDependingOnCliErrors(repoRoot);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.message).toContain(CLI_PACKAGE_NAME);
    expect(problems[0]?.message).toContain("scripts <- CLI");
    vi.restoreAllMocks();
  });

  test("flags the CLI declared as a script devDependency too", () => {
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((
      path: Parameters<typeof fs.readFileSync>[0],
      ...rest: unknown[]
    ) => {
      if (String(path).endsWith("package.json")) {
        return JSON.stringify({
          devDependencies: { [CLI_PACKAGE_NAME]: "workspace:*" },
        });
      }
      return (realReadFileSync as (...args: unknown[]) => unknown)(
        path,
        ...rest,
      );
    }) as typeof fs.readFileSync);
    const problems = scriptsDependingOnCliErrors(repoRoot);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.message).toContain(CLI_PACKAGE_NAME);
    vi.restoreAllMocks();
  });

  test("reports an unparseable script manifest", () => {
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((
      path: Parameters<typeof fs.readFileSync>[0],
      ...rest: unknown[]
    ) => {
      if (String(path).endsWith("package.json")) return "{ not json";
      return (realReadFileSync as (...args: unknown[]) => unknown)(
        path,
        ...rest,
      );
    }) as typeof fs.readFileSync);
    const problems = scriptsDependingOnCliErrors(repoRoot);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.message).toContain("not valid JSON");
    vi.restoreAllMocks();
  });
});
