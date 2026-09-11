// Pure decision logic for `.github/workflows/claude-pr-review.yml`'s guard,
// precompute, and Enforce steps — extracted so the gate's own control flow
// is unit tested instead of shipped on inference. Three historical fixes to
// this workflow (#503, #504, #566) shipped without a test harness; two of
// them broke production before being caught, and two PRs (#785, #806) that
// edited this very file merged with a *failing* required check because the
// gate structurally cannot review changes to itself. See
// bin/tests/pr-review-gate.test.ts and docs/research/pr-review-action-tuning.md.
//
// Also covers the loop-economics additions from PR 4 of that same effort:
// parsing the prior round's Must-fix list (`parseMustFixSection`),
// reconstructing a delta patch from GitHub's compare API
// (`buildDeltaPatch`), and counting genuine review rounds among a PR's
// claude[bot] comments (`countReviewComments`) — all feeding the
// guard/precompute steps' scoped re-review and round-bound path.
// `countReviewComments` exists as a pure function (not a bare `jq` filter
// on `.user.login == "claude[bot]"`, which was the first cut) because
// `claude-assistant.yml` responds to any `@claude` mention from any
// commenter with NO actor allowlist, posting as the same `claude[bot]`
// identity on the same PR thread — a login-only filter would let an
// unrelated reply inflate (or, if the round-bound math ever inverted, help
// evade) the round count. Filtering on "parses a `### Verdict` line" scopes
// the count to what the guard step's own PASS/FAIL logic already treats as
// a review, closing that gap without a GitHub-side actor-allowlist change.
//
// Mirrors bin/lib/pr-diff-filter.mjs's shape: a pure lib module, consumed by
// a thin CLI wrapper (bin/pr-review-gate.mjs) the workflow shells out to.
//
// Also covers the should-fix-ack gate's per-round binding (issue #1193):
// `collectShouldFixRounds`, `planShouldFixAckRanges`, and
// `describeShouldFixAckOutcome` — see bin/check-should-fix-ack.mjs, which
// composes them with git-backed classification of each round's reviewed
// commit. This replaced ADR-0097's original design, which read
// `selectShouldFixComment`'s single "loudest round" against one
// `base..head` presence test: PR #1190 proved live that a footer answering
// round 1's findings also satisfied round 2's unrelated, later findings —
// the under-reporting direction ADR-0097 did not anticipate (it documented
// only the opposite, over-reporting trade-off). `selectShouldFixComment`
// itself is unchanged and still backs the historical backfill measurement.

/** Matches the `### Verdict` heading's bullet line — `- PASS` or `- FAIL`,
 * immediately after the heading (only blank lines between). Anchored to the
 * bullet form deliberately: a bare word-search over the following lines
 * (the pattern this replaces) matches "PASS" inside a FAIL reason string
 * like `FAIL — this does not pass the export check`, converting a real FAIL
 * into a false PASS. */
const VERDICT_LINE_RE = /###\s*Verdict\s*\n+\s*-\s*(PASS|FAIL)\b/i;

/** Matches every `claude-review-sha` HTML-comment marker in a body, so the
 * caller can take the LAST one — the prompt requires the marker be the
 * comment's final line, so a quoted or restated SHA earlier in the body
 * (e.g. inside a code block discussing a prior round) must never win. */
const REVIEW_SHA_RE = /<!--\s*claude-review-sha:\s*([0-9a-f]+)\s*-->/gi;

/** A verdict-file line the model or a workflow step writes: `PASS`/`FAIL`,
 * optionally followed by whitespace and a commit SHA. */
const VERDICT_FILE_RE = /^(PASS|FAIL)(?:\s+([0-9a-f]{7,40}))?$/i;

/** Matches the `### Must-fix` section's body, up to the next `###` heading or
 * the trailing `claude-review-sha` HTML comment (whichever comes first) —
 * mirrors REVIEW.md's Output format section, which the workflow prompt
 * restates verbatim. */
const MUST_FIX_SECTION_RE =
  /###\s*Must-fix\s*\n+([\s\S]*?)(?=\n###\s|\n<!--|$)/i;

/** Same shape as {@link MUST_FIX_SECTION_RE}, for the `### Should-fix`
 * heading — see {@link parseShouldFixSection}. */
const SHOULD_FIX_SECTION_RE =
  /###\s*Should-fix\s*\n+([\s\S]*?)(?=\n###\s|\n<!--|$)/i;

