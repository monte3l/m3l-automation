#!/usr/bin/env node
// Verifies packages/m3l-cli against the CLI package shape recorded in
// docs/contributing/cli-structure.md — the CLI-side sibling of
// check-script-scaffold.mjs, closing one of the two governance gaps ADR-0053
// names (the CLI package and its contract page were the only first-class
// surfaces in this repo with no machine gate on their shape).
//
// Deliberately ONE file, not the two-file checker + bin/lib/ manifest split
// check-script-scaffold.mjs uses. That split exists so the GENERATOR
// (bin/scaffold-script.mjs) and the checker consume one manifest and cannot
// drift; there is no CLI generator and never will be — there is exactly one
// packages/m3l-cli. Pure validators are exported above the main guard and
// unit-tested from bin/tests/check-cli-scaffold.test.ts (the
// check-script-deps.mjs pattern).
//
// Forward (packages/m3l-cli must satisfy):
//   - every required file exists (manifests, both tsconfigs, README, the
//     bin/m3l.mjs process entry, the src/main.ts composition root)
//   - every src/ layer that an invariant names carries at least one .ts, and
//     tests/ carries at least one .test.ts
//   - package.json satisfies the CLI package contract — including the
//     bin-first identity (exactly one bin entry, no scripts.start, no
//     exports map) and the zero-third-party-dependency rule
//   - tsconfig.json and tsconfig.build.json each carry their documented shape
//   - every directory directly under src/ is a sanctioned layer, and main.ts
//     is the only file sitting directly under src/
//   - packages/m3l-cli/bin/ holds exactly the one process entry
// Reverse:
//   - no scripts/*/package.json depends on @m3l-automation/m3l-cli (ADR-0029
//     runs scripts <- CLI; U7 inverts it, so pin the direction now)
//
// Deliberately NOT checked here, because something else already owns it: the
// root tsconfig project reference (bin/check-scaffold.mjs), the CLI's import
// boundary (eslint.config.js + check:zones), and reserved-name parity
// (packages/m3l-cli/tests/doctor.test.ts's drift guard).
//
// Usage:
//   node bin/check-cli-scaffold.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { scriptPackageDirs } from "./lib/script-scaffold.mjs";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

/** Repo-relative path of the CLI package this gate governs. */
export const CLI_PACKAGE_DIR = "packages/m3l-cli";

/** The CLI package's declared name. */
export const CLI_PACKAGE_NAME = "@m3l-automation/m3l-cli";

/** The library the CLI is allowed — and required — to depend on. */
export const CLI_LIBRARY_DEPENDENCY = "@m3l-automation/m3l-common";

/** Workspace-internal packages share this scope; anything else is third-party. */
export const WORKSPACE_SCOPE = "@m3l-automation/";

/** The single `bin` entry name and its target. */
export const CLI_BIN_NAME = "m3l";

/** The only file `packages/m3l-cli/bin/` may contain. */
export const CLI_BIN_ENTRY_FILE = "m3l.mjs";

/**
 * Files pinned by name. Only what an invariant actually names: the two
 * manifests, the README, the sole process entry, and the composition root.
 * Individual command modules are deliberately absent — that set grows one
 * entry per CLI phase (U9 `new`, U10 `flow`, U12 `completion`), and pinning
 * `src/commands/doctor.ts` by name would turn this gate into a changelog.
 */
export const CLI_REQUIRED_EXACT_FILES = Object.freeze([
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "README.md",
  `bin/${CLI_BIN_ENTRY_FILE}`,
  "src/main.ts",
]);

/**
 * Directories that must each hold at least one matching file (shallow,
 * one level). `src/history` and `src/presets` are shipped but deliberately
 * absent: they are 8f feature stores that ADR-0054/U7 may relocate, and
 * requiring them here would fight a refactor this gate has no opinion on.
 */
export const CLI_REQUIRED_GLOBS = Object.freeze([
  { dir: "src/cli", suffix: ".ts", what: "the presentation layer" },
  { dir: "src/commands", suffix: ".ts", what: "at least one command module" },
  { dir: "src/discovery", suffix: ".ts", what: "the discovery layer" },
  { dir: "src/run", suffix: ".ts", what: "the execution layer" },
  { dir: "tests", suffix: ".test.ts", what: "at least one test file" },
]);

