#!/usr/bin/env node
/**
 * Preflight advisory for the OOM/livelock hazard documented in
 * docs/adr/0080-host-resource-budgeting.md: running 2+ Claude Code sessions
 * against this repo on a 16 GB Linux box can exhaust memory faster than the
 * kernel's own OOM killer reacts (memory-pressure livelock, not a clean
 * kill). This script reports the host mitigations that address that —
 * whether an OOM daemon is active, whether zram swap exists, whether the
 * user's systemd slice has a memory ceiling, and whether
 * `CLAUDE_CODE_TOOL_MEMORY_LIMIT` is set — plus how many `claude` processes
 * are already running.
 *
 * `bin/setup-host-resources.mjs` applies the fixes this reports on; this
 * script only observes and warns. Every check here is Linux-specific
 * (systemd + zram); on any other platform it reports a single informational
 * line and exits 0.
 *
 * WARN-ONLY, same pattern as guard-provenance-staleness.mjs and the other
 * advisory bin/ gates: this never exits non-zero. There is no CI equivalent
 * — a CI runner is a fresh single-purpose container, not the multi-session
 * host this guards.
 *
 * Usage:
 *   node bin/check-host-resources.mjs          # human-readable report
 *   node bin/check-host-resources.mjs --json   # structured report
 *   pnpm check:host-resources
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { totalmem } from "node:os";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

/**
 * Recommend a `CLAUDE_CODE_TOOL_MEMORY_LIMIT` value from total host memory,
 * adaptive per-machine rather than a single hardcoded number (24 GB dev boxes
 * and 16 GB target boxes both run this repo). Reserves headroom for the OS
 * plus each session's own non-tool overhead (measured on the audit box:
 * ~776 MB `claude` client + ~86 MB stdio MCP server + hook/statusLine burst,
 * called ~1 GiB per session below) before splitting what remains across the
 * number of sessions the caller wants to support concurrently.
 *
 * @param {number} totalMemGiB total host memory in GiB
 * @param {number} [maxConcurrentSessions] sessions to budget for at once
 * @returns {number} recommended limit in whole GiB, floored at 2
 */
export function recommendToolMemoryLimitGiB(
  totalMemGiB,
  maxConcurrentSessions = 2,
) {
  const OS_RESERVE_GIB = 2;
  const PER_SESSION_CLIENT_OVERHEAD_GIB = 1;
  const perSessionBudget =
    (totalMemGiB - OS_RESERVE_GIB) / Math.max(1, maxConcurrentSessions) -
    PER_SESSION_CLIENT_OVERHEAD_GIB;
  return Math.max(2, Math.floor(perSessionBudget));
}

/**
 * Parse `swapon --show=NAME --noheadings` output for a zram device.
 *
 * @param {string} swaponOutput
 * @returns {boolean}
 */
export function hasZramSwap(swaponOutput) {
  return /zram/.test(swaponOutput);
}

/**
 * Parse `systemctl is-active <unit>` output.
 *
 * @param {string} output
 * @returns {boolean}
 */
export function isSystemdUnitActive(output) {
  return output.trim() === "active";
}

/**
 * Parse `systemctl show <slice> -p MemoryMax --value` output into a finite
 * ceiling, or null when unset (`"infinity"`, empty, or unparseable).
 *
 * @param {string} output
 * @returns {number | null}
 */
export function parseMemoryMax(output) {
  const trimmed = output.trim();
  if (trimmed === "" || trimmed === "infinity") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Count processes whose command name is exactly `claude` from a
 * `ps -eo comm` listing (one name per line, as produced with `--no-headers`).
 *
 * @param {string} psOutput
 * @returns {number}
 */
export function countClaudeProcesses(psOutput) {
  return psOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l === "claude").length;
}