/** Matches the placeholder REVIEW.md's Output format section specifies for
 * an empty tier — case-insensitive, tolerant of surrounding whitespace. */
const EMPTY_SECTION_RE = /^_none\._$/i;

/** One review-comment bullet, per REVIEW.md's Output format template:
 * `- **`path/to/file.ts:line`** — <violation> (<which rule>).` Used only to
 * count findings, so it need not capture the bullet's parts — just match one
 * line per finding, tolerant of the bullet marker being `-` or `*`. Anchored
 * to column zero deliberately (no leading `\s*`) — REVIEW.md's template
 * never nests a finding under another, so an indented `-`/`*` line is never
 * a second finding; it's either a sub-point the model added under one
 * finding's own text, or content inside a fenced code block a finding
 * quotes. Column-zero anchoring correctly excludes the first case. It does
 * NOT exclude a fenced block whose own content happens to start a line with
 * `- ` at column zero (e.g. a quoted unified diff) — full fence-awareness
 * would need real markdown parsing, which is disproportionate for a bullet
 * counter whose only consumer is a merge-gate finding count; a miscount
 * here fails toward over-counting, i.e. requiring an acknowledgment rather
 * than silently waving one through, which is the safer direction for that
 * gate to fail in. */
const FINDING_BULLET_RE = /^[-*]\s+/gm;

/** Matches an `Acknowledged-Should-Fix:` commit-footer trailer — the
 * acknowledgment channel for a Should-fix finding a PR intentionally merges
 * unresolved (mirrors `hasBreakingMarker()` in `bin/check-exports-semver.mjs`,
 * which reads the same PR commit range for a `BREAKING CHANGE:` footer). The
 * trailer's own text is not parsed further: its presence is the signal, and
 * the free-text reason after the colon is for a human reviewer, not this
 * function. Deliberately does not start with `Claude-` — the commit-msg hook
 * (`bin/lint-commit.mjs`'s `FORBIDDEN_TRAILER_PATTERN`) strips or rejects any
 * `Claude-*` trailer other than `Co-Authored-By`, so this name was chosen to
 * never collide with that guard. */
const SHOULD_FIX_ACK_RE = /(^|\n)\s*Acknowledged-Should-Fix:/i;

/**
 * The verdict (`PASS`/`FAIL`) stated under a review comment's `### Verdict`
 * heading, or `null` if no parseable verdict line exists.
 *
 * @param {string} body Full PR-comment body.
 * @returns {"PASS" | "FAIL" | null}
 */
export function parseVerdict(body) {
  const match = VERDICT_LINE_RE.exec(body);
  return match ? /** @type {"PASS" | "FAIL"} */ (match[1].toUpperCase()) : null;
}

/**
 * How many of the given `claude[bot]` comment bodies parse as an actual
 * review verdict (contain a `### Verdict` bullet) — used to bound the
 * review-round count so an unrelated `claude[bot]` comment on the same PR
 * thread (e.g. a `claude-assistant.yml` reply to an `@claude` mention from
 * any commenter, which carries no actor allowlist) can never inflate it.
 * Every body is checked independently with {@link parseVerdict}, so this is
 * equivalent to `bodies.filter((b) => parseVerdict(b) !== null).length`
 * spelled out as its own named operation for the guard step's CLI call.
 *
 * @param {string[]} bodies
 * @returns {number}
 */
export function countReviewComments(bodies) {
  return bodies.filter((body) => parseVerdict(body) !== null).length;
}

/**
 * The `claude-review-sha` marker's value — the LAST occurrence in `body`, or
 * `null` if none is present.
 *
 * @param {string} body Full PR-comment body.
 * @returns {string | null}
 */
export function parseReviewedSha(body) {
  const matches = [...body.matchAll(REVIEW_SHA_RE)];
  return matches.length === 0 ? null : matches[matches.length - 1][1];
}

/**
 * The raw `### Must-fix` section body from a review comment, or `null` when
 * the section is missing or reads the empty-tier placeholder (`_None._`).
 * Used to feed a delta re-review the prior round's outstanding Must-fix
 * items, so the reviewer can confirm each is resolved without re-reading the
 * whole PR — see the "Delta patch on re-review" step in
 * `claude-pr-review.yml`'s guard step.
 *
 * @param {string} body Full PR-comment body.
 * @returns {string | null}
 */
