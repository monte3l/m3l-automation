// Pure derivation for the docs/adr/ index (ADR-0094's governance convention).
// No filesystem access here — bin/gen-adr-index.mjs and bin/check-adr-index.mjs
// both read the directory and hand this module the parsed data, mirroring
// bin/lib/reference-index.mjs's gen/check split.
//
// Reuses parseAdr()/classifyAdrStatusKind() from bin/lib/project-hub.mjs (the
// existing, tested ADR parser that already renders docs/adr into the
// published GitHub Pages hub) rather than re-parsing the Status line from
// scratch — this module only adds what ADR-0094 introduced on top of that:
// Relations parsing, reciprocity, the clause-list requirement, and the
// generated README index table.
//
// Shipped in two stages (ADR-0094's own Links section names this sequence):
//   PR2 (this file): advisory only — every finding is a warning, the corpus
//     is not yet normalized to the new schema, so a false positive here
//     would be noise, not signal.
//   PR3: after the 93-file mechanical sweep, the structural checks below
//     (STRUCTURAL_FINDING_KINDS) flip to blocking in bin/check-adr-index.mjs.
import { parseAdr } from "./project-hub.mjs";
import { displayWidth, padToDisplay } from "./reference-index.mjs";

/** Where the ADR corpus lives. */
export const ADR_DIR = "docs/adr";

/** The index this gate verifies against ADR_DIR's contents. */
export const README_PATH = "docs/adr/README.md";

/** Generated-block markers in docs/adr/README.md's `## Index` section. */
export const BEGIN_MARKER = "<!-- BEGIN GENERATED ADR INDEX -->";
export const END_MARKER = "<!-- END GENERATED ADR INDEX -->";

// Anchored to a whole line, not a bare substring search: docs/adr/README.md's
// own Conventions section quotes both marker names inline, as documentation,
// inside a backticked prose bullet ("...inside the `<!-- BEGIN GENERATED ADR
// INDEX -->` ... markers"). A plain `content.indexOf(BEGIN_MARKER)` finds
// that prose occurrence first and inserts the generated table into the
// middle of a sentence — confirmed live before this fix (`node
// bin/gen-adr-index.mjs` corrupted the Conventions paragraph on first run).
// Requiring the marker to be the *entire* trimmed line rules out any inline
// prose quotation, wherever it appears in the file.
const BEGIN_LINE_RE = /^<!-- BEGIN GENERATED ADR INDEX -->$/m;
const END_LINE_RE = /^<!-- END GENERATED ADR INDEX -->$/m;

/**
 * Locate the real generated block — the marker pair that each occupy a whole
 * line by themselves — as character offsets into `content`. Returns `null`
 * if either marker is absent as a standalone line, or the end marker
 * doesn't follow the begin marker.
 *
 * @param {string} content docs/adr/README.md's full text
 * @returns {{ start: number, end: number } | null} `start` is the begin
 *   marker's own line start; `end` is one past the end marker's line end —
 *   i.e. `content.slice(start, end)` is the whole block, markers included.
 */
export function findGeneratedBlockRange(content) {
  const beginMatch = BEGIN_LINE_RE.exec(content);
  if (!beginMatch) return null;

  const afterBegin = content.slice(beginMatch.index + beginMatch[0].length);
  const endMatch = END_LINE_RE.exec(afterBegin);
  if (!endMatch) return null;

  return {
    start: beginMatch.index,
    end:
      beginMatch.index +
      beginMatch[0].length +
      endMatch.index +
      endMatch[0].length,
  };
}

/**
 * ADR-0094's closed set of `Relations:` verbs. Every entry in a `Relations:`
 * line must use one of these, spelled exactly.
 */
export const VALID_RELATION_VERBS = new Set([
  "supersedes",
  "superseded-by",
  "partially-supersedes",
  "partially-superseded-by",
  "amends",
  "amended-by",
  "re-affirmed-by",
  "fires-trigger-of",
  "trigger-fired-by",
]);

