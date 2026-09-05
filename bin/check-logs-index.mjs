#!/usr/bin/env node
// Cross-references docs/logs/README.md's six index tables against the log
// files actually present in docs/logs/. The README's tables are
// hand-maintained — a log's section can't be derived mechanically, since a
// log file carries no frontmatter and no category field — so a row is easy
// to forget when /writing-work-logs writes a log. That's drifted silently at
// least twice before this gate existed: docs/logs/2026-07-22-promotion-audit.md
// ("tables stopped at 2026-07-16 while ten…") and
// docs/logs/2026-09-03-x8-open-items.md (five same-day logs never indexed).
// This gate doesn't own the index — nothing mechanical can, see the README's
// maintenance note — but it verifies coverage, which needs no section
// knowledge at all.
//
// Checks (see bin/lib/logs-index.mjs):
//   - Coverage    every log file on disk has at least one README row.
//   - Dangling    every README row's link resolves to a real file.
//   - Duplicates  no log is linked from more than one row.
//   - Date match  a row's date column matches its linked file's date prefix.
//
// Advisory only, like check:retrospective and check:harness-freshness — this
// NEVER blocks a push. Every finding is a warning and the process always
// exits 0.
//
// Usage:
//   node bin/check-logs-index.mjs
//   node bin/check-logs-index.mjs --json   # ADR-0030 structured report
//   pnpm check:logs-index
import process from "node:process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOGS_DIR,
  README_PATH,
  checkLogsIndex,
  listLogFiles,
  parseIndexLinks,
} from "./lib/logs-index.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const root = repoRoot(import.meta.url);

const files = listLogFiles(join(root, LOGS_DIR), { readdir: readdirSync });
const links = parseIndexLinks(readFileSync(join(root, README_PATH), "utf8"));
const findings = checkLogsIndex({ files, links });

for (const finding of findings) {
  reporter.warn(finding, { file: README_PATH });
}

if (findings.length === 0) {
  reporter.succeed(
    `${README_PATH} indexes all ${files.length} log file(s) — coverage, ` +
      `links, and dates all consistent.`,
  );
}

reporter.finish({ findings, logs: files.length, indexed: links.length });

// Advisory only — never blocks a push. See the header comment above.
process.exit(0);