export function parseMustFixSection(body) {
  const match = MUST_FIX_SECTION_RE.exec(body);
  if (match === null) return null;
  const content = match[1].trim();
  if (content === "" || EMPTY_SECTION_RE.test(content)) return null;
  return content;
}

/**
 * The raw `### Should-fix` section body from a review comment, or `null`
 * when the section is missing or reads the empty-tier placeholder
 * (`_None._`). Mirrors {@link parseMustFixSection} exactly, for the tier
 * REVIEW.md defines as non-blocking but which this repo now requires be
 * either resolved or explicitly acknowledged before merge (see
 * {@link hasShouldFixAcknowledgment}).
 *
 * @param {string} body Full PR-comment body.
 * @returns {string | null}
 */
export function parseShouldFixSection(body) {
  const match = SHOULD_FIX_SECTION_RE.exec(body);
  if (match === null) return null;
  const content = match[1].trim();
  if (content === "" || EMPTY_SECTION_RE.test(content)) return null;
  return content;
}

/**
 * How many individual findings a non-empty `### Should-fix` section body
 * lists — one per bullet line. Returns `0` for a `null`/empty section (no
 * findings raised, nothing to acknowledge), matching
 * {@link parseShouldFixSection}'s "no section" and "empty tier" cases.
 *
 * @param {string | null} section A section body from
 *   {@link parseShouldFixSection}, or `null`.
 * @returns {number}
 */
export function countShouldFixFindings(section) {
  if (section === null || section.trim() === "") return 0;
  const matches = section.match(FINDING_BULLET_RE);
  return matches === null ? 0 : matches.length;
}

/**
 * Whether a PR's commit range carries an `Acknowledged-Should-Fix:` footer —
 * the one path that clears a non-empty Should-fix section without requiring
 * every finding be fixed (REVIEW.md still treats Should-fix as non-blocking
 * on correctness; this only requires the finding be *seen and decided*, not
 * resolved). Takes the same shape of input as
 * `hasBreakingMarker(commitLog)` in `bin/check-exports-semver.mjs` — the
 * concatenated `git log --format=%B <base>..<head>` output for the PR — so a
 * caller already computing that range for the exports-semver check can reuse
 * it here unchanged.
 *
 * @param {string} commitLog Concatenated commit messages across the PR's
 *   commit range.
 * @returns {boolean}
 */
export function hasShouldFixAcknowledgment(commitLog) {
  return SHOULD_FIX_ACK_RE.test(commitLog);
}

/**
 * Among a PR's posted `claude[bot]` comment bodies, the one that carries the
 * largest number of Should-fix findings — i.e. a round that enumerated them
 * as bullets, not a later re-review's suppressed count-only summary.
 * REVIEW.md's "Re-review convergence" rule instructs the reviewer to
 * suppress new Should-fix/Nit bullets on any round after the first,
 * reporting only a count in the summary line — so a naive "read the most
 * recent comment" strategy would silently stop enforcing acknowledgment the
 * moment a PR reaches a second review round, even though the first round's
 * findings are still outstanding.
 *
 * **This function is retained only for
 * {@link import("./should-fix-backfill.mjs").classifyPr}'s historical
 * measurement and `bin/pr-review-gate.mjs`'s matching CLI mode — it is NOT
 * how `bin/check-should-fix-ack.mjs` enforces acknowledgment.**
 * Its max-count heuristic rests on a premise later disproven live: PR #1190
 * round 2 posted 2 Should-fix findings structurally different from round
 * 1's 2 findings (a win32 `detached` cost and an untested `catch`, versus a
 * group-send fallback bug and a disputed Notes-count claim) — REVIEW.md's
 * suppression rule is not reliably obeyed by the reviewer in practice (round
 * 3 on that same PR did suppress correctly, from the identical unconditional
 * prompt), so "no later round ever posts more than round 1 did" does not
 * hold. Collapsing a PR's whole history to one "loudest" comment silently
 * discards whichever round did not win the max, whose specific findings
 * then never surface in a failure message and can be satisfied by an
 * unrelated round's footer. See {@link collectShouldFixRounds}, which
 * `check-should-fix-ack.mjs` uses instead: it keeps every round with
 * findings, each bound to its own reviewed commit, so no round is lost to
 * another round's count.
 *
 * Only bodies that parse a real verdict are considered (same filter as
 * {@link countReviewComments}), so an unrelated `claude-assistant.yml`
 * reply on the same PR thread can never be selected. Ties are broken
 * toward the later body in `bodies` (assumes chronological order, oldest
 * first, matching GitHub's default comment ordering) — both candidates
 * carry the same count in that case, so which one is returned doesn't
 * change the result of {@link countShouldFixFindings} downstream, only
 * which literal comment text a caller would quote.
 *
 * @param {string[]} bodies
 * @returns {string | null} The selected body, or `null` if none of `bodies`
 *   parses a verdict at all (e.g. the PR was never reviewed).
 */
