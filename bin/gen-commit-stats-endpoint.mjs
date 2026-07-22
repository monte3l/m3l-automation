#!/usr/bin/env node
// Emits one shields.io endpoint-badge JSON payload per badge — aggregate.json
// plus one per canonical Claude model — to dist/commit-stats/. Each payload
// follows the shields.io endpoint-badge schema
// (https://shields.io/badges/endpoint-badge): {schemaVersion, label, message,
// color, labelColor, style}. .github/workflows/pages.yml runs
// this on every push to main and publishes dist/commit-stats/ to GitHub
// Pages, so the badge numbers live outside git history instead of being
// baked into a committed README block (ADR-0032 addendum). This is the
// publishing path for those badges — the old README-rewriting flow was
// removed from bin/gen-commit-stats.mjs when the README cut over to
// referencing these hosted endpoints (ADR-0032 addendum PR 2).
//
// Reuses bin/gen-commit-stats.mjs's counting logic (countCommitsByModel,
// countTotalCommits) and bin/lib/claude-models.mjs's canonical model list
// rather than reimplementing either — both files stay untouched by this
// module.
//
// Usage:
//   node bin/gen-commit-stats-endpoint.mjs   # writes dist/commit-stats/*.json
import process from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CANONICAL_CLAUDE_MODELS } from "./lib/claude-models.mjs";
import { countCommitsByModel, countTotalCommits } from "./gen-commit-stats.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors the module-private color constants in bin/gen-commit-stats.mjs
// (AGGREGATE_COLOR, BADGE_COLOR, and the labelColor baked into BADGE_STYLE);
// redeclared here rather than imported so that file stays byte-identical.
const AGGREGATE_COLOR = "66D9EF";
const MODEL_COLOR = "A6E22E";
const LABEL_COLOR = "272822";

/**
 * Slugify a canonical Claude model name into the filename shields.io's
 * endpoint badge will be served under: lowercase, with `.` and spaces
 * folded to `-`.
 *
 * @param {string} name - canonical model name, e.g. "Claude Opus 4.8"
 * @returns {string} slug, e.g. "claude-opus-4-8"
 * @example
 * ```js
 * import { modelSlug } from "@m3l-automation/workspace/bin/gen-commit-stats-endpoint.mjs";
 *
 * modelSlug("Claude Opus 4.8"); // "claude-opus-4-8"
 * ```
 */
export function modelSlug(name) {
  return name.toLowerCase().replace(/[. ]/g, "-");
}

/**
 * Build a shields.io endpoint-badge JSON payload
 * (https://shields.io/badges/endpoint-badge) with the fixed styling shared
 * by every badge this generator emits.
 *
 * @param {string} label
 * @param {string} message
 * @param {string} color
 * @returns {{schemaVersion: 1, label: string, message: string, color: string, labelColor: string, style: string}}
 * @example
 * ```js
 * import { endpointPayload } from "@m3l-automation/workspace/bin/gen-commit-stats-endpoint.mjs";
 *
 * endpointPayload("AI co-authored", "331 of 515 commits", "66D9EF");
 * ```
 */
export function endpointPayload(label, message, color) {
  return {
    schemaVersion: 1,
    label,
    message,
    color,
    labelColor: LABEL_COLOR,
    style: "flat-square",
  };
}

/**
 * Build every endpoint-badge payload keyed by the filename it will be
 * written under: `aggregate.json` first, then one entry per
 * `CANONICAL_CLAUDE_MODELS` entry, in canonical (capability-tier) order.
 *
 * Unlike the retired static README badge block, a model absent from
 * `counts` still gets a payload here — with a "0 commits" message — rather
 * than being omitted. shields.io endpoint badges are addressed individually
 * by filename, so a README (or any consumer) can reference a model's badge
 * URL before that model's first commit lands; omitting the file would make
 * that badge 404 instead of reading "0 commits".
 *
 * @param {Map<string, number>} counts - canonical model name -> commit count
 * @param {number} total - all commits reachable from HEAD
 * @returns {Map<string, ReturnType<typeof endpointPayload>>} filename -> payload
 * @example
 * ```js
 * import { buildEndpointPayloads } from "@m3l-automation/workspace/bin/gen-commit-stats-endpoint.mjs";
 *
 * const payloads = buildEndpointPayloads(new Map([["Claude Opus 4.8", 287]]), 515);
 * payloads.get("aggregate.json");
 * ```
 */
export function buildEndpointPayloads(counts, total) {
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  const payloads = new Map();
  payloads.set(
    "aggregate.json",
    endpointPayload(
      "AI co-authored",
      `${sum} of ${total} commits`,
      AGGREGATE_COLOR,
    ),
  );
  for (const model of CANONICAL_CLAUDE_MODELS) {
    const count = counts.get(model) ?? 0;
    payloads.set(
      `${modelSlug(model)}.json`,
      endpointPayload(model, `${count} commits`, MODEL_COLOR),
    );
  }
  return payloads;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = countCommitsByModel();
  const total = countTotalCommits();
  const payloads = buildEndpointPayloads(counts, total);
  const outDir = join(root, "dist", "commit-stats");
  mkdirSync(outDir, { recursive: true });
  for (const [filename, payload] of payloads) {
    writeFileSync(
      join(outDir, filename),
      JSON.stringify(payload, null, 2) + "\n",
    );
  }
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `✓  wrote ${payloads.size} commit-stats endpoint badges to dist/commit-stats/ (${sum} of ${total} commits co-authored)`,
  );
}
