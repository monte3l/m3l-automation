#!/usr/bin/env node
/**
 * Guards this repo's Claude Code context budget against silent regrowth
 * (ADR-0078) — the single inventory gate covering the always-loaded surface
 * (CLAUDE.md plus its resolved `@`-imports), the conditionally-loaded
 * `.claude/rules/*.md` extracts, and the always-listed `.claude/skills/*`
 * descriptions.
 *
 * Formerly `bin/check-claude-md-budget.mjs`, which measured CLAUDE.md raw
 * and never resolved its `@`-imports — it reported 96% of a 3,000-token
 * budget while the actual resolved payload (`CLAUDE.md` + `@package.json` +
 * `@docs/adr/README.md`) ran ~2.9x over. `@path` imports "help organization
 * but don't reduce context" (`code.claude.com/docs/en/memory`): Claude Code
 * injects CLAUDE.md's raw text (an unresolved `@token` stays literal text in
 * that block — confirmed by inspection of an actual session's injected
 * context) and separately injects each resolved import's full content as its
 * own block. This gate mirrors that: each block is measured independently
 * (comment-stripped, blank-line-collapsed, same as before) and the totals are
 * summed — not a single merged/re-normalized text.
 *
 * Four checks, four different enforcement shapes:
 *
 *   1. Always-loaded budget (CLAUDE.md + resolved imports): a HARD ceiling,
 *      MAX_RUNTIME_LINES / MAX_APPROX_TOKENS — no ratchet. This surface is
 *      paid on every session and every custom-spoke launch; it must fit, not
 *      just track its own growth.
 *   2. `.claude/rules/*.md` conditional-load weight: a RATCHET, mirroring
 *      `bin/check-file-budget.mjs` exactly — a baselined file may shrink but
 *      never grow past its recorded size; an unbaselined file must stay under
 *      RULE_CEILING_BYTES. Four of seven existing rule files are already well
 *      over the 10,000-byte ceiling (library-src.md at 29,082 B is ~3x) — a
 *      flat cap would fail on day one, same rationale as check-file-budget.mjs.
 *   3. `.claude/skills/<name>/SKILL.md` per-skill description weight: a WARN
 *      for any single description over 1,536 chars, the documented Claude
 *      Code listing-truncation threshold (`code.claude.com/docs/en/skills`).
 *      Not ratcheted: descriptions churn with normal skill-writing edits and
 *      a hard per-file gate here would fight that.
 *   3b. Aggregate skill-listing weight vs. Claude Code's documented ~1%-of-
 *      context-window listing budget: a HARD ceiling at the
 *      SKILL_LISTING_ENFORCED_WINDOW reference window (200k tokens — the
 *      floor a session can run at), reported informationally against every
 *      window in SKILL_LISTING_REFERENCE_WINDOWS. Unlike #3, this one is
 *      enforced: on overflow Claude Code silently drops descriptions
 *      starting with the least-invoked skills (`code.claude.com/docs/en/
 *      skills`), so a 22-skill repo whose combined descriptions already ran
 *      2.7x over the 200k-window budget (21,684 chars vs. an ~8,000-char
 *      budget, measured 2026-09-02) was degrading prose-triggered invocation
 *      silently, for exactly the skills a naive read would expect it least —
 *      the low-usage ones a truncation drops first. A per-skill WARN alone
 *      cannot catch this: 22 descriptions each under the 1,536-char
 *      per-skill threshold can still sum well past the aggregate budget.
 *
 * A fourth, INFORMATIONAL-only measurement (2026-09-01 harness-refresh sweep)
 * reports total `.claude/skills/*\/SKILL.md` **body** bytes (the payload
 * injected when a skill actually runs, capped per-skill at 5,000 tokens by
 * Claude Code itself per `code.claude.com/docs/en/context-window` — this gate
 * does not enforce that cap, only surfaces the current total) and total
 * `.claude/agents/*.md` **body** bytes (loaded once per spoke dispatch). Both
 * were previously entirely unbudgeted — the two largest context surfaces in
 * `.claude/` had no gate at all. Not ratcheted for the same reason as #3: no
 * evidenced per-body ceiling to enforce yet, only visibility.
 *
 * `estimateTokens()` is a chars/4 approximation, not a real tokenizer — the
 * same sweep confirmed the actual Claude 4.7+ tokenizer produces ~30% MORE
 * tokens than this estimate for the same text. `--exact` calls Anthropic's
 * real `POST /v1/messages/count_tokens` endpoint (free, no message-creation
 * quota) for the always-loaded block and reports the true count alongside
 * the estimate — opt-in only: it needs `ANTHROPIC_API_KEY` and a network
 * call, neither of which a `pre-push`/CI gate should require by default.
 *
 * Usage:
 *   node bin/check-context-budget.mjs            # verify (fails on any hard violation)
 *   node bin/check-context-budget.mjs --update    # rewrite the rules ratchet baseline
 *   node bin/check-context-budget.mjs --exact     # also report the real token count (needs ANTHROPIC_API_KEY)
 */
