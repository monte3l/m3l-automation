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
 * script only observes and warns. Linux checks are systemd + zram based;
 * macOS has a parallel branch reporting on what IS observable there (jetsam
 * memory pressure, swap, vm_stat-derived available memory) and naming the
 * macOS analogue of each Linux-only mitigation (jetsam for earlyoom, the
 * in-kernel memory compressor for zram, no cgroups for `MemoryMax`) rather
 * than silently skipping — see .claude/rules/harness-artifacts.md's
 * "cries wolf" / silent-skip guidance. Any other platform gets a single
 * informational line and exits 0.
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
import { parseDarwinVmStat } from "./lib/host-profile.mjs";

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
 * `ps -eo comm=` listing (one name per line — `comm=`'s empty header is the
 * portable no-header form, working on both BSD `ps` (macOS) and procps
 * (Linux); BSD's long-option parser rejects the GNU-only `--no-headers`).
 * BSD `comm` also renders the path as invoked (e.g. `/usr/libexec/logd`)
 * where GNU `comm` always yields a bare basename, so a leading path is
 * stripped before the exact-match compare.
 *
 * @param {string} psOutput
 * @returns {number}
 */
export function countClaudeProcesses(psOutput) {
  return psOutput
    .split("\n")
    .map((l) => l.trim().replace(/^.*\//, ""))
    .filter((l) => l === "claude").length;
}

/**
 * Parse `sysctl -n kern.memorystatus_vm_pressure_level` output — Apple's own
 * jetsam pressure level (1 = normal, 2 = warning, 4 = critical).
 *
 * @param {string} output
 * @returns {number | null} null for empty/non-numeric output
 */
export function parseDarwinMemoryPressureLevel(output) {
  const trimmed = output.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `sysctl vm.swapusage` output into total/used GiB, e.g.
 * `vm.swapusage: total = 1024.00M  used = 124.00M  free = 900.00M`.
 * Tolerates a comma decimal separator too — this script's own `runQuiet`
 * forces `LC_ALL=C`, but the parser stays locale-tolerant on its own so it
 * is directly fixture-testable independent of that (same reasoning as
 * `bin/lib/host-profile.mjs`'s `parseDarwinSwapUsage`).
 *
 * @param {string} output
 * @returns {{ totalGiB: number, usedGiB: number } | null}
 */
export function parseDarwinSwapDetail(output) {
  const totalMatch = /total\s*=\s*([\d.,]+)M/.exec(output);
  const usedMatch = /used\s*=\s*([\d.,]+)M/.exec(output);
  if (!totalMatch || !usedMatch) return null;
  const toGiB = (raw) =>
    Math.round((Number(raw.replace(",", ".")) / 1024) * 10) / 10;
  const totalGiB = toGiB(totalMatch[1]);
  const usedGiB = toGiB(usedMatch[1]);
  if (!Number.isFinite(totalGiB) || !Number.isFinite(usedGiB)) return null;
  return { totalGiB, usedGiB };
}

/**
 * macOS analogue of {@link evaluateHostResources}'s Linux branch. macOS's
 * OOM/swap/per-session memory story is entirely in-kernel and not
 * user-configurable — jetsam replaces earlyoom, the always-on memory
 * compressor replaces zram, and there are no cgroups so no `MemoryMax`
 * equivalent — so this names each analogue explicitly rather than silently
 * skipping (an advisory check with nothing to say is worse than one that
 * explains why — see .claude/rules/harness-artifacts.md).
 * `CLAUDE_CODE_TOOL_MEMORY_LIMIT` is documented Linux/WSL-only
 * (docs/contributing/host-resources.md), so it is reported informationally
 * here and never warned on — warning about a setting the CLI itself ignores
 * on this platform would cry wolf.
 *
 * @param {{
 *   memoryPressureLevel: number | null,
 *   swap: { totalGiB: number, usedGiB: number } | null,
 *   availableMemGiB: number | null,
 *   toolMemoryLimitEnv: string | undefined,
 *   claudeProcessCount: number,
 *   totalMemGiB: number,
 * }} facts
 * @returns {{ warnings: string[], info: string[] }}
 */

// Minimum swap actually in use, in GiB, before the swap warning below can
// fire — paired with the 50% usedFraction check so a small dynamic_pager-
// grown swap file (macOS sizes it on demand, not upfront) sitting mostly
// "used" on an otherwise healthy host doesn't cry wolf.
const SWAP_WARNING_FLOOR_GIB = 2;

export function evaluateDarwinHostResources(facts) {
  const info = [
    "earlyoom/systemd-oomd have no macOS equivalent to configure: jetsam " +
      "is the in-kernel OOM killer here and is not user-configurable.",
    "zram has no macOS equivalent to configure: the always-on in-kernel " +
      "memory compressor already does this job and cannot be sized or " +
      "disabled.",
    "user@<uid>.slice has no macOS equivalent: there are no cgroups on " +
      "Darwin, so no per-session memory ceiling can be set at the OS level.",
  ];
  const warnings = [];

  if (facts.memoryPressureLevel !== null && facts.memoryPressureLevel >= 2) {
    warnings.push(
      `macOS memory pressure is elevated ` +
        `(kern.memorystatus_vm_pressure_level = ${facts.memoryPressureLevel}; ` +
        `1 = normal, 2 = warning, 4 = critical). The host is under real ` +
        `memory pressure right now.`,
    );
  }

  if (facts.swap !== null && facts.swap.totalGiB > 0) {
    const usedFraction = facts.swap.usedGiB / facts.swap.totalGiB;
    // A bare percentage fires on normal macOS operation: dynamic_pager
    // grows the swap file on demand rather than provisioning it upfront
    // (unlike Linux's fixed zram/swapfile size), so a healthy host can sit
    // at a high used fraction of a small total (e.g. 0.6 GiB of 1 GiB) with
    // no real pressure at all. Requiring an absolute floor alongside the
    // percentage keeps this quiet on that normal case while still catching
    // genuinely heavy swapping — see .claude/rules/harness-artifacts.md on
    // an advisory check that cries wolf.
    if (usedFraction >= 0.5 && facts.swap.usedGiB >= SWAP_WARNING_FLOOR_GIB) {
      warnings.push(
        `${facts.swap.usedGiB} GiB of ${facts.swap.totalGiB} GiB swap in ` +
          `use (${Math.round(usedFraction * 100)}%). Heavy swap use is ` +
          "this host's own memory-pressure signal.",
      );
    }
  }

  if (facts.availableMemGiB !== null) {
    info.push(`${facts.availableMemGiB} GiB available (vm_stat-derived).`);
  }

  if (!facts.toolMemoryLimitEnv) {
    info.push(
      "CLAUDE_CODE_TOOL_MEMORY_LIMIT is documented Linux/WSL-only " +
        "(v2.1.233+) and has no effect on macOS, so it is not recommended " +
        "here — see docs/contributing/host-resources.md.",
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

  return { warnings, info };
}

/**
 * Pure decision function over already-gathered host facts — exported for
 * unit testing without touching the real OS. Never signals failure: every
 * finding is a warning, matching this script's warn-only contract.
 *
 * @param {{
 *   platform: string,
 *   oomDaemonActive?: boolean,
 *   hasZram?: boolean,
 *   userSliceMemoryMax?: number | null,
 *   memoryPressureLevel?: number | null,
 *   swap?: { totalGiB: number, usedGiB: number } | null,
 *   availableMemGiB?: number | null,
 *   toolMemoryLimitEnv: string | undefined,
 *   claudeProcessCount: number,
 *   totalMemGiB: number,
 * }} facts
 * @returns {{ warnings: string[], info: string[] }}
 */
export function evaluateHostResources(facts) {
  if (facts.platform === "darwin") {
    return evaluateDarwinHostResources(facts);
  }
  if (facts.platform !== "linux") {
    return {
      info: [
        `Host resource checks are Linux/macOS-specific; platform is ` +
          `"${facts.platform}" — skipping.`,
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

  // LC_ALL=C keeps every parsed command output locale-independent — without
  // it, a non-C-locale host (e.g. LC_NUMERIC=it_IT) can make `sysctl` print
  // a comma decimal separator, silently breaking the Darwin swap/pressure
  // parsers below. Same fix as bin/lib/host-profile.mjs's DEFAULT_IO.run.
  const runQuiet = (cmd, args) => {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      });
    } catch {
      return "";
    }
  };

  const facts = {
    platform,
    toolMemoryLimitEnv: process.env.CLAUDE_CODE_TOOL_MEMORY_LIMIT,
    claudeProcessCount: countClaudeProcesses(runQuiet("ps", ["-eo", "comm="])),
    totalMemGiB,
  };

  if (platform === "linux") {
    facts.oomDaemonActive =
      isSystemdUnitActive(runQuiet("systemctl", ["is-active", "earlyoom"])) ||
      isSystemdUnitActive(runQuiet("systemctl", ["is-active", "systemd-oomd"]));
    facts.hasZram = (() => {
      try {
        return hasZramSwap(readFileSync("/proc/swaps", "utf8"));
      } catch {
        return hasZramSwap(runQuiet("swapon", ["--show=NAME", "--noheadings"]));
      }
    })();
    facts.userSliceMemoryMax = parseMemoryMax(
      runQuiet("systemctl", [
        "show",
        `user-${process.getuid?.() ?? 0}.slice`,
        "-p",
        "MemoryMax",
        "--value",
      ]),
    );
  } else if (platform === "darwin") {
    facts.memoryPressureLevel = parseDarwinMemoryPressureLevel(
      runQuiet("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    );
    facts.swap = parseDarwinSwapDetail(runQuiet("sysctl", ["vm.swapusage"]));
    facts.availableMemGiB = parseDarwinVmStat(runQuiet("vm_stat", []));
  }

  const { warnings, info } = evaluateHostResources(facts);
  for (const line of info) reporter.info(line);
  for (const warning of warnings) reporter.warn(warning);

  const isSupportedPlatform = platform === "linux" || platform === "darwin";
  if (warnings.length === 0) {
    reporter.succeed(
      isSupportedPlatform
        ? "Host resource mitigations in place."
        : "Host resource checks skipped (unsupported platform).",
    );
  }
  reporter.finish({ totalMemGiB, warningCount: warnings.length });
  // Warn-only: always exit 0. See file header.
}
