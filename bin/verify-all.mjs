#!/usr/bin/env node
// Aggregate local reproduction of CI's project-check steps — one command
// instead of chaining ~30 `pnpm check:*` invocations by hand. Runs
// bin/lib/verify-steps.mjs (VERIFY_STEPS) in order, streaming each step's own
// output, then prints a pass/fail summary table. `pnpm check:verify-parity`
// is the drift guard that keeps this list honest against ci.yml's lane jobs;
// this script trusts that list.
//
// Default behaviour: fail-fast (stop at the first failing step, matching how
// CI itself behaves) and skip steps that declare a `skipReason` (no local
// equivalent, or needs live GitHub state — see bin/lib/verify-steps.mjs's
// header comment) plus PR-only steps when no base ref resolves.
//
// Concurrency (P3.4 of adaptive-host-budgeting): steps are grouped into
// "lanes" by their ci.yml job (`groupStepsIntoLanes`, bin/lib/verify-steps.mjs)
// and up to `--jobs N` lanes run at once. This is safe with no new dependency
// metadata because ci.yml already runs every lane job concurrently today —
// each one's only `needs:` is the shared `changes` job — so two steps living
// in different ci.yml jobs are already proven safe to run at the same time;
// steps within the SAME job keep that job's own ci.yml order (e.g. `gates`
// builds the CLI before the scaffold checkers that read its `dist/`). Each
// lane's output is buffered and printed as one block when the lane finishes,
// so concurrent lanes never interleave mid-line. On a failure (without
// `--continue`), no NEW lane is started, but every already-running lane keeps
// going to its own natural stopping point — nothing is killed mid-flight.
//
// Flags:
//   --continue   Run every step regardless of earlier failures; summarise at
//                the end instead of stopping at the first red step.
//   --full       Also run skip-by-default steps that DO have a local command
//                (e.g. "Check hub drift (push-only)", which needs a
//                `gh`-authenticated session). A step with no local command
//                at all (e.g. gitleaks) has nothing to run and stays skipped
//                regardless of this flag.
//   --jobs=N     Max concurrent lanes. Defaults to the host-derived
//                `concurrentLaneWorkers` budget (bin/lib/host-profile.mjs) —
//                the same default `pnpm build`/`pnpm typecheck` already use
//                via bin/print-concurrency.mjs. `--jobs=1` reproduces the
//                previous fully-sequential behaviour.
//
// Usage:
//   node bin/verify-all.mjs [--continue] [--full] [--jobs=N]
//   pnpm verify [-- --continue --full --jobs=4]
//
// `main()` only runs when this file is executed directly (the
// `process.argv[1] === fileURLToPath(import.meta.url)` guard below, same
// pattern as bin/bench-gates.mjs) — importing `parseJobsArg` alone (as the
// test suite does) never triggers a real run.
import process from "node:process";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERIFY_STEPS, groupStepsIntoLanes } from "./lib/verify-steps.mjs";
import { detectHostProfile, deriveBudget } from "./lib/host-profile.mjs";

/**
 * Parse `--jobs=N` / `--jobs N` from argv, falling back to the host-derived
 * concurrent-lane budget. Anything non-positive or non-integer is ignored
 * (falls back to `defaultJobs`) rather than producing a confusing 0-worker
 * hang.
 *
 * @param {string[]} argv
 * @param {number} defaultJobs
 * @returns {number}
 */
export function parseJobsArg(argv, defaultJobs) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let raw;
    if (arg.startsWith("--jobs=")) raw = arg.slice("--jobs=".length);
    else if (arg === "--jobs") raw = argv[i + 1];
    if (raw === undefined) continue;
    // Strict decimal digits only — bare Number(raw) would also accept
    // exponent ("1e3" -> 1000 lanes) and hex ("0x8" -> 8) forms, neither of
    // which matches the flag's documented plain-integer N shape.
    if (!/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return defaultJobs;
}

/**
 * Pick the index of the next lane in `queue` whose `dependsOn` is fully
 * satisfied by `completedJobNames`, or `-1` if none is ready yet. Pulled
 * out of the scheduler's worker loop as its own pure function so the
 * dependency-gating logic — the riskiest part of the concurrency design —
 * is unit-testable against plain fixtures, without spawning any process.
 *
 * @param {{ jobName: string, dependsOn: string[] }[]} queue
 * @param {Set<string>} completedJobNames
 * @returns {number}
 */
