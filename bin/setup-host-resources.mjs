#!/usr/bin/env node
/**
 * Idempotent host-level setup for the OOM/livelock mitigations documented in
 * docs/contributing/host-resources.md and docs/adr/0080-host-resource-budgeting.md.
 * Companion to bin/check-host-resources.mjs, which only observes; this script
 * applies fixes. Linux-only (systemd + zram); exits 0 with an informational
 * message on any other platform.
 *
 * SAFE BY DEFAULT: runs in --dry-run mode unless --apply is passed. Dry-run
 * prints exactly what would change (each step's current vs. target state) and
 * makes no changes — review the plan before ever running with --apply on a
 * shared machine, since several steps use `sudo` and touch systemd/sysctl
 * state outside this repo.
 *
 * Idempotency: every step first reads current state and skips (reporting
 * "already ...") when the target is already met. A step never WEAKENS an
 * existing stricter setting it finds (e.g. a lower vm.swappiness than the
 * one this script would set, or a smaller MemoryMax than the derived
 * recommendation) — it reports the existing value and leaves it alone.
 *
 * Steps:
 *   1. earlyoom — install (apt) + enable, tuned to avoid killing
 *      sshd/systemd/tmux/sudo/the Claude Code CLI itself, and prefer
 *      killing Node-hosted processes (matched by /proc/PID/comm, not argv
 *      — see EARLYOOM_AVOID/EARLYOOM_PREFER's own comments for why
 *      "node"/"vitest"/"tsc" don't work as tokens).
 *   2. zram swap — install zram-tools, ~50% of RAM, zstd.
 *   3. vm.swappiness — lower via /etc/sysctl.d/ drop-in (never raises it).
 *   4. user-.slice MemoryMax — system-wide drop-in bounding the TOTAL memory
 *      available to all of this user's login sessions combined (one shared
 *      cgroup per UID, not one per session), derived from total host memory
 *      with a fixed OS reserve. Deliberately independent of --sessions: the
 *      per-session split is CLAUDE_CODE_TOOL_MEMORY_LIMIT's job (step 6).
 *   5. claude-rc.service — MemoryMax + OOMPolicy=kill drop-in, if the unit
 *      exists (~/.config/systemd/user/claude-rc.service per this host's
 *      remote-control wrapper; a no-op elsewhere).
 *   6. CLAUDE_CODE_TOOL_MEMORY_LIMIT — write the recommended value into
 *      .claude/settings.local.json's "env" block (gitignored, host-specific
 *      — never the repo-tracked settings.json, since the number is derived
 *      from THIS host's RAM).
 *   7. lefthook-local.yml — forces `pre-push: parallel: false` when the
 *      SAME derived host budget `bin/verify-all.mjs`'s own `--jobs` default
 *      resolves to (deriveBudget(detectHostProfile()).concurrentLaneWorkers,
 *      P3.5 of adaptive-host-budgeting) comes out to 1 concurrent lane
 *      worker, via lefthook's own documented local-override mechanism
 *      (https://lefthook.dev/examples/lefthook-local, gitignored).
 *      `pre-push`'s heavy lanes (test/typecheck/build-exports) each cap
 *      their own internal fan-out (turbo/vitest, both 50%), but three
 *      already-capped heavy processes can still stack on a small or
 *      contended box; this is the remaining lever once the internal caps
 *      aren't enough.
 *
 * Usage:
 *   node bin/setup-host-resources.mjs             # dry-run (default)
 *   node bin/setup-host-resources.mjs --apply      # apply changes (uses sudo)
 *   node bin/setup-host-resources.mjs --apply --sessions=3   # budget for 3 concurrent sessions
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { totalmem, availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { repoRoot, parseJsonFlag, createReporter } from "./lib/report.mjs";
import { recommendToolMemoryLimitGiB } from "./check-host-resources.mjs";
import { detectHostProfile, deriveBudget } from "./lib/host-profile.mjs";

// earlyoom's --prefer/--avoid match /proc/PID/comm (the kernel thread name,
// truncated to 15 visible bytes), NOT argv (`man earlyoom`: "EARLYOOM_NAME
// Process name truncated to 16 bytes, as reported in /proc/PID/comm"). Node
// >=12 sets its main thread's comm to "MainThread" (a worker thread's is
// "node-MainThread") regardless of the script it's running — confirmed live
// on this host for eslint, vitest, tsc, and this repo's own
// bin/mcp-server.mjs, all Node-hosted and all presenting as "MainThread". A
// literal "node" token therefore never matches any real Node process. The
// original PREFER list's "claude" token DID match — the Claude Code CLI
// binary's own comm is literally "claude" — which meant the ORIGINAL regex
// boosted the interactive session's own kill-priority (+300 oom_score)
// while leaving every actual toolchain process it named unmatched: the
// opposite of the intent. Fixing PREFER alone only returns "claude" to
// neutral priority, though — actually protecting the foreground session
// (not merely no-longer-preferring to kill it) means adding it here, to
// AVOID, alongside the other processes this host cannot afford to lose.
const EARLYOOM_AVOID = "^(sshd|systemd|tmux|sudo|dbus-daemon|claude)$";
// "esbuild" is kept for a native (non-Node-hosted) esbuild binary, which
// sets its own comm directly — not present in this repo's tsc-only build
// today, but harmless to list for a consumer that adds a bundler.
// Comm-based matching still can't distinguish a heavy toolchain process
// from a long-lived Node service that also presents as "MainThread" (e.g.
// bin/mcp-server.mjs) — a known coarseness; a cgroup-scoped guard would be
// the precise fix if that proves insufficient in practice.
const EARLYOOM_PREFER = "^(MainThread|node-MainThread|esbuild)$";
const SWAPPINESS_TARGET = 10;
// earlyoom only acts once BOTH the memory and swap conditions hold
// (`earlyoom --help`: "both memory and swap must be below minimum for
// earlyoom to act") — so the swap floor below is not independent of the
// swap this same script provisions in step 2. zram is sized to ~50% of RAM;
// pairing that with earlyoom's own default -s 10 (free swap must fall below
// 10% of TOTAL swap) means roughly 90% of the provisioned swap has to be
// exhausted, on top of memory already being critically low (-m 5), before
// the guard is permitted to fire at all — which defers it well past the
// point a heavy fan-out has already made the host unresponsive, the exact
// livelock this script exists to prevent. Raising the floor to 50% makes the
// swap condition true once roughly half of the provisioned cushion is spent
// — still requires genuine memory pressure via -m, but no longer requires
// swap to be nearly full first.
const EARLYOOM_SWAP_FREE_MIN_PERCENT = 50;
const EARLYOOM_OVERRIDE_PATH =
  "/etc/systemd/system/earlyoom.service.d/override.conf";

/**
 * Parse `--sessions=N` from argv, defaulting to 2. Pure for testability.
 *
 * @param {string[]} argv
 * @returns {number}
 */
