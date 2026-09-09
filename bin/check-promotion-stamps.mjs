#!/usr/bin/env node
// Validates the `promoted →` stamp convention `/promoting-work-log-insights`
// and `/writing-work-logs` share (ROADMAP H7, issue #1000):
//   - forward: every docs/logs/*.md `_(promoted → <path>)_` stamp names a
//     file that actually exists;
//   - reverse: every `docs/logs/<name>.md` citation inside .claude/rules/*.md,
//     .claude/agents/*.md, .claude/skills/*/SKILL.md, or CLAUDE.md resolves
//     to a real log.
//
// Neither arm was checked before this gate. Three targets had already gone
// dead by the time it was written, every one a rename that silently
// orphaned its stamps — .claude/agents/submodule-implementer.md (renamed
// code-implementer.md, commit 9db7c3bb), .claude/skills/sync-docs/SKILL.md
// (renamed syncing-docs, commit fa60919e), and
// .claude/skills/vitest-coverage-types-mocks/SKILL.md (renamed
// vitest-testing, commit 2cdbd165 / #1077). All three are repaired via
// bin/lib/promotion-stamps.mjs's RENAMED_TARGETS map rather than by editing
// the logs, which docs/logs/README.md declares immutable history.
//
// Deliberately NOT checked: symmetry (every stamp's target citing its
// source log back) — see bin/lib/promotion-stamps.mjs's header comment for
// why, including the 109/299 measurement that ruled it out.
//
// Blocking, unlike check:retrospective and check:logs-index: both findings
// here are mechanically certain (a path exists or it doesn't), not a
// judgment call a maintainer needs to triage.
//
// Usage:
//   node bin/check-promotion-stamps.mjs   # exits 0 on success, 1 on any dangling stamp/citation
//   node bin/check-promotion-stamps.mjs --json
//   pnpm check:promotion-stamps
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOGS_DIR,
  SCAN_GLOBS,
  checkPromotionStamps,
  collectCitations,
  collectStamps,
  resolveScanGlobs,
} from "./lib/promotion-stamps.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const root = repoRoot(import.meta.url);

const readText = (relPath) => readFileSync(join(root, relPath), "utf8");
const exists = (relPath) => existsSync(join(root, relPath));

// --- docs/logs/*.md --------------------------------------------------------
// README.md is the index, not a log — excluded from the forward-arm stamp
// scan (a stamp never targets it) but kept in the reverse arm's existence
// set, since .claude/skills/{finishing-work,writing-work-logs}/SKILL.md
// legitimately cite it (`docs/logs/README.md` names the index itself).
const allLogDirFiles = readdirSync(join(root, LOGS_DIR))
  .filter((name) => name.endsWith(".md"))
  .sort();
const logFiles = allLogDirFiles.filter((name) => name !== "README.md");
const logs = logFiles.map((file) => ({
  file,
  text: readText(`${LOGS_DIR}/${file}`),
}));

// --- SCAN_GLOBS: .claude/rules/*.md, .claude/agents/*.md, .claude/skills/*/SKILL.md, CLAUDE.md
const scanPaths = resolveScanGlobs(SCAN_GLOBS, {
  readdir: (relDir) => readdirSync(join(root, relDir)),
  exists,
});

const scannedFiles = scanPaths.map((path) => ({ path, text: readText(path) }));

const stamps = collectStamps(logs);
const citations = collectCitations(scannedFiles);
const existingLogFiles = new Set(allLogDirFiles);

const findings = checkPromotionStamps({
  stamps,
  citations,
  exists,
  existingLogFiles,
});

for (const finding of findings) {
  reporter.error(finding.message, { file: finding.file, line: finding.line });
}

if (findings.length > 0) {
  reporter.finish({
    findings,
    stamps: stamps.length,
    citations: citations.length,
  });
  process.exit(1);
}

reporter.succeed(
  `${stamps.length} promotion stamp(s) across ${logs.length} log(s), and ` +
    `${citations.length} reverse log citation(s) across ${scannedFiles.length} ` +
    `harness file(s), all resolve.`,
);
reporter.finish({
  findings,
  stamps: stamps.length,
  citations: citations.length,
});
