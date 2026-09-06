#!/usr/bin/env node
// ADR-0095: advisory-only nudge flagging a newly added ADR whose own
// Consequences section matches a known low-blast-radius shape (a label/
// milestone retitle, widening one lint/type-check zone by a single module)
// and declares no semver impact, as a possible docs/decision-notes/
// candidate instead. Never blocks — the maintainer's judgment is final;
// this only prompts the question at review time (see
// bin/lib/adr-worthiness.mjs's header for the full rationale, including why
// the heuristic flags narrowly rather than broadly).
//
// "New" is determined by diffing against origin/main — an ADR already
// accepted before this branch is never re-evaluated (that would relitigate
// a settled decision, exactly what ADR-0094/ADR-0095 argue against). If
// that range can't be resolved at all (no origin remote, shallow clone,
// already on main), the gate says so explicitly and skips rather than
// reporting a false "no new ADRs" success.
//
// Usage:
//   node bin/check-adr-worthiness.mjs
//   node bin/check-adr-worthiness.mjs --json   # ADR-0030 structured report
//   pnpm check:adr-worthiness
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveWorthinessCandidates } from "./lib/adr-worthiness.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const root = repoRoot(import.meta.url);

/**
 * Repo-relative paths of docs/adr/NNNN-*.md files added on this branch but
 * absent from origin/main. Returns `{ files: [], resolved: false }` when
 * there is no `origin/main` to diff against (a fresh clone with no remote,
 * a shallow clone, or a detached run outside CI) — distinct from
 * `{ files: [], resolved: true }`, a genuinely clean branch. Collapsing
 * those two into the same `[]` would let a git failure print the same
 * success message as "no new ADRs" (bin/check-review-size.mjs:247 names
 * the same degradation explicitly rather than silently).
 *
 * @returns {{ files: string[], resolved: boolean }}
 */
function newAdrFiles() {
  let diff;
  try {
    diff = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "--diff-filter=A",
        "origin/main...HEAD",
        "--",
        "docs/adr/",
      ],
      { cwd: root, encoding: "utf8" },
    );
  } catch {
    return { files: [], resolved: false };
  }
  const files = diff
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^docs\/adr\/\d{4}-.+\.md$/.test(l));
  return { files, resolved: true };
}

const { files: newFiles, resolved } = newAdrFiles();

if (!resolved) {
  reporter.info(
    "Could not resolve an origin/main...HEAD range (no origin remote, shallow clone, or already on main) — skipping.",
  );
  reporter.finish({ checked: 0, flagged: [], skipped: true });
  process.exit(0);
}
const candidates = newFiles.map((relPath) => ({
  filename: relPath.split("/").pop() ?? relPath,
  content: readFileSync(join(root, relPath), "utf8"),
}));

const flagged = deriveWorthinessCandidates(candidates);

for (const filename of flagged) {
  reporter.warn(
    `${filename} declares no semver impact and no public-contract/harness-wide language — ` +
      `consider whether docs/decision-notes/ (ADR-0095) fits this decision better than a full ADR. ` +
      `Advisory only: keep the ADR if you've already decided it belongs.`,
    { file: `docs/adr/${filename}` },
  );
}

if (flagged.length === 0) {
  reporter.succeed(
    newFiles.length === 0
      ? "No new ADRs on this branch to evaluate."
      : `${newFiles.length} new ADR(s) checked — none reads as a decision-note candidate.`,
  );
}

reporter.finish({ checked: newFiles.length, flagged });

// Advisory only — never blocks a push. See the header comment above.
process.exit(0);
