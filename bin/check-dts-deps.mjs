#!/usr/bin/env node
/**
 * Published-declaration dependency gate — every module specifier that survives
 * into an emitted `.d.ts` must be resolvable, with types, by a consumer who
 * installed nothing but `@m3l-automation/m3l-common` and its declared
 * `dependencies`/`peerDependencies`.
 *
 * The leak this catches: a public type alias over a third-party type
 * (`export type M3LSqliteDatabase = BetterSqlite3.Database`) puts
 * `import ... from "better-sqlite3"` into the shipped `.d.ts`. When that
 * package carries no declarations of its own, the alias resolves only through
 * `@types/better-sqlite3` — and if THAT sits in `devDependencies`, every
 * consumer gets `Could not find a declaration file for module
 * 'better-sqlite3'` (issue #798). Nothing else sees it: `publint` and
 * `attw --profile esm-only` validate the `exports` map's shape, `check:api`
 * tracks the public surface, and `check:doc-exports` tracks documentation —
 * none of them resolves a declaration's imports against the manifest.
 *
 * A type-only import inside `src/` that never reaches a `.d.ts` is genuinely
 * internal and stays out of scope: the five optional text-extraction peers
 * (`unpdf`, `adm-zip`, `mailparser`, `cheerio`, `mammoth`) are type-imported
 * in `src/core/text/*.ts` and correctly emit nothing. Reading `dist/` rather
 * than `src/` is what makes the distinction — hence the `build` dependency.
 *
 * Exit codes:
 *   0  Every `.d.ts` specifier (and every required `@types/*` counterpart) is
 *      declared in `dependencies` or `peerDependencies`.
 *   1  One or more specifiers are undeclared or types-only-in-devDependencies.
 *
 * Usage:
 *   node bin/check-dts-deps.mjs
 *   pnpm check:dts-deps
 */
import process from "node:process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

/** The published package this gate governs — the only one with an `exports` map. */
const LIB_DIR = join("packages", "m3l-common");

/**
 * Strip block comments — the form TSDoc uses, and the only form whose contents
 * are never load-bearing. `dist/aws/**` is full of
 * `* import { X } from "@m3l-automation/m3l-common/aws";` `@example` lines,
 * which would otherwise register as a self-referential dependency.
 *
 * @param {string} source contents of a `.d.ts` file
 * @returns {string} the same source with block comments removed
 */
export function stripBlockComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Strip every comment. Block comments go first, so a `//` sequence inside one
 * cannot terminate a line-comment match early.
 *
 * Deliberately NOT applied before scanning for `/// <reference types="…" />`:
 * that directive is itself a line comment, and stripping it would erase the
 * one comment in a `.d.ts` that genuinely declares a dependency. See
 * {@link extractDtsSpecifiers}.
 *
 * @param {string} source contents of a `.d.ts` file
 * @returns {string} the same source with comments removed
 */
export function stripComments(source) {
  return stripBlockComments(source).replaceAll(/\/\/.*$/gm, "");
}

/**
 * Every form a module specifier can take in real declaration code:
 * `import`/`export … from "x"`, a bare side-effect `import "x"`, and an inline
 * `import("x")` type reference. Each captures the specifier in its only group.
 */