/**
 * The verb pairs ADR-0094's reciprocity rule checks: if ADR A declares the
 * key verb pointing at ADR B, ADR B must declare the value verb pointing
 * back at ADR A. `re-affirmed-by` is deliberately absent — ADR-0094's schema
 * defines no `re-affirms` counterpart (a re-affirmation only ever points
 * backward from the newer ADR; the original README convention it codifies,
 * `docs/adr/README.md`'s "e.g. ADR-0012 → ADR-0023", never required the
 * older ADR to point forward either), so it is intentionally one-directional
 * and never flagged as non-reciprocal.
 */
export const RECIPROCAL_VERB = {
  supersedes: "superseded-by",
  "superseded-by": "supersedes",
  "partially-supersedes": "partially-superseded-by",
  "partially-superseded-by": "partially-supersedes",
  amends: "amended-by",
  "amended-by": "amends",
  "fires-trigger-of": "trigger-fired-by",
  "trigger-fired-by": "fires-trigger-of",
};

/** Verbs whose entry must carry a `(clauses: …)` qualifier (ADR-0094). */
const CLAUSE_REQUIRED_VERBS = new Set([
  "partially-supersedes",
  "partially-superseded-by",
]);

/**
 * Placeholder tokens that satisfy the `(clauses: …)` regex's non-empty check
 * (`bin/lib/adr-index.mjs`'s `parseRelations()`) without naming anything a
 * reader could act on — `(clauses: TBD)` parses to a truthy, non-whitespace
 * string today and passes silently. Matched whole-value (after trimming),
 * case-insensitively, so a real clause list that happens to mention one of
 * these words mid-sentence is never caught by mistake.
 */
const PLACEHOLDER_CLAUSE_RE = /^(?:tbd|todo|n\/a|\?+|\.{3}|…|-)$/i;

/**
 * One `Relations:` entry: `<verb>: <NNNN>` optionally followed by
 * `(clauses: …)`. Global so every entry on a line is captured, not just the
 * first — a Relations line typically lists several.
 */
const RELATION_ENTRY_RE =
  /([a-z][a-z-]*):\s*(\d{4})\s*(?:\(clauses:\s*([^)]*)\))?/g;

/**
 * @typedef {{ verb: string, number: number, clauses: string | undefined }} AdrRelation
 * @typedef {{
 *   number: number,
 *   filename: string,
 *   title: string,
 *   statusText: string,
 *   statusKind: string,
 *   relations: AdrRelation[],
 *   date: string | undefined,
 *   reviewBy?: string | undefined,
 * }} AdrEntry
 * @typedef {{ kind: string, message: string }} AdrIndexFinding
 */

/**
 * Parse a `- **Relations:** …` value into its individual entries. Tolerant
 * of a `(clauses: …)` qualifier containing its own commas or semicolons —
 * matched by an explicit per-entry regex rather than a naive comma split,
 * which a clause list like "the publish pipeline; §Decision 2" would not
 * survive intact if it happened to contain a comma.
 *
 * @param {string} relationsText the Relations line's value, or "" if absent
 * @returns {AdrRelation[]}
 */
export function parseRelations(relationsText) {
  if (!relationsText) return [];
  return Array.from(relationsText.matchAll(RELATION_ENTRY_RE)).map((m) => ({
    verb: m[1],
    number: parseInt(m[2], 10),
    clauses: m[3]?.trim() || undefined,
  }));
}

/**
 * The file's header block only — from the top through (not including) the
 * first `##` section heading. The Status/Relations/Date bullets always live
 * here; scoping to this region (rather than scanning the whole file) is
 * required, not just defensive: ADR-0094 itself illustrates the
 * `- **Relations:** …` syntax inside a fenced code example in its body, and
 * a whole-document regex matches that illustration as if it were the file's
 * own Relations line (confirmed live: `node bin/check-adr-index.mjs` against
 * the real corpus before this fix falsely reported ADR-0094 declaring a
 * `partially-superseded-by: 0057` relation it does not have).
 *
 * @param {string} content
 * @returns {string}
 */
function headerBlock(content) {
  const firstSection = /^##\s/m.exec(content);
  return firstSection ? content.slice(0, firstSection.index) : content;
}

/**
 * Parse one `docs/adr/NNNN-slug.md` file into an {@link AdrEntry}, extending
 * `parseAdr()`'s fields with `filename` and `relations`. Returns `null` for
 * a filename that doesn't match the ADR naming convention (`README.md`,
 * `template.md`), same as `parseAdr()`.
 *
 * @param {string} filename basename only
 * @param {string} content file contents
 * @returns {AdrEntry | null}
 */
