#!/usr/bin/env node
// Verifies every mechanically-probeable factual claim the corpus's
// load-bearing ADRs make against live repo state (bin/lib/adr-claims.mjs) —
// generalizing bin/lib/integration-stance.mjs's descriptor-table pattern
// from "does a skill's text match its own behavior" to "does an ADR's
// concrete claim still hold." Blocking: each probe has one mechanically
// certain source of truth, so a mismatch is not a judgment call — this is
// exactly the confirmed live defect the audit found (ADR-0004 asserted a
// three-entry exports map after the live map had grown a fourth entry).
//
// Usage:
//   node bin/check-adr-claims.mjs   # exits 0 on success, 1 on any drift
//   node bin/check-adr-claims.mjs --json
//   pnpm check:adr-claims
import process from "node:process";
import { checkAdrClaims, ADR_CLAIMS } from "./lib/adr-claims.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const root = repoRoot(import.meta.url);

const findings = checkAdrClaims(root);

for (const finding of findings) {
  reporter.error(finding.message, { file: `docs/adr/${finding.adr}-*.md` });
}

if (findings.length > 0) {
  reporter.finish({ findings, checked: ADR_CLAIMS.length });
  process.exit(1);
}

reporter.succeed(
  `${ADR_CLAIMS.length} probeable ADR claim(s) still hold against live repo state.`,
);
reporter.finish({ findings, checked: ADR_CLAIMS.length });