export function selectShouldFixComment(bodies) {
  let best = null;
  let bestCount = -1;
  for (const body of bodies) {
    if (parseVerdict(body) === null) continue;
    const count = countShouldFixFindings(parseShouldFixSection(body));
    if (count >= bestCount) {
      best = body;
      bestCount = count;
    }
  }
  return best;
}

/**
 * @typedef {object} ShouldFixRound
 * @property {number} round 1-based ordinal among verdict-parsing bodies only
 *   (matches what a human means by "round 2") — not an index into `bodies`,
 *   since a non-verdict reply does not consume a round number.
 * @property {string | null} sha This round's `claude-review-sha` marker
 *   value, or `null` when the comment carries none.
 * @property {number} count Number of Should-fix findings this round posted.
 * @property {string} section The raw, non-empty `### Should-fix` section
 *   body.
 */

/**
 * Every review round that posted at least one Should-fix finding, in
 * posting order — the basis for binding an acknowledgment to the specific
 * round that raised it (`bin/check-should-fix-ack.mjs`), in place of
 * {@link selectShouldFixComment}'s single "loudest round" selection for
 * enforcement. Unlike that function, this reports EVERY round with
 * findings, each carrying its own reviewed `sha` — the case PR #1190 proved
 * live (round 2 raising two findings structurally different from round 1's
 * two) is exactly what a single "loudest round" selection collapses to one
 * round, silently discarding the other's specific findings.
 *
 * Two rounds that resolve to the same non-null `sha` (an edited or
 * re-posted comment for the same reviewed commit) collapse to one entry,
 * keeping the larger count — they describe one review, not two.
 *
 * @param {string[]} bodies Chronological, oldest first (GitHub's default
 *   comment ordering, and what the `round` ordinal assumes).
 * @returns {ShouldFixRound[]}
 */
export function collectShouldFixRounds(bodies) {
  /** @type {ShouldFixRound[]} */
  const rounds = [];
  let round = 0;
  for (const body of bodies) {
    if (parseVerdict(body) === null) continue;
    round += 1;
    const section = parseShouldFixSection(body);
    const count = countShouldFixFindings(section);
    if (count === 0) continue;
    rounds.push({
      round,
      sha: parseReviewedSha(body),
      count,
      section: /** @type {string} */ (section),
    });
  }

  /** @type {Map<string, number>} sha -> index in `deduped` of the kept entry */
  const keptIndexBySha = new Map();
  /** @type {ShouldFixRound[]} */
  const deduped = [];
  for (const entry of rounds) {
    if (entry.sha === null) {
      deduped.push(entry);
      continue;
    }
    const keptIndex = keptIndexBySha.get(entry.sha);
    if (keptIndex === undefined) {
      keptIndexBySha.set(entry.sha, deduped.length);
      deduped.push(entry);
      continue;
    }
    const kept = /** @type {ShouldFixRound} */ (deduped[keptIndex]);
    if (entry.count >= kept.count) {
      // Keep the FIRST-seen round ordinal — it matches this entry's fixed
      // array position — even when a later duplicate for the same sha wins
      // on count. Swapping in the later entry's `round` here would decouple
      // the ordinal from the position a caller indexes by, so a failure
      // message could read "Round 2" for the array's first entry.
      deduped[keptIndex] = { ...entry, round: kept.round };
    }
  }
  return deduped;
}

/**
 * A reviewed commit's trustworthiness as a range boundary, from the CLI's
 * git-backed classification (`bin/check-should-fix-ack.mjs`'s
 * `classifyReviewedSha`): `"usable"` when present locally and an ancestor of
 * the head under test; `"missing"` when the object does not exist in this
 * checkout at all (force-pushed away, or never fetched); `"unreachable"`
 * when it exists but is not an ancestor (the branch was rebased or amended
 * since that review was posted).
 *
 * @typedef {"usable" | "missing" | "unreachable"} ReviewedShaStatus
 */

