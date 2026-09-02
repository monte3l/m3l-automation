#!/usr/bin/env node
/**
 * `commit-msg` lefthook step: silently strips any harness-injected
 * `Claude-*` trailer (see FORBIDDEN_TRAILER_PATTERN, bin/lib/claude-models.mjs)
 * from a commit message before bin/lint-commit.mjs validates it.
 *
 * Deletion is line-based over the WHOLE message, not git's trailer API
 * (`%(trailers:key=…)`): a squash-merge message can carry the line
 * mid-body, concatenated in from a squashed commit's own trailer block,
 * where it is not a trailing git trailer at all — observed up to 19
 * occurrences in a single real message here.
 *
 * `Co-Authored-By:` never matches FORBIDDEN_TRAILER_PATTERN, so the
 * sanctioned co-authorship trailer is always left untouched.
 *
 * Chained ahead of lint-commit.mjs in lefthook.yml's commit-msg step, so
 * lint-commit never sees the line on the normal path. lint-commit's own
 * validateForbiddenTrailers() stays as the write-time backstop for a message
 * that reaches it some other way; bin/check-commit-trailers.mjs is the
 * push-time backstop for a `git commit --no-verify` that skips this script
 * entirely.
 *
 * Usage:
 *   node bin/strip-claude-trailers.mjs <message-file>
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_TRAILER_PATTERN } from "./lib/claude-models.mjs";

/**
 * Remove every line matching {@link FORBIDDEN_TRAILER_PATTERN} from a commit
 * message. When a removal leaves a run of two or more trailing blank lines
 * at the very end of the message, it is collapsed to a single trailing
 * blank line — the shape a normal commit message ends with — so a stripped
 * message never reads as having grown extra empty lines where the deleted
 * trailer used to sit.
 *
 * @param {string} text full commit message, as read from the message file
 * @returns {{ text: string, removed: string[] }} the stripped message and
 *   every removed line, in original order (empty when nothing matched)
 */
export function stripForbiddenTrailers(text) {
  const removed = [];
  const kept = text.split("\n").filter((line) => {
    if (!FORBIDDEN_TRAILER_PATTERN.test(line)) return true;
    removed.push(line);
    return false;
  });
  let result = kept.join("\n");
  if (removed.length > 0) {
    result = result.replace(/\n{3,}$/, "\n\n");
  }
  return { text: result, removed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: strip-claude-trailers.mjs <message-file>");
    process.exit(1);
  }
  const original = readFileSync(file, "utf8");
  const { text, removed } = stripForbiddenTrailers(original);
  if (removed.length > 0) {
    writeFileSync(file, text);
    console.log(
      `strip-claude-trailers: removed ${removed.length} harness-injected trailer line(s).`,
    );
  }
}