/**
 * The sanctioned top-level layers under `src/`. A new layer fails this gate
 * until someone consciously edits this list — which is the point: the CLI's
 * module topology is a decision, not an accident of whoever added a file.
 */
export const CLI_SRC_LAYERS = Object.freeze([
  "cli",
  "commands",
  "discovery",
  "history",
  "presets",
  "run",
]);

/** The only file allowed to sit directly under `src/` — one composition root. */
export const CLI_SRC_ROOT_FILE = "main.ts";

/** Exact `scripts` command values the CLI package must declare. */
export const CLI_EXPECTED_SCRIPTS = Object.freeze({
  build: "tsc -b tsconfig.build.json",
  typecheck: "tsc -p tsconfig.json",
});

/** Both tsconfigs extend this, and reference the library's build project. */
const EXPECTED_TSCONFIG_EXTENDS = "../../tsconfig.base.json";
const EXPECTED_TSCONFIG_REFERENCE = "../m3l-common/tsconfig.build.json";

/**
 * Validate `packages/m3l-cli/package.json` against the CLI package contract.
 * Pure — operates on a parsed package.json object. Returns human-readable
 * problem strings (empty array = conformant).
 *
 * Beyond the fleet-shaped fields (`name`/`private`/`type`/`engines.node`),
 * five assertions have no `scripts/*` equivalent and encode the CLI's own
 * identity: a readable `version` (`src/main.ts`'s `readCliVersion()` reads it,
 * so `m3l --version` breaks silently without one), exactly one `bin` entry,
 * and the ABSENCE of both `scripts.start` (a start script would imply
 * `dist/main.js` is a process entry, contradicting import-inertness) and an
 * `exports` map (the package is bin-first and nothing in it is importable,
 * which is also what keeps it out of check:api/publint scope).
 *
 * The dependency rule is deliberately NOT check-script-deps.mjs's "exactly
 * one dependency": it is "the library, plus workspace-internal packages only".
 * The invariant being expressed is ZERO THIRD-PARTY RUNTIME DEPENDENCIES —
 * the manifest half of the guarantee eslint.config.js already mechanizes at
 * source level. Phrasing it this way survives U7, which makes the CLI declare
 * the script packages as dependencies; an "exactly one" rule would be torn
 * out there.
 *
 * @param {Record<string, any>} pkg parsed packages/m3l-cli/package.json
 * @returns {string[]}
 */