/**
 * @typedef {object} AckRangePlan
 * @property {ShouldFixRound} round
 * @property {string} from
 * @property {string} to
 * @property {boolean} degraded Whether `from` fell back to `base` because
 *   `round.sha` could not be trusted as a range boundary.
 * @property {string | null} degradeReason Human-readable explanation, or
 *   `null` when not degraded.
 * @property {boolean} empty `from === to` — the round's own reviewed commit
 *   IS the head under test (it just posted these findings against this very
 *   commit), so no commit yet exists that could carry an acknowledgment for
 *   it. Never true for a degraded round unless `base === head` too.
 */

/**
 * Resolve the commit range each round's acknowledgment footer must appear
 * in: `<round's reviewed sha>..<head>`, falling back to the full
 * `<base>..<head>` (today's un-scoped range, the correct floor) whenever the
 * reviewed sha cannot be trusted as an ancestor of `head`. Degradation only
 * ever WIDENS a round's range, so it can never make the gate stricter than
 * it was before per-round scoping — contrast {@link resolveVerdict}'s
 * fail-closed policy, which concerns verdict *trust*, not range
 * *resolution*: a range gap here is an infrastructure limitation, not a
 * reason to fail a PR that may be entirely blameless for it.
 *
 * @param {ShouldFixRound[]} rounds
 * @param {{ base: string, head: string, shaStatus: Record<string, ReviewedShaStatus> }} ctx
 *   `shaStatus` should have an entry for every round's non-null `sha`; a
 *   missing entry degrades the same as `"missing"`.
 * @returns {AckRangePlan[]}
 */
export function planShouldFixAckRanges(rounds, { base, head, shaStatus }) {
  return rounds.map((round) => {
    if (round.sha !== null && shaStatus[round.sha] === "usable") {
      const from = round.sha;
      return {
        round,
        from,
        to: head,
        degraded: false,
        degradeReason: null,
        empty: from === head,
      };
    }
    const degradeReason =
      round.sha === null
        ? `round ${round.round}'s review comment carries no claude-review-sha marker`
        : shaStatus[round.sha] === "unreachable"
          ? `round ${round.round}'s reviewed commit ${round.sha} is present in this checkout but is not an ancestor of ${head} (branch rebased or amended since that review)`
          : `round ${round.round}'s reviewed commit ${round.sha} is not present in this checkout (force-pushed away, or never fetched)`;
    return {
      round,
      from: base,
      to: head,
      degraded: true,
      degradeReason,
      empty: base === head,
    };
  });
}

/**
 * @typedef {AckRangePlan & { acknowledged: boolean }} AckEvaluation
 */

/**
 * Render the pass/fail decision and human-readable messages for a set of
 * per-round ranges already checked for an `Acknowledged-Should-Fix:`
 * footer — pure string/decision work, kept out of the CLI so it is testable
 * with no git/gh seam at all.
 *
 * The empty-range case (`evaluation.empty`) gets its own message: it is not
 * a footer that failed to appear, it is a round whose reviewed commit IS the
 * head under test, so literally no commit yet exists that could carry one.
 * This is a forced, deliberate consequence of binding an acknowledgment to
 * the round that raised it — a round that just posted findings always fails
 * its own CI run once, and passes on the next push that carries the footer
 * (issue #1193).
 *
 * @param {AckEvaluation[]} evaluations
 * @returns {{ ok: boolean, unacknowledged: AckEvaluation[], degraded: AckEvaluation[], messages: string[], summary: string }}
 */
export function describeShouldFixAckOutcome(evaluations) {
  const degraded = evaluations.filter((evaluation) => evaluation.degraded);
  const unacknowledged = evaluations.filter(
    (evaluation) => !evaluation.acknowledged,
  );
  const messages = unacknowledged.map((evaluation) => {
    const shaLabel = evaluation.round.sha ?? "an unmarked commit";
    if (evaluation.empty) {
      return (
        `Round ${evaluation.round.round}'s ${evaluation.round.count} Should-fix finding(s) ` +
        `(reviewed ${shaLabel}) were posted against the commit under test — no commit exists ` +
        `yet that could acknowledge them. Push a commit carrying ` +
        "`Acknowledged-Should-Fix: <reason>` on top of " +
        `${evaluation.to}; the next review round's gate run will read ` +
        `${evaluation.to}..<new head> and find it.`
      );
    }
    return (
      `Round ${evaluation.round.round}'s ${evaluation.round.count} Should-fix finding(s) ` +
      `(reviewed ${shaLabel}) have no Acknowledged-Should-Fix: commit footer in ` +
      `${evaluation.from}..${evaluation.to}:\n\n${evaluation.round.section}`
    );
  });
  const ok = unacknowledged.length === 0;
  const summary = ok
    ? evaluations.length === 0
      ? "No Should-fix findings ever posted — nothing to acknowledge."
      : `${evaluations.length} review round(s) with Should-fix findings — all acknowledged in their own post-review commit range.`
    : `${unacknowledged.length} of ${evaluations.length} review round(s) with Should-fix findings are unacknowledged.`;
  return { ok, unacknowledged, degraded, messages, summary };
}

