#!/usr/bin/env node
/**
 * Prints the adaptive `--concurrency` value for a turbo-backed pre-push lane
 * (`build`, `typecheck`) to stdout, replacing turbo.json's old fixed `50%`
 * literal (docs/plans/2026-09-08-adaptive-host-budgeting.md, Stage 2).
 *
 * `turbo.json` has no computation seam — it's static JSON — so the two
 * package.json scripts that invoke turbo call this script via shell command
 * substitution instead:
 *
 *   "build": "turbo run build --concurrency=$(node bin/print-concurrency.mjs)"
 *
 * All the actual policy (why this number, the CI-vs-local distinction, the
 * concurrent-sibling-lane halving) lives in `deriveBudget`'s
 * `concurrentLaneWorkers` field (bin/lib/host-profile.mjs) — this file is
 * plumbing only, so it carries no test suite of its own (see
 * .claude/rules/harness-artifacts.md: a live run is the acceptance test for
 * a thin CLI wrapper whose logic is otherwise fully covered elsewhere).
 *
 * Usage:
 *   node bin/print-concurrency.mjs   # prints an integer, e.g. "2"
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { detectHostProfile, deriveBudget } from "./lib/host-profile.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const budget = deriveBudget(detectHostProfile());
  process.stdout.write(String(budget.concurrentLaneWorkers));
}
