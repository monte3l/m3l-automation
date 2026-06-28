#!/usr/bin/env node
// Thin wrapper around @commitlint/lint + @commitlint/load that replaces
// @commitlint/cli without pulling in the git-raw-commits transitive dep.
// See docs/adr/0008-commitlint-cli-replacement.md.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import lint from "@commitlint/lint";
import load from "@commitlint/load";

const args = process.argv.slice(2);
const editIdx = args.indexOf("--edit");
const fromIdx = args.indexOf("--from");
const toIdx = args.indexOf("--to");

const config = await load({});
const opts = {
  defaultIgnores: config.defaultIgnores,
  ignores: config.ignores,
  ...(config.parserPreset ? { parserPreset: config.parserPreset } : {}),
};

async function check(msg) {
  const result = await lint(msg.trim(), config.rules, opts);
  if (!result.valid) {
    console.error(`✗  ${msg.trim()}`);
    result.errors.forEach((e) => console.error(`   ${e.message}`));
  }
  return result.valid;
}

let ok = true;
if (editIdx !== -1) {
  const msg = readFileSync(args[editIdx + 1], "utf8");
  ok = await check(msg);
} else if (fromIdx !== -1 && toIdx !== -1) {
  const from = args[fromIdx + 1];
  const to = args[toIdx + 1];
  const msgs = execSync(`git log --format=%s --no-merges ${from}..${to}`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const results = await Promise.all(msgs.map(check));
  ok = results.every(Boolean);
} else {
  console.error(
    "Usage: lint-commit.mjs --edit <file> | --from <sha> --to <sha>",
  );
  process.exit(1);
}

if (!ok) process.exit(1);