/**
 * @typedef {object} WorkflowGateChangeStatus
 * @property {boolean} includesWorkflowFile Whether the reviewable-file list
 *   contains `.github/workflows/claude-pr-review.yml`.
 * @property {string[]} otherReviewableFiles Every other reviewable file in
 *   the list, in input order — non-empty exactly when a PR mixes a change to
 *   the gate itself with other reviewable content.
 */

/** Repo-relative path of the review-gate workflow itself. */
export const REVIEW_GATE_WORKFLOW_PATH =
  ".github/workflows/claude-pr-review.yml";

/**
 * Whether a reviewable-file list includes the review-gate workflow, and what
 * else (if anything) is in the same list. GitHub withholds the OIDC token
 * `claude-code-action` needs whenever the *running* workflow file differs
 * from `main`'s copy, so a PR touching this file can never get a live
 * review of ANY of its reviewable content, not just the workflow diff — the
 * caller uses `otherReviewableFiles` to say so explicitly on such a PR
 * rather than silently auto-passing unreviewed files.
 *
 * @param {string[]} reviewableFiles Reviewable paths (already filtered by
 *   `bin/lib/pr-diff-filter.mjs`), in input order.
 * @returns {WorkflowGateChangeStatus}
 */
export function describeWorkflowGateChange(reviewableFiles) {
  const otherReviewableFiles = reviewableFiles.filter(
    (path) => path !== REVIEW_GATE_WORKFLOW_PATH,
  );
  return {
    includesWorkflowFile:
      otherReviewableFiles.length !== reviewableFiles.length,
    otherReviewableFiles,
  };
}

/**
 * @typedef {object} ParsedVerdictFile
 * @property {"PASS" | "FAIL" | null} verdict `null` when unparseable.
 * @property {string | null} sha The commit SHA stamped alongside the
 *   verdict, or `null` when the file carries none (the reject step, the
 *   auto-pass step, and the prior-PASS carry-forward step all write a bare
 *   verdict with no per-commit SHA — see {@link resolveVerdict}).
 */

/**
 * Parse a verdict-file's raw content into its verdict and optional SHA.
 *
 * @param {string} raw Raw file content.
 * @returns {ParsedVerdictFile}
 */
export function parseVerdictFile(raw) {
  const trimmed = raw.trim();
  const match = VERDICT_FILE_RE.exec(trimmed);
  if (match === null) return { verdict: null, sha: null };
  return {
    verdict: /** @type {"PASS" | "FAIL"} */ (match[1].toUpperCase()),
    sha: match[2] ?? null,
  };
}

/**
 * @typedef {object} ResolvedVerdict
 * @property {"PASS" | "FAIL" | null} verdict `null` when no trustworthy
 *   verdict could be established — the caller must fail closed.
 * @property {string} reason Human-readable explanation, for the workflow log.
 */

/**
 * The Enforce step's primary-path decision: is `fileContent` a verdict this
 * commit may trust?
 *
 * A verdict carrying a SHA (the model's own write) must match `headSha` or
 * it is rejected outright — this is what closes the gap where a stale
 * verdict file (left over from an earlier commit, or written by a step that
 * ran under different `if:` conditions than intended) was previously
 * indistinguishable from a fresh one at enforcement time. A verdict with no
 * SHA is trusted unconditionally: it can only have been written by the
 * reject step, the auto-pass step, or the prior-PASS carry-forward step —
 * all three are workflow-authored for the commit under test, with no
 * per-commit provenance to check.
 *
 * @param {string} fileContent Raw `.claude-review-verdict` content, or the
 *   empty string when the file is missing.
 * @param {string} headSha The commit SHA under test.
 * @returns {ResolvedVerdict}
 */