const CODE_PATTERNS = [
  /(?:^|[\s;}])(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  /(?:^|[\s;}])import\s*["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** The `/// <reference types="x" />` directive — a line comment that declares a dependency. */
const REFERENCE_PATTERN = /\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/g;

/**
 * Extract the bare (non-relative, non-builtin) module specifiers a declaration
 * file depends on. Relative specifiers resolve inside the package and `node:`
 * builtins need no declaration, so both are dropped.
 *
 * Two passes over two different views of the source, because the two kinds of
 * dependency live on opposite sides of the comment boundary: real imports are
 * code (scanned with all comments stripped), while `/// <reference types>` is
 * a line comment (scanned with only block comments stripped, so a directive
 * quoted inside a TSDoc `@example` still doesn't count).
 *
 * @param {string} source contents of a `.d.ts` file
 * @returns {string[]} unique specifiers, sorted
 */
export function extractDtsSpecifiers(source) {
  /** @type {Set<string>} */
  const found = new Set();

  const add = (/** @type {string | undefined} */ specifier) => {
    if (specifier === undefined) return;
    if (specifier.startsWith(".")) return;
    if (specifier.startsWith("node:")) return;
    found.add(specifier);
  };

  const code = stripComments(source);
  for (const pattern of CODE_PATTERNS) {
    for (const match of code.matchAll(pattern)) add(match[1]);
  }
  for (const match of stripBlockComments(source).matchAll(REFERENCE_PATTERN)) {
    add(match[1]);
  }

  return [...found].sort();
}

/**
 * Reduce a specifier to the package it resolves from — `@scope/pkg/sub` →
 * `@scope/pkg`, `pkg/sub/deep` → `pkg`. A deep import is satisfied by the same
 * manifest entry as the package root, so the gate reasons about package names.
 *
 * @param {string} specifier a bare module specifier
 * @returns {string} the package name
 */
export function packageNameFromSpecifier(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : /** @type {string} */ (segments[0]);
}

/**
 * The DefinitelyTyped counterpart of a package name, applying the documented
 * scope mangling: `@scope/pkg` → `@types/scope__pkg`, `pkg` → `@types/pkg`.
 *
 * @param {string} packageName
 * @returns {string}
 */
export function typesPackageFor(packageName) {
  if (packageName.startsWith("@types/")) return packageName;
  const mangled = packageName.startsWith("@")
    ? packageName.slice(1).replace("/", "__")
    : packageName;
  return `@types/${mangled}`;
}

/**
 * Whether a package's own manifest advertises TypeScript declarations —
 * a top-level `types`/`typings` field, or a `types` condition anywhere in its
 * `exports` map (the modern way to ship them per-subpath).
 *
 * @param {Record<string, unknown>} pkg a parsed `package.json`
 * @returns {boolean}
 */
export function declaresTypes(pkg) {
  if (typeof pkg.types === "string" || typeof pkg.typings === "string")
    return true;
  return hasTypesCondition(pkg.exports);
}

/**
 * Recursive search for a `types` condition key inside an `exports` map.
 *
 * @param {unknown} node an `exports` map or any nested subtree of one
 * @returns {boolean}
 */
function hasTypesCondition(node) {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasTypesCondition);
  for (const [key, value] of Object.entries(node)) {
    if (key === "types") return true;
    if (hasTypesCondition(value)) return true;
  }
  return false;
}

/**
 * The names a consumer must be able to resolve for one `.d.ts` specifier:
 * always the specifier's own package, plus its `@types/*` counterpart when the
 * package ships no declarations of its own.
 *
 * `shipsOwnTypes` is supplied by the caller (it needs disk access — see
 * {@link inspectTypeSupport}), keeping this function pure.
 *
 * @param {string} packageName
 * @param {boolean} shipsOwnTypes
 * @returns {{ name: string, isTypesCounterpart: boolean }[]}
 */
export function requiredDeclarations(packageName, shipsOwnTypes) {
  const required = [{ name: packageName, isTypesCounterpart: false }];
  if (!shipsOwnTypes) {
    required.push({
      name: typesPackageFor(packageName),
      isTypesCounterpart: true,
    });
  }
  return required;
}

/**
 * The gate's whole judgement, as a pure function over already-gathered facts.
 *
 * A name is satisfied when it appears in `dependencies` or
 * `peerDependencies` — an optional peer counts, because a consumer who uses
 * the type has installed the peer. A `devDependencies`-only declaration is the
 * failure this gate exists for: it type-checks in-repo and breaks on install.
 * The package's own name is always satisfied (a self-reference through the
 * `exports` map, not a dependency).
 *
 * @param {{ file: string, specifier: string, packageName: string, shipsOwnTypes: boolean }[]} imports
 *   one entry per (declaration file, specifier) pair
 * @param {{ dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, devDependencies?: Record<string, string>, name?: string }} pkg
 *   the published package's manifest
 * @returns {{ file: string, specifier: string, missing: string, reason: string }[]}
 *   violations, deduplicated by (missing name, specifier) and sorted by file
 */