import process from "node:process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const baselineRel = "bin/context-budget-baseline.json";
const baselinePath = join(root, baselineRel);

export const MAX_RUNTIME_LINES = 200;
export const MAX_APPROX_TOKENS = 3000;
export const MAX_TABLE_LINE_WIDTH = 200;
/** Ceiling for a `.claude/rules/*.md` file not in the ratchet baseline. */
export const RULE_CEILING_BYTES = 10_000;
/** Claude Code's documented listing-truncation threshold for a single skill's description. */
export const SKILL_DESC_WARN_CHARS = 1536;
/**
 * Claude Code's documented fraction of the context window budgeted for the
 * skill-description listing (`code.claude.com/docs/en/skills`). Named to
 * track the `skillListingBudgetFraction` settings.json key, if this repo
 * ever raises it — this gate should keep measuring against whatever the
 * live setting says, not a value hardcoded independently of it.
 */
export const SKILL_LISTING_BUDGET_FRACTION = 0.01;
/** Reference context windows the aggregate skill-listing budget is reported against. */
export const SKILL_LISTING_REFERENCE_WINDOWS = Object.freeze([
  200_000, 1_000_000,
]);
/**
 * The context window whose listing budget is HARD-enforced — the smallest
 * window a session can plausibly run this repo at, so it is the binding
 * constraint; the larger windows in {@link SKILL_LISTING_REFERENCE_WINDOWS}
 * are reported for visibility only.
 */
export const SKILL_LISTING_ENFORCED_WINDOW = 200_000;

// ---------------------------------------------------------------------------
// Shared measurement primitives (unchanged from check-claude-md-budget.mjs)
// ---------------------------------------------------------------------------

/**
 * Strip block-level HTML comments the same way Claude Code strips them before
 * injecting a file into context — anything inside `<!-- ... -->` costs zero
 * runtime tokens, so it must not count toward the budget.
 *
 * Repeats the strip to a fixed point rather than a single pass: a single
 * non-greedy pass over adjacent/nested `<!--`/`-->` markers (e.g.
 * `<!--<!---->`) can leave a dangling `<!--` behind, which a later read of
 * this "sanitized" text could misinterpret as still-open markup (CodeQL
 * js/incomplete-multi-character-sanitization).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripBlockComments(text) {
  let previous;
  let result = text;
  do {
    previous = result;
    result = result.replace(/<!--[\s\S]*?-->/g, "");
  } while (result !== previous);
  return result;
}

/**
 * Collapse runs of 3+ blank lines left behind by comment stripping and trim
 * the ends.
 *
 * @param {string} strippedText output of {@link stripBlockComments}
 * @returns {string}
 */
export function normalizeRuntimeContent(strippedText) {
  return strippedText.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * @param {string} normalized output of {@link normalizeRuntimeContent}
 * @returns {number}
 */
export function countRuntimeLines(normalized) {
  return normalized.length === 0 ? 0 : normalized.split("\n").length;
}

/**
 * Rough token estimate (~4 chars/token) — good enough for a budget gate, not
 * a substitute for a real tokenizer.
 *
 * @param {string} normalized output of {@link normalizeRuntimeContent}
 * @returns {number}
 */
export function estimateTokens(normalized) {
  return Math.ceil(normalized.length / 4);
}

/**
 * Table rows Prettier has padded past `maxWidth`. A warning, not a failure:
 * legitimate short tables can still have one wide cell.
 *
 * @param {string} normalized output of {@link normalizeRuntimeContent}
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function findWidePaddedTableLines(normalized, maxWidth) {
  return normalized
    .split("\n")
    .filter(
      (line) => line.trimStart().startsWith("|") && line.length > maxWidth,
    );
}

/**
 * @param {string} normalized output of {@link normalizeRuntimeContent}
 * @returns {{ lines: number, tokens: number }}
 */
export function measure(normalized) {
  return {
    lines: countRuntimeLines(normalized),
    tokens: estimateTokens(normalized),
  };
}

// ---------------------------------------------------------------------------
// @-import resolution
// ---------------------------------------------------------------------------

/**
 * `@<path>` import tokens Claude Code recognizes anywhere in a file's text —
 * observed in this repo's CLAUDE.md as inline prose ("See @package.json
 * for..."), never a standalone import line. Deliberately loose (word chars,
 * `.`, `/`, `-`): the false-positive filter is "does this resolve to a real
 * file", not the token shape — CLAUDE.md itself contains @-tokens that are
 * NOT imports (`@m3l-automation/m3l-common`, `@example`, `@version`,
 * `@arethetypeswrong/cli`), and none of those resolve to a real path.
 *
 * @param {string} text
 * @returns {string[]} deduplicated token bodies (without the leading `@`)
 */
export function findImportTokens(text) {
  const tokens = new Set();
  for (const match of text.matchAll(/@([A-Za-z0-9_][A-Za-z0-9_./-]*)/g)) {
    tokens.add(match[1]);
  }
  return [...tokens];
}

/**
 * Resolve every `@<path>` token in `rootText` that names a real file,
 * recursively through each resolved file's own tokens, up to `maxHops` —
 * matching Claude Code's documented 4-hop import limit. Each resolved file
 * is returned once (first hop it's discovered at); a cycle or repeated
 * reference never re-visits a path.
 *
 * Deliberately returns raw blocks rather than a merged/substituted text: the
 * observed injection behavior is "CLAUDE.md's own text, unmodified, plus one
 * separate block per resolved import" — not inline splicing — so each block
 * is measured independently and the totals summed by the caller.
 *
 * @param {string} rootText
 * @param {string} fromRoot absolute directory imports resolve against
 * @param {number} [maxHops]
 * @returns {Array<{ path: string, content: string }>}
 */
export function resolveImportedFiles(rootText, fromRoot, maxHops = 4) {
  /** @type {Array<{ path: string, content: string }>} */
  const resolved = [];
  const seen = new Set();
  let frontier = findImportTokens(rootText);

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    /** @type {string[]} */
    const next = [];
    for (const relPath of frontier) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      const abs = resolve(fromRoot, relPath);
      // Defense in depth: a token containing "../" segments (e.g. a
      // hypothetical "@a/../../../../etc/passwd") must never resolve
      // outside fromRoot, even though CLAUDE.md is a trusted, repo-controlled
      // file today.
      if (abs !== fromRoot && !abs.startsWith(fromRoot + sep)) continue;
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        continue; // not a real path — literal @-token, not an import
      }
      if (!stats.isFile()) continue;
      const content = readFileSync(abs, "utf8");
      resolved.push({ path: relPath, content });
      next.push(...findImportTokens(content));
    }
    frontier = next;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// .claude/rules/*.md conditional-load scenario totals
