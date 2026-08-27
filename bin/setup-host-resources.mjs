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
 *      sshd/systemd/tmux/sudo and prefer killing node/claude/vitest/tsc.
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

const EARLYOOM_AVOID = "^(sshd|systemd|tmux|sudo|dbus-daemon)$";
const EARLYOOM_PREFER = "^(node|claude|vitest|tsc|esbuild)$";
const SWAPPINESS_TARGET = 10;

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
    "[Service]\n" +
    "ExecStart=\n" +
    `ExecStart=/usr/bin/earlyoom -m 5 -s 10 --avoid '${EARLYOOM_AVOID}' --prefer '${EARLYOOM_PREFER}'\n`
  );
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

/**
 * Build the claude-rc.service drop-in, if that unit exists on this host.
 *
 * @returns {string}
 */
export function buildClaudeRcOverride() {
  return "[Service]\nMemoryMax=6G\nOOMPolicy=kill\n";
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
  const earlyoomActive = shQuiet("systemctl", ["is-active", "earlyoom"]);
  if (earlyoomActive === "active") {
    reporter.info("[1/6] earlyoom: already active — leaving as-is.");
  } else {
    reporter.info(
      `[1/6] earlyoom: would install + enable, tuned --avoid '${EARLYOOM_AVOID}' ` +
        `--prefer '${EARLYOOM_PREFER}'.`,
    );
    if (opts.apply) {
      sh("sudo", ["apt-get", "install", "-y", "earlyoom"]);
      sh("sudo", ["mkdir", "-p", "/etc/systemd/system/earlyoom.service.d"]);
      sh(
        "sudo",
        ["tee", "/etc/systemd/system/earlyoom.service.d/override.conf"],
        {
          input: buildEarlyoomOverride(),
        },
      );
      sh("sudo", ["systemctl", "daemon-reload"]);
      sh("sudo", ["systemctl", "enable", "--now", "earlyoom"]);
      reporter.change("updated", "earlyoom.service", "(installed + enabled)");
    }
  }

  // 2. zram
  const hasZram = /zram/.test(shQuiet("cat", ["/proc/swaps"]) ?? "");
  if (hasZram) {
    reporter.info("[2/6] zram: swap device already present — leaving as-is.");
  } else {
    reporter.info("[2/6] zram: would install zram-tools (~50% RAM, zstd).");
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
      `[3/6] vm.swappiness: already ${currentSwappiness} (<= target ${SWAPPINESS_TARGET}) — leaving as-is.`,
    );
  } else {
    reporter.info(
      `[3/6] vm.swappiness: would lower from ${currentSwappiness} to ${SWAPPINESS_TARGET}.`,
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
  if (existingSlice === sliceOverride) {
    reporter.info(
      "[4/6] user-.slice MemoryMax: already at target — leaving as-is.",
    );
  } else {
    reporter.info(
      `[4/6] user-.slice MemoryMax: would write:\n${sliceOverride
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
    reporter.info(
      "[5/6] claude-rc.service: would add MemoryMax=6G + OOMPolicy=kill drop-in.",
    );
    if (opts.apply) {
      const dropinDir = join(
        process.env.HOME ?? "",
        ".config/systemd/user/claude-rc.service.d",
      );
      mkdirSync(dropinDir, { recursive: true });
      writeFileSync(join(dropinDir, "override.conf"), buildClaudeRcOverride());
      sh("systemctl", ["--user", "daemon-reload"]);
      reporter.change("updated", "claude-rc.service.d/override.conf");
    }
  } else {
    reporter.info(
      "[5/6] claude-rc.service: not present on this host — skipping.",
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
  if (currentLimit === `${recommendedGiB}G`) {
    reporter.info(
      `[6/6] CLAUDE_CODE_TOOL_MEMORY_LIMIT: already ${currentLimit} in settings.local.json — leaving as-is.`,
    );
  } else {
    reporter.info(
      `[6/6] CLAUDE_CODE_TOOL_MEMORY_LIMIT: would set to ${recommendedGiB}G in ` +
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
