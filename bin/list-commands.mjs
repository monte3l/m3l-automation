#!/usr/bin/env node
// Lists every `package.json` `scripts` entry, grouped by family, with a short
// description of its scope and intended usage — the discovery complement to
// CLAUDE.md's terse "the full list is in package.json scripts" pointer.
//
// The description text is hand-authored in bin/lib/command-catalog.mjs (this
// script is a thin reader over that pure module); a script with no catalog
// entry still prints (falling back to its raw command string, flagged with a
// warning) rather than being silently hidden — bin/check-command-catalog.mjs
// (`pnpm check:command-catalog`) is the blocking half that fails CI on that gap.
//
// Usage:
//   pnpm commands             # human-readable, grouped by family
//   pnpm commands -- --json   # ADR-0030 structured report
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { groupByFamily } from "./lib/command-catalog.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { json } = parseJsonFlag();
const reporter = createReporter(json);

const { scripts } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const families = groupByFamily(scripts);
const allEntries = families.flatMap((group) => group.entries);
const undocumented = allEntries.filter((entry) => !entry.hasDescription);

if (!json) {
  for (const { family, entries } of families) {
    console.log(`\n${family}:`);
    for (const entry of entries) {
      console.log(`  pnpm ${entry.name.padEnd(24)} ${entry.description}`);
    }
  }
  console.log();
}

for (const entry of undocumented) {
  reporter.warn(
    `"${entry.name}" has no bin/lib/command-catalog.mjs entry — showing its raw command as a fallback description.`,
  );
}

const total = allEntries.length;
reporter.succeed(
  `${total} command(s) across ${families.length} famil${families.length === 1 ? "y" : "ies"}` +
    (undocumented.length > 0 ? ` (${undocumented.length} undocumented).` : "."),
);
reporter.finish({ families });