export function cliPackageManifestErrors(pkg) {
  const problems = [];

  if (pkg.name !== CLI_PACKAGE_NAME) {
    problems.push(
      `"name" must be "${CLI_PACKAGE_NAME}" (got ${JSON.stringify(pkg.name)})`,
    );
  }
  if (pkg.private !== true) {
    problems.push(`"private" must be true (the CLI is never published to npm)`);
  }
  if (pkg.type !== "module") {
    problems.push(`"type" must be "module" (ESM only, ADR-0002)`);
  }
  if (!/>=\s*24/.test(pkg.engines?.node ?? "")) {
    problems.push(`"engines.node" must declare ">=24" (ADR-0003)`);
  }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    problems.push(
      `"version" must be a non-empty string — src/main.ts's readCliVersion() reads it, so \`m3l --version\` breaks without it (got ${JSON.stringify(pkg.version)})`,
    );
  }

  const bin = pkg.bin;
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) {
    problems.push(
      `"bin" must be an object declaring the single \`${CLI_BIN_NAME}\` entry (got ${JSON.stringify(bin)})`,
    );
  } else {
    const binNames = Object.keys(bin);
    const expectedTarget = `./bin/${CLI_BIN_ENTRY_FILE}`;
    if (binNames.length !== 1 || binNames[0] !== CLI_BIN_NAME) {
      problems.push(
        `"bin" must declare exactly one entry, "${CLI_BIN_NAME}" (got ${JSON.stringify(binNames)})`,
      );
    }
    if (bin[CLI_BIN_NAME] !== expectedTarget) {
      problems.push(
        `"bin.${CLI_BIN_NAME}" must be ${JSON.stringify(expectedTarget)} (got ${JSON.stringify(bin[CLI_BIN_NAME])})`,
      );
    }
  }

  if (pkg.scripts?.start !== undefined) {
    problems.push(
      `"scripts.start" must NOT be declared — unlike a scripts/* package the CLI has no dist/main.js process entry; its only entry is bin/${CLI_BIN_ENTRY_FILE} (import-inert modules).`,
    );
  }
  if (pkg.exports !== undefined) {
    problems.push(
      `"exports" must NOT be declared — this package is bin-first and nothing in it is importable; declaring one would also pull it into check:api/publint scope.`,
    );
  }

  for (const [script, expected] of Object.entries(CLI_EXPECTED_SCRIPTS)) {
    const actual = pkg.scripts?.[script];
    if (typeof actual !== "string" || !actual) {
      problems.push(`"scripts.${script}" must be declared`);
    } else if (actual !== expected) {
      problems.push(
        `"scripts.${script}" must be ${JSON.stringify(expected)} (got ${JSON.stringify(actual)})`,
      );
    }
  }

  if (pkg.devDependencies !== undefined) {
    problems.push(
      `"devDependencies" must not be declared — the workspace root owns all tooling.`,
    );
  }

  const deps = pkg.dependencies ?? {};
  if (deps[CLI_LIBRARY_DEPENDENCY] !== "workspace:*") {
    problems.push(
      `dependencies must include "${CLI_LIBRARY_DEPENDENCY}": "workspace:*" (got ${JSON.stringify(deps[CLI_LIBRARY_DEPENDENCY])})`,
    );
  }
  for (const [name, range] of Object.entries(deps)) {
    if (name === CLI_LIBRARY_DEPENDENCY) continue;
    if (!name.startsWith(WORKSPACE_SCOPE)) {
      problems.push(
        `dependency "${name}" is third-party — the CLI's zero-runtime-dependency guarantee allows only "${WORKSPACE_SCOPE}*" workspace packages; a new capability becomes an m3l-common wrapper first.`,
      );
    } else if (range !== "workspace:*") {
      problems.push(
        `dependency "${name}" must be pinned to "workspace:*" (got ${JSON.stringify(range)}).`,
      );
    }
  }

  return problems;
}

/**
 * Validate one of the CLI package's two tsconfigs. Pure — operates on the
 * parsed JSON. Returns human-readable problem strings (empty = conformant).
 *
 * The tooling config's `include` must carry BOTH globs: dropping
 * `tests/**\/*.ts` silently un-type-checks the CLI's whole test tree while
 * `pnpm typecheck` still reports green.
 *
 * @param {Record<string, any>} tsconfig parsed tsconfig contents
 * @param {"tsconfig.json" | "tsconfig.build.json"} which which config this is
 * @returns {string[]}
 */
export function cliTsconfigErrors(tsconfig, which) {
  const problems = [];

  if (tsconfig.extends !== EXPECTED_TSCONFIG_EXTENDS) {
    problems.push(
      `"extends" must be ${JSON.stringify(EXPECTED_TSCONFIG_EXTENDS)} (got ${JSON.stringify(tsconfig.extends)})`,
    );
  }

  const refPaths = (
    Array.isArray(tsconfig.references) ? tsconfig.references : []
  ).map((entry) => entry?.path);
  if (!refPaths.includes(EXPECTED_TSCONFIG_REFERENCE)) {
    problems.push(
      `"references" must include { "path": ${JSON.stringify(EXPECTED_TSCONFIG_REFERENCE)} } so tsc -b resolves the library`,
    );
  }

  const options = tsconfig.compilerOptions ?? {};
  const include = Array.isArray(tsconfig.include) ? tsconfig.include : [];
  const exclude = Array.isArray(tsconfig.exclude) ? tsconfig.exclude : [];

  if (which === "tsconfig.json") {
    for (const [option, expected] of [
      ["noEmit", true],
      ["composite", false],
      ["declaration", false],
    ]) {
      if (options[option] !== expected) {
        problems.push(
          `"compilerOptions.${option}" must be ${expected} (the tooling project emits nothing; tsconfig.build.json owns the build) — got ${JSON.stringify(options[option])}`,
        );
      }
    }
    for (const glob of ["src/**/*.ts", "tests/**/*.ts"]) {
      if (!include.includes(glob)) {
        problems.push(
          `"include" must contain ${JSON.stringify(glob)} — dropping it silently un-type-checks those files while pnpm typecheck still passes (got ${JSON.stringify(include)})`,
        );
      }
    }
  } else {
    for (const [option, expected] of [
      ["rootDir", "src"],
      ["outDir", "dist"],
      ["isolatedDeclarations", true],
    ]) {
      if (options[option] !== expected) {
        problems.push(
          `"compilerOptions.${option}" must be ${JSON.stringify(expected)} (got ${JSON.stringify(options[option])})`,
        );
      }
    }
    if (include.length !== 1 || include[0] !== "src/**/*.ts") {
      problems.push(
        `"include" must be exactly ["src/**/*.ts"] — the build compiles sources only (got ${JSON.stringify(include)})`,
      );
    }
    if (!exclude.includes("tests")) {
      problems.push(
        `"exclude" must contain "tests" so the test tree never reaches dist/ (got ${JSON.stringify(exclude)})`,
      );
    }
  }

  return problems;
}