export function findUndeclaredDtsDeps(imports, pkg) {
  const runtime = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
  const selfName = pkg.name;

  /** @type {Map<string, { file: string, specifier: string, missing: string, reason: string }>} */
  const violations = new Map();

  for (const entry of imports) {
    if (entry.packageName === selfName) continue;
    for (const required of requiredDeclarations(
      entry.packageName,
      entry.shipsOwnTypes,
    )) {
      if (runtime.has(required.name)) continue;
      const key = `${required.name} ${entry.specifier}`;
      if (violations.has(key)) continue;
      violations.set(key, {
        file: entry.file,
        specifier: entry.specifier,
        missing: required.name,
        reason: buildReason(required, entry, dev.has(required.name)),
      });
    }
  }

  return [...violations.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.missing.localeCompare(b.missing),
  );
}

/**
 * The human-readable explanation attached to one violation.
 *
 * @param {{ name: string, isTypesCounterpart: boolean }} required
 * @param {{ specifier: string, packageName: string }} entry
 * @param {boolean} inDev whether the missing name sits in `devDependencies`
 * @returns {string}
 */
function buildReason(required, entry, inDev) {
  const where = inDev
    ? "declared only in devDependencies"
    : "not declared at all";
  return required.isTypesCounterpart
    ? `\`${entry.packageName}\` ships no type declarations, so \`${required.name}\` is what types this import — but it is ${where}`
    : `\`${required.name}\` is imported by a published declaration but is ${where}`;
}

/**
 * Recursively collect every `.d.ts` under a directory, as repo-relative paths
 * with forward slashes (stable across platforms and directly quotable in an
 * error message).
 *
 * @param {string} dir absolute directory to walk
 * @param {string} repoRootDir absolute repo root, for relativising
 * @returns {string[]} sorted repo-relative paths
 */
function collectDeclarationFiles(dir, repoRootDir) {
  /** @type {string[]} */
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    files.push(
      relative(repoRootDir, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    );
  }
  return files.sort();
}

/**
 * Report whether a package ships TypeScript declarations, resolving its
 * manifest from the published package's directory via
 * {@link resolveManifestPath}.
 *
 * Unresolvable packages are reported as shipping their own types: the gate's
 * job is dependency declaration, not install-tree health, and an optional peer
 * that is genuinely not installed must not be misreported as needing
 * `@types/*`.
 *
 * @param {string} packageName
 * @param {string} fromDir absolute directory to resolve from
 * @returns {{ shipsOwnTypes: boolean, resolved: boolean }}
 */
function inspectTypeSupport(packageName, fromDir) {
  const manifestPath = resolveManifestPath(packageName, fromDir);
  if (manifestPath === null) return { shipsOwnTypes: true, resolved: false };

  /** @type {Record<string, unknown>} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { shipsOwnTypes: true, resolved: false };
  }

  if (declaresTypes(pkg)) return { shipsOwnTypes: true, resolved: true };

  // No manifest field — a package may still ship an adjacent `index.d.ts`
  // that classic node resolution picks up beside its `main` entry.
  const packageDir = dirname(manifestPath);
  const main = typeof pkg.main === "string" ? pkg.main : "index.js";
  const adjacent = [
    join(packageDir, "index.d.ts"),
    join(packageDir, main.replace(/\.[cm]?js$/, ".d.ts")),
  ];
  const shipsOwnTypes = adjacent.some((candidate) => existsSync(candidate));
  return { shipsOwnTypes, resolved: true };
}

/**
 * Locate a package's own `package.json`, preferring real module resolution and
 * falling back to a `node_modules` walk for packages whose `exports` map does
 * not expose `./package.json` (legal, and common in older packages).
 *
 * @param {string} packageName
 * @param {string} fromDir absolute directory to resolve from
 * @returns {string | null} absolute path, or `null` when unresolvable
 */
function resolveManifestPath(packageName, fromDir) {
  const require = createRequire(join(fromDir, "noop.js"));
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    return findManifestByWalk(packageName, fromDir);
  }
}

