#!/usr/bin/env node
// Static gate (Anthropic AI-native SDLC harness-alignment plan, Section 5):
// REVIEW.md is the single source of truth for the review policy. This asserts:
//   1. the finding-cap number is restated identically in claude-pr-review.yml's
//      prompt and every SEVERITY_CAPPED_SPOKES agent file (bin/lib/agent-roster.mjs)
//   2. REVIEW.md's severity-tier descriptions, exclusion-list patterns, and
//      output-format literal strings (headings, bullet template, verdict line)
//      are each restated verbatim SOMEWHERE in claude-pr-review.yml's prompt —
//      the same parity-gate pattern check:cadence already runs for the pre-push
//      table, extended past the cap number after an audit found the prompt's own
//      comment ("REVIEW.md — the canonical source pnpm check:review-policy keeps
//      this file in sync with") was true only for the cap: tiers, exclusions,
//      and output format could all drift silently before this.
//
// Checks 2 are scoped to the workflow prompt only, not the spoke agent files —
// REVIEW.md's own "Where this is enforced" table documents the spoke files as
// paraphrasing severity philosophy, not quoting it verbatim, so a literal-string
// check against them would be a false positive by design.
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

/**
 * The body of a `## <heading>` markdown section — everything up to the next
 * `## ` heading, or end of text. Returns `null` if the heading isn't found.
 *
 * @param {string} markdown
 * @param {string} heading exact heading text (no leading `##`)
 * @returns {string | null}
 */
export function extractSection(markdown, heading) {
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, "m");
  const match = headingRe.exec(markdown);
  if (match === null) return null;
  const rest = markdown.slice(match.index + match[0].length);
  const nextHeading = /^##\s+/m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

/**
 * Collapse whitespace runs to a single space and trim — used to compare two
 * pieces of markdown prose that must agree on words but may be reflowed to
 * different line widths (REVIEW.md vs. the indented YAML prompt block).
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parse REVIEW.md's "## Severity tiers" section into `{ tierName: description }`,
 * one entry per `- **<name>** — <description>` bullet. Descriptions are
 * whitespace-normalized so a line-wrap difference from the prompt's own
 * copy never causes a false mismatch.
 *
 * @param {string} reviewMdText
 * @returns {Record<string, string>}
 */
export function extractSeverityTiers(reviewMdText) {
  const section = extractSection(reviewMdText, "Severity tiers");
  if (section === null) return {};
  const tierRe = /-\s+\*\*([^*]+)\*\*\s+—\s+([\s\S]*?)(?=\n-\s+\*\*|\n\n|$)/g;
  /** @type {Record<string, string>} */
  const tiers = {};
  for (const match of section.matchAll(tierRe)) {
    tiers[match[1].trim()] = normalizeWhitespace(match[2]);
  }
  return tiers;
}

/**
 * Diff REVIEW.md's severity-tier descriptions against whether each one
 * (whitespace-normalized) appears verbatim somewhere in `promptText`.
 *
 * @param {Record<string, string>} tiers from {@link extractSeverityTiers}
 * @param {string} promptText raw claude-pr-review.yml text
 * @returns {string[]} human-readable error messages, empty when all match
 */
export function diffSeverityTiers(tiers, promptText) {
  const normalizedPrompt = normalizeWhitespace(promptText);
  const errors = [];
  for (const [name, description] of Object.entries(tiers)) {
    if (!normalizedPrompt.includes(description)) {
      errors.push(
        `claude-pr-review.yml's prompt does not restate REVIEW.md's "${name}" ` +
          `severity-tier description verbatim: "${description}"`,
      );
    }
  }
  return errors;
}

/**
 * Parse REVIEW.md's "## Exclusions" section into the list of backtick-quoted
 * path patterns it declares (`` `*.md` ``, `` `docs/**` ``, …).
 *
 * @param {string} reviewMdText
 * @returns {string[]}
 */