export function selectReadyLaneIndex(queue, completedJobNames) {
  return queue.findIndex((lane) =>
    lane.dependsOn.every((d) => completedJobNames.has(d)),
  );
}

/**
 * Resolve the PR-style base ref a prOnly step needs (`origin/main...HEAD`),
 * mirroring what ci.yml receives as `github.event.pull_request.base.sha`.
 * Returns null when the range cannot be resolved (e.g. no `origin` remote,
 * or already on `main`), which the caller treats as "skip this step".
 *
 * @param {string} root
 * @returns {string | null}
 */
function resolveBaseRef(root) {
  try {
    return execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Run one shell command to completion, capturing combined stdout+stderr into
 * a single buffer (interleaved in roughly arrival order — good enough for a
 * buffered post-hoc print, not a byte-exact terminal replay).
 *
 * @param {string} cmd
 * @param {string} root
 * @returns {Promise<{ status: number, output: string }>}
 */
function runCommand(cmd, root) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(cmd, {
      cwd: root,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => {
      chunks.push(Buffer.from(String(err)));
      resolve({ status: 1, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.on("close", (code) => {
      resolve({
        status: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const args = process.argv.slice(2);
  const runContinue = args.includes("--continue");
  const runFull = args.includes("--full");
  const defaultJobs = deriveBudget(detectHostProfile()).concurrentLaneWorkers;
  const jobs = parseJobsArg(args, defaultJobs);
  const baseRef = resolveBaseRef(root);

  /** @type {{ id: string, ciStepName: string, status: "pass" | "fail" | "skip" }[]} */
  const skipResults = [];
  /** @type {Map<string, { id: string, ciStepName: string, status: "pass" | "fail" }>} */
  const runResults = new Map();

  /** @type {import("./lib/verify-steps.mjs").VerifyStep[]} */
  const runnable = [];

  for (const step of VERIFY_STEPS) {
    if (!step.cmd) {
      console.log(
        `⏭  ${step.ciStepName} — skipped (${step.skipReason ?? "no local command"})`,
      );
      skipResults.push({
        id: step.id,
        ciStepName: step.ciStepName,
        status: "skip",
      });
      continue;
    }
    if (step.skipReason && !runFull) {
      console.log(`⏭  ${step.ciStepName} — skipped (${step.skipReason})`);
      skipResults.push({
        id: step.id,
        ciStepName: step.ciStepName,
        status: "skip",
      });
      continue;
    }
    if (step.prOnly && baseRef === null) {
      console.log(
        `⏭  ${step.ciStepName} — skipped (no origin/main...HEAD range resolved)`,
      );
      skipResults.push({
        id: step.id,
        ciStepName: step.ciStepName,
        status: "skip",
      });
      continue;
    }
    runnable.push(step);
  }

  const ciYamlText = readFileSync(
    join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  const allLanes = groupStepsIntoLanes(ciYamlText, VERIFY_STEPS);
  const runnableIds = new Set(runnable.map((s) => s.id));
  const runnableLanes = allLanes
    .map((lane) => ({
      jobName: lane.jobName,
      steps: lane.steps.filter((s) => runnableIds.has(s.id)),
      dependsOn: lane.dependsOn,
    }))
    .filter((lane) => lane.steps.length > 0);
  // A `dependsOn` naming a job that ended up with no runnable lane at all
  // (every one of its own steps skipped) has nothing left to wait for.
  const presentJobNames = new Set(runnableLanes.map((l) => l.jobName));
  const lanes = runnableLanes.map((lane) => ({
    ...lane,
    dependsOn: lane.dependsOn.filter((d) => presentJobNames.has(d)),
  }));

  let globalStopped = false;
  const completedJobNames = new Set();
  /** @type {(() => void)[]} */
  let laneWaiters = [];
  function notifyLaneDone(jobName) {
    completedJobNames.add(jobName);
    const toWake = laneWaiters;
    laneWaiters = [];
    for (const resolve of toWake) resolve();
  }
  function waitForAnyLaneDone() {
    return new Promise((resolve) => laneWaiters.push(resolve));
  }

  /**
   * Run one lane's steps sequentially (this is the same fail-fast semantics
   * `pnpm verify` always had, just scoped to a lane instead of the whole
   * run): a step failure stops the REST of this lane (unless `--continue`),
   * but never reaches across into another concurrently-running lane.
   */
  async function runLane(lane) {
    const buffer = [];
    let laneFailed = false;
    for (const step of lane.steps) {
      if (laneFailed && !runContinue) break;
      const cmd = step.cmd({ baseRef: baseRef ?? "" });
      buffer.push(`\n▶  ${step.ciStepName}\n   ${cmd}`);
      const { status, output } = await runCommand(cmd, root);
      buffer.push(output.trimEnd());
      const passed = status === 0;
      runResults.set(step.id, {
        id: step.id,
        ciStepName: step.ciStepName,
        status: passed ? "pass" : "fail",
      });
      if (!passed) laneFailed = true;
    }
    return { jobName: lane.jobName, buffer: buffer.join("\n"), laneFailed };
  }

  /** Bounded-concurrency lane pool: `jobs` workers pull from `queue` until
   * it's empty or (without `--continue`) a failure anywhere stops new
   * dequeues. A lane whose `dependsOn` isn't fully satisfied yet (its
   * dependency lane(s) haven't completed) is left in the queue for another
   * worker's turn rather than run early — this is what stops e.g. the
   * `test` lane's `test-coverage` from racing the `build` lane's own
   * `pnpm build` against the one shared local `dist/`. */
  async function runLanesConcurrently(queue) {
    async function worker() {
      for (;;) {
        if (globalStopped && !runContinue) return;
        if (queue.length === 0) return;
        const idx = selectReadyLaneIndex(queue, completedJobNames);
        if (idx === -1) {
          // Every queued lane is still waiting on a dependency — nothing
          // for this worker to do until some other lane finishes.
          await waitForAnyLaneDone();
          continue;
        }
        const [lane] = queue.splice(idx, 1);
        console.log(
          `\n▶▶ lane: ${lane.jobName} (${lane.steps.length} step(s))`,
        );
        try {
          const result = await runLane(lane);
          console.log(result.buffer);
          console.log(
            `◀◀ lane: ${lane.jobName} ${result.laneFailed ? "✗ failed" : "✓ done"}`,
          );
          if (result.laneFailed) globalStopped = true;
        } finally {
          // Always unblock any worker waiting on this lane's dependency,
          // even on an unexpected throw — otherwise a stuck lane leaves
          // every dependent worker parked in waitForAnyLaneDone() forever.
          notifyLaneDone(lane.jobName);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(jobs, queue.length) }, () => worker()),
    );
  }

  await runLanesConcurrently([...lanes]);

  const skipById = new Map(skipResults.map((r) => [r.id, r]));
  // A step present in neither map was runnable but never actually reached
  // (fail-fast stopped before its lane was scheduled) — distinct from a
  // deliberate skipReason/prOnly skip, so it gets its own status/icon
  // rather than silently reusing "skip"'s.
  const results = VERIFY_STEPS.map(
    (step) =>
      runResults.get(step.id) ??
      skipById.get(step.id) ?? {
        id: step.id,
        ciStepName: step.ciStepName,
        status: "not-run",
      },
  );

  console.log("\n── pnpm verify summary ──");
  for (const r of results) {
    const icon =
      r.status === "pass"
        ? "✓"
        : r.status === "fail"
          ? "✗"
          : r.status === "skip"
            ? "⏭"
            : "·";
    console.log(`${icon}  ${r.ciStepName}`);
  }
  if (globalStopped && !runContinue) {
    const remaining =
      VERIFY_STEPS.length - runResults.size - skipResults.length;
    if (remaining > 0) {
      console.log(
        `\n${remaining} step(s) not run — stopped after the first failure (pass --continue to run all).`,
      );
    }
  }

  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    console.error(`\n✗  ${failed.length} step(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n✓  ${results.filter((r) => r.status === "pass").length} step(s) passed, ${results.filter((r) => r.status === "skip").length} skipped.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