/**
 * Pure decision function over already-gathered host facts — exported for
 * unit testing without touching the real OS. Never signals failure: every
 * finding is a warning, matching this script's warn-only contract.
 *
 * @param {{
 *   platform: string,
 *   oomDaemonActive: boolean,
 *   hasZram: boolean,
 *   userSliceMemoryMax: number | null,
 *   toolMemoryLimitEnv: string | undefined,
 *   claudeProcessCount: number,
 *   totalMemGiB: number,
 * }} facts
 * @returns {{ warnings: string[], info: string[] }}
 */
export function evaluateHostResources(facts) {
  if (facts.platform !== "linux") {
    return {
      info: [
        `Host resource checks are Linux-specific (systemd + zram); ` +
          `platform is "${facts.platform}" — skipping.`,
      ],
      warnings: [],
    };
  }

  const warnings = [];
  if (!facts.oomDaemonActive) {
    warnings.push(
      "No OOM daemon (earlyoom/systemd-oomd) is active. Without one, memory " +
        "pressure can livelock the box before the kernel OOM killer fires. " +
        "See docs/contributing/host-resources.md.",
    );
  }
  if (!facts.hasZram) {
    warnings.push(
      "No zram swap device found. zram gives the cheapest extra headroom " +
        "on a memory-constrained host — see docs/contributing/host-resources.md.",
    );
  }
  if (facts.userSliceMemoryMax === null) {
    warnings.push(
      "user@<uid>.slice has no MemoryMax ceiling (unbounded). A single " +
        "runaway session can consume all host memory.",
    );
  }
  if (!facts.toolMemoryLimitEnv) {
    const recommended = recommendToolMemoryLimitGiB(facts.totalMemGiB);
    warnings.push(
      `CLAUDE_CODE_TOOL_MEMORY_LIMIT is not set. Recommended for this host ` +
        `(${facts.totalMemGiB} GiB total): ${recommended}G. Set it in ` +
        `.claude/settings.local.json's "env" block (host-specific, ` +
        `gitignored) or run bin/setup-host-resources.mjs.`,
    );
  }
  if (facts.claudeProcessCount > 1) {
    warnings.push(
      `${facts.claudeProcessCount} "claude" processes are already running. ` +
        "Each session measured ~1 GiB idle overhead before any tool use " +
        "(client + stdio MCP server); confirm the host has headroom before " +
        "starting more work concurrently.",
    );
  }
  return { warnings, info: [] };
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const platform = process.platform;
  const totalMemGiB = Math.round((totalmem() / 1024 ** 3) * 10) / 10;

  const runQuiet = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8" });
    } catch {
      return "";
    }
  };

  const facts = {
    platform,
    oomDaemonActive:
      isSystemdUnitActive(runQuiet("systemctl", ["is-active", "earlyoom"])) ||
      isSystemdUnitActive(runQuiet("systemctl", ["is-active", "systemd-oomd"])),
    hasZram: (() => {
      try {
        return hasZramSwap(readFileSync("/proc/swaps", "utf8"));
      } catch {
        return hasZramSwap(runQuiet("swapon", ["--show=NAME", "--noheadings"]));
      }
    })(),
    userSliceMemoryMax: parseMemoryMax(
      runQuiet("systemctl", [
        "show",
        `user-${process.getuid?.() ?? 0}.slice`,
        "-p",
        "MemoryMax",
        "--value",
      ]),
    ),
    toolMemoryLimitEnv: process.env.CLAUDE_CODE_TOOL_MEMORY_LIMIT,
    claudeProcessCount: countClaudeProcesses(
      runQuiet("ps", ["-eo", "comm", "--no-headers"]),
    ),
    totalMemGiB,
  };

  const { warnings, info } = evaluateHostResources(facts);
  for (const line of info) reporter.info(line);
  for (const warning of warnings) reporter.warn(warning);

  if (warnings.length === 0) {
    reporter.succeed(
      info.length > 0
        ? "Host resource checks skipped (non-Linux platform)."
        : "Host resource mitigations in place.",
    );
  }
  reporter.finish({ totalMemGiB, warningCount: warnings.length });
  // Warn-only: always exit 0. See file header.
}
