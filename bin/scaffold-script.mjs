#!/usr/bin/env node
// Thin delegate onto the CLI-owned generator (ADR-0053 U9): scaffolding for
// a new consumer-script package under scripts/<name>/ now lives in
// packages/m3l-cli/src/scaffold/generate.ts (also reachable as `m3l new`).
// This script keeps `pnpm scaffold:script` working exactly as before —
// argv parsing, reporter-driven output, and the "Next steps" block are all
// unchanged — but delegates the actual validation/emission to the built CLI,
// so there is exactly one implementation for both entry points to drift from.
//
// Usage:
//   pnpm scaffold:script <name> [--purpose "<one-line purpose>"] [--variant <cli|lambda>] [--dry-run] [--force]
//   node bin/scaffold-script.mjs data-sync --purpose "Sync S3 exports to Dynamo"
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { docPagePath } from "./lib/script-scaffold.mjs";
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
let variant = "cli";
const variantFlag = args.indexOf("--variant");
if (variantFlag !== -1) {
  variant = args[variantFlag + 1] ?? "";
}
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const dryRunNote = "(dry-run — not written)";

if (!name || name.startsWith("--")) {
  fail(
    'Usage: pnpm scaffold:script <name> [--purpose "<one-line purpose>"] [--variant <cli|lambda>] [--dry-run] [--force] — <name> is required.',
  );
}

// --- Delegate to the CLI-owned generator --------------------------------------
// A dynamic import (not a static one) so a missing build fails with THIS
// script's own clear message rather than Node's raw ERR_MODULE_NOT_FOUND.
let generateScript;
try {
  ({ generateScript } =
    await import("../packages/m3l-cli/dist/scaffold/generate.js"));
} catch (cause) {
  fail(
    `packages/m3l-cli is not built — run \`pnpm build\` first (scaffolding now lives in the CLI, ADR-0053 U9): ${cause}`,
  );
}

if (dryRun) {
  reporter.info("--dry-run: rendering every file, writing nothing.");
}

let result;
try {
  result = generateScript({
    workspaceRoot: root,
    name,
    purpose,
    variant,
    dryRun,
    force,
  });
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause));
}

for (const change of result.changes) {
  reporter.change(change.action, change.path, dryRun ? dryRunNote : undefined);
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