/**
 * Locate a package's `package.json` by walking `node_modules` directories up
 * from a starting point — the fallback {@link resolveManifestPath} uses when
 * the package does not export `./package.json`.
 *
 * @param {string} packageName
 * @param {string} fromDir absolute directory to start from
 * @returns {string | null}
 */
function findManifestByWalk(packageName, fromDir) {
  let current = fromDir;
  for (;;) {
    const candidate = join(
      current,
      "node_modules",
      packageName,
      "package.json",
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const libDirAbs = join(root, LIB_DIR);
  const libPkgRel = `${LIB_DIR}/package.json`.split(sep).join("/");
  const distDir = join(libDirAbs, "dist");

  /** @type {Record<string, unknown>} */
  let libPkg;
  try {
    libPkg = JSON.parse(readFileSync(join(libDirAbs, "package.json"), "utf8"));
  } catch (err) {
    reporter.error(
      `check:dts-deps: could not read/parse ${libPkgRel}. (${/** @type {Error} */ (err).message})`,
      { file: libPkgRel },
    );
    reporter.finish();
    process.exit(1);
  }

  const declarationFiles = collectDeclarationFiles(distDir, root);
  if (declarationFiles.length === 0) {
    reporter.error(
      `check:dts-deps: no .d.ts files under ${LIB_DIR}/dist — run \`pnpm build\` first. ` +
        "This gate reads the BUILT declarations, not src/.",
      { file: libPkgRel },
    );
    reporter.finish();
    process.exit(1);
  }

  // One disk probe per package name, not per import site — the AWS SDK clients
  // alone appear in dozens of declaration files.
  /** @type {Map<string, { shipsOwnTypes: boolean, resolved: boolean }>} */
  const typeSupport = new Map();
  /** @type {{ file: string, specifier: string, packageName: string, shipsOwnTypes: boolean }[]} */
  const imports = [];

  for (const file of declarationFiles) {
    const source = readFileSync(join(root, file), "utf8");
    for (const specifier of extractDtsSpecifiers(source)) {
      const packageName = packageNameFromSpecifier(specifier);
      let support = typeSupport.get(packageName);
      if (support === undefined) {
        support = inspectTypeSupport(packageName, libDirAbs);
        typeSupport.set(packageName, support);
      }
      imports.push({
        file,
        specifier,
        packageName,
        shipsOwnTypes: support.shipsOwnTypes,
      });
    }
  }

  const violations = findUndeclaredDtsDeps(imports, libPkg);

  if (violations.length > 0) {
    for (const violation of violations) {
      reporter.error(
        `${violation.file}: imports \`${violation.specifier}\` — ${violation.reason}. ` +
          `Move \`${violation.missing}\` into ${LIB_DIR}'s \`dependencies\` (exact-pinned, ADR-0017) ` +
          "or stop exposing the type in a published declaration.",
        { file: violation.file },
      );
    }
    if (!json) {
      console.error(
        `\ncheck:dts-deps — ${violations.length} published declaration(s) reference a package a ` +
          "consumer cannot resolve. Every specifier surviving into dist/**/*.d.ts must be in " +
          "`dependencies` or `peerDependencies`, with types.",
      );
    }
    reporter.finish({
      declarationFiles: declarationFiles.length,
      specifiers: [...new Set(imports.map((i) => i.packageName))].sort(),
    });
    process.exit(1);
  }

  const distinct = [...new Set(imports.map((i) => i.packageName))].sort();
  reporter.succeed(
    `check:dts-deps — ${declarationFiles.length} declaration file(s), ` +
      `${distinct.length} external package(s), all declared with types.`,
  );
  reporter.finish({
    declarationFiles: declarationFiles.length,
    specifiers: distinct,
  });
  process.exit(0);
}
