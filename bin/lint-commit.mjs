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
  const ok = messages.every((msg, i) => report(msg, results[i]));
  if (!ok) process.exit(1);
}