/**
 * Reverse check: every directory directly under `src/` is a sanctioned layer
 * (`CLI_SRC_LAYERS`), and `main.ts` is the only file sitting directly under
 * `src/`. Reads the filesystem — tests spy on `node:fs` rather than passing a
 * fixture.
 *
 * @param {string} root repo root
 * @returns {{ file: string, message: string }[]}
 */
export function cliSrcLayoutErrors(root) {
  const srcRel = `${CLI_PACKAGE_DIR}/src`;
  let entries;
  try {
    entries = readdirSync(join(root, srcRel), { withFileTypes: true });
  } catch (cause) {
    return [
      { file: srcRel, message: `${srcRel}/ could not be read: ${cause}` },
    ];
  }

  const problems = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!CLI_SRC_LAYERS.includes(entry.name)) {
        problems.push({
          file: `${srcRel}/${entry.name}`,
          message: `${srcRel}/${entry.name}/ is not a sanctioned CLI layer — allowed: ${CLI_SRC_LAYERS.join(", ")}. Adding a top-level layer is a topology decision: record it in docs/contributing/cli-structure.md and add it to CLI_SRC_LAYERS in the same change.`,
        });
      }
    } else if (entry.name !== CLI_SRC_ROOT_FILE) {
      problems.push({
        file: `${srcRel}/${entry.name}`,
        message: `${srcRel}/${entry.name} sits directly under src/ — ${CLI_SRC_ROOT_FILE} is the CLI's one composition root; everything else belongs to a layer directory.`,
      });
    }
  }
  return problems;
}

/**
 * Reverse check: `packages/m3l-cli/bin/` holds exactly the one process entry.
 * Machine-checks docs/reference/cli.md's "the only process entry is the
 * `bin/m3l.mjs` wrapper" invariant.
 *
 * @param {string} root repo root
 * @returns {{ file: string, message: string }[]}
 */
export function cliBinEntryErrors(root) {
  const binRel = `${CLI_PACKAGE_DIR}/bin`;
  let entries;
  try {
    entries = readdirSync(join(root, binRel));
  } catch (cause) {
    return [
      { file: binRel, message: `${binRel}/ could not be read: ${cause}` },
    ];
  }

  const unexpected = entries.filter((name) => name !== CLI_BIN_ENTRY_FILE);
  const problems = unexpected.map((name) => ({
    file: `${binRel}/${name}`,
    message: `${binRel}/${name} is not the CLI's process entry — ${binRel}/ must hold exactly ${CLI_BIN_ENTRY_FILE} (docs/reference/cli.md, "Import-inert modules").`,
  }));
  if (!entries.includes(CLI_BIN_ENTRY_FILE)) {
    problems.push({
      file: `${binRel}/${CLI_BIN_ENTRY_FILE}`,
      message: `${binRel}/${CLI_BIN_ENTRY_FILE} is missing — it is the CLI's only process entry.`,
    });
  }
  return problems;
}