export function parseSessionsFlag(argv) {
  const match = argv.find((a) => a.startsWith("--sessions="));
  if (!match) return 2;
  const n = Number(match.split("=")[1]);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/**
 * Build the earlyoom systemd drop-in unit content.
 *
 * @returns {string}
 */
export function buildEarlyoomOverride() {
  return (
    "# Managed by bin/setup-host-resources.mjs (ADR-0080) — safe to\n" +
    "# regenerate; re-run `--apply` after any of its earlyoom constants change.\n" +
    "[Service]\n" +
    "ExecStart=\n" +
    `ExecStart=/usr/bin/earlyoom -m 5 -s ${EARLYOOM_SWAP_FREE_MIN_PERCENT} --avoid '${EARLYOOM_AVOID}' --prefer '${EARLYOOM_PREFER}'\n`
  );
}

/**
 * Classify what step 1 (earlyoom) needs to do, from the service's live
 * active-state and its on-disk drop-in content (`null` when the file is
 * absent). Pure predicate, exported for unit testing — `run()` only
 * translates this into reporter/side-effect calls.
 *
 * A prior version of this script only checked "is the service active",
 * which meant a host that already had earlyoom running would report
 * "already active — leaving as-is" FOREVER, even after a fix changed
 * {@link buildEarlyoomOverride}'s content (e.g. the --prefer/--avoid comm
 * matching or the -s swap floor) — the new tuning would never reach an
 * already-provisioned host without a manual reinstall. Comparing content
 * against the live drop-in, the same way steps 3/4/6/7 already compare
 * their own current-vs-target state, closes that gap.
 *
 * @param {{ active: boolean, existingOverride: string | null }} state
 * @returns {"install" | "refresh" | "current"}
 */
export function classifyEarlyoomState(state) {
  if (!state.active) return "install";
  return state.existingOverride === buildEarlyoomOverride()
    ? "current"
    : "refresh";
}

/**
 * Build the `/etc/systemd/system/user-.slice.d/` drop-in that bounds the
 * TOTAL memory available to every one of this user's login sessions
 * combined — `user-.slice` is one shared cgroup per UID, not one per
 * session, so this must NOT be divided by the session count (a divided
 * value would make the ceiling for the whole user tree shrink as more
 * concurrent sessions are budgeted for, inverting `--sessions`'s intent
 * and colliding with the per-session `CLAUDE_CODE_TOOL_MEMORY_LIMIT`
 * step 6 derives from the same host). Reserves the same OS_RESERVE_GIB as
 * {@link recommendToolMemoryLimitGiB} so the two ceilings stay consistent.
 *
 * @param {number} totalMemGiB
 * @returns {string}
 */
export function buildUserSliceOverride(totalMemGiB) {
  const OS_RESERVE_GIB = 2;
  const totalBudgetGiB = Math.max(4, Math.floor(totalMemGiB - OS_RESERVE_GIB));
  return `[Slice]\nMemoryMax=${totalBudgetGiB}G\nMemoryHigh=${Math.max(
    2,
    totalBudgetGiB - 1,
  )}G\n`;
}

// Margin, in GiB, that claude-rc.service's MemoryMax is kept above the
// host-derived CLAUDE_CODE_TOOL_MEMORY_LIMIT (recommendToolMemoryLimitGiB,
// step 6). A fixed margin on top of a host-derived number, rather than a
// second hardcoded constant, is what keeps the "always above" invariant true
// BY CONSTRUCTION as totalMemGiB/sessions vary — a hardcoded MemoryMax could
// equal or fall below a tool limit computed for a larger host (e.g. a 24 GiB
// host's recommendToolMemoryLimitGiB(24, 2) is 10, which a flat 10G ceiling
// only equals rather than exceeds).
const CLAUDE_RC_MEMORY_MARGIN_GIB = 2;

/**
 * Build the claude-rc.service drop-in, if that unit exists on this host.
 *
 * MemoryMax is derived as `recommendToolMemoryLimitGiB(totalMemGiB,
 * maxConcurrentSessions) + CLAUDE_RC_MEMORY_MARGIN_GIB` — deliberately above
 * the CLAUDE_CODE_TOOL_MEMORY_LIMIT (step 6, below) that spawned sessions
 * inherit from `.claude/settings.local.json`, on every supported host size,
 * not just this one. If this ceiling sat at or below that limit, the
 * cgroup's OOMPolicy=kill would race the tool limit's own targeted kill and
 * could win — tearing down every session in the unit at once instead of just
 * the one tool call that overran its budget.
 *
 * @param {number} totalMemGiB
 * @param {number} [maxConcurrentSessions]
 * @returns {string}
 */
export function buildClaudeRcOverride(totalMemGiB, maxConcurrentSessions = 2) {
  const memoryMaxGiB =
    recommendToolMemoryLimitGiB(totalMemGiB, maxConcurrentSessions) +
    CLAUDE_RC_MEMORY_MARGIN_GIB;
  return `[Service]\nMemoryMax=${memoryMaxGiB}G\nOOMPolicy=kill\n`;
}

/**
 * Extract the integer GiB value from a `MemoryMax=<N>G` line in systemd
 * drop-in content. Returns null when the line is absent or not a plain
 * `<N>G` value (e.g. `infinity`) — treated as "unknown", never as 0, so a
 * caller comparing against it doesn't mistake unparseable for unbounded.
 *
 * @param {string} overrideText
 * @returns {number | null}
 */
export function extractMemoryMaxGiB(overrideText) {
  const match = /MemoryMax=(\d+)G/.exec(overrideText);
  return match ? Number(match[1]) : null;
}

/**
 * Extract the integer GiB value from a `<N>G` string, the format
 * `CLAUDE_CODE_TOOL_MEMORY_LIMIT` is written in. Returns null when the
 * value isn't that exact shape.
 *
 * @param {string} value
 * @returns {number | null}
 */
export function extractGiBSuffix(value) {
  const match = /^(\d+)G$/.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * Build the `lefthook-local.yml` override that forces `pre-push` to run
 * serially — lefthook's own documented local-config mechanism
 * (https://lefthook.dev/examples/lefthook-local), gitignored and merged over
 * the shared `lefthook.yml` per-checkout. Only written when
 * {@link shouldSerializePrePush} says the host needs it.
 *
 * @param {import("./lib/host-profile.mjs").HostBudget} budget
 * @returns {string}
 */
export function buildLefthookLocalOverride(budget) {
  return (
    "# Generated by bin/setup-host-resources.mjs (ADR-0080 / P3.5 of\n" +
    "# adaptive-host-budgeting) — gitignored, per-machine. This host's derived\n" +
    `# lane budget is ${budget.concurrentLaneWorkers} concurrent lane worker(s) ` +
    `(effectiveCores=${budget.effectiveCores}, sessions=${budget.sessions}, ` +
    `limitedBy=${budget.limitedBy});\n` +
    "# pre-push's heavy lanes (test/typecheck/build-exports) run SERIALLY here\n" +
    "# instead of lefthook.yml's shared `parallel: true`, to avoid oversubscribing\n" +
    "# this host — the same signal `pnpm verify --isolated` names explicitly\n" +
    "# (bin/lib/host-profile.mjs's deriveBudget().concurrentLaneWorkers). Delete\n" +
    "# this file, or re-run `node bin/setup-host-resources.mjs --apply` after\n" +
    "# conditions change (more RAM, fewer concurrent sessions), to restore the\n" +
    "# default parallel behavior.\n" +
    "pre-push:\n" +
    "  parallel: false\n"
  );
}

/**
 * Whether this host's derived lane budget is thin enough that `pre-push`
 * should be forced serial. Previously a static RAM-only threshold; now
 * reads the SAME live host-budget signal `bin/verify-all.mjs`'s own
 * `--jobs` default resolves to
 * (`deriveBudget(detectHostProfile()).concurrentLaneWorkers`, P3.5 of
 * adaptive-host-budgeting) — so the two decisions (`pnpm verify`'s lane
 * concurrency and pre-push's) can never disagree, and this reacts to
 * live conditions the host-profile module already tracks (concurrent
 * Claude sessions, effective cores, memory) rather than total RAM alone.
 * Pure predicate, exported for unit testing.
 *
 * @param {import("./lib/host-profile.mjs").HostBudget} budget
 * @returns {boolean}
 */
export function shouldSerializePrePush(budget) {
  return budget.concurrentLaneWorkers <= 1;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
}

function shQuiet(cmd, args) {
  try {
    return sh(cmd, args);
  } catch {
    return null;
  }
}

/**
 * Read a file, tolerating any failure (missing, EACCES, etc.) as "unknown"
 * rather than throwing — mirrors {@link shQuiet}'s tolerance for a failed
 * command. Every drift/current-state probe in `run()` should be able to
 * fail without aborting the whole multi-step script; a raw `fs` throw here
 * would otherwise abort before steps 2-7 ever run.
 *
 * @param {string} path
 * @returns {string | null}
 */
function tryReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {{ apply: boolean, sessions: number }} opts
 * @param {import("./lib/report.mjs").createReporter extends (...args: any) => infer R ? R : never} reporter
 */
function run(opts, reporter) {
  if (process.platform !== "linux") {
    reporter.info(
      `Host resource setup is Linux-specific (systemd + zram); platform is ` +
        `"${process.platform}" — nothing to do.`,
    );
    return;
  }

  const totalMemGiB = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  const mode = opts.apply ? "APPLY" : "DRY-RUN";
  reporter.info(
    `[${mode}] Host: ${totalMemGiB} GiB RAM, ${availableParallelism()} cores, ` +
      `budgeting for ${opts.sessions} concurrent session(s).\n`,
  );

  // 1. earlyoom
  const earlyoomActive =
    shQuiet("systemctl", ["is-active", "earlyoom"]) === "active";
  const existingEarlyoomOverride = tryReadFile(EARLYOOM_OVERRIDE_PATH);
  const earlyoomState = classifyEarlyoomState({
    active: earlyoomActive,
    existingOverride: existingEarlyoomOverride,
  });
  if (earlyoomState === "current") {
    reporter.info(
      "[1/7] earlyoom: already active and tuned as expected — leaving as-is.",
    );
  } else if (earlyoomState === "refresh") {
    reporter.info(
      `[1/7] earlyoom: active, but its tuning is stale (drop-in ` +
        `${existingEarlyoomOverride === null ? "missing" : "differs"}) — ` +
        `would rewrite to -m 5 -s ${EARLYOOM_SWAP_FREE_MIN_PERCENT} --avoid ` +
        `'${EARLYOOM_AVOID}' --prefer '${EARLYOOM_PREFER}' and restart.`,
    );
    if (opts.apply) {
      sh("sudo", ["mkdir", "-p", "/etc/systemd/system/earlyoom.service.d"]);
      sh("sudo", ["tee", EARLYOOM_OVERRIDE_PATH], {
        input: buildEarlyoomOverride(),
      });
      sh("sudo", ["systemctl", "daemon-reload"]);
      sh("sudo", ["systemctl", "restart", "earlyoom"]);
      reporter.change("updated", "earlyoom.service", "(tuning refreshed)");
    }
  } else {
    reporter.info(
      `[1/7] earlyoom: would install + enable, tuned -m 5 -s ` +
        `${EARLYOOM_SWAP_FREE_MIN_PERCENT} --avoid '${EARLYOOM_AVOID}' ` +
        `--prefer '${EARLYOOM_PREFER}'.`,
    );
    if (opts.apply) {
      sh("sudo", ["apt-get", "install", "-y", "earlyoom"]);
      sh("sudo", ["mkdir", "-p", "/etc/systemd/system/earlyoom.service.d"]);
      sh("sudo", ["tee", EARLYOOM_OVERRIDE_PATH], {
        input: buildEarlyoomOverride(),
      });
      sh("sudo", ["systemctl", "daemon-reload"]);
      sh("sudo", ["systemctl", "enable", "--now", "earlyoom"]);
      reporter.change("updated", "earlyoom.service", "(installed + enabled)");
    }
  }

  // 2. zram
  const hasZram = /zram/.test(shQuiet("cat", ["/proc/swaps"]) ?? "");
  if (hasZram) {
    reporter.info("[2/7] zram: swap device already present — leaving as-is.");
  } else {
    reporter.info("[2/7] zram: would install zram-tools (~50% RAM, zstd).");
    if (opts.apply) {
      sh("sudo", ["apt-get", "install", "-y", "zram-tools"]);
      sh("sudo", ["tee", "/etc/default/zramswap"], {
        input: "ALGO=zstd\nPERCENT=50\nPRIORITY=100\n",
      });
      sh("sudo", ["systemctl", "restart", "zramswap"]);
      reporter.change("updated", "zramswap.service", "(installed)");
    }
  }

  // 3. swappiness
  const currentSwappiness = Number(
    shQuiet("cat", ["/proc/sys/vm/swappiness"]) ?? "60",
  );
  if (currentSwappiness <= SWAPPINESS_TARGET) {
    reporter.info(
      `[3/7] vm.swappiness: already ${currentSwappiness} (<= target ${SWAPPINESS_TARGET}) — leaving as-is.`,
    );
  } else {
    reporter.info(
      `[3/7] vm.swappiness: would lower from ${currentSwappiness} to ${SWAPPINESS_TARGET}.`,
    );
    if (opts.apply) {
      sh("sudo", ["tee", "/etc/sysctl.d/90-host-resources.conf"], {
        input: `vm.swappiness=${SWAPPINESS_TARGET}\n`,
      });
      sh("sudo", ["sysctl", "--system"]);
      reporter.change(
        "updated",
        "/etc/sysctl.d/90-host-resources.conf",
        `(swappiness ${currentSwappiness} -> ${SWAPPINESS_TARGET})`,
      );
    }
  }

  // 4. user@.slice MemoryMax
  const sliceOverride = buildUserSliceOverride(totalMemGiB);
  const sliceOverridePath = "/etc/systemd/system/user-.slice.d/override.conf";
  const existingSlice = existsSync(sliceOverridePath)
    ? readFileSync(sliceOverridePath, "utf8")
    : null;
  const existingSliceGiB =
    existingSlice !== null ? extractMemoryMaxGiB(existingSlice) : null;
  const targetSliceGiB = extractMemoryMaxGiB(sliceOverride);
  if (existingSliceGiB !== null && existingSliceGiB <= targetSliceGiB) {
    reporter.info(
      `[4/7] user-.slice MemoryMax: existing ${existingSliceGiB}G is already ` +
        `at or stricter than the derived ${targetSliceGiB}G — leaving as-is.`,
    );
  } else {
    reporter.info(
      `[4/7] user-.slice MemoryMax: would write:\n${sliceOverride
        .split("\n")
        .filter(Boolean)
        .map((l) => `        ${l}`)
        .join("\n")}`,
    );
    if (opts.apply) {
      sh("sudo", ["mkdir", "-p", "/etc/systemd/system/user-.slice.d"]);
      sh("sudo", ["tee", sliceOverridePath], {
        input: sliceOverride,
      });
      sh("sudo", ["systemctl", "daemon-reload"]);
      reporter.change("updated", sliceOverridePath);
    }
  }

  // 5. claude-rc.service (only if it exists — this host's remote-control unit)
  const rcUnitPath = join(
    process.env.HOME ?? "",
    ".config/systemd/user/claude-rc.service",
  );
  if (existsSync(rcUnitPath)) {
    const rcOverride = buildClaudeRcOverride(totalMemGiB, opts.sessions);
    const rcMemoryMaxGiB = extractMemoryMaxGiB(rcOverride);
    reporter.info(
      `[5/7] claude-rc.service: would add MemoryMax=${rcMemoryMaxGiB}G + OOMPolicy=kill drop-in.`,
    );
    if (opts.apply) {
      const dropinDir = join(
        process.env.HOME ?? "",
        ".config/systemd/user/claude-rc.service.d",
      );
      mkdirSync(dropinDir, { recursive: true });
      writeFileSync(join(dropinDir, "override.conf"), rcOverride);
      sh("systemctl", ["--user", "daemon-reload"]);
      reporter.change("updated", "claude-rc.service.d/override.conf");
    }
  } else {
    reporter.info(
      "[5/7] claude-rc.service: not present on this host — skipping.",
    );
  }

  // 6. CLAUDE_CODE_TOOL_MEMORY_LIMIT — written to settings.local.json, NOT the
  // repo-tracked settings.json: the recommended value is derived from THIS
  // host's RAM, so committing it would apply one machine's number to every
  // contributor's differently-sized box. settings.local.json is
  // gitignored and merges over settings.json per-checkout.
  const recommendedGiB = recommendToolMemoryLimitGiB(
    totalMemGiB,
    opts.sessions,
  );
  const localSettingsPath = join(
    repoRoot(import.meta.url),
    ".claude/settings.local.json",
  );
  const localSettings = existsSync(localSettingsPath)
    ? JSON.parse(readFileSync(localSettingsPath, "utf8"))
    : {};
  const currentLimit = localSettings.env?.CLAUDE_CODE_TOOL_MEMORY_LIMIT;
  const currentLimitGiB =
    typeof currentLimit === "string" ? extractGiBSuffix(currentLimit) : null;
  if (currentLimitGiB !== null && currentLimitGiB <= recommendedGiB) {
    reporter.info(
      `[6/7] CLAUDE_CODE_TOOL_MEMORY_LIMIT: existing ${currentLimit} is ` +
        `already at or stricter than the derived ${recommendedGiB}G — leaving as-is.`,
    );
  } else {
    reporter.info(
      `[6/7] CLAUDE_CODE_TOOL_MEMORY_LIMIT: would set to ${recommendedGiB}G in ` +
        `.claude/settings.local.json (currently ${currentLimit ?? "unset"}). ` +
        "Relaunch Claude Code after applying — the cap latches at first tool use.",
    );
    if (opts.apply) {
      localSettings.env = {
        ...localSettings.env,
        CLAUDE_CODE_TOOL_MEMORY_LIMIT: `${recommendedGiB}G`,
      };
      writeFileSync(
        localSettingsPath,
        `${JSON.stringify(localSettings, null, 2)}\n`,
      );
      reporter.change(
        "updated",
        ".claude/settings.local.json",
        `(env.CLAUDE_CODE_TOOL_MEMORY_LIMIT=${recommendedGiB}G)`,
      );
    }
  }

  // 7. lefthook-local.yml — force serial pre-push when the derived lane
  // budget (same signal bin/verify-all.mjs's --jobs default uses) is thin.
  const lefthookLocalPath = join(
    repoRoot(import.meta.url),
    "lefthook-local.yml",
  );
  const hostBudget = deriveBudget(
    detectHostProfile({ sessions: opts.sessions }),
  );
  if (shouldSerializePrePush(hostBudget)) {
    const override = buildLefthookLocalOverride(hostBudget);
    const existingLocal = existsSync(lefthookLocalPath)
      ? readFileSync(lefthookLocalPath, "utf8")
      : null;
    if (existingLocal === override) {
      reporter.info(
        "[7/7] lefthook-local.yml: already forcing serial pre-push — leaving as-is.",
      );
    } else {
      reporter.info(
        `[7/7] lefthook-local.yml: would write (derived budget: ${hostBudget.concurrentLaneWorkers} concurrent lane worker(s)) to force serial pre-push.`,
      );
      if (opts.apply) {
        writeFileSync(lefthookLocalPath, override);
        reporter.change(
          "created",
          "lefthook-local.yml",
          "(forces serial pre-push on this host)",
        );
      }
    }
  } else {
    reporter.info(
      `[7/7] lefthook-local.yml: derived budget is ${hostBudget.concurrentLaneWorkers} concurrent lane workers — parallel pre-push is fine, nothing to write.`,
    );
  }

  if (!opts.apply) {
    reporter.info(
      "\nDry-run complete — no changes made. Re-run with --apply to apply them.",
    );
  }
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);
  const opts = {
    apply: argv.includes("--apply"),
    sessions: parseSessionsFlag(argv),
  };
  run(opts, reporter);
  reporter.finish();
}
