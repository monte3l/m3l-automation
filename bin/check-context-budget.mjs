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
 * Three checks, three different enforcement shapes:
 *
 *   1. Always-loaded budget (CLAUDE.md + resolved imports): a HARD ceiling,
 *      MAX_RUNTIME_LINES / MAX_APPROX_TOKENS — no ratchet. This surface is
 *      paid on every session and every custom-spoke launch; it must fit, not
 *      just track its own growth.
 *   2. `.claude/rules/*.md` conditional-load weight: a RATCHET, mirroring
 *      `bin/check-file-budget.mjs` exactly — a baselined file may shrink but
 *      never grow past its recorded size; an unbaselined file must stay under
 *      RULE_CEILING_BYTES. Two of six existing rule files are already well
 *      over any reasonable per-file ceiling (library-src.md at 28,002 B is
 *      2x CLAUDE.md's own budget) — a flat cap would fail on day one, same
 *      rationale as check-file-budget.mjs.
 *   3. `.claude/skills/<name>/SKILL.md` description weight: INFORMATIONAL —
 *      total listing weight plus a WARN for any single description over
 *      1,536 chars, the documented Claude Code listing-truncation threshold
 *      (`code.claude.com/docs/en/skills`). Not ratcheted: descriptions churn
 *      with normal skill-writing edits and a hard gate here would fight that.
 *
 * Usage:
 *   node bin/check-context-budget.mjs            # verify (fails on any hard violation)
 *   node bin/check-context-budget.mjs --update    # rewrite the rules ratchet baseline
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
    const description =
      fmBody === null ? "" : extractFrontmatterField(fmBody, "description");
    descriptions.push({ name: entry.name, chars: description.length });
  }
  return descriptions.sort((a, b) => a.name.localeCompare(b.name));
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

  // --- Scenario totals (informational) ---
  const scenarios = deriveScenarioTotals(rules);

  reporter.info(
    `Always-loaded: ${totalLines} line(s), ~${totalTokens} approx. token(s) across ${blocks.length} block(s).`,
  );
  reporter.info(
    `Rules ratchet: ${rules.length} file(s) checked, ${ruleViolations.length} violation(s).`,
  );
  reporter.info(
    `Skill listing: ${skillDescriptions.length} description(s), ${totalSkillDescChars} total chars.`,
  );
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
    scenarios,
    skillDescriptions,
    totalSkillDescChars,
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
