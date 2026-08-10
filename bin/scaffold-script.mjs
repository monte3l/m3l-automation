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
//   pnpm scaffold:script <name> [--purpose "<one-line purpose>"] [--dry-run] [--force]
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
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json, argv } = parseJsonFlag();
const reporter = createReporter(json);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  reporter.error(message);
  reporter.finish();
  process.exit(1);
}

// --- Parse arguments ---------------------------------------------------------
const args = argv;
const name = args[0];
let purpose = "TODO: describe what this automation does.";
const purposeFlag = args.indexOf("--purpose");
if (purposeFlag !== -1) {
  purpose = args[purposeFlag + 1] ?? "";
}
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const dryRunNote = "(dry-run — not written)";

if (!name || name.startsWith("--")) {
  fail(
    'Usage: pnpm scaffold:script <name> [--purpose "<one-line purpose>"] [--dry-run] [--force] — <name> is required.',
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
// Tracked so a failure mid-run rolls back only what THIS run created — a
// blanket recursive removal is safe when the package dir is entirely new
// (guarded below for the non-force path), but under --force onto a
// pre-existing scripts/<name>/ it would delete content this run never wrote.
const packageDirPreexisted = existsSync(packageDir);
const docPagePreexisted = existsSync(docPage);

if (packageDirPreexisted && !force) {
  fail(
    `scripts/${name}/ already exists — implement or edit it directly instead of re-scaffolding, or pass --force to overwrite the generated files.`,
  );
}
if (docPagePreexisted && !force) {
  fail(
    `${docPagePath(name)} already exists — remove or rename it first, or pass --force to overwrite it.`,
  );
}
if (force && (packageDirPreexisted || docPagePreexisted)) {
  reporter.info(
    `--force: overwriting the manifest's known files under scripts/${name}/` +
      (docPagePreexisted ? ` and ${docPagePath(name)}` : "") +
      " — anything else already there is left untouched, and a failure mid-run will NOT be rolled back (see the atomic-rollback note in bin/scaffold-script.mjs).",
  );
}
if (dryRun) {
  reporter.info("--dry-run: rendering every file, writing nothing.");
}

// --- Emit files (prettier-formatted so format:check stays green) -------------
const tokens = scriptTokens(name, purpose);

/**
 * Render a template through token substitution + Prettier, and — unless
 * `dryRun` — write it to `absoluteTarget`. Always renders (even in dry-run)
 * so a genuine template/token error (e.g. substituteTokens' unreplaced-token
 * guard) still surfaces during a preview, not just on a real run.
 */
async function emit(templateRel, absoluteTarget) {
  const raw = readFileSync(join(root, TEMPLATE_DIR, templateRel), "utf8");
  const substituted = substituteTokens(raw, tokens);
  const prettierOptions = await resolveConfig(absoluteTarget);
  const formatted = await format(substituted, {
    ...prettierOptions,
    filepath: absoluteTarget,
  });
  if (!dryRun) {
    mkdirSync(dirname(absoluteTarget), { recursive: true });
    writeFileSync(absoluteTarget, formatted);
  }
}

// Atomic emission: on ANY failure, remove everything this run created — but
// only when the target didn't already exist before this run (the default,
// non---force path: neither target existed, guarded above). Under --force
// onto a pre-existing scripts/<name>/, a blanket rm would delete content this
// run never wrote, so that combination deliberately does not roll back (see
// the --force notice above).
try {
  for (const { template, target } of PACKAGE_TEMPLATE_FILES) {
    const resolvedTarget = substituteTokens(target, tokens);
    await emit(template, join(packageDir, resolvedTarget));
    reporter.change(
      "created",
      `scripts/${name}/${resolvedTarget}`,
      dryRun ? dryRunNote : undefined,
    );
  }
  await emit(DOC_PAGE_TEMPLATE, docPage);
  reporter.change(
    "created",
    docPagePath(name),
    dryRun ? dryRunNote : undefined,
  );
} catch (cause) {
  if (!packageDirPreexisted)
    rmSync(packageDir, { recursive: true, force: true });
  if (!docPagePreexisted) rmSync(docPage, { force: true });
  reporter.error(
    `Scaffold failed${packageDirPreexisted || docPagePreexisted ? " (--force target predates this run — NOT rolled back)" : " and was rolled back (scripts/" + name + "/ removed)"}: ${cause}`,
  );
  reporter.finish({ scriptName: name });
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
  if (dryRun) {
    reporter.change(
      "updated",
      "tsconfig.json",
      `references ${ref} ${dryRunNote}`,
    );
  } else {
    rootTsconfig.references = references;
    const prettierOptions = await resolveConfig(rootTsconfigPath);
    writeFileSync(
      rootTsconfigPath,
      await format(JSON.stringify(rootTsconfig), {
        ...prettierOptions,
        filepath: rootTsconfigPath,
      }),
    );
    reporter.change("updated", "tsconfig.json", `references ${ref}`);
  }
}

reporter.succeed(
  dryRun
    ? `Dry run complete for scripts/${name}/ — nothing was written.`
    : `Scaffold complete for scripts/${name}/.`,
);
if (!dryRun) {
  reporter.info(`
Next steps:
  1. pnpm install                                # workspace glob picks up the package
  2. pnpm build                                  # turbo builds m3l-common first
  3. pnpm --filter @m3l-automation/${name} start # smoke run
  4. Fill in scripts/${name}/README.md (how to run) and
     ${docPagePath(name)} (the contract) — the generated
     README's Examples section starts as a placeholder that
     pnpm check:script-scaffold rejects until it's filled in.
  5. pnpm check:script-scaffold                  # conformance backstop, run last
  6. Hand off implementation to the implementing-scripts pipeline.`);
}
reporter.finish({ scriptName: name });
