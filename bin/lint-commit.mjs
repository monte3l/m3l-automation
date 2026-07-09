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
    messages = execSync(`git log --format=%s --no-merges ${from}..${to}`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
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
      const trailerErrors = validateClaudeTrailers(msg);
      if (trailerErrors.length > 0) {
        console.error(`✗  ${msg.split("\n")[0].trim()}`);
        trailerErrors.forEach((e) => console.error(`   ${e}`));
        ok = false;
      }
    }
  }

  if (!ok) process.exit(1);
}
