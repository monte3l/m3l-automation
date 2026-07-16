#!/usr/bin/env node
// Deterministic generator for a new consumer-script package under
// scripts/<name>/ (ADR-0022 fleet conventions). Emits every file from
// templates/script/ with token substitution, creates the script's contract
// page under docs/reference/scripts/, and inserts the root tsconfig project
// reference — the three manual steps that used to be hand-typed from the
// scaffolding-scripts skill and could drift between runs.
//
// Pure file emission: no install, no build, no network. The skill (or the
// user) runs `pnpm install` / `pnpm build` / the smoke run afterwards.
// bin/check-script-scaffold.mjs verifies the same shape from the shared
// manifest (bin/lib/script-scaffold.mjs), so generator and checker cannot
// drift apart.
//
// Usage:
//   pnpm scaffold:script <name> [--purpose "<one-line purpose>"]
//   node bin/scaffold-script.mjs data-sync --purpose "Sync S3 exports to Dynamo"
import process from "node:process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { format, resolveConfig } from "prettier";
import {
  DOC_PAGE_TEMPLATE,
  PACKAGE_TEMPLATE_FILES,
  SCRIPT_NAME_RE,
  TEMPLATE_DIR,
  docPagePath,
  purposeErrors,
  rootTsconfigRef,
  scriptTokens,
  serviceNameErrors,
  substituteTokens,
} from "./lib/script-scaffold.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`✗  ${message}`);
  process.exit(1);
}

// --- Parse arguments ---------------------------------------------------------
const args = process.argv.slice(2);
const name = args[0];
let purpose = "TODO: describe what this automation does.";
const purposeFlag = args.indexOf("--purpose");
if (purposeFlag !== -1) {
  purpose = args[purposeFlag + 1] ?? "";
}

if (!name || name.startsWith("--")) {
  fail(
    'Usage: pnpm scaffold:script <name> [--purpose "<one-line purpose>"] — <name> is required.',
  );
}
if (!SCRIPT_NAME_RE.test(name)) {
  fail(
    `Script name "${name}" must be kebab-case ([a-z0-9] segments separated by "-").`,
  );
}
for (const problem of serviceNameErrors(name)) {
  fail(problem);
}
for (const problem of purposeErrors(purpose)) {
  fail(problem);
}

const packageDir = join(root, "scripts", name);
const docPage = join(root, docPagePath(name));
if (existsSync(packageDir)) {
  fail(
    `scripts/${name}/ already exists — implement or edit it directly instead of re-scaffolding.`,
  );
}
if (existsSync(docPage)) {
  fail(`${docPagePath(name)} already exists — remove or rename it first.`);
}

// --- Emit files (prettier-formatted so format:check stays green) -------------
const tokens = scriptTokens(name, purpose);

async function emit(templateRel, absoluteTarget) {
  const raw = readFileSync(join(root, TEMPLATE_DIR, templateRel), "utf8");
  const substituted = substituteTokens(raw, tokens);
  const prettierOptions = await resolveConfig(absoluteTarget);
  const formatted = await format(substituted, {
    ...prettierOptions,
    filepath: absoluteTarget,
  });
  mkdirSync(dirname(absoluteTarget), { recursive: true });
  writeFileSync(absoluteTarget, formatted);
}

// Atomic emission: neither target existed (guarded above), so on ANY failure
// remove everything this run created — a half-scaffolded scripts/<name>/
// would otherwise permanently trip the duplicate-guard on retry.
try {
  for (const { template, target } of PACKAGE_TEMPLATE_FILES) {
    const resolvedTarget = substituteTokens(target, tokens);
    await emit(template, join(packageDir, resolvedTarget));
    console.log(`✓  scripts/${name}/${resolvedTarget}`);
  }
  await emit(DOC_PAGE_TEMPLATE, docPage);
  console.log(`✓  ${docPagePath(name)}`);
} catch (cause) {
  rmSync(packageDir, { recursive: true, force: true });
  rmSync(docPage, { force: true });
  console.error(
    `✗  Scaffold failed and was rolled back (scripts/${name}/ removed): ${cause}`,
  );
  process.exit(1);
}

// --- Wire the root tsconfig project reference (sorted, idempotent) -----------
const rootTsconfigPath = join(root, "tsconfig.json");
const rootTsconfig = JSON.parse(readFileSync(rootTsconfigPath, "utf8"));
const ref = rootTsconfigRef(name);
const references = rootTsconfig.references ?? [];
if (!references.some((entry) => entry.path === ref)) {
  references.push({ path: ref });
  references.sort((a, b) => a.path.localeCompare(b.path));
  rootTsconfig.references = references;
  const prettierOptions = await resolveConfig(rootTsconfigPath);
  writeFileSync(
    rootTsconfigPath,
    await format(JSON.stringify(rootTsconfig), {
      ...prettierOptions,
      filepath: rootTsconfigPath,
    }),
  );
  console.log(`✓  tsconfig.json references ${ref}`);
}

console.log(`
Scaffold complete. Next steps:
  1. pnpm install                                # workspace glob picks up the package
  2. pnpm build                                  # turbo builds m3l-common first
  3. pnpm --filter @m3l-automation/${name} start # smoke run
  4. pnpm check:script-scaffold                  # conformance backstop
  5. Fill in scripts/${name}/README.md (how to run) and
     ${docPagePath(name)} (the contract), then hand off
     implementation to the implementing-scripts pipeline.`);
