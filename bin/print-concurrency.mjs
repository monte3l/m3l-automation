#!/usr/bin/env node
/**
 * Prints the adaptive `--concurrency` value for a turbo-backed pre-push lane
 * (`build`, `typecheck`) to stdout, replacing turbo.json's old fixed `50%`
 * literal (docs/plans/2026-09-08-adaptive-host-budgeting.md, Stage 2).
 *
 * `turbo.json` has no computation seam — it's static JSON — so every direct
 * `turbo run <task>` invocation (the `build`/`typecheck` package.json
 * scripts, `bin/bench-gates.mjs`'s turbo-backed lanes, and the two
 * Containerfiles' `--filter=...` builds) calls this script via shell command
 * substitution instead:
 *
 *   "build": "turbo run build --concurrency=$(node bin/print-concurrency.mjs)"
 *
 * If this script fails to produce a value (an unhandled exception, or an
 * empty/interrupted invocation), the substitution yields an empty string —
 * `turbo run <task> --concurrency=` — which turbo itself rejects immediately
 * with a clear "Invalid value for `--concurrency` flag" error and a non-zero
 * exit, rather than silently proceeding at some other concurrency. Verified
 * directly: `turbo run build --concurrency=` exits 1 with that message. This
 * script therefore does not need its own retry/validation layer on top —
 * unlike most `bin/*.mjs` entry points, it is never imported (nothing else
 * needs its logic — the real policy lives in `deriveBudget`'s
 * `concurrentLaneWorkers` field, bin/lib/host-profile.mjs), so it carries no
 * `if (process.argv[1] === ...)` main guard and no test suite of its own:
 * `.claude/rules/harness-artifacts.md` treats a live end-to-end run as the
 * acceptance test for a thin script like this, not as a reason to skip
 * testing altogether — the live run here is `node bin/print-concurrency.mjs`
 * printing a sane integer, verified during this file's own review.
 *
 * Usage:
 *   node bin/print-concurrency.mjs   # prints an integer, e.g. "2"
 */
import { detectHostProfile, deriveBudget } from "./lib/host-profile.mjs";

const budget = deriveBudget(detectHostProfile());
process.stdout.write(String(budget.concurrentLaneWorkers));
