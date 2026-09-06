#!/usr/bin/env node
// Verifies docs/adr/'s ADR-0094 governance convention: the generated
// <!-- BEGIN/END GENERATED ADR INDEX --> block in docs/adr/README.md is
// current, every Status classifies, every Relations verb is one of the
// declared nine, every relation resolves and is reciprocated, and a partial
// supersession carries a clause list.
//
// Severity split (ADR-0094's own Links section names this sequence):
//   PR2 (this file, first landing): every finding is a WARNING, exit 0
//     regardless — the corpus is not yet normalized to the new schema, so
//     flagging its pre-existing free-prose statuses as blocking errors would
//     fail every push for a defect this gate cannot itself fix. See
//     docs/logs/2026-09-06-adr-corpus-audit.md for the confirmed baseline
//     (9 index/file disagreements, 2 bare partial supersessions, 6
//     one-directional relations) this version reports without blocking.
//   PR3 (after the 93-file mechanical sweep): STRUCTURAL_FINDING_KINDS
//     (unknown-status, unknown-relation-verb, dangling-relation-target,
//     non-reciprocal-relation, duplicate-number) plus a stale generated
//     block flip to ERROR / exit 1; missing-clause-list and any future
//     purely-judgmental check stay WARNING even then.
//
// Usage:
//   node bin/check-adr-index.mjs
//   node bin/check-adr-index.mjs --json   # ADR-0030 structured report
//   pnpm check:adr-index
import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ADR_DIR,
  README_PATH,
  STRUCTURAL_FINDING_KINDS,
  buildGeneratedBlock,
  checkAdrIndex,
  findGeneratedBlockRange,
  parseAdrEntry,
} from "./lib/adr-index.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

// Flip to `true` once PR3's 93-file normalization sweep lands, so the
// structural findings below start blocking (see the header comment).
const BLOCKING = false;

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const root = repoRoot(import.meta.url);

const entries = readdirSync(join(root, ADR_DIR))
  .map((filename) =>
    parseAdrEntry(
      filename,
      readFileSync(join(root, ADR_DIR, filename), "utf8"),
    ),
  )
  .filter((entry) => entry !== null)
  .sort((a, b) => a.number - b.number);

const findings = checkAdrIndex(entries);

const readmePath = join(root, README_PATH);
const readmeContent = readFileSync(readmePath, "utf8");
const range = findGeneratedBlockRange(readmeContent);
let indexDrifted = false;
if (!range) {
  findings.push({
    kind: "missing-index-markers",
    message: `${README_PATH} is missing the GENERATED ADR INDEX markers.`,
  });
  indexDrifted = true;
} else {
  const committedBlock = readmeContent.slice(range.start, range.end);
  if (committedBlock !== buildGeneratedBlock(entries)) {
    findings.push({
      kind: "stale-index",
      message: `${README_PATH}'s generated index is out of date — run pnpm gen:adr-index.`,
    });
    indexDrifted = true;
  }
}

// This script's own two index-staleness kinds are structural too (a stale
// or missing generated block is exactly as blocking-worthy as a bad
// Relations entry), but they're produced here rather than by the shared
// checkAdrIndex(), so STRUCTURAL_FINDING_KINDS — the set shared with anyone
// else consuming checkAdrIndex() directly — doesn't itself list them.
const LOCAL_STRUCTURAL_KINDS = new Set([
  "stale-index",
  "missing-index-markers",
]);

let errors = 0;
for (const finding of findings) {
  const isStructural =
    STRUCTURAL_FINDING_KINDS.has(finding.kind) ||
    LOCAL_STRUCTURAL_KINDS.has(finding.kind);

  if (BLOCKING && isStructural) {
    reporter.error(finding.message, { file: README_PATH });
    errors++;
  } else {
    reporter.warn(finding.message, { file: README_PATH });
  }
}

if (findings.length === 0) {
  reporter.succeed(
    `docs/adr/'s index and status schema are fully consistent across ` +
      `${entries.length} ADR(s) — no findings.`,
  );
} else if (errors === 0) {
  reporter.succeed(
    `${findings.length} finding(s) reported as advisory (BLOCKING=false; ` +
      `see this script's header) across ${entries.length} ADR(s).`,
  );
}

reporter.finish({
  findings,
  adrs: entries.length,
  indexDrifted,
  blocking: BLOCKING,
});

process.exit(errors > 0 ? 1 : 0);
