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
//
// A third, orthogonal thing is tracked here too: the hand-written NAME
// enumerations that sit next to those numbers (README "Implemented
// submodules: `a`, `b`, …" prose, barrel TSDoc lists). A number can be
// right while the list next to it is stale — issue #343 found three such
// lists drifted independently of the (already-guarded) counts. Two
// mechanisms cover them:
//   - GENERATED_LIST_SITES: markdown prose fully owned by `gen:counts`,
//     spliced between `<!-- BEGIN/END GENERATED <NAME> -->` markers.
//   - LIST_ASSERTION_SITES: hand-authored TSDoc prose (barrel comments in
//     packages/m3l-common/src/{core,aws}/index.ts) that this tooling must
//     never write to — checked, not generated.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { root, parseImplementationStatus } from "./reference-index.mjs";

export { root };

/**
 * The opening marker for a named generated block, e.g.
 * `beginMarker("SUBMODULE-LIST")` → `<!-- BEGIN GENERATED SUBMODULE-LIST -->`.
 *
 * @param {string} name
 * @returns {string}
 */
export function beginMarker(name) {
  return `<!-- BEGIN GENERATED ${name} -->`;
}

/**
 * The closing marker for a named generated block. See {@link beginMarker}.
 *
 * @param {string} name
 * @returns {string}
 */
export function endMarker(name) {
  return `<!-- END GENERATED ${name} -->`;
}

export const IMPLEMENTED_LIST_BEGIN_MARKER = beginMarker("IMPLEMENTED-LIST");
export const IMPLEMENTED_LIST_END_MARKER = endMarker("IMPLEMENTED-LIST");

/**
 * Assemble a full generated block — markers plus interior lines — as one
 * string ready to splice into a document. Shared by every
 * {@link GENERATED_LIST_SITES} renderer so no renderer hand-formats markers.
 *
 * @param {string} name
 * @param {string[]} lines
 * @returns {string}
 */
function buildBlock(name, lines) {
  return [beginMarker(name), ...lines, endMarker(name)].join("\n");
}

/**
 * Find a named generated block's exact span in `content`, including both
 * markers. Returns `null` when either marker is missing — the caller decides
 * whether that means "not generated yet" (gen:counts) or "guard violated"
 * (check:impl-counts).
 *
 * @param {string} content
 * @param {string} name
 * @returns {{ start: number, end: number } | null}
 */
export function locateBlock(content, name) {
  const begin = beginMarker(name);
  const end = endMarker(name);
  const start = content.indexOf(begin);
  const endIdx = content.indexOf(end);
  if (start === -1 || endIdx === -1) return null;
  return { start, end: endIdx + end.length };
}

function countMdFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * Sorted submodule basenames for a `docs/reference/<namespace>` directory —
 * the same `.md`-only filter as {@link countMdFiles}, but yielding names
 * instead of a count. Backs the hand-written-name-list sites (README
 * enumerations, barrel TSDoc assertions) that need to know *which*
 * submodules exist, not just how many.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listMdBasenames(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -".md".length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Derive both canonical counts (plus the name lists derived work needs) from
 * the filesystem — the single computation the generator and all checkers
 * build on, so they can never disagree with each other about what the
 * "right" numbers or names are.
 *
 * Injectable for tests: pass `countCore`/`countAws`/`listCoreNames`/
 * `listAwsNames`/`getStatus` fixtures instead of reading the real filesystem
 * (pattern-parallel with hashBlobs' `runGit` injection in
 * bin/lib/doc-provenance.mjs). `listCoreNames`/`listAwsNames` are additive —
 * existing fixtures that only override `countCore`/`countAws` keep working
 * unchanged; they simply don't exercise `coreNames`/`awsNames`/
 * `qualifiedImplementedNames`.
 *
 * @param {{
 *   countCore?: () => number,
 *   countAws?: () => number,
 *   listCoreNames?: () => string[],
 *   listAwsNames?: () => string[],
 *   getStatus?: () => Record<string, string>,
 * }} [deps]
 * @returns {{
 *   coreCount: number,
 *   awsCount: number,
 *   total: number,
 *   coreNames: string[],
 *   awsNames: string[],
 *   implementedNames: string[],
 *   implemented: number,
 *   qualifiedImplementedNames: string[],
 * }}
 */
export function deriveCounts({
  countCore = () => countMdFiles(join(root, "docs/reference/core")),
  countAws = () => countMdFiles(join(root, "docs/reference/aws")),
  listCoreNames = () => listMdBasenames(join(root, "docs/reference/core")),
  listAwsNames = () => listMdBasenames(join(root, "docs/reference/aws")),
  getStatus = parseImplementationStatus,
} = {}) {
  const coreCount = countCore();
  const awsCount = countAws();
  const coreNames = listCoreNames();
  const awsNames = listAwsNames();
  const coreNameSet = new Set(coreNames);
  const awsNameSet = new Set(awsNames);
  const status = getStatus();
  const implementedNames = Object.keys(status).filter(
    (name) => status[name] === "✅",
  );
  // Qualify each implemented name with its namespace the way the
  // hand-written README lists already do ("aws/eks", but bare "script" for
  // Core) — Core wins on the (currently nonexistent) case of a name shared
  // by both namespaces, since a bare name reads as Core by convention.
  const qualifiedImplementedNames = implementedNames.map((name) =>
    !coreNameSet.has(name) && awsNameSet.has(name) ? `aws/${name}` : name,
  );
  return {
    coreCount,
    awsCount,
    total: coreCount + awsCount,
    coreNames,
    awsNames,
    implementedNames,
    implemented: implementedNames.length,
    qualifiedImplementedNames,
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
    pattern: /\d+ of (\d+) library submodules are/,
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
    pattern: /\d+ of (\d+) library submodules are/,
    label: "total submodule count (npm-facing README.md prose)",
    expected: (counts) => counts.total,
  },
  {
    file: "docs/implementation-status.md",
    pattern: /\(\d+ of (\d+) submodules\)/,
    label: "total submodule count (implementation-status.md intro prose)",
    expected: (counts) => counts.total,
  },
  {
    file: "docs/implementation-status.md",
    pattern: /all (\d+) Core submodules surfaced here/,
    label: "Core submodule count (implementation-status.md barrels table)",
    expected: (counts) => counts.coreCount,
  },
  {
    file: "docs/implementation-status.md",
    pattern: /all (\d+) AWS submodules surfaced here/,
    label: "AWS submodule count (implementation-status.md barrels table)",
    expected: (counts) => counts.awsCount,
  },
  {
    file: "docs/plans/README.md",
    pattern: /library ledger \(\d+\/(\d+) submodules, count-enforced\)/,
    label:
      "total submodule count (docs/plans/README.md living-trackers pointer)",
    expected: (counts) => counts.total,
  },
  {
    file: "docs/contributing/agent-operating-model.md",
    pattern: /count-enforced \d+\/(\d+) ledger/,
    label:
      "total submodule count (agent-operating-model.md live-status bullet)",
    expected: (counts) => counts.total,
  },
  {
    file: "README.md",
    pattern: /alt="library modules: \d+\/(\d+)"/,
    label: "total submodule count (root README.md badge alt text)",
    expected: (counts) => counts.total,
  },
  {
    file: "packages/m3l-common/README.md",
    pattern: /alt="library modules: \d+\/(\d+)"/,
    label: "total submodule count (npm-facing README.md badge alt text)",
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
    pattern: /(\d+) of \d+ library submodules are/,
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
    pattern: /(\d+) of \d+ library submodules are/,
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
  {
    file: "docs/plans/README.md",
    pattern: /library ledger \((\d+)\/\d+ submodules, count-enforced\)/,
    label: "docs/plans/README.md living-trackers pointer",
    expected: (counts) => counts.implemented,
  },
  {
    file: "docs/contributing/agent-operating-model.md",
    pattern: /count-enforced (\d+)\/\d+ ledger/,
    label: "agent-operating-model.md live-status bullet",
    expected: (counts) => counts.implemented,
  },
  {
    file: "README.md",
    pattern: /alt="library modules: (\d+)\/\d+"/,
    label: "root README.md badge alt text",
    expected: (counts) => counts.implemented,
  },
  {
    file: "packages/m3l-common/README.md",
    pattern: /alt="library modules: (\d+)\/\d+"/,
    label: "npm-facing README.md badge alt text",
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
/**
 * 1-indexed line number of a character offset into `content` — used to give
 * a {@link locateSite} match a `{file, line}` location for the reporter's
 * GitHub Actions annotation support.
 *
 * @param {string} content
 * @param {number} index
 * @returns {number}
 */
export function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

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
  return buildBlock("IMPLEMENTED-LIST", ["", sentence, ""]);
}

/**
 * The plain (non-Oxford) comma-joined, backtick-quoted submodule list the
 * three README-family sites already use — distinct from
 * {@link buildImplementedListBlock}'s Oxford-comma sentence, which is
 * `docs/implementation-status.md`'s own established phrasing and is left
 * unchanged.
 *
 * @param {ReturnType<typeof deriveCounts>} counts
 * @returns {string}
 */
function qualifiedListText(counts) {
  return counts.qualifiedImplementedNames.map((n) => `\`${n}\``).join(", ");
}

// Prettier reflows a blockquote HTML comment as its own block, inserting a
// blank `>` line between the BEGIN marker and the following paragraph (but
// not between the paragraph and an immediately-following END marker) — this
// exact interior shape is what a `prettier --write` pass produces from a
// straight `BEGIN\ncontent\nEND` block, so it's rendered as the generator's
// steady state directly rather than fighting the formatter every commit.
const BLOCKQUOTE_BLANK_LINE = ">";

/**
 * Like {@link buildBlock}, but for a block that lives inside a markdown
 * blockquote: every quoted site's hand-authored `> ` immediately preceding
 * the BEGIN marker is left untouched (it sits *before* `locateBlock`'s start
 * offset, so a plain splice never disturbs it), but the END marker is
 * spliced in fresh on every regeneration and needs its own `> ` — omitting
 * it silently ends the blockquote one line early, dropping every line after
 * END out of the quote.
 *
 * @param {string} name
 * @param {string[]} lines
 * @returns {string}
 */
function buildQuotedBlock(name, lines) {
  return [beginMarker(name), ...lines, `> ${endMarker(name)}`].join("\n");
}

/**
 * Render the `README.md` / `packages/m3l-common/README.md` "Implemented
 * submodules: …" blockquote line — a single quoted (`> `-prefixed) sentence
 * ending in a period, since both READMEs treat the list as the end of that
 * sentence.
 *
 * @param {ReturnType<typeof deriveCounts>} counts
 * @returns {string}
 */
function renderReadmeSubmoduleList(counts) {
  return buildQuotedBlock("SUBMODULE-LIST", [
    BLOCKQUOTE_BLANK_LINE,
    `> ${qualifiedListText(counts)}.`,
  ]);
}

/**
 * Render `docs/README.md`'s development-status callout list — no trailing
 * period, since the surrounding hand-authored prose continues the sentence
 * with "implemented (N of M)." right after the block.
 *
 * @param {ReturnType<typeof deriveCounts>} counts
 * @returns {string}
 */
function renderDocsReadmeSubmoduleList(counts) {
  return buildQuotedBlock("SUBMODULE-LIST", [
    BLOCKQUOTE_BLANK_LINE,
    `> ${qualifiedListText(counts)}`,
  ]);
}

/**
 * Every markdown site whose interior is fully owned by `gen:counts` —
 * spliced between `<!-- BEGIN/END GENERATED <marker> -->` markers, byte-
 * verified by `check:impl-counts`. Each `render` is a pure function of
 * `counts`; a mismatch means the file was hand-edited (or the marker pair is
 * simply missing yet — `gen:counts` reports that case distinctly from a
 * stale one).
 *
 * @type {{ file: string, marker: string, label: string, render: (counts: ReturnType<typeof deriveCounts>) => string }[]}
 */
export const GENERATED_LIST_SITES = [
  {
    file: "docs/implementation-status.md",
    marker: "IMPLEMENTED-LIST",
    label: "implemented-list sentence",
    render: buildImplementedListBlock,
  },
  {
    file: "README.md",
    marker: "SUBMODULE-LIST",
    label: "root README.md implemented-submodules list",
    render: renderReadmeSubmoduleList,
  },
  {
    file: "packages/m3l-common/README.md",
    marker: "SUBMODULE-LIST",
    label: "npm-facing README.md implemented-submodules list",
    render: renderReadmeSubmoduleList,
  },
  {
    file: "docs/README.md",
    marker: "SUBMODULE-LIST",
    label: "docs/README.md development-status submodule list",
    render: renderDocsReadmeSubmoduleList,
  },
];

/**
 * Pull every backtick-quoted `kebab-case` token out of `text` — the shape
 * every hand-written submodule name list here uses (`` `errors` ``,
 * `` `cloudwatch-logs-insights` ``, …). Shared by
 * {@link locateListAssertion}'s span-then-extract step.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractBacktickNames(text) {
  const names = [];
  const pattern = /`([a-z][a-z0-9-]*)`/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Locate a {@link LIST_ASSERTION_SITES} entry's enumerated-names span in
 * `content` and extract the backtick-quoted names inside it, without
 * comparing against `counts` — the caller (check-doc-counts.mjs) owns the
 * set-difference reporting so it can name missing/extra submodules
 * individually rather than failing on a single opaque mismatch.
 *
 * @param {string} content
 * @param {{ pattern: RegExp }} site
 * @returns {{ found: boolean, actualNames?: string[], matchIndex?: number }}
 */
export function locateListAssertion(content, site) {
  const match = site.pattern.exec(content);
  if (!match) return { found: false };
  return {
    found: true,
    actualNames: extractBacktickNames(match[1] ?? match[0]),
    matchIndex: match.index,
  };
}

// Check-only sites: hand-authored TSDoc prose this tooling must never write
// to (packages/*/src is guarded, and the AWS list is deliberately ordered
// "in dependency order" rather than alphabetically — generation would fight
// that ordering choice). check-doc-counts.mjs asserts the backtick-quoted
// names inside each span match `expectedNames(counts)` as a *set* (order-
// insensitive), reporting any missing or extra name by name.
export const LIST_ASSERTION_SITES = [
  {
    file: "packages/m3l-common/src/core/index.ts",
    pattern: /here as they are implemented:\s*([\s\S]*?)\./,
    label: "Core barrel TSDoc submodule list",
    expectedNames: (counts) => counts.coreNames,
  },
  {
    file: "packages/m3l-common/src/aws/index.ts",
    pattern:
      /here as they are implemented, in dependency order:\s*([\s\S]*?)\./,
    label: "AWS barrel TSDoc submodule list",
    expectedNames: (counts) => counts.awsNames,
  },
];