export function parseAdrEntry(filename, content) {
  const base = parseAdr(filename, content);
  if (!base) return null;

  const header = headerBlock(content);
  const relationsMatch = /^-\s*\*\*Relations:\*\*\s*(.+)$/m.exec(header);
  const relations = parseRelations(relationsMatch?.[1]?.trim() ?? "");

  // Optional (docs/decision-notes/0001-deferral-review-by-dates.md): a
  // deferral with a named-but-unfired revisit trigger can carry a
  // Review by: date so it isn't forgotten indefinitely — checkAdrIndex()
  // warns once it's passed. Scoped to the header block for the same reason
  // Relations: is (see headerBlock()'s own doc comment).
  const reviewByMatch = /^-\s*\*\*Review by:\*\*\s*(\d{4}-\d{2}-\d{2})/m.exec(
    header,
  );
  const reviewBy = reviewByMatch?.[1];

  return { ...base, filename, relations, reviewBy };
}

/**
 * Render the ADR/Title/Status Markdown table, column widths padded to match
 * what `prettier`'s own GFM table formatter produces (reusing
 * `reference-index.mjs`'s `displayWidth`/`padToDisplay`, the same helpers
 * `buildReadmeBlock` uses for `docs/reference/README.md`'s generated table).
 * Emitting unpadded cells here and relying on a later `prettier --write`
 * pass to align them causes exactly the oscillation this avoids: the
 * generator's own output would differ from the committed, prettier-formatted
 * file, so `check-adr-index.mjs`'s byte-for-byte comparison would never
 * settle (confirmed live: `pnpm format` reflowed the first unpadded version
 * of this table, which then failed a re-run of `check:adr-index`).
 *
 * @param {AdrEntry[]} entries sorted by `number` ascending
 * @returns {string}
 */
export function buildAdrIndexTable(entries) {
  const header = ["ADR", "Title", "Status"];
  const dataRows = entries.map((entry) => [
    String(entry.number).padStart(4, "0"),
    `[${entry.title}](./${entry.filename})`,
    entry.statusText,
  ]);
  const colWidths = header.map((h, col) =>
    Math.max(displayWidth(h), ...dataRows.map((r) => displayWidth(r[col]))),
  );
  const fmtRow = (cells) =>
    "| " +
    cells.map((c, i) => padToDisplay(c, colWidths[i])).join(" | ") +
    " |";
  const separator =
    "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  return [fmtRow(header), separator, ...dataRows.map(fmtRow)].join("\n");
}

/** Static do-not-hand-edit notice included in every generated block. */
const GENERATED_BLOCK_NOTICE =
  "<!-- Do not hand-edit this block — run `pnpm gen:adr-index` " +
  "(bin/gen-adr-index.mjs)\n     to regenerate it from each ADR's own " +
  "status block. `pnpm check:adr-index`\n     verifies it matches a fresh " +
  "re-derivation. -->";

/**
 * Build the full generated-block content, markers included, from a parsed
 * entry list — what `gen-adr-index.mjs` writes and `check-adr-index.mjs`
 * diffs the committed block against.
 *
 * @param {AdrEntry[]} entries
 * @returns {string}
 */
export function buildGeneratedBlock(entries) {
  return [
    BEGIN_MARKER,
    GENERATED_BLOCK_NOTICE,
    "",
    buildAdrIndexTable(entries),
    "",
    END_MARKER,
  ].join("\n");
}

/**
 * ADR-0094's structural findings — the ones PR3 flips to blocking once the
 * corpus is normalized. Exported so `check-adr-index.mjs` can decide
 * severity per finding without duplicating this classification.
 *
 * `missing-clause-list` and `placeholder-clause-list` joined this set after
 * the corpus was confirmed clean of both (0 findings across 95 ADRs) — see
 * the audit that added them. ADR-0094:93-94 already states the clause
 * requirement in absolute terms ("no longer permitted"); moving these two
 * kinds here makes the gate enforce that rule structurally instead of
 * merely warning about a violation of it.
 */
