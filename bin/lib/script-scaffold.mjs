// The single source of truth for the consumer-script scaffold shape
// (ADR-0022 fleet conventions). Both the generator (bin/scaffold-script.mjs)
// and the conformance checker (bin/check-script-scaffold.mjs) consume this
// manifest, so the two cannot drift apart: a file added here is emitted by
// the generator AND required by the checker in the same change.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Kebab-case script names only: `data-sync`, `report-builder`, `probe`. */
export const SCRIPT_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Directory (repo-relative) holding the *.tmpl sources. */
export const TEMPLATE_DIR = "templates/script";

/** Directory (repo-relative) holding one contract page per script. */
export const SCRIPT_DOCS_DIR = "docs/reference/scripts";

/** `data-sync` → `DataSync` (for generated identifiers like `runDataSync`). */
export function pascalCase(name) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * The substitution map applied to template content AND target paths.
 * Every `__TOKEN__` used by any file under templates/script/ must be here.
 */
export function scriptTokens(name, purpose) {
  return {
    __SCRIPT_NAME__: name,
    __SCRIPT_NAME_PASCAL__: pascalCase(name),
    __PURPOSE__: purpose,
  };
}

/** Replace every known token in `text`. */
export function substituteTokens(text, tokens) {
  let result = text;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.replaceAll(token, value);
  }
  return result;
}

/**
 * Template → target pairs emitted inside `scripts/<name>/`. Targets may carry
 * tokens (resolved with the same map as the content).
 */
export const PACKAGE_TEMPLATE_FILES = [
  { template: "package.json.tmpl", target: "package.json" },
  { template: "tsconfig.json.tmpl", target: "tsconfig.json" },
  { template: "tsconfig.build.json.tmpl", target: "tsconfig.build.json" },
  { template: "src/main.ts.tmpl", target: "src/main.ts" },
  { template: "src/config.ts.tmpl", target: "src/config.ts" },
  { template: "src/hooks.ts.tmpl", target: "src/hooks.ts" },
  {
    template: "src/steps/run-__SCRIPT_NAME__.ts.tmpl",
    target: "src/steps/run-__SCRIPT_NAME__.ts",
  },
  { template: "tests/config.test.ts.tmpl", target: "tests/config.test.ts" },
  { template: "README.md.tmpl", target: "README.md" },
];

/** The contract page emitted outside the package dir. */
export const DOC_PAGE_TEMPLATE = "docs-page.md.tmpl";

/** Repo-relative path of a script's contract page. */
export function docPagePath(name) {
  return `${SCRIPT_DOCS_DIR}/${name}.md`;
}

/**
 * Files the checker requires by exact path inside `scripts/<name>/`.
 * (The starter step and smoke test are required via REQUIRED_GLOBS instead,
 * so a script may rename/extend them without a false positive.)
 */
export const REQUIRED_EXACT_FILES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "src/main.ts",
  "src/config.ts",
  "src/hooks.ts",
  "README.md",
];

/**
 * Directory/suffix pairs of which at least one match must exist:
 * business logic lives in steps modules, and ADR-0022 §8 mandates at least a
 * config-declaration smoke test.
 */
export const REQUIRED_GLOBS = [
  { dir: "src/steps", suffix: ".ts", what: "a steps/ module" },
  { dir: "tests", suffix: ".test.ts", what: "the config smoke test" },
];

/** The root tsconfig `references` entry a script package must have. */
export function rootTsconfigRef(name) {
  return `./scripts/${name}/tsconfig.build.json`;
}

/**
 * Validate a script's package.json against the ADR-0022 package contract.
 * Returns human-readable problem strings (empty array = conformant).
 */
export function packageManifestErrors(pkg, name) {
  const problems = [];
  if (pkg.name !== `@m3l-automation/${name}`) {
    problems.push(
      `"name" must be "@m3l-automation/${name}" (got ${JSON.stringify(pkg.name)})`,
    );
  }
  if (pkg.private !== true) {
    problems.push(`"private" must be true (scripts are never published)`);
  }
  if (pkg.type !== "module") {
    problems.push(`"type" must be "module" (ESM only)`);
  }
  if (!/>=\s*24/.test(pkg.engines?.node ?? "")) {
    problems.push(`"engines.node" must declare ">=24"`);
  }
  if (pkg.dependencies?.["@m3l-automation/m3l-common"] !== "workspace:*") {
    problems.push(
      `dependencies must include "@m3l-automation/m3l-common": "workspace:*"`,
    );
  }
  for (const script of ["build", "typecheck", "start"]) {
    if (typeof pkg.scripts?.[script] !== "string" || !pkg.scripts[script]) {
      problems.push(`"scripts.${script}" must be declared`);
    }
  }
  return problems;
}

/**
 * Directory names under `scripts/` that contain a package.json — the set of
 * script packages the checker validates. Artifact-only ghosts (a leftover
 * dist/ with no manifest) are ignored.
 */
export function scriptPackageDirs(root) {
  const scriptsDir = join(root, "scripts");
  if (!existsSync(scriptsDir)) {
    return [];
  }
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(scriptsDir, name, "package.json")));
}