// ---------------------------------------------------------------------------

/**
 * Extract the YAML frontmatter block (between the first two `---` lines).
 * Only what this gate needs: a `paths:` list and a `description:` scalar
 * (plain or folded/literal block style) — not general YAML.
 *
 * @param {string} content
 * @returns {string | null} the frontmatter body, or null if absent
 */
export function extractFrontmatterBody(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match === null ? null : match[1];
}

/**
 * `paths:` glob list from a `.claude/rules/*.md` frontmatter body.
 *
 * @param {string} fmBody output of {@link extractFrontmatterBody}
 * @returns {string[]}
 */
export function extractRulePaths(fmBody) {
  const pathsMatch = fmBody.match(/^paths:\n((?:[ \t]*-[ \t]*.+\n?)+)/m);
  if (pathsMatch === null) return [];
  return pathsMatch[1]
    .split("\n")
    .map((line) => line.match(/^[ \t]*-[ \t]*"?([^"]+?)"?[ \t]*$/))
    .filter((m) => m !== null)
    .map((m) => m[1]);
}

/**
 * A frontmatter scalar field's text, handling both an inline value
 * (`description: text`) and a folded/literal block scalar (`description:
 * >-` / `description: |-` followed by indented lines) — enough to measure
 * length, not to reproduce exact YAML folding semantics.
 *
 * @param {string} fmBody output of {@link extractFrontmatterBody}
 * @param {string} key
 * @returns {string}
 */
export function extractFrontmatterField(fmBody, key) {
  const lines = fmBody.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (idx === -1) return "";
  const inline = lines[idx].slice(key.length + 1).trim();
  if (inline !== "" && !/^[>|][-+]?\d*$/.test(inline)) return inline;

  const collected = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      collected.push("");
      continue;
    }
    if (!/^\s/.test(line)) break;
    collected.push(line.trim());
  }
  return collected.join(" ").trim();
}

/**
 * Convert a `paths:` glob (`**`/`*` only — the only wildcards this repo's
 * rule files use) to a RegExp. `**` matches zero or more path segments
 * (including their separating slashes); `*` matches within one segment.
 *
 * A "zero" match must not leave a stray separator behind: `"a/**\/b"` has to
 * match `"a/b"` (no segments in between) as well as `"a/x/y/b"`, and
 * `"**\/*.ts"` has to match a top-level `"foo.ts"` with no leading `"/"` at
 * all. Each `**` segment therefore swallows its own adjoining slash into an
 * optional group, rather than being joined via a plain `.*` between fixed
 * neighbors (which requires at least one intervening segment to exist).
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const escapeLiteral = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const segments = glob.split("/");
  /** @type {Array<string | null>} */
  const parts = segments.map((seg) =>
    seg === "**" ? null : seg.split("*").map(escapeLiteral).join("[^/]*"),
  );

  let pattern = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === null) {
      if (parts.length === 1) {
        pattern += ".*"; // the entire glob is just "**"
      } else if (i === 0) {
        pattern += "(?:.*\\/)?"; // "**/rest" -> optional "anything/" prefix
      } else if (i === parts.length - 1) {
        pattern += "(?:\\/.*)?"; // "prefix/**" -> optional "/anything" suffix
      } else {
        pattern += "(?:.*\\/)?"; // "a/**/b" -> optional "anything/" between
      }
      continue;
    }
    if (i > 0 && parts[i - 1] !== null) pattern += "\\/";
    pattern += part;
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * A plausible file path that a `paths:` glob would match, for probing which
 * OTHER rules' globs also match the same edit — the mechanism behind the
 * scenario-total report. A trailing `**` (whole-segment wildcard) becomes a
 * file name (using the glob's own extension when the pattern implies one,
 * `.ts` otherwise); a `**` earlier in the path, or any segment containing a
 * literal `*`, becomes a generic placeholder segment/file.
 *
 * @param {string} glob
 * @returns {string}
 */
