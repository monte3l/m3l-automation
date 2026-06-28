#!/usr/bin/env node
// Prints a one-line nudge after any "git push" Bash call so the user remembers
// to open a PR. Non-blocking: always exits 0.
import { readFileSync } from "node:fs";

try {
  const input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  const cmd = input?.tool_input?.command ?? "";
  if (/\bgit\s+push\b/.test(cmd)) {
    process.stderr.write(
      "\u{1F4A1} Branch pushed. Run /create-pr to open a pull request.\n",
    );
  }
} catch {
  // Malformed input — stay silent.
}
process.exit(0);
