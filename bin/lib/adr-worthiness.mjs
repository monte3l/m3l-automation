// Pure derivation for bin/check-adr-worthiness.mjs (ADR-0095): flags a new
// ADR that matches a specific low-blast-radius SHAPE as a decision-note
// candidate. Advisory only, a nudge at review time: the maintainer is this
// repo's sole reviewer and the gate must never block a legitimate ADR
// they've already decided to write (ADR-0095's own Decision drivers).
//
// Design history — why this isn't "flag unless a worthy topic is
// mentioned": an earlier version defaulted to flagging any ADR whose
// Consequences declared no semver impact, exempting only ADRs mentioning a
// short list of "worthy" phrases (public contract, harness-wide, etc.).
// Measured live against this repo's own 95-ADR corpus, that flagged 49 of
// them (~52%) — legitimate, foundational ADRs (the Node version floor, the
// license choice, signed-commit enforcement, the agent-operator programme,
// the Podman migration) simply don't use any of a finite keyword list,
// because the topics an ADR can legitimately cover are far more diverse
// than any such list can enumerate. That rate is exactly the "cries wolf"
// failure mode `.claude/rules/harness-artifacts.md` warns an advisory check
// must never exhibit — a reader trains themselves to ignore a check that's
// wrong half the time, defeating the nudge's purpose entirely.
//
// This version inverts the polarity: instead of flagging broadly and
// exempting known-worthy topics, it flags narrowly — only an ADR matching
// one of a small set of SPECIFIC low-value shapes ADR-0095's own Context
// section named as the audit's actual examples (a label/milestone rename;
// widening one lint/type-check zone to admit a single named module) with no
// semver impact. This trades recall for precision on purpose: missing a
// genuinely low-value ADR that doesn't match either shape costs nothing (the
// gate is advisory), but a false positive against a legitimate architectural
// ADR is the failure mode worth guarding against. Measured against the same
// 95-ADR corpus, this version flags exactly one — ADR-0074, a milestone-label
// retitle and one of ADR-0095's own cited audit examples — see
// bin/tests/adr-worthiness.test.ts's live-corpus sanity check.
/**
 * Extract one `## <heading>` section's body (text after the heading line, up
 * to the next `## ` heading or end of file) — scoped so `SEMVER_NONE_RE`
 * only matches the ADR's own declared impact, never a quoted or discussed
 * `- **Semver impact:** none` from another ADR mentioned in Context or
 * Links. Mirrors bin/lib/adr-index.mjs's `headerBlock()` scoping fix for
 * the identical class of false positive (confirmed live there: a whole-
 * document regex matched an illustrative example instead of the real
 * field).
 *
 * @param {string} content
 * @param {string} heading exact heading text, no `##`/leading space
 * @returns {string} the section body, or "" if the heading isn't present
 */
function section(content, heading) {
  // No "m" flag: the trailing `$` must mean end-of-STRING, not end-of-line —
  // under "m" it matches before every "\n" in the document, so the
  // non-greedy `[\s\S]*?` lookahead succeeds at the very first newline and
  // the whole section always captures empty (confirmed live: this exact bug
  // made SEMVER_NONE_RE never match, silently flagging zero ADRs). `^` is
  // instead anchored via `(?:^|\n)`, which needs no multiline flag.
  const re = new RegExp(`(?:^|\\n)## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
  return re.exec(content)?.[1] ?? "";
}

/** Matches a Consequences bullet declaring no semver impact. */
const SEMVER_NONE_RE = /\*\*Semver impact:\*\*\s*none\b/i;

/**
 * The specific low-blast-radius shapes ADR-0095's Context section names as
 * the audit's actual examples of ADR-writing-as-rubber-stamp: a label or
 * milestone rename/retitle, and widening one lint/type-check zone to admit
 * a single named module. Deliberately narrow and literal rather than a
 * broad topic-keyword list — see the module header for why breadth failed.
 */
const LOW_VALUE_SHAPE_RE =
  /\bretitle\b|\brenam(?:e|ing|ed)\b.{0,40}\b(?:label|milestone)\b|\bwiden(?:s|ing)?\b.{0,60}\bzone\b.{0,40}\b(?:a |one )?(?:single )?module\b/i;

/**
 * @typedef {{ filename: string, content: string }} AdrFile
 */

/**
 * Flag every ADR in `candidates` whose title or Consequences matches a
 * known low-value shape and whose own Consequences section declares no
 * semver impact.
 *
 * @param {AdrFile[]} candidates - ADRs to evaluate (the caller decides which
 *   ones are "new" — this module has no git access of its own)
 * @returns {string[]} filenames flagged as decision-note candidates
 */
export function deriveWorthinessCandidates(candidates) {
  /** @type {string[]} */
  const flagged = [];

  for (const { filename, content } of candidates) {
    const consequences = section(content, "Consequences");
    if (!SEMVER_NONE_RE.test(consequences)) continue;

    const titleLine = /^#\s+(.+)$/m.exec(content)?.[1] ?? "";
    if (
      !LOW_VALUE_SHAPE_RE.test(titleLine) &&
      !LOW_VALUE_SHAPE_RE.test(consequences)
    ) {
      continue;
    }

    flagged.push(filename);
  }

  return flagged;
}