export function globToProbePath(glob) {
  const segments = glob.split("/");
  const lastSegment = segments[segments.length - 1];
  // The literal suffix after the LAST "*" — not just the last dot-extension —
  // so a compound pattern like "*.test.ts" probes as "probe-file.test.ts",
  // not the ambiguous "probe-file.ts" a naive last-extension match would
  // produce (which then fails to match the very glob it was derived from).
  const lastStar = lastSegment.lastIndexOf("*");
  const suffix = lastStar === -1 ? "" : lastSegment.slice(lastStar + 1);
  const ext = suffix !== "" ? suffix : ".ts";
  return segments
    .map((seg, i) => {
      const isLast = i === segments.length - 1;
      if (seg === "**") return isLast ? `probe-file${ext}` : "probe-dir";
      if (seg.includes("*")) return `probe-file${ext}`;
      return seg;
    })
    .join("/");
}

/**
 * @typedef {Object} RuleFile
 * @property {string} name basename, e.g. "library-src.md"
 * @property {string} relPath repo-relative path
 * @property {number} bytes
 * @property {string[]} globs `paths:` entries
 */

/**
 * @param {string} rulesDir absolute path to `.claude/rules`
 * @returns {RuleFile[]}
 */
export function collectRuleFiles(rulesDir) {
  if (!existsSync(rulesDir)) return [];
  /** @type {RuleFile[]} */
  const files = [];
  for (const entry of readdirSync(rulesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const abs = join(rulesDir, entry.name);
    const content = readFileSync(abs, "utf8");
    const fmBody = extractFrontmatterBody(content);
    const globs = fmBody === null ? [] : extractRulePaths(fmBody);
    files.push({
      name: entry.name,
      relPath: relative(root, abs),
      bytes: Buffer.byteLength(content, "utf8"),
      globs,
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse CLAUDE.md's "Coding, errors & tests (path-scoped)" rule-glob bullet
 * list — the prose description of which `.claude/rules/*.md` extract loads
 * for which path glob(s) — into a map of rule filename -> declared globs.
 * This is the CLAUDE.md-side half of the parity check against each rule
 * file's own `paths:` frontmatter in {@link diffRuleGlobParity}: the two
 * drifted apart twice with no gate catching it before this one existed
 * (2026-08-31 audit against Anthropic's AI-native SDLC playbook).
 *
 * @param {string} claudeMdContent raw CLAUDE.md text
 * @returns {Map<string, string[]>} rule filename -> globs, in bullet order
 */
export function parseClaudeMdRuleGlobs(claudeMdContent) {
  /** @type {Map<string, string[]>} */
  const result = new Map();
  const bulletRe = /^- ((?:`[^`]+`(?:,\s*)?)+)\s*→\s*`([\w.-]+\.md)`/gm;
  let match;
  while ((match = bulletRe.exec(claudeMdContent)) !== null) {
    const globs = [...match[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    result.set(match[2], globs);
  }
  return result;
}

/**
 * Diff CLAUDE.md's declared rule-glob prose against each rule file's actual
 * `paths:` frontmatter — an order-insensitive set comparison, since the
 * prose lists read most naturally in a hand-chosen order that need not match
 * the frontmatter array order.
 *
 * @param {Map<string, string[]>} claudeMdGlobs from {@link parseClaudeMdRuleGlobs}
 * @param {RuleFile[]} rules from {@link collectRuleFiles}
 * @returns {Array<{ rule: string, documented: string[], actual: string[] }>}
 */
export function diffRuleGlobParity(claudeMdGlobs, rules) {
  const mismatches = [];
  for (const rule of rules) {
    const documented = claudeMdGlobs.get(rule.name);
    if (documented === undefined) continue;
    const a = [...documented].sort();
    const b = [...rule.globs].sort();
    const same = a.length === b.length && a.every((g, i) => g === b[i]);
    if (!same) {
      mismatches.push({ rule: rule.name, documented, actual: rule.globs });
    }
  }
  return mismatches;
}

/**
 * @typedef {Object} ScenarioTotal
 * @property {string} probe representative path for this scenario
 * @property {string[]} rules matching rule file names, sorted
 * @property {number} bytes combined size
 */

/**
 * Group `.claude/rules/*.md` files into conditional-load scenarios: for each
 * distinct probe path derivable from any rule's glob, find every rule whose
 * glob(s) also match that probe, and sum their sizes. This is what "editing
 * `packages/m3l-common/src/**`" actually costs — not one rule file's size in
 * isolation, but every rule that would ALSO load for that same edit.
 *
 * @param {RuleFile[]} rules
 * @returns {ScenarioTotal[]} sorted by bytes descending, deduplicated by probe
 */
export function deriveScenarioTotals(rules) {
  const compiled = rules.map((r) => ({
    ...r,
    regexes: r.globs.map(globToRegExp),
  }));

  /** @type {Map<string, ScenarioTotal>} */
  const byProbe = new Map();
  for (const rule of compiled) {
    for (const glob of rule.globs) {
      const probe = globToProbePath(glob);
      if (byProbe.has(probe)) continue;
      const matching = compiled.filter((r) =>
        r.regexes.some((re) => re.test(probe)),
      );
      byProbe.set(probe, {
        probe,
        rules: matching.map((r) => r.name).sort(),
        bytes: matching.reduce((sum, r) => sum + r.bytes, 0),
      });
    }
  }
  return [...byProbe.values()].sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// .claude/rules ratchet baseline (mirrors bin/check-file-budget.mjs)
// ---------------------------------------------------------------------------

/**
 * @param {RuleFile[]} rules
 * @param {Record<string, number>} baseline relPath -> recorded byte ceiling
 * @returns {Array<{ path: string, bytes: number, limit: number, baselined: boolean }>}
 */
export function checkRuleBudget(rules, baseline) {
  const violations = [];
  for (const rule of rules) {
    const recorded = baseline[rule.relPath];
    if (recorded !== undefined) {
      if (rule.bytes > recorded) {
        violations.push({
          path: rule.relPath,
          bytes: rule.bytes,
          limit: recorded,
          baselined: true,
        });
      }
      continue;
    }
    if (rule.bytes > RULE_CEILING_BYTES) {
      violations.push({
        path: rule.relPath,
        bytes: rule.bytes,
        limit: RULE_CEILING_BYTES,
        baselined: false,
      });
    }
  }
  return violations;
}

/**
 * @param {RuleFile[]} rules
 * @returns {Record<string, number>} key-sorted
 */
export function buildRuleBaseline(rules) {
  /** @type {Record<string, number>} */
  const next = {};
  for (const rule of rules) {
    if (rule.bytes > RULE_CEILING_BYTES) next[rule.relPath] = rule.bytes;
  }
  return Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// ---------------------------------------------------------------------------
// .claude/skills/*/SKILL.md description weight
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SkillDescription
 * @property {string} name skill directory name
 * @property {number} chars description length
 */

/**
 * @param {string} skillsDir absolute path to `.claude/skills`
 * @returns {SkillDescription[]}
 */
export function collectSkillDescriptions(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  /** @type {SkillDescription[]} */
  const descriptions = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    const content = readFileSync(skillMdPath, "utf8");
    const fmBody = extractFrontmatterBody(content);
    // A skill with `disable-model-invocation: true` never appears in the
    // model's skill listing at all (Anthropic's docs) — reachable only by
    // its literal `/slug`, e.g. harness-guide. Counting its description
    // against the listing budget would charge for a description the model
    // never sees, so it's excluded entirely rather than just zeroed.
    if (
      fmBody !== null &&
      extractFrontmatterField(fmBody, "disable-model-invocation") === "true"
    ) {
      continue;
    }
    const description =
      fmBody === null ? "" : extractFrontmatterField(fmBody, "description");
    descriptions.push({ name: entry.name, chars: description.length });
  }
  return descriptions.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @typedef {Object} SkillListingBudget
 * @property {number} contextWindow reference context window, in tokens
 * @property {number} budgetTokens `contextWindow * fraction`, floored
 * @property {number} budgetChars `budgetTokens * 4` (chars/4 estimate, matching {@link estimateTokens})
 * @property {boolean} overBudget whether `totalChars` exceeds `budgetChars`
 */

/**
 * Compares total skill-description chars against Claude Code's documented
 * skill-listing budget (`code.claude.com/docs/en/skills`) for every window
 * in {@link SKILL_LISTING_REFERENCE_WINDOWS}.
 *
 * @param {number} totalChars sum of every skill's `description` length
 * @param {number} [fraction] defaults to {@link SKILL_LISTING_BUDGET_FRACTION}
 * @returns {SkillListingBudget[]}
 */
export function checkSkillListingBudget(
  totalChars,
  fraction = SKILL_LISTING_BUDGET_FRACTION,
) {
  return SKILL_LISTING_REFERENCE_WINDOWS.map((contextWindow) => {
    const budgetTokens = Math.floor(contextWindow * fraction);
    const budgetChars = budgetTokens * 4;
    return {
      contextWindow,
      budgetTokens,
      budgetChars,
      overBudget: totalChars > budgetChars,
    };
  });
}

// ---------------------------------------------------------------------------
// .claude/skills/*/SKILL.md and .claude/agents/*.md body weight (informational)
// ---------------------------------------------------------------------------

/**
 * The text after a leading YAML frontmatter block, or the whole content when
 * there is none — the payload actually injected at runtime (a skill's body
 * on invocation, an agent's prompt on dispatch), as opposed to the
 * frontmatter fields other parts of this gate already measure separately
 * (e.g. a skill's `description`).
 *
 * @param {string} content
 * @returns {string}
 */
export function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  return match === null ? content : content.slice(match[0].length);
}

/**
 * @typedef {Object} BodyWeight
 * @property {string} name skill directory name, or agent file basename
 * @property {number} bytes body byte length (frontmatter excluded)
 */

/**
 * @param {string} skillsDir absolute path to `.claude/skills`
 * @returns {BodyWeight[]} sorted by name
 */
export function collectSkillBodyBytes(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  /** @type {BodyWeight[]} */
  const bodies = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    const content = readFileSync(skillMdPath, "utf8");
    const body = stripFrontmatter(content);
    bodies.push({ name: entry.name, bytes: Buffer.byteLength(body, "utf8") });
  }
  return bodies.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {string} agentsDir absolute path to `.claude/agents`
 * @returns {BodyWeight[]} sorted by name
 */
export function collectAgentBodyBytes(agentsDir) {
  if (!existsSync(agentsDir)) return [];
  /** @type {BodyWeight[]} */
  const bodies = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = readFileSync(join(agentsDir, entry.name), "utf8");
    const body = stripFrontmatter(content);
    bodies.push({ name: entry.name, bytes: Buffer.byteLength(body, "utf8") });
  }
  return bodies.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// --exact: real token count via Anthropic's count_tokens endpoint
// ---------------------------------------------------------------------------

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";
const COUNT_TOKENS_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Call Anthropic's `POST /v1/messages/count_tokens` for `text`, under the
 * given model's tokenizer. Free of the message-creation quota (a separate,
 * documented rate limit) — see `platform.claude.com/docs/en/build-with-claude/token-counting`.
 *
 * @param {string} text
 * @param {{ apiKey: string, model?: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<number>} `input_tokens` from the API response
 * @throws {Error} on a non-OK response or a network failure — the caller
 *   decides whether that's fatal (this gate treats it as a warning, never a
 *   hard failure, since `--exact` is opt-in and never required for CI).
 */
export async function countTokensExact(
  text,
  { apiKey, model = COUNT_TOKENS_MODEL, fetchImpl = fetch },
) {
  const response = await fetchImpl(COUNT_TOKENS_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `count_tokens request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
    );
  }
  const payload = await response.json();
  if (typeof payload.input_tokens !== "number") {
    throw new Error(
      `count_tokens response missing a numeric "input_tokens" field: ${JSON.stringify(payload)}`,
    );
  }
  return payload.input_tokens;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);

  // --update only concerns the rules ratchet — handle and exit before
  // touching CLAUDE.md/@-imports at all, so it never prints unrelated
  // always-loaded errors on its way to a successful baseline write.
  if (argv.includes("--update")) {
    const rulesDirForUpdate = join(root, ".claude", "rules");
    const nextBaseline = buildRuleBaseline(collectRuleFiles(rulesDirForUpdate));
    writeFileSync(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`);
    const count = Object.keys(nextBaseline).length;
    reporter.change(
      "updated",
      baselineRel,
      `(${count} ${count === 1 ? "entry" : "entries"})`,
    );
    reporter.finish();
    process.exit(0);
  }

  // --- 1. Always-loaded budget: CLAUDE.md + resolved @-imports (hard cap) ---
  const claudeMdPath = join(root, "CLAUDE.md");
  let raw;
  try {
    raw = readFileSync(claudeMdPath, "utf8");
  } catch (error) {
    reporter.error(
      `Cannot read CLAUDE.md: ${error instanceof Error ? error.message : String(error)}`,
    );
    reporter.finish();
    process.exit(1);
  }

  const imports = resolveImportedFiles(raw, root);
  const blocks = [{ path: "CLAUDE.md", content: raw }, ...imports];

  let totalLines = 0;
  let totalTokens = 0;
  /** @type {Array<{ path: string, lines: number, tokens: number }>} */
  const perBlock = [];
  for (const block of blocks) {
    const normalized = normalizeRuntimeContent(
      stripBlockComments(block.content),
    );
    const { lines, tokens } = measure(normalized);
    perBlock.push({ path: block.path, lines, tokens });
    totalLines += lines;
    totalTokens += tokens;

    if (block.path === "CLAUDE.md") {
      for (const line of findWidePaddedTableLines(
        normalized,
        MAX_TABLE_LINE_WIDTH,
      )) {
        reporter.warn(
          `CLAUDE.md table row is ${line.length} chars (> ${MAX_TABLE_LINE_WIDTH}) — likely Prettier ` +
            `alignment padding: "${line.slice(0, 60)}…". Shorten the cell or move the table on-demand.`,
          { file: "CLAUDE.md" },
        );
      }
    }
  }

  let hardFail = false;
  if (totalLines > MAX_RUNTIME_LINES) {
    hardFail = true;
    reporter.error(
      `Resolved always-loaded content (CLAUDE.md + ${imports.length} @-import(s)) is ${totalLines} ` +
        `line(s) — exceeds the ${MAX_RUNTIME_LINES}-line budget. ` +
        `Per-block: ${perBlock.map((b) => `${b.path}=${b.lines}`).join(", ")}.`,
    );
  }
  if (totalTokens > MAX_APPROX_TOKENS) {
    hardFail = true;
    reporter.error(
      `Resolved always-loaded content is ~${totalTokens} approx. token(s) — exceeds the ` +
        `~${MAX_APPROX_TOKENS}-token budget. Per-block: ` +
        `${perBlock.map((b) => `${b.path}=${b.tokens}`).join(", ")}.`,
    );
  }

  // --- 1b. Optional --exact: real token count via Anthropic's count_tokens API ---
  if (argv.includes("--exact")) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reporter.warn(
        "--exact requested but ANTHROPIC_API_KEY is not set — skipping the real token count.",
      );
    } else {
      const combinedText = blocks
        .map((b) => normalizeRuntimeContent(stripBlockComments(b.content)))
        .join("\n\n");
      try {
        const exactTokens = await countTokensExact(combinedText, { apiKey });
        const delta = exactTokens - totalTokens;
        reporter.info(
          `Exact token count (count_tokens API, ${COUNT_TOKENS_MODEL}): ${exactTokens} ` +
            `(chars/4 estimate was ~${totalTokens}, ${delta >= 0 ? "+" : ""}${delta}).`,
        );
      } catch (error) {
        // Never fatal — --exact is opt-in and must not turn a network hiccup
        // into a broken gate.
        reporter.warn(
          `--exact token count failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // --- 2. .claude/rules/*.md ratchet ---
  const rulesDir = join(root, ".claude", "rules");
  const rules = collectRuleFiles(rulesDir);

  /** @type {Record<string, number>} */
  let ruleBaseline = {};
  if (existsSync(baselinePath)) {
    try {
      ruleBaseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch (cause) {
      reporter.error(
        `Could not parse ${baselineRel}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      reporter.finish();
      process.exit(1);
    }
  }

  const ruleViolations = checkRuleBudget(rules, ruleBaseline);
  for (const v of ruleViolations) {
    hardFail = true;
    if (v.baselined) {
      reporter.error(
        `${v.path}: ${v.bytes} bytes — grew past its baselined ceiling of ${v.limit} ` +
          `(${baselineRel}).`,
        { file: v.path },
      );
    } else {
      reporter.error(
        `${v.path}: ${v.bytes} bytes — exceeds the ${RULE_CEILING_BYTES}-byte ceiling and is not ` +
          `in the baseline. Split it, or run \`node bin/check-context-budget.mjs --update\` and ` +
          `explain why in the PR body.`,
        { file: v.path },
      );
    }
  }

  // --- 2b. CLAUDE.md rule-glob prose vs. rule-file frontmatter parity ---
  const claudeMdRuleGlobs = parseClaudeMdRuleGlobs(raw);
  const ruleGlobMismatches = diffRuleGlobParity(claudeMdRuleGlobs, rules);
  for (const m of ruleGlobMismatches) {
    hardFail = true;
    reporter.error(
      `CLAUDE.md's rule-glob list for \`${m.rule}\` says [${m.documented.join(", ")}] but ` +
        `.claude/rules/${m.rule}'s \`paths:\` frontmatter declares [${m.actual.join(", ")}] — ` +
        `update CLAUDE.md's "Coding, errors & tests" bullet to match.`,
      { file: "CLAUDE.md" },
    );
  }

  // --- 3. .claude/skills/*/SKILL.md description weight (informational) ---
  const skillsDir = join(root, ".claude", "skills");
  const skillDescriptions = collectSkillDescriptions(skillsDir);
  const totalSkillDescChars = skillDescriptions.reduce(
    (sum, s) => sum + s.chars,
    0,
  );
  for (const skill of skillDescriptions) {
    if (skill.chars > SKILL_DESC_WARN_CHARS) {
      reporter.warn(
        `.claude/skills/${skill.name}/SKILL.md description is ${skill.chars} chars — over the ` +
          `${SKILL_DESC_WARN_CHARS}-char listing-truncation threshold (code.claude.com/docs/en/skills).`,
        { file: `.claude/skills/${skill.name}/SKILL.md` },
      );
    }
  }

  // --- 3b. Aggregate skill-listing budget vs. Claude Code's ~1%-of-context-window cap (HARD at SKILL_LISTING_ENFORCED_WINDOW) ---
  const listingBudgets = checkSkillListingBudget(totalSkillDescChars);
  const estListingTokens = Math.ceil(totalSkillDescChars / 4);
  const enforcedBudget = listingBudgets.find(
    (b) => b.contextWindow === SKILL_LISTING_ENFORCED_WINDOW,
  );
  if (enforcedBudget?.overBudget) {
    hardFail = true;
    reporter.error(
      `Skill listing is ${totalSkillDescChars} chars (~${estListingTokens} tokens) — over the ` +
        `${enforcedBudget.budgetTokens}-token (~${enforcedBudget.budgetChars}-char) listing budget ` +
        `Claude Code enforces at a ${SKILL_LISTING_ENFORCED_WINDOW.toLocaleString()}-token context ` +
        `window (${SKILL_LISTING_BUDGET_FRACTION * 100}% of context, code.claude.com/docs/en/skills). ` +
        `On overflow Claude Code drops descriptions starting with the least-invoked skills — trim the ` +
        `longest descriptions below, or raise skillListingBudgetFraction in settings.json.`,
    );
  }

  // --- 4. .claude/skills/*/SKILL.md + .claude/agents/*.md BODY weight (informational) ---
  const skillBodies = collectSkillBodyBytes(skillsDir);
  const totalSkillBodyBytes = skillBodies.reduce((sum, s) => sum + s.bytes, 0);
  const agentsDir = join(root, ".claude", "agents");
  const agentBodies = collectAgentBodyBytes(agentsDir);
  const totalAgentBodyBytes = agentBodies.reduce((sum, a) => sum + a.bytes, 0);

  // --- Scenario totals (informational) ---
  const scenarios = deriveScenarioTotals(rules);

  reporter.info(
    `Always-loaded: ${totalLines} line(s), ~${totalTokens} approx. token(s) across ${blocks.length} block(s).`,
  );
  reporter.info(
    `Rules ratchet: ${rules.length} file(s) checked, ${ruleViolations.length} violation(s).`,
  );
  reporter.info(
    `Rule-glob parity: ${claudeMdRuleGlobs.size} documented, ${ruleGlobMismatches.length} mismatch(es).`,
  );
  reporter.info(
    `Skill listing: ${skillDescriptions.length} description(s), ${totalSkillDescChars} total chars ` +
      `(~${estListingTokens} tokens).`,
  );
  for (const b of listingBudgets) {
    reporter.info(
      `  listing budget @ ${b.contextWindow.toLocaleString()}-token context: ` +
        `${b.budgetTokens.toLocaleString()}-token budget — ${b.overBudget ? "OVER" : "within budget"}.`,
    );
  }
  reporter.info(
    `Skill bodies: ${skillBodies.length} SKILL.md body(ies), ${totalSkillBodyBytes} total bytes (not ratcheted — visibility only).`,
  );
  for (const skill of [...skillBodies]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)) {
    reporter.info(`  ${skill.name}/SKILL.md: ${skill.bytes} bytes`);
  }
  reporter.info(
    `Agent bodies: ${agentBodies.length} agent file(s), ${totalAgentBodyBytes} total bytes (not ratcheted — visibility only).`,
  );
  for (const agent of [...agentBodies]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)) {
    reporter.info(`  .claude/agents/${agent.name}: ${agent.bytes} bytes`);
  }
  for (const scenario of scenarios.slice(0, 10)) {
    reporter.info(
      `  scenario ${scenario.probe}: ${scenario.rules.join(" + ")} = ${scenario.bytes} bytes`,
    );
  }

  const finishExtra = {
    lines: totalLines,
    approxTokens: totalTokens,
    perBlock,
    ruleViolations,
    ruleGlobMismatches,
    scenarios,
    skillDescriptions,
    totalSkillDescChars,
    listingBudgets,
    skillBodies,
    totalSkillBodyBytes,
    agentBodies,
    totalAgentBodyBytes,
  };

  if (hardFail) {
    const finalReport = reporter.finish(finishExtra);
    if (!json)
      console.error(
        `\n✗  ${finalReport.errors.length} context-budget violation(s).`,
      );
    process.exit(1);
  }

  reporter.succeed(
    `Context budget within bounds: always-loaded ${totalLines} lines / ~${totalTokens} tokens ` +
      `(cap ${MAX_RUNTIME_LINES}/${MAX_APPROX_TOKENS}); ${rules.length} rule file(s) within ratchet.`,
  );
  reporter.finish(finishExtra);
}
