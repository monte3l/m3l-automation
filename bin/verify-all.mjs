#!/usr/bin/env node
// Aggregate local reproduction of the CI `verify` job — one command instead
// of chaining ~30 `pnpm check:*` invocations by hand. Runs bin/lib/verify-steps.mjs
// (VERIFY_STEPS) in order, streaming each step's own output, then prints a
// pass/fail summary table. `pnpm check:verify-parity` is the drift guard that
// keeps this list honest against ci.yml; this script trusts that list.
//
// Default behaviour: fail-fast (stop at the first failing step, matching how
// CI itself behaves) and skip steps that declare a `skipReason` (no local
// equivalent, or environment bootstrap — see bin/lib/verify-steps.mjs's
// header comment) plus PR-only steps when no base ref resolves.
//
// Flags:
//   --continue   Run every step regardless of earlier failures; summarise at
//                the end instead of stopping at the first red step.
//   --full       Also run skip-by-default steps that DO have a local command
//                (e.g. re-install with a frozen lockfile). A step with no
//                local command at all (e.g. gitleaks) has nothing to run and
//                stays skipped regardless of this flag.
//
// Usage:
//   node bin/verify-all.mjs [--continue] [--full]
//   pnpm verify [-- --continue --full]
import process from "node:process";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { VERIFY_STEPS } from "./lib/verify-steps.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const runContinue = args.includes("--continue");
const runFull = args.includes("--full");

/**
 * Resolve the PR-style base ref a prOnly step needs (`origin/main...HEAD`),
 * mirroring what ci.yml receives as `github.event.pull_request.base.sha`.
 * Returns null when the range cannot be resolved (e.g. no `origin` remote,
 * or already on `main`), which the caller treats as "skip this step".
 *
 * @returns {string | null}
 */
function resolveBaseRef() {
  try {
    return execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

const baseRef = resolveBaseRef();

/** @type {{ id: string, ciStepName: string, status: "pass" | "fail" | "skip" }[]} */
const results = [];
let stopped = false;

for (const step of VERIFY_STEPS) {
  if (stopped) break;

  if (!step.cmd) {
    // No local command exists at all (e.g. gitleaks) — unconditionally
    // skipped, regardless of --full. --full only widens which
    // has-a-command-but-skipped-by-default steps run (e.g. "install").
    console.log(
      `⏭  ${step.ciStepName} — skipped (${step.skipReason ?? "no local command"})`,
    );
    results.push({ id: step.id, ciStepName: step.ciStepName, status: "skip" });
    continue;
  }
  if (step.skipReason && !runFull) {
    console.log(`⏭  ${step.ciStepName} — skipped (${step.skipReason})`);
    results.push({ id: step.id, ciStepName: step.ciStepName, status: "skip" });
    continue;
  }
  if (step.prOnly && baseRef === null) {
    console.log(
      `⏭  ${step.ciStepName} — skipped (no origin/main...HEAD range resolved)`,
    );
    results.push({ id: step.id, ciStepName: step.ciStepName, status: "skip" });
    continue;
  }

  const cmd = step.cmd({ baseRef: baseRef ?? "" });
  console.log(`\n▶  ${step.ciStepName}\n   ${cmd}`);
  const res = spawnSync(cmd, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  const passed = res.status === 0 && !res.error;
  results.push({
    id: step.id,
    ciStepName: step.ciStepName,
    status: passed ? "pass" : "fail",
  });
  if (!passed && !runContinue) stopped = true;
}

console.log("\n── pnpm verify summary ──");
for (const r of results) {
  const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "⏭";
  console.log(`${icon}  ${r.ciStepName}`);
}
if (stopped) {
  const remaining = VERIFY_STEPS.length - results.length;
  if (remaining > 0) {
    console.log(
      `\n${remaining} step(s) not run — stopped at the first failure (pass --continue to run all).`,
    );
  }
}

const failed = results.filter((r) => r.status === "fail");
if (failed.length > 0) {
  console.error(`\n✗  ${failed.length} step(s) failed.`);
  process.exit(1);
}
console.log(
  `\n✓  ${results.filter((r) => r.status === "pass").length} step(s) passed, ${results.filter((r) => r.status === "skip").length} skipped.`,
);
