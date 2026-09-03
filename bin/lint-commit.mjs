#!/usr/bin/env node
// Thin wrapper around @commitlint/lint + @commitlint/load that replaces
// @commitlint/cli without pulling in the git-raw-commits transitive dep.
// See docs/adr/0008-commitlint-cli-replacement.md.
import process from "node:process";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import lint from "@commitlint/lint";
import load from "@commitlint/load";
import {
  CANONICAL_CLAUDE_MODELS,
  CO_AUTHOR_EMAIL,
  FORBIDDEN_TRAILER_PATTERN,
  parseCoAuthor,
} from "./lib/claude-models.mjs";

/**
 * Build the options object for `@commitlint/lint` from a loaded config.
 *
 * `@commitlint/lint(message, rules, opts)` honors `opts.parserOpts` — NOT
 * `opts.parserPreset`. Passing the preset object is silently ignored, so the
 * parser falls back to the default conventional-commits grammar whose header
 * pattern does not accept the `!` breaking marker, and `feat!: …` fails with
 * "type/subject may not be empty". Forwarding the preset's `parserOpts` (whose
 * headerPattern is `/^(\w*)(?:\((.*)\))?!?: (.*)$/`) makes the `!` marker parse.
 *
 * @param {{ defaultIgnores?: boolean, ignores?: unknown, parserPreset?: { parserOpts?: unknown } }} config
 * @returns {{ defaultIgnores?: boolean, ignores?: unknown, parserOpts?: unknown }}
 */
export function buildOpts(config) {
  return {
    defaultIgnores: config.defaultIgnores,
    ignores: config.ignores,
    ...(config.parserPreset?.parserOpts
      ? { parserOpts: config.parserPreset.parserOpts }
      : {}),
  };
}

/**
 * Lint a batch of commit messages against the repo's commitlint config.
 *
 * @param {string[]} messages
 * @returns {Promise<{ valid: boolean, errors: { name: string, message: string }[] }[]>}
 */
export async function lintMessages(messages) {
  const config = await load({});
  const opts = buildOpts(config);
  return Promise.all(
    messages.map((msg) => lint(msg.trim(), config.rules, opts)),
  );
}

/**
 * Validate the Claude co-author trailers of a full commit message.
 *
 * Any `Co-Authored-By:` trailer naming Claude must be exactly
 * `<canonical model> <noreply@anthropic.com>` with the model in
 * `CANONICAL_CLAUDE_MODELS` — this is what keeps model attribution in
 * history queryable (drifted names like "(1M context)" variants split the
 * counts). Non-Claude co-authors pass through untouched, and the trailer
 * itself stays optional: there is no deterministic signal that Claude
 * authored a commit, so only malformed claims are rejected.
 *
 * @param {string} message - the full commit message, headers + body
 * @returns {string[]} one error line per offending trailer; empty when valid
 */
export function validateClaudeTrailers(message) {
  const errors = [];
  for (const line of message.split("\n")) {
    const trailer = line.match(/^Co-Authored-By:\s*(.*)$/i);
    if (trailer === null) continue;
    const value = trailer[1];
    if (!/\bClaude\b/.test(value)) continue;
    const parsed = parseCoAuthor(value);
    if (
      parsed !== null &&
      parsed.email === CO_AUTHOR_EMAIL &&
      CANONICAL_CLAUDE_MODELS.includes(parsed.name)
    ) {
      continue;
    }
    errors.push(
      `non-canonical Claude co-author "${value.trim()}" — use ` +
        `"<model> <${CO_AUTHOR_EMAIL}>" with one of: ` +
        CANONICAL_CLAUDE_MODELS.join(", ") +
        " (see bin/lib/claude-models.mjs)",
    );
  }
  return errors;
}

/**
 * Reject any harness-injected `Claude-*` trailer that reached this validator
 * still present in the message — the write-time backstop for
 * bin/strip-claude-trailers.mjs, which normally deletes these lines earlier
 * in the same `commit-msg` step (see FORBIDDEN_TRAILER_PATTERN,
 * bin/lib/claude-models.mjs, for why: undocumented, unvalidated upstream,
 * injected per Claude Code session rather than by anything in this repo).
 * `Co-Authored-By:` never matches and is never flagged here.
 *
 * @param {string} message - the full commit message, headers + body
 * @returns {string[]} one error line per offending trailer; empty when valid
 */
