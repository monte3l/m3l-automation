// Shared site inventory for the "N of M" submodule counts, consumed by both
// the generator (gen-doc-counts.mjs) and the two checkers
// (check-doc-counts.mjs, check-impl-counts.mjs) — a gen/check pair that
// cannot drift, same pattern as gen-reference-index.mjs/check-reference-index.mjs
// sharing bin/lib/reference-index.mjs.
//
// Two independent counts are tracked:
//   - the DENOMINATOR ("total documented"): Core + AWS reference pages on
//     disk, asserted by the TOTAL_COUNT_SITES badges/prose. Historically
//     always 22 (total == implemented) until the AWS `dynamodb` submodule was
//     scaffolded without yet being implemented — every "N of M" site tracks
//     both numbers independently so neither pattern hardcodes the other.
//   - the NUMERATOR ("N implemented"): the ✅ rows in
//     docs/implementation-status.md, asserted by the IMPLEMENTED_COUNT_SITES
//     badges/prose and rendered as the generated implemented-list block. Its
//     "of M" half is left wildcarded (see IMPLEMENTED_COUNT_SITES below) —
//     the denominator's correctness is verified independently by the
//     sibling TOTAL_COUNT_SITES entry for the same phrase.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { root, parseImplementationStatus } from "./reference-index.mjs";

export { root };

export const IMPLEMENTED_LIST_BEGIN_MARKER =
  "<!-- BEGIN GENERATED IMPLEMENTED-LIST -->";
export const IMPLEMENTED_LIST_END_MARKER =
  "<!-- END GENERATED IMPLEMENTED-LIST -->";

function countMdFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * Derive both canonical counts from the filesystem — the single computation
 * both the generator and both checkers build on, so they can never disagree
 * with each other about what the "right" numbers are.
 *
 * Injectable for tests: pass `countCore`/`countAws`/`getStatus` fixtures
 * instead of reading the real filesystem (pattern-parallel with hashBlobs'
 * `runGit` injection in bin/lib/doc-provenance.mjs).
 *
 * @param {{
 *   countCore?: () => number,
 *   countAws?: () => number,
 *   getStatus?: () => Record<string, string>,
 * }} [deps]
 * @returns {{
 *   coreCount: number,
 *   awsCount: number,
 *   total: number,
 *   implementedNames: string[],
 *   implemented: number,
 * }}
 */
export function deriveCounts({
  countCore = () => countMdFiles(join(root, "docs/reference/core")),
  countAws = () => countMdFiles(join(root, "docs/reference/aws")),
  getStatus = parseImplementationStatus,
} = {}) {
  const coreCount = countCore();
  const awsCount = countAws();
  const status = getStatus();
  const implementedNames = Object.keys(status).filter(
    (name) => status[name] === "✅",
  );
  return {
    coreCount,
    awsCount,
    total: coreCount + awsCount,
    implementedNames,
    implemented: implementedNames.length,
  };
}