export const STRUCTURAL_FINDING_KINDS = new Set([
  "unknown-status",
  "unknown-relation-verb",
  "dangling-relation-target",
  "non-reciprocal-relation",
  "duplicate-number",
  "missing-clause-list",
  "placeholder-clause-list",
]);

/**
 * Every finding kind this module can produce: the structural ones in
 * `STRUCTURAL_FINDING_KINDS` (blocking in bin/check-adr-index.mjs once the
 * corpus is normalized) plus the advisory-only ones (ADR-0094's bare
 * partial-supersession warning; docs/decision-notes/0001-deferral-review-by-dates.md's
 * `Review by:` date check).
 *
 * @param {AdrEntry[]} entries all parsed ADRs, unsorted
 * @param {string} [today] ISO date (YYYY-MM-DD), injectable for tests;
 *   defaults to the real current date for live use
 * @returns {AdrIndexFinding[]}
 */
export function checkAdrIndex(
  entries,
  today = new Date().toISOString().slice(0, 10),
) {
  /** @type {AdrIndexFinding[]} */
  const findings = [];
  const byNumber = new Map();
  for (const entry of entries) {
    const existing = byNumber.get(entry.number);
    if (existing) {
      findings.push({
        kind: "duplicate-number",
        message:
          `ADR number ${entry.number} is used by both ${existing.filename} ` +
          `and ${entry.filename}.`,
      });
    } else {
      byNumber.set(entry.number, entry);
    }
  }

  for (const entry of entries) {
    if (entry.reviewBy !== undefined && entry.reviewBy < today) {
      findings.push({
        kind: "review-by-passed",
        message:
          `${entry.filename}'s Review by: ${entry.reviewBy} has passed — ` +
          `revisit whether this deferral still stands.`,
      });
    }

    if (entry.statusKind === "Unknown") {
      findings.push({
        kind: "unknown-status",
        message:
          `${entry.filename}'s Status "${entry.statusText}" does not ` +
          `classify into any of ADR-0094's six kinds.`,
      });
    }

    for (const relation of entry.relations) {
      if (!VALID_RELATION_VERBS.has(relation.verb)) {
        findings.push({
          kind: "unknown-relation-verb",
          message:
            `${entry.filename}'s Relations entry uses "${relation.verb}", ` +
            `not one of ADR-0094's declared verbs.`,
        });
        continue;
      }

      if (CLAUSE_REQUIRED_VERBS.has(relation.verb)) {
        if (!relation.clauses) {
          findings.push({
            kind: "missing-clause-list",
            message:
              `${entry.filename}'s "${relation.verb}: ${String(relation.number).padStart(4, "0")}" ` +
              `entry has no "(clauses: …)" qualifier — ADR-0094 requires one ` +
              `for partial supersession.`,
          });
        } else if (PLACEHOLDER_CLAUSE_RE.test(relation.clauses.trim())) {
          findings.push({
            kind: "placeholder-clause-list",
            message:
              `${entry.filename}'s "${relation.verb}: ${String(relation.number).padStart(4, "0")}" ` +
              `entry's "(clauses: ${relation.clauses})" is a placeholder, not a real clause list.`,
          });
        }
      }

      const target = byNumber.get(relation.number);
      if (!target) {
        findings.push({
          kind: "dangling-relation-target",
          message:
            `${entry.filename}'s "${relation.verb}: ${String(relation.number).padStart(4, "0")}" ` +
            `entry points at an ADR number that does not exist.`,
        });
        continue;
      }

      const reciprocalVerb = RECIPROCAL_VERB[relation.verb];
      if (!reciprocalVerb) continue; // re-affirmed-by: intentionally one-directional
      const reciprocated = target.relations.some(
        (r) => r.verb === reciprocalVerb && r.number === entry.number,
      );
      if (!reciprocated) {
        findings.push({
          kind: "non-reciprocal-relation",
          message:
            `${entry.filename} declares "${relation.verb}: ${String(relation.number).padStart(4, "0")}" ` +
            `but ${target.filename} has no matching "${reciprocalVerb}: ${String(entry.number).padStart(4, "0")}" entry.`,
        });
      }
    }
  }

  return findings;
}
