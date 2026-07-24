#!/usr/bin/env node
// Verifies bin/lib/command-catalog.mjs's COMMAND_CATALOG has exactly one row
// per `package.json` `scripts` entry, and vice versa — the non-drift gate
// for `pnpm commands` (bin/list-commands.mjs), so a script added or removed
// from `package.json` can't silently leave the catalog out of sync.
//
// This checks STRUCTURE only (every name present in both, in both
// directions) — whether a description's prose is still accurate after the
// script it describes changes behavior is a review-time concern, not a
// machine-checkable one.
//
// Usage:
//   node bin/check-command-catalog.mjs   # exits 0 on success, 1 on any drift
import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCommandCatalogDiff } from "./lib/command-catalog.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { json } = parseJsonFlag();
const reporter = createReporter(json);

const { scripts } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const { missingFromCatalog, staleInCatalog } =
  deriveCommandCatalogDiff(scripts);

for (const name of missingFromCatalog) {
  reporter.error(
    `"${name}" is a package.json script with no bin/lib/command-catalog.mjs entry. Add a { name: "${name}", description: "..." } row.`,
  );
}
for (const name of staleInCatalog) {
  reporter.error(
    `"${name}" has a bin/lib/command-catalog.mjs entry but package.json no longer defines it. Remove its row.`,
  );
}

if (missingFromCatalog.length > 0 || staleInCatalog.length > 0) {
  reporter.finish({
    missingFromCatalog,
    staleInCatalog,
  });
  process.exit(1);
}

reporter.succeed(
  `Command catalog matches package.json: ${Object.keys(scripts).length} script(s) verified.`,
);
reporter.finish({ missingFromCatalog, staleInCatalog });
