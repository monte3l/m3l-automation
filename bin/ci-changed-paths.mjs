#!/usr/bin/env node
// CLI entry point for bin/lib/changed-paths.mjs — see that file for the
// classification logic and the fail-open rule.
//
// Usage:
//   node bin/ci-changed-paths.mjs --base <sha> --head <sha> [--json]
//   node bin/ci-changed-paths.mjs --base <sha> --head <sha> >> "$GITHUB_OUTPUT"
//
// Without --json, prints one `key=value` line per category to stdout — the
// format `$GITHUB_OUTPUT` expects. With --json, prints one JSON object
// instead, for local inspection/testing. Missing/unresolvable --base or
// --head falls back to allChanged() (fail open), same as any git error.
import process from "node:process";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./lib/report.mjs";
import {
  CHANGE_CATEGORIES,
  classifyChangedPaths,
  allChanged,
  resolveChangedPaths,
} from "./lib/changed-paths.mjs";

function parseArgs(argv) {
  const json = argv.includes("--json");
  let base;
  let head;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[i + 1];
    if (argv[i] === "--head") head = argv[i + 1];
  }
  return { base, head, json };
}

const root = repoRoot(import.meta.url);
const { base, head, json } = parseArgs(process.argv.slice(2));

let flags;
if (!base || !head) {
  flags = allChanged();
} else {
  try {
    flags = classifyChangedPaths(
      resolveChangedPaths({ execFileSync }, root, base, head),
    );
  } catch {
    flags = allChanged();
  }
}

if (json) {
  console.log(JSON.stringify(flags));
} else {
  for (const category of CHANGE_CATEGORIES) {
    console.log(`${category}=${flags[category]}`);
  }
}