export function validateForbiddenTrailers(message) {
  const errors = [];
  for (const line of message.split("\n")) {
    if (!FORBIDDEN_TRAILER_PATTERN.test(line)) continue;
    errors.push(
      `forbidden trailer "${line.trim()}" — harness-injected Claude-* ` +
        "trailers other than Co-Authored-By are not permitted; remove the " +
        "line (see bin/lib/claude-models.mjs)",
    );
  }
  return errors;
}

// Dependabot's author email for every PR it opens, of the shape
// "<numeric-id>+dependabot[bot]@users.noreply.github.com". The legacy
// "support@dependabot.com" address predates GitHub App authorship and no
// longer appears on new commits, but stays matched for old ranges.
const DEPENDABOT_AUTHOR_PATTERN =
  /^(?:\d+\+dependabot\[bot\]@users\.noreply\.github\.com|support@dependabot\.com)$/i;

/**
 * Whether a commit author email belongs to Dependabot.
 *
 * Deliberately narrow — matched against Dependabot's own address, not a
 * broad `*[bot]@users.noreply.github.com` pattern. Widening it would also
 * exempt `github-actions[bot]` and any other bot without a considered
 * decision to do so.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function isDependabotAuthor(email) {
  return DEPENDABOT_AUTHOR_PATTERN.test(email.trim());
}

/**
 * Parse `git log --format=%s%x00%ae`'s NUL-delimited output into commit
 * subjects, dropping Dependabot-authored ones.
 *
 * Dependabot's own bump commits (`chore(deps): Bump foo from 1 to 2`) started
 * capitalizing the verb after the type/scope prefix — every commit this repo
 * has merged used lowercase `bump` — so `@commitlint/config-conventional`'s
 * subject-case rule now rejects every bump PR at the `verify` gate, on
 * subject *shape* rather than any real defect. Exempting by author identity
 * (rather than pattern-matching the shape) keeps the rule at full strength
 * for humans: a hand-authored bump (e.g. rebuilding a PR Dependabot can't
 * recreate, #790's `aws-sdk` precedent) still must write lowercase `bump`.
 * A subject can't contain a newline or NUL, so one NUL-delimited record per
 * line splits unambiguously even though subjects may contain `:`/`|`.
 *
 * @param {string} log - raw `%s%x00%ae` output, one record per line
 * @returns {string[]} subjects of non-Dependabot commits, in log order
 */
export function subjectsFromLog(log) {
  return log
    .split("\n")
    .filter(Boolean)
    .map((record) => record.split("\0"))
    .filter(([, email]) => !isDependabotAuthor(email ?? ""))
    .map(([subject]) => subject);
}

/**
 * Print any lint failures for a message/result pair and return validity.
 *
 * @param {string} msg
 * @param {{ valid: boolean, errors: { message: string }[] }} result
 * @returns {boolean}
 */
function report(msg, result) {
  if (!result.valid) {
    console.error(`✗  ${msg.trim()}`);
    result.errors.forEach((e) => console.error(`   ${e.message}`));
  }
  return result.valid;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const editIdx = args.indexOf("--edit");
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");

  let messages;
  if (editIdx !== -1) {
    messages = [readFileSync(args[editIdx + 1], "utf8")];
  } else if (fromIdx !== -1 && toIdx !== -1) {
    const from = args[fromIdx + 1];
    const to = args[toIdx + 1];
    const log = execSync(
      `git log --format=%s%x00%ae --no-merges ${from}..${to}`,
      { encoding: "utf8" },
    );
    messages = subjectsFromLog(log);
  } else {
    console.error(
      "Usage: lint-commit.mjs --edit <file> | --from <sha> --to <sha>",
    );
    process.exit(1);
  }

  const results = await lintMessages(messages);
  let ok = messages.every((msg, i) => report(msg, results[i]));

  // Trailer validation runs only in --edit mode: range mode lints subjects
  // only, and historical commits predating the allowlist must not start
  // failing retroactively.
  if (editIdx !== -1) {
    for (const msg of messages) {
      const trailerErrors = [
        ...validateClaudeTrailers(msg),
        ...validateForbiddenTrailers(msg),
      ];
      if (trailerErrors.length > 0) {
        console.error(`✗  ${msg.split("\n")[0].trim()}`);
        trailerErrors.forEach((e) => console.error(`   ${e}`));
        ok = false;
      }
    }
  }

  if (!ok) process.exit(1);
}