export function resolveVerdict(fileContent, headSha) {
  if (fileContent.trim() === "") {
    return { verdict: null, reason: "Verdict file is missing or empty." };
  }

  const { verdict, sha } = parseVerdictFile(fileContent);
  if (verdict === null) {
    return {
      verdict: null,
      reason: `Verdict file content is unparseable: ${JSON.stringify(fileContent.trim())}`,
    };
  }

  if (sha !== null && sha !== headSha) {
    return {
      verdict: null,
      reason: `Verdict file is stamped for ${sha}, not the commit under test (${headSha}) — stale, discarding.`,
    };
  }

  return {
    verdict,
    reason:
      sha === null
        ? `${verdict} (unstamped — workflow-authored, trusted for this commit).`
        : `${verdict} (stamped for ${sha}, matches head).`,
  };
}

/**
 * @typedef {object} CompareApiFile
 * @property {string} filename
 * @property {string} [previous_filename] Present only when `status` is
 *   `"renamed"`.
 * @property {"added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"} [status]
 * @property {number} [changes] `additions + deletions`; `0` means nothing
 *   textual changed (e.g. a pure rename or a mode-only change).
 * @property {string} [patch] Unified-diff hunks for this file, absent for a
 *   binary file or one over GitHub's per-file patch size cap.
 */

/**
 * @typedef {object} CompareApiResponse
 * @property {CompareApiFile[]} [files]
 */

/** GitHub's documented cap on the compare API's `files[]` array — beyond
 * this many changed files, the response silently omits the rest with no
 * truncation flag to detect it by. A delta whose file count reaches this
 * cap can never be trusted as the complete change set. */
const COMPARE_API_FILE_CAP = 300;

/**
 * Reconstruct a synthetic unified-diff patch from a GitHub compare-API
 * response (`GET /repos/{owner}/{repo}/compare/{base}...{head}`), in the
 * same `diff --git a/x b/x` / `--- a/x` / `+++ b/x` shape
 * `bin/lib/pr-diff-filter.mjs`'s patch-splitting regex expects — so the
 * delta-review path (a scoped compare against the prior PASS's commit,
 * instead of the full PR diff) can reuse that filter and the reviewable-size
 * measurement unmodified. Added/removed files get a `/dev/null` side
 * (matching real diff output); a renamed file's header names both the old
 * and new path.
 *
 * Returns `null` — instead of a patch string — whenever the response cannot
 * be trusted to represent the complete delta:
 * - the file list hits {@link COMPARE_API_FILE_CAP}, or
 * - any file has a confirmed-or-unknown content change (`changes` is a
 *   positive number, or `changes` is missing/non-numeric) but no `patch`
 *   field — GitHub withheld real diff content (binary, or over its
 *   per-file patch size cap) that this function cannot safely paper over
 *   with a placeholder: the reviewer would never see it, and the
 *   reviewable-byte size gate would never catch it either, since the
 *   placeholder is tiny. A placeholder is only ever emitted when `changes`
 *   positively confirms nothing textual changed (`=== 0`).
 *
 * The caller (the precompute step in `claude-pr-review.yml`) falls back to
 * the full, untruncated `gh pr diff` on a `null` return — a delta review is
 * an optimization the gate can always decline, never a requirement it can
 * silently under-deliver.
 *
 * @param {CompareApiResponse} compareResponse Parsed JSON response body.
 * @returns {string | null}
 */
export function buildDeltaPatch(compareResponse) {
  const files = compareResponse.files ?? [];
  if (files.length >= COMPARE_API_FILE_CAP) return null;

  const blocks = [];
  for (const file of files) {
    const oldName =
      file.status === "renamed" && typeof file.previous_filename === "string"
        ? file.previous_filename
        : file.filename;
    const fromPath = file.status === "added" ? "/dev/null" : `a/${oldName}`;
    const toPath =
      file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
    const header = `diff --git a/${oldName} b/${file.filename}\n--- ${fromPath}\n+++ ${toPath}`;

    if (typeof file.patch === "string" && file.patch.length > 0) {
      blocks.push(`${header}\n${file.patch}`);
      continue;
    }
    if (file.changes === 0) {
      blocks.push(
        `${header}\n(diff omitted — GitHub's compare API reported no content change for this file)`,
      );
      continue;
    }
    return null;
  }
  return blocks.join("\n");
}