/**
 * Reverse check: no `scripts/*` package depends on the CLI. ADR-0029 runs the
 * dependency arrow scripts <- CLI; U7 will make the CLI depend on the script
 * packages, so pinning the direction before that lands is cheap.
 *
 * @param {string} root repo root
 * @returns {{ file: string, message: string }[]}
 */
export function scriptsDependingOnCliErrors(root) {
  const problems = [];
  for (const name of scriptPackageDirs(root)) {
    const manifestRel = `scripts/${name}/package.json`;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, manifestRel), "utf8"));
    } catch (cause) {
      problems.push({
        file: manifestRel,
        message: `${manifestRel} is not valid JSON: ${cause}`,
      });
      continue;
    }
    const declared = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    if (CLI_PACKAGE_NAME in declared) {
      problems.push({
        file: manifestRel,
        message: `${manifestRel} depends on ${CLI_PACKAGE_NAME} — the dependency direction is scripts <- CLI, never the reverse (ADR-0029).`,
      });
    }
  }
  return problems;
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const root = repoRoot(import.meta.url);

  let errors = 0;
  function report(message, file) {
    reporter.error(message, file ? { file } : undefined);
    errors++;
  }

  const packageDir = join(root, CLI_PACKAGE_DIR);
  if (!existsSync(packageDir)) {
    // No vacuous pass: there is exactly one CLI package and its absence is
    // itself the failure.
    report(
      `${CLI_PACKAGE_DIR}/ does not exist — the CLI package is a fixed part of this workspace (ADR-0053).`,
      CLI_PACKAGE_DIR,
    );
  } else {
    for (const file of CLI_REQUIRED_EXACT_FILES) {
      if (!existsSync(join(packageDir, file))) {
        report(
          `${CLI_PACKAGE_DIR}/${file} is missing (docs/contributing/cli-structure.md §Package structure).`,
          `${CLI_PACKAGE_DIR}/${file}`,
        );
      }
    }

    for (const { dir, suffix, what } of CLI_REQUIRED_GLOBS) {
      let matches = [];
      try {
        matches = readdirSync(join(packageDir, dir)).filter((file) =>
          file.endsWith(suffix),
        );
      } catch {
        // Missing directory -> handled by the empty-matches report below.
      }
      if (matches.length === 0) {
        report(
          `${CLI_PACKAGE_DIR}/${dir}/ has no ${suffix} file — ${what} is required.`,
          `${CLI_PACKAGE_DIR}/${dir}`,
        );
      }
    }

    const manifestRel = `${CLI_PACKAGE_DIR}/package.json`;
    const manifestPath = join(packageDir, "package.json");
    if (existsSync(manifestPath)) {
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (cause) {
        report(`${manifestRel} is not valid JSON: ${cause}`, manifestRel);
      }
      if (pkg) {
        for (const problem of cliPackageManifestErrors(pkg)) {
          report(`${manifestRel}: ${problem}`, manifestRel);
        }
      }
    }

    for (const which of ["tsconfig.json", "tsconfig.build.json"]) {
      const tsconfigRel = `${CLI_PACKAGE_DIR}/${which}`;
      const tsconfigPath = join(packageDir, which);
      if (!existsSync(tsconfigPath)) continue; // reported above
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      } catch (cause) {
        report(`${tsconfigRel} is not valid JSON: ${cause}`, tsconfigRel);
        continue;
      }
      for (const problem of cliTsconfigErrors(parsed, which)) {
        report(`${tsconfigRel}: ${problem}`, tsconfigRel);
      }
    }

    for (const { file, message } of cliSrcLayoutErrors(root)) {
      report(message, file);
    }
    for (const { file, message } of cliBinEntryErrors(root)) {
      report(message, file);
    }
  }

  for (const { file, message } of scriptsDependingOnCliErrors(root)) {
    report(message, file);
  }

  if (errors > 0) {
    if (!json) {
      console.error(
        `\n✗  ${errors} CLI-scaffold mismatch(es). The shape is specified in docs/contributing/cli-structure.md (ADR-0053).`,
      );
    }
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(`${CLI_PACKAGE_DIR} conforms to the CLI package shape.`);
  reporter.finish();
}