// Denominator sites: each must show `counts.total` (or, for the two
// CLAUDE.md/README namespace-specific badges, coreCount/awsCount).
//
// Every "N of M" or "N%2FM" phrase below is tracked by TWO independent sites
// — one here (denominator = total) and its sibling in IMPLEMENTED_COUNT_SITES
// (numerator = implemented) — so each number can change without the other's
// pattern hardcoding a stale literal. This was a latent bug until the AWS
// `dynamodb` submodule (scaffolded, not yet implemented) made total ≠
// implemented for the first time: the four IMPLEMENTED_COUNT_SITES patterns
// had hardcoded "22" as the denominator, which only worked by coincidence
// while total and implemented were both always 22.
export const TOTAL_COUNT_SITES = [
  {
    file: "CLAUDE.md",
    pattern: /Core namespace barrel \((\d+) documented submodules\)/,
    label: "Core barrel comment",
    expected: (counts) => counts.coreCount,
  },
  {
    file: "CLAUDE.md",
    pattern: /AWS namespace barrel \((\d+) documented submodules\)/,
    label: "AWS barrel comment",
    expected: (counts) => counts.awsCount,
  },
  {
    file: "docs/ROADMAP.md",
    pattern: /library ledger \(\d+\/(\d+) submodules, count-enforced\)/,
    label: "total submodule count (ROADMAP.md intro pointer)",
    expected: (counts) => counts.total,
  },
  {
    file: "docs/ROADMAP.md",
    pattern:
      /count-enforced library ledger \(\d+\/(\d+) submodules, shipped at/,
    label: "total submodule count (ROADMAP.md Status snapshot)",
    expected: (counts) => counts.total,
  },
  {
    file: "docs/README.md",
    pattern: /(\d+) submodules documented/,
    label: "total submodule count (development status callout)",
    expected: (counts) => counts.total,
  },
  {
    file: "docs/README.md",
    pattern: /implemented \(\d+ of (\d+)\)/,
    label: "total submodule count (docs/README.md development-status callout)",
    expected: (counts) => counts.total,
  },
  {
    file: "README.md",
    pattern: /modules-\d+%2F(\d+)-/,
    label: "total submodule count (root README.md badge URL)",
    expected: (counts) => counts.total,
  },
  {
    file: "README.md",
    pattern: /\d+ of (\d+) submodules are/,
    label: "total submodule count (root README.md prose)",
    expected: (counts) => counts.total,
  },
  {
    file: "packages/m3l-common/README.md",
    pattern: /modules-\d+%2F(\d+)-/,
    label: "total submodule count (npm-facing README.md badge URL)",
    expected: (counts) => counts.total,
  },
  {
    file: "packages/m3l-common/README.md",
    pattern: /\d+ of (\d+) submodules are/,
    label: "total submodule count (npm-facing README.md prose)",
    expected: (counts) => counts.total,
  },
  {
    file: "docs/implementation-status.md",
    pattern: /\(\d+ of (\d+) submodules\)/,
    label: "total submodule count (implementation-status.md intro prose)",
    expected: (counts) => counts.total,
  },
];

// Numerator sites: each must show `counts.implemented`. The denominator half
// of each phrase is wildcarded (`\d+`, not captured) — its correctness is
// asserted independently by the sibling TOTAL_COUNT_SITES entry above, so
// this pattern never needs to hardcode a specific total.
export const IMPLEMENTED_COUNT_SITES = [
  {
    file: "README.md",
    pattern: /modules-(\d+)%2F\d+/,
    label: "root README.md badge URL",
    expected: (counts) => counts.implemented,
  },
  {
    file: "README.md",
    pattern: /(\d+) of \d+ submodules are/,
    label: "root README.md prose callout",
    expected: (counts) => counts.implemented,
  },
  {
    file: "packages/m3l-common/README.md",
    pattern: /modules-(\d+)%2F\d+/,
    label: "npm-facing README.md badge URL",
    expected: (counts) => counts.implemented,
  },
  {
    file: "packages/m3l-common/README.md",
    pattern: /(\d+) of \d+ submodules are/,
    label: "npm-facing README.md prose callout",
    expected: (counts) => counts.implemented,
  },
  {
    file: "docs/README.md",
    pattern: /implemented \((\d+) of \d+\)/,
    label: "docs/README.md development-status callout",
    expected: (counts) => counts.implemented,
  },
  {
    file: "docs/implementation-status.md",
    pattern: /\((\d+) of \d+ submodules\)/,
    label: "implementation-status.md intro prose",
    expected: (counts) => counts.implemented,
  },
  {
    file: "docs/ROADMAP.md",
    pattern: /library ledger \((\d+)\/\d+ submodules, count-enforced\)/,
    label: "ROADMAP.md intro pointer",
    expected: (counts) => counts.implemented,
  },
  {
    file: "docs/ROADMAP.md",
    pattern:
      /count-enforced library ledger \((\d+)\/\d+ submodules, shipped at/,
    label: "ROADMAP.md Status snapshot",
    expected: (counts) => counts.implemented,
  },
];

/**
 * Locate a site's numeric capture in `content` and report whether it already
 * matches `counts`. Shared by the checkers (report-only) and the generator
 * (which additionally splices in the replacement).
 *
 * Uses the regex `d` (hasIndices) flag to read the capture group's exact
 * absolute offset from `match.indices`, rather than `matchText.indexOf(captured)`
 * — the latter finds the group's digits wherever they *first* appear in the
 * whole match, which is wrong whenever an uncaptured part of the pattern
 * (e.g. the leading `\d+` in `/\d+ of (\d+) submodules are/`) contains the
 * same digits earlier in the string.
 *
 * @param {string} content
 * @param {{ pattern: RegExp, expected: (counts: ReturnType<typeof deriveCounts>) => number }} site
 * @param {ReturnType<typeof deriveCounts>} counts
 * @returns {{ found: boolean, actual?: number, expected?: number, matchIndex?: number, matchText?: string, capturedIndex?: number, capturedText?: string }}
 */
export function locateSite(content, site, counts) {
  const flags = site.pattern.flags.includes("d")
    ? site.pattern.flags
    : `${site.pattern.flags}d`;
  const indexedPattern = new RegExp(site.pattern.source, flags);
  const m = indexedPattern.exec(content);
  if (!m) return { found: false };
  const capturedText = m[1];
  const [capturedStart] = m.indices[1];
  return {
    found: true,
    actual: parseInt(capturedText, 10),
    expected: site.expected(counts),
    matchIndex: m.index,
    matchText: m[0],
    capturedIndex: capturedStart,
    capturedText,
  };
}

/**
 * Render the implemented-list prose sentence ("The barrels are wired; `a`,
 * `b`, and `c` are implemented and reviewed (N of M submodules).") from the
 * derived implemented-name list, wrapped in its marker comments — same
 * mechanism as the generated catalog blocks in docs/reference/README.md.
 *
 * @param {ReturnType<typeof deriveCounts>} counts
 * @returns {string}
 */
export function buildImplementedListBlock(counts) {
  const names = counts.implementedNames.map((n) => `\`${n}\``);
  const list =
    names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const sentence =
    `The barrels are wired; ${list} are implemented and reviewed ` +
    `(${counts.implemented} of ${counts.total} submodules). See the table ` +
    `below for per-submodule status.`;
  return [
    IMPLEMENTED_LIST_BEGIN_MARKER,
    "",
    sentence,
    "",
    IMPLEMENTED_LIST_END_MARKER,
  ].join("\n");
}