export function extractExclusions(reviewMdText) {
  const section = extractSection(reviewMdText, "Exclusions");
  if (section === null) return [];
  const patterns = [];
  for (const match of section.matchAll(/^-\s+`([^`]+)`/gm)) {
    patterns.push(match[1]);
  }
  return patterns;
}

/**
 * Diff REVIEW.md's exclusion patterns against whether each backtick-quoted
 * literal appears verbatim somewhere in `promptText`.
 *
 * @param {string[]} exclusions from {@link extractExclusions}
 * @param {string} promptText raw claude-pr-review.yml text
 * @returns {string[]} human-readable error messages, empty when all match
 */
export function diffExclusions(exclusions, promptText) {
  const errors = [];
  for (const pattern of exclusions) {
    if (!promptText.includes(`\`${pattern}\``)) {
      errors.push(
        `claude-pr-review.yml's prompt does not mention the exclusion ` +
          `pattern \`${pattern}\` from REVIEW.md.`,
      );
    }
  }
  return errors;
}

/**
 * Parse REVIEW.md's "## Output format" section into the literal strings it
 * declares every enforcing surface must restate: each fenced ` ``` ` code
 * block's trimmed content (the bullet template and the verdict line — kept
 * fenced rather than inline-backtick-escaped, since the bullet template
 * itself contains a backtick-quoted path and nested backtick escaping is
 * ambiguous to parse reliably), plus every remaining single-backtick inline
 * span outside those fences (the four `###` headings and `_None._`).
 *
 * @param {string} reviewMdText
 * @returns {string[]}
 */
export function extractOutputFormatLiterals(reviewMdText) {
  const section = extractSection(reviewMdText, "Output format");
  if (section === null) return [];
  const literals = [];

  const fenceRe = /```[a-z]*\n([\s\S]*?)```/g;
  for (const match of section.matchAll(fenceRe)) {
    literals.push(match[1].trim());
  }

  const withoutFences = section.replace(fenceRe, "");
  for (const match of withoutFences.matchAll(/`([^`]+)`/g)) {
    literals.push(match[1].trim());
  }

  return literals;
}

/**
 * Diff REVIEW.md's output-format literals against whether each one appears
 * verbatim somewhere in `promptText`.
 *
 * @param {string[]} literals from {@link extractOutputFormatLiterals}
 * @param {string} promptText raw claude-pr-review.yml text
 * @returns {string[]} human-readable error messages, empty when all match
 */
export function diffOutputFormatLiterals(literals, promptText) {
  const errors = [];
  for (const literal of literals) {
    if (!promptText.includes(literal)) {
      errors.push(
        `claude-pr-review.yml's prompt does not restate REVIEW.md's ` +
          `Output format literal verbatim: ${literal}`,
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

  const capErrors = diffCapSources(canonicalCap, sources);
  for (const error of capErrors) reporter.error(error);

  const reviewMdText = readFileSync(reviewMdPath, "utf8");
  const workflowText = existsSync(workflowPath)
    ? readFileSync(workflowPath, "utf8")
    : null;

  /** @type {string[]} */
  let contractErrors = [];
  if (workflowText === null) {
    contractErrors.push(
      "claude-pr-review.yml is missing — cannot check severity-tier, " +
        "exclusion, or output-format parity against REVIEW.md.",
    );
  } else {
    const tiers = extractSeverityTiers(reviewMdText);
    const exclusions = extractExclusions(reviewMdText);
    const outputFormatLiterals = extractOutputFormatLiterals(reviewMdText);
    contractErrors = [
      ...diffSeverityTiers(tiers, workflowText),
      ...diffExclusions(exclusions, workflowText),
      ...diffOutputFormatLiterals(outputFormatLiterals, workflowText),
    ];
  }
  for (const error of contractErrors) reporter.error(error);

  const errors = [...capErrors, ...contractErrors];
  if (errors.length > 0) {
    if (!json)
      console.error(`\n✗  ${errors.length} review-policy mismatch(es).`);
    reporter.finish({
      canonicalCap,
      sourcesChecked: sources.length,
      capMismatches: capErrors.length,
      contractMismatches: contractErrors.length,
    });
    process.exit(1);
  }

  reporter.succeed(
    `Review-policy cap (${canonicalCap}) matches across REVIEW.md and ` +
      `${sources.length} enforcing surface(s); severity tiers, exclusions, ` +
      `and output format all restated verbatim in claude-pr-review.yml.`,
  );
  reporter.finish({
    canonicalCap,
    sourcesChecked: sources.length,
    capMismatches: 0,
    contractMismatches: 0,
  });
}
