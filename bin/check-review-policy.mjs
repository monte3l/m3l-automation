#!/usr/bin/env node
// Static gate (Anthropic AI-native SDLC harness-alignment plan, Section 5):
// REVIEW.md is the single source of truth for the review finding cap; this
// asserts the cap number it declares is restated identically in
// claude-pr-review.yml's prompt and every SEVERITY_CAPPED_SPOKES agent file
// (bin/lib/agent-roster.mjs) — the same parity-gate pattern check:cadence
// already runs for the pre-push table.
//
// Usage:
//   node bin/check-review-policy.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SEVERITY_CAPPED_SPOKES } from "./lib/agent-roster.mjs";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

/** Matches `... its **10** most severe findings ...` (REVIEW.md, bold) or
 * `... its 10 most severe findings ...` (plain prose elsewhere). */
const CAP_RE = /its\s+\**(\d+)\**\s+most\s+severe\s+findings/;

/**
 * Extract the finding-cap number from a source's text, or `null` if the
 * expected phrase isn't present at all.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function extractCap(text) {
  const match = text.match(CAP_RE);
  return match === null ? null : Number(match[1]);
}

/**
 * @typedef {object} CapSource
 * @property {string} label repo-relative path (or path#section) for reporting
 * @property {number | null} cap null when the phrase is missing entirely
 */

/**
 * Pure diff: given the canonical (REVIEW.md) cap and every other source's
 * extracted cap, return the mismatches — a source missing the phrase
 * entirely, or one restating a different number.
 *
 * @param {number} canonicalCap
 * @param {CapSource[]} sources
 * @returns {string[]} human-readable error messages, empty when all agree
 */
export function diffCapSources(canonicalCap, sources) {
  const errors = [];
  for (const source of sources) {
    if (source.cap === null) {
      errors.push(
        `${source.label} has no "its N most severe findings" cap phrase — ` +
          `REVIEW.md declares ${canonicalCap}.`,
      );
    } else if (source.cap !== canonicalCap) {
      errors.push(
        `${source.label} restates the cap as ${source.cap}, but REVIEW.md ` +
          `declares ${canonicalCap}.`,
      );
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const root = repoRoot(import.meta.url);

  const reviewMdPath = join(root, "REVIEW.md");
  if (!existsSync(reviewMdPath)) {
    reporter.error(
      "REVIEW.md is missing — it is the review-policy source of truth.",
    );
    reporter.finish({ canonicalCap: null, sourcesChecked: 0 });
    process.exit(1);
  }

  const canonicalCap = extractCap(readFileSync(reviewMdPath, "utf8"));
  if (canonicalCap === null) {
    reporter.error(
      'REVIEW.md has no "its **N** most severe findings" cap phrase to derive the canonical number from.',
    );
    reporter.finish({ canonicalCap: null, sourcesChecked: 0 });
    process.exit(1);
  }

  const workflowPath = join(root, ".github/workflows/claude-pr-review.yml");
  /** @type {CapSource[]} */
  const sources = [
    {
      label: ".github/workflows/claude-pr-review.yml",
      cap: existsSync(workflowPath)
        ? extractCap(readFileSync(workflowPath, "utf8"))
        : null,
    },
    ...[...SEVERITY_CAPPED_SPOKES].sort().map((name) => {
      const agentPath = join(root, ".claude/agents", `${name}.md`);
      return {
        label: `.claude/agents/${name}.md`,
        cap: existsSync(agentPath)
          ? extractCap(readFileSync(agentPath, "utf8"))
          : null,
      };
    }),
  ];

  const errors = diffCapSources(canonicalCap, sources);
  for (const error of errors) reporter.error(error);

  if (errors.length > 0) {
    if (!json)
      console.error(`\n✗  ${errors.length} review-policy cap mismatch(es).`);
    reporter.finish({ canonicalCap, sourcesChecked: sources.length });
    process.exit(1);
  }

  reporter.succeed(
    `Review-policy cap (${canonicalCap}) matches across REVIEW.md and ` +
      `${sources.length} enforcing surface(s).`,
  );
  reporter.finish({ canonicalCap, sourcesChecked: sources.length });
}
