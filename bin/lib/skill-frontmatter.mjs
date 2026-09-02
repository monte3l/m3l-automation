// Pure derivations for `bin/check-skill-frontmatter.mjs` — no filesystem
// reads here; the CLI wrapper collects `.claude/skills/*/SKILL.md` file
// contents and hands them in, mirroring `bin/lib/integration-stance.mjs`'s
// shape so this stays exercisable in tests without spawning anything.

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---/;

/**
 * Extract the YAML frontmatter block (the raw text between the first two
 * `---` lines) as one string.
 *
 * Mirrors `bin/check-context-budget.mjs`'s `extractFrontmatterBody` exactly
 * — duplicated rather than imported to keep this gate independent of that
 * script's own export surface (both parse the same skill-frontmatter shape
 * for unrelated purposes: listing-budget weight there, structural validity
 * here).
 *
 * @param {string} content
 * @returns {string | null} the frontmatter block, or `null` if the file has none
 */
export function extractFrontmatterBody(content) {
  const match = content.match(FRONTMATTER_PATTERN);
  return match === null ? null : match[1];
}

/**
 * Extract one frontmatter field's value — either an inline scalar
 * (`name: auditing`) or a YAML folded/literal block scalar (`description:
 * >-` followed by indented lines), joined into one string.
 *
 * @param {string} fmBody output of {@link extractFrontmatterBody}
 * @param {string} key
 * @returns {string} the field's value, or `""` if absent
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
 * @typedef {Object} SkillFrontmatter
 * @property {string} dirName directory name under `.claude/skills/`
 * @property {string} name raw `name:` field value (`""` if absent)
 * @property {string} description raw `description:` field value (`""` if absent)
 */

/**
 * @param {{dirName: string, content: string}[]} skills
 * @returns {SkillFrontmatter[]}
 */
export function parseSkillFrontmatter(skills) {
  return skills.map(({ dirName, content }) => {
    const fmBody = extractFrontmatterBody(content);
    const name = fmBody === null ? "" : extractFrontmatterField(fmBody, "name");
    const description =
      fmBody === null ? "" : extractFrontmatterField(fmBody, "description");
    return { dirName, name, description };
  });
}

/**
 * @typedef {Object} FrontmatterIssues
 * @property {string[]} emptyDescription dirNames with a missing/empty `description`
 * @property {string[]} nameMismatch one message per skill whose `name:` field
 *   doesn't match its directory name
 */

/**
 * Validate the structural invariants `bin/check-agents.mjs` already enforces
 * for `.claude/agents/*.md` (non-empty `description`), plus a `name`-matches-
 * directory check with no existing equivalent for skills.
 *
 * @param {SkillFrontmatter[]} parsed
 * @returns {FrontmatterIssues}
 */
export function deriveFrontmatterIssues(parsed) {
  /** @type {FrontmatterIssues} */
  const issues = { emptyDescription: [], nameMismatch: [] };
  for (const { dirName, name, description } of parsed) {
    if (description.trim() === "") issues.emptyDescription.push(dirName);
    if (name.trim() !== dirName) {
      issues.nameMismatch.push(
        `${dirName}: name: field is "${name || "<missing>"}", expected "${dirName}"`,
      );
    }
  }
  return issues;
}

/**
 * Every skill directory name absent from the catalog's raw text — a plain
 * substring check, matching how a human re-checking coverage would `grep`
 * the file (`docs/contributing/skills-catalog.md` § How to re-check usage).
 *
 * @param {string[]} skillDirNames
 * @param {string} catalogContent
 * @returns {string[]}
 */
export function deriveMissingFromCatalog(skillDirNames, catalogContent) {
  return skillDirNames.filter((name) => !catalogContent.includes(name));
}

// ---------------------------------------------------------------------------
// Description overlap (warning-only) — flags skill pairs whose descriptions
// share enough vocabulary that a prose-triggered request could plausibly
// match either. Mirrors the SHAPE of check-context-budget.mjs's
// deriveScenarioTotals (pairwise comparison over a fixed corpus, reported for
// visibility) — not its content, which combines rule files per path scenario
// rather than comparing text similarity.
// ---------------------------------------------------------------------------

// Boilerplate common to nearly every description in this corpus ("Use for",
// "this skill", "the user says") — left untrimmed, these words dominate every
// pair's overlap score and make the metric measure phrasing convention
// instead of subject-matter similarity.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "use",
  "used",
  "using",
  "this",
  "skill",
  "when",
  "user",
  "says",
  "is",
  "are",
  "it",
  "its",
  "that",
  "not",
  "no",
  "any",
  "from",
  "into",
  "as",
  "via",
  "be",
  "been",
  "has",
  "have",
  "had",
  "can",
  "will",
  "would",
  "should",
  "was",
  "were",
  "if",
  "then",
  "than",
  "so",
  "out",
  "up",
  "down",
  "over",
  "under",
  "all",
  "each",
  "every",
  "also",
  "only",
  "just",
  "more",
  "most",
  "one",
  "two",
  "three",
  "four",
  "five",
  "you",
  "your",
  "their",
  "them",
  "they",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "where",
  "why",
  "how",
  "do",
  "does",
  "did",
  "done",
  "being",
  "still",
  "yet",
  "both",
  "either",
  "neither",
  "nor",
  "same",
  "other",
  "another",
  "some",
  "such",
  "own",
  "because",
  "before",
  "after",
  "while",
  "during",
  "without",
  "within",
  "across",
  "per",
]);

/**
 * Lowercased, stopword-filtered word set for a description's free text.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  const words = text.toLowerCase().match(/[a-z][a-z-]*[a-z]|[a-z]/g) ?? [];
  return new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0 (disjoint or both empty) to 1 (identical)
 */
export function jaccardSimilarity(a, b) {
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Threshold picked against this repo's real 22-skill corpus (2026-09-02): 0
 * pairs clear 0.25, and 0.15 surfaces exactly the pairs from adjacent
 * scaffold/implement skill families already reviewed and cleared for
 * cross-triggering risk (`implementing-submodules`/`scaffolding-submodules`,
 * `scaffolding-scripts`/`scaffolding-submodules`,
 * `implementing-scripts`/`implementing-submodules`) — a visible, non-noisy
 * starting point rather than a guessed round number.
 */
export const OVERLAP_WARN_THRESHOLD = 0.15;

/**
 * @typedef {Object} OverlappingPair
 * @property {[string, string]} pair dirNames, in file-listing order
 * @property {number} similarity Jaccard similarity, 0..1
 */

/**
 * @param {SkillFrontmatter[]} parsed
 * @param {number} [threshold] defaults to {@link OVERLAP_WARN_THRESHOLD}
 * @returns {OverlappingPair[]} sorted highest-similarity first
 */
export function deriveOverlappingPairs(
  parsed,
  threshold = OVERLAP_WARN_THRESHOLD,
) {
  const tokenized = parsed.map((s) => ({
    dirName: s.dirName,
    tokens: tokenize(s.description),
  }));
  /** @type {OverlappingPair[]} */
  const results = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const similarity = jaccardSimilarity(
        tokenized[i].tokens,
        tokenized[j].tokens,
      );
      if (similarity >= threshold) {
        results.push({
          pair: [tokenized[i].dirName, tokenized[j].dirName],
          similarity,
        });
      }
    }
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}
