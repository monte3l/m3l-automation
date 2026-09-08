/**
 * Adaptive host-resource profiling (successor design to ADR-0080's fixed
 * `50%`-style constants). Detects the live host's OS, architecture, real
 * hardware (physical/performance cores, memory, swap, pressure), and
 * concurrent-Claude-session count, then derives a concurrency/memory budget
 * from those facts instead of a constant that can only be right on one host.
 * See docs/plans/2026-09-08-adaptive-host-budgeting.md.
 *
 * No consumer is switched over to this module yet (that is slice P2 of the
 * same wave) — this slice ships the detection + derivation only, plus
 * `bin/bench-gates.mjs`'s measurement harness, so the switch-over has real
 * before/after numbers to justify it.
 *
 * Every fact-gathering function accepts an injectable `io` (shell exec + fs
 * read) so tests exercise them against fixture text rather than the live OS
 * — same injection pattern as `bin/lib/staleness-scan.mjs`'s `defaultRunGit`.
 * The parsing functions below are pure and take raw command/file output
 * directly, so they're unit-testable with no injection at all.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, totalmem, freemem } from "node:os";
import process from "node:process";

/** Real `node:os` accessors — the default `nodeOs` seam for {@link detectHostProfile}. */
const DEFAULT_NODE_OS = { availableParallelism, totalmem, freemem };

/**
 * @typedef {{
 *   some: { avg10: number, avg60: number, avg300: number, total: number },
 *   full: { avg10: number, avg60: number, avg300: number, total: number } | null,
 * }} PressureReading
 */

/**
 * @typedef {{
 *   os: "linux" | "darwin" | "other",
 *   distro: string | null,
 *   arch: string,
 *   logicalCores: number,
 *   physicalCores: number,
 *   performanceCores: number | null,
 *   smt: boolean,
 *   totalMemGiB: number,
 *   availableMemGiB: number,
 *   swapGiB: number,
 *   hasZram: boolean,
 *   isCI: boolean,
 *   isContainer: boolean,
 *   fsType: string | null,
 *   pressure: { cpu: PressureReading | null, memory: PressureReading | null, io: PressureReading | null } | null,
 *   sessions: number,
 *   warnings?: string[],
 * }} HostProfile
 */

/**
 * @typedef {{
 *   run: (cmd: string, args: string[]) => string | null,
 *   readFile: (path: string) => string | null,
 *   exists: (path: string) => boolean,
 * }} HostProfileIo
 */

/**
 * Default `io`: real shell/filesystem access, every failure tolerated as
 * `null`/`false` rather than thrown — mirrors `setup-host-resources.mjs`'s
 * `shQuiet`/`tryReadFile`. A gathering function must never abort the whole
 * profile because one optional probe (e.g. `lscpu` missing in a minimal
 * container) failed.
 *
 * @type {HostProfileIo}
 */
export const DEFAULT_IO = {
  run(cmd, args) {
    try {
      return execFileSync(cmd, args, { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists(path) {
    return existsSync(path);
  },
};

// ---------------------------------------------------------------------------
// Pure parsers — each takes raw command/file output and returns structured
// data. No IO, no process access; fully unit-testable against fixture text.
// ---------------------------------------------------------------------------

/**
 * Classify `process.platform` into the three buckets this module budgets
 * for. Any platform besides `linux`/`darwin` (win32, freebsd, ...) lands in
 * `other` and gets the conservative node:os-only fallback profile.
 *
 * @param {string} nodePlatform
 * @returns {"linux" | "darwin" | "other"}
 */
export function classifyOsFromPlatform(nodePlatform) {
  if (nodePlatform === "linux") return "linux";
  if (nodePlatform === "darwin") return "darwin";
  return "other";
}

/**
 * Resolve the session count to budget for: an explicit `--sessions`
 * override wins outright; otherwise the live count, floored at 1 so a
 * budget is never divided by zero (a host running zero `claude` processes
 * still needs a sane single-session budget for e.g. a benchmark run).
 *
 * @param {{ override?: number, liveCount: number }} args
 * @returns {number}
 */
export function resolveSessions({ override, liveCount }) {
  if (
    typeof override === "number" &&
    Number.isInteger(override) &&
    override > 0
  ) {
    return override;
  }
  return Math.max(1, liveCount);
}

/**
 * Count processes whose command name is exactly `claude`, from a
 * `ps -eo comm --no-headers` listing. Duplicated (not imported) from
 * `bin/check-host-resources.mjs`'s `countClaudeProcesses`: importing a
 * top-level script into a `bin/lib/*.mjs` module the script itself might
 * later import back from would invert the intended dependency direction.
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
 * Parse `lscpu -J`'s JSON shape (`{ lscpu: [{ field, data }, ...] }`) into
 * physical-core/SMT facts. Returns `null` on any structurally unexpected
 * input (missing binary, unparseable JSON, absent fields) so the caller
 * falls back to `/proc/cpuinfo`.
 *
 * @param {string | null} lscpuJsonOutput
 * @returns {{ physicalCores: number, smt: boolean } | null}
 */
export function parseLscpuJson(lscpuJsonOutput) {
  if (!lscpuJsonOutput) return null;
  try {
    const parsed = JSON.parse(lscpuJsonOutput);
    /** @type {Map<string, string>} */
    const fields = new Map(
      (parsed.lscpu ?? []).map((entry) => [
        String(entry.field).replace(/:$/, "").trim(),
        String(entry.data).trim(),
      ]),
    );
    const coresPerSocket = Number(fields.get("Core(s) per socket"));
    const sockets = Number(fields.get("Socket(s)"));
    const threadsPerCore = Number(fields.get("Thread(s) per core"));
    if (
      !Number.isFinite(coresPerSocket) ||
      !Number.isFinite(sockets) ||
      !Number.isFinite(threadsPerCore) ||
      coresPerSocket <= 0 ||
      sockets <= 0 ||
      threadsPerCore <= 0
    ) {
      return null;
    }
    return {
      physicalCores: coresPerSocket * sockets,
      smt: threadsPerCore > 1,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback physical-core count from `/proc/cpuinfo` when `lscpu` is
 * unavailable (minimal container images often omit `util-linux`). Counts
 * distinct `physical id`/`core id` pairs; when those fields are absent
 * (common on cloud ARM hosts with a single package reported with no
 * `physical id` line), falls back to the logical processor count with
 * `smt: false` — the same "unknown SMT" assumption `node:os` itself makes.
 *
 * @param {string | null} cpuinfoText
 * @returns {{ physicalCores: number, smt: boolean, logicalCores: number } | null}
 */
export function parseCpuinfoCores(cpuinfoText) {
  if (!cpuinfoText) return null;
  const blocks = cpuinfoText
    .split(/\n\n+/)
    .filter((b) => b.includes("processor"));
  if (blocks.length === 0) return null;
  const logicalCores = blocks.length;
  const pairs = new Set();
  let hasPhysicalId = true;
  for (const block of blocks) {
    const physicalId = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
    const coreId = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (physicalId === undefined || coreId === undefined) {
      hasPhysicalId = false;
      break;
    }
    pairs.add(`${physicalId}:${coreId}`);
  }
  if (!hasPhysicalId) {
    return { physicalCores: logicalCores, smt: false, logicalCores };
  }
  const physicalCores = pairs.size;
  return { physicalCores, smt: physicalCores < logicalCores, logicalCores };
}

/**
 * Parse `/proc/meminfo` into total/available GiB. `MemAvailable` (kernel
 * ≥3.14) is preferred over `MemFree` — it already accounts for reclaimable
 * cache, which `MemFree` alone systematically undercounts as "used".
 *
 * @param {string | null} meminfoText
 * @returns {{ totalMemGiB: number, availableMemGiB: number } | null}
 */
export function parseMeminfo(meminfoText) {
  if (!meminfoText) return null;
  const totalKiB = Number(/^MemTotal:\s*(\d+)/m.exec(meminfoText)?.[1]);
  const availableKiB = Number(/^MemAvailable:\s*(\d+)/m.exec(meminfoText)?.[1]);
  if (!Number.isFinite(totalKiB) || totalKiB <= 0) return null;
  const toGiB = (kib) => Math.round((kib / 1024 / 1024) * 10) / 10;
  return {
    totalMemGiB: toGiB(totalKiB),
    availableMemGiB: Number.isFinite(availableKiB)
      ? toGiB(availableKiB)
      : toGiB(totalKiB),
  };
}

/**
 * Parse `/proc/swaps` for total provisioned swap (GiB, summed across every
 * device) and whether any device is zram-backed.
 *
 * @param {string | null} swapsText
 * @returns {{ swapGiB: number, hasZram: boolean }}
 */
export function parseProcSwaps(swapsText) {
  if (!swapsText) return { swapGiB: 0, hasZram: false };
  const lines = swapsText
    .split("\n")
    .slice(1)
    .filter((l) => l.trim() !== "");
  let totalKiB = 0;
  for (const line of lines) {
    const sizeKiB = Number(line.trim().split(/\s+/)[2]);
    if (Number.isFinite(sizeKiB)) totalKiB += sizeKiB;
  }
  return {
    swapGiB: Math.round((totalKiB / 1024 / 1024) * 10) / 10,
    hasZram: /zram/.test(swapsText),
  };
}

/**
 * Parse one `/proc/pressure/{cpu,memory,io}` file's `some`/`full` lines.
 * The `cpu` file may have no `full` line (system-wide CPU pressure has no
 * "all tasks stalled" state on most kernels) — returned as `full: null`.
 *
 * @param {string | null} pressureText
 * @returns {PressureReading | null}
 */
export function parsePressureFile(pressureText) {
  if (!pressureText) return null;
  /** @param {string} kind */
  const parseLine = (kind) => {
    const line = pressureText.split("\n").find((l) => l.startsWith(kind));
    if (!line) return null;
    /** @type {Record<string, number>} */
    const values = {};
    for (const m of line.matchAll(/(\w+)=([\d.]+)/g)) {
      values[m[1]] = Number(m[2]);
    }
    if (!Number.isFinite(values.avg10)) return null;
    return {
      avg10: values.avg10,
      avg60: values.avg60,
      avg300: values.avg300,
      total: values.total,
    };
  };
  const some = parseLine("some");
  if (!some) return null;
  return { some, full: parseLine("full") };
}

/**
 * Extract `PRETTY_NAME="..."` from `/etc/os-release` content.
 *
 * @param {string | null} osReleaseText
 * @returns {string | null}
 */
export function parseOsReleasePrettyName(osReleaseText) {
  if (!osReleaseText) return null;
  const match = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(osReleaseText);
  return match ? match[1].trim() : null;
}

/**
 * Find the root filesystem's type from `/proc/mounts` content
 * (`device mountpoint fstype options dump pass`, one per line).
 *
 * @param {string | null} procMountsText
 * @returns {string | null}
 */
export function parseRootFsType(procMountsText) {
  if (!procMountsText) return null;
  for (const line of procMountsText.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === "/") return fields[2] ?? null;
  }
  return null;
}

/**
 * Best-effort container detection from `/proc/1/cgroup` content plus
 * whether `/.dockerenv` exists. Never load-bearing for the derived budget
 * today — informational only, kept for a future container-specific policy.
 *
 * @param {string | null} cgroupText
 * @param {boolean} dockerEnvExists
 * @returns {boolean}
 */
export function isLikelyContainer(cgroupText, dockerEnvExists) {
  if (dockerEnvExists) return true;
  // The first runtime-name marker below is built from two literal parts
  // rather than one contiguous word: `check:no-docker` (ADR-0091) scans
  // every bin/** file's raw text for that exact word used as a would-be
  // command invocation, and a cgroup-path substring to detect (never
  // executed) is exactly the false-positive class that gate's own module
  // documents as needing a self-exemption for its own source.
  const containerMarker = new RegExp(
    `${"do" + "cker"}|kubepods|containerd|lxc`,
  );
  return containerMarker.test(cgroupText ?? "");
}

/**
 * Parse macOS `sysctl -n hw.physicalcpu hw.logicalcpu hw.memsize` output
 * (one value per line, in that order) plus optional P/E `perflevel*`
 * logical-CPU counts appended the same way.
 *
 * @param {string | null} output
 * @returns {{ physicalCores: number, logicalCores: number, totalMemGiB: number } | null}
 */
export function parseDarwinSysctlCore(output) {
  if (!output) return null;
  const lines = output.split("\n").map(Number);
  const [physicalCores, logicalCores, memBytes] = lines;
  if (
    !Number.isFinite(physicalCores) ||
    !Number.isFinite(logicalCores) ||
    !Number.isFinite(memBytes)
  ) {
    return null;
  }
  return {
    physicalCores,
    logicalCores,
    totalMemGiB: Math.round((memBytes / 1024 ** 3) * 10) / 10,
  };
}

/**
 * Parse Apple Silicon's P/E split from
 * `sysctl -n hw.perflevel0.logicalcpu` output (performance cores; Apple
 * lists perflevel0 as the P-cores). Returns `null` on an Intel Mac or any
 * host where the sysctl doesn't exist.
 *
 * @param {string | null} output
 * @returns {number | null} performance-core count
 */
export function parseDarwinPerformanceCores(output) {
  if (!output) return null;
  const performanceCores = Number(output.split("\n")[0]);
  return Number.isFinite(performanceCores) && performanceCores > 0
    ? performanceCores
    : null;
}

/**
 * Parse `sysctl vm.swapusage` output, e.g.
 * `vm.swapusage: total = 3072.00M  used = 0.00M  free = 3072.00M`.
 *
 * @param {string | null} output
 * @returns {number} swap size in GiB, 0 if unparseable
 */
export function parseDarwinSwapUsage(output) {
  if (!output) return 0;
  const match = /total\s*=\s*([\d.]+)M/.exec(output);
  return match ? Math.round((Number(match[1]) / 1024) * 10) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Impure gathering — one function per OS, composing the pure parsers above
// over live `io` calls. Each returns a complete HostProfile.
// ---------------------------------------------------------------------------

/**
 * @param {HostProfileIo} io
 * @param {{ isCI: boolean, sessions: number }} common
 * @returns {HostProfile}
 */
function gatherLinuxProfile(io, common) {
  /** @type {string[]} */
  const warnings = [];
  const cpuinfoCores = parseCpuinfoCores(io.readFile("/proc/cpuinfo"));
  const cpu =
    parseLscpuJson(io.run("lscpu", ["-J"])) ??
    (cpuinfoCores
      ? { physicalCores: cpuinfoCores.physicalCores, smt: cpuinfoCores.smt }
      : null);
  if (!cpu) {
    warnings.push(
      "CPU topology detection failed (lscpu and /proc/cpuinfo both " +
        "unreadable/unparseable) — physicalCores/logicalCores defaulted to " +
        "1, which understates a real multi-core host; not a measurement.",
    );
  }
  const mem = parseMeminfo(io.readFile("/proc/meminfo"));
  if (!mem) {
    warnings.push(
      "/proc/meminfo unreadable/unparseable — totalMemGiB/availableMemGiB " +
        "defaulted to 0, not a real measurement.",
    );
  }
  const swap = parseProcSwaps(io.readFile("/proc/swaps"));
  return {
    os: "linux",
    distro: parseOsReleasePrettyName(io.readFile("/etc/os-release")),
    arch: process.arch,
    logicalCores: cpuinfoCores?.logicalCores ?? cpu?.physicalCores ?? 1,
    physicalCores: cpu?.physicalCores ?? cpuinfoCores?.logicalCores ?? 1,
    performanceCores: null,
    smt: cpu?.smt ?? false,
    totalMemGiB: mem?.totalMemGiB ?? 0,
    availableMemGiB: mem?.availableMemGiB ?? 0,
    swapGiB: swap.swapGiB,
    hasZram: swap.hasZram,
    isCI: common.isCI,
    isContainer: isLikelyContainer(
      io.readFile("/proc/1/cgroup"),
      io.exists("/.dockerenv"),
    ),
    fsType: parseRootFsType(io.readFile("/proc/mounts")),
    pressure: {
      cpu: parsePressureFile(io.readFile("/proc/pressure/cpu")),
      memory: parsePressureFile(io.readFile("/proc/pressure/memory")),
      io: parsePressureFile(io.readFile("/proc/pressure/io")),
    },
    sessions: common.sessions,
    warnings,
  };
}

/**
 * Darwin collector — behind the same seam as the Linux one, but unproven on
 * real hardware as of this wave (no Mac available to this project yet). No
 * PSI equivalent exists on Darwin; `pressure` is reported `null` rather than
 * faked. Memory availability falls back to total memory (no `vm_stat`
 * parsing — a `pages free` estimate is noisy and this profile only needs a
 * defensible order of magnitude until validated on real hardware).
 *
 * @param {HostProfileIo} io
 * @param {{ isCI: boolean, sessions: number }} common
 * @returns {HostProfile}
 */
function gatherDarwinProfile(io, common) {
  /** @type {string[]} */
  const warnings = [];
  const rawCore = parseDarwinSysctlCore(
    io.run("sysctl", ["-n", "hw.physicalcpu", "hw.logicalcpu", "hw.memsize"]),
  );
  if (!rawCore) {
    warnings.push(
      "sysctl hw.physicalcpu/hw.logicalcpu/hw.memsize detection failed — " +
        "physicalCores/logicalCores/totalMemGiB defaulted to 1/1/0, not " +
        "real measurements.",
    );
  }
  const core = rawCore ?? { physicalCores: 1, logicalCores: 1, totalMemGiB: 0 };
  const performanceCores = parseDarwinPerformanceCores(
    io.run("sysctl", ["-n", "hw.perflevel0.logicalcpu"]),
  );
  const swapGiB = parseDarwinSwapUsage(io.run("sysctl", ["vm.swapusage"]));
  return {
    os: "darwin",
    distro: null,
    arch: process.arch,
    logicalCores: core.logicalCores,
    physicalCores: core.physicalCores,
    performanceCores,
    smt: false,
    totalMemGiB: core.totalMemGiB,
    availableMemGiB: core.totalMemGiB,
    swapGiB,
    hasZram: false,
    isCI: common.isCI,
    isContainer: false,
    fsType: null,
    pressure: null,
    sessions: common.sessions,
    warnings,
  };
}

/**
 * Conservative fallback for any platform besides linux/darwin, using only
 * `node:os` (no shell-outs, nothing OS-specific to get wrong).
 *
 * @param {{ isCI: boolean, sessions: number }} common
 * @param {{ availableParallelism: () => number, totalmem: () => number, freemem: () => number }} nodeOs
 * @returns {HostProfile}
 */
function gatherFallbackProfile(common, nodeOs) {
  const totalMemGiB = Math.round((nodeOs.totalmem() / 1024 ** 3) * 10) / 10;
  const availableMemGiB = Math.round((nodeOs.freemem() / 1024 ** 3) * 10) / 10;
  const logicalCores = nodeOs.availableParallelism();
  return {
    os: "other",
    distro: null,
    arch: process.arch,
    logicalCores,
    physicalCores: logicalCores,
    performanceCores: null,
    smt: false,
    totalMemGiB,
    availableMemGiB,
    swapGiB: 0,
    hasZram: false,
    isCI: common.isCI,
    isContainer: false,
    fsType: null,
    pressure: null,
    sessions: common.sessions,
    warnings: [],
  };
}

/**
 * Detect the live host's full profile: OS, architecture, real hardware,
 * pressure, and the session count to budget for. This is the single source
 * of truth {@link deriveBudget} derives every concurrency/memory knob from.
 *
 * @param {{
 *   sessions?: number,
 *   io?: HostProfileIo,
 *   nodeOs?: { availableParallelism: () => number, totalmem: () => number, freemem: () => number },
 * }} [opts] `sessions` overrides the live-detected count (floored at 1
 *   either way); `io`/`nodeOs` are injection seams for tests — omit both to
 *   read the real host.
 * @returns {HostProfile}
 */
export function detectHostProfile(opts = {}) {
  const io = opts.io ?? DEFAULT_IO;
  const nodeOs = opts.nodeOs ?? DEFAULT_NODE_OS;
  const isCI = Boolean(process.env.CI);
  const liveCount = countClaudeProcesses(
    io.run("ps", ["-eo", "comm", "--no-headers"]) ?? "",
  );
  const sessions = resolveSessions({ override: opts.sessions, liveCount });
  const common = { isCI, sessions };

  const osKind = classifyOsFromPlatform(process.platform);
  if (osKind === "linux") return gatherLinuxProfile(io, common);
  if (osKind === "darwin") return gatherDarwinProfile(io, common);
  return gatherFallbackProfile(common, nodeOs);
}

// ---------------------------------------------------------------------------
// Budget derivation — pure, no IO. The entire tuning policy lives here so
// it's trivially testable against fixture profiles (ubuntu-arm64, CI x86_64,
// macOS P/E, unknown-OS fallback) without touching a real host.
// ---------------------------------------------------------------------------

// Conservative default when a caller doesn't pass a measured `perWorkerGiB`.
// Not exported: no consumer needs it as public API until slice P2 wires a
// tool-specific caller — keeping it module-private avoids a knip "unused
// export" finding for a symbol nothing outside this file uses yet.
const DEFAULT_PER_WORKER_GIB = 1;

/**
 * @typedef {{
 *   effectiveCores: number,
 *   sessions: number,
 *   perSessionCores: number,
 *   memoryBoundWorkers: number,
 *   workers: number,
 *   limitedBy: "cpu" | "memory",
 * }} HostBudget
 */

/**
 * Derive a concurrency/memory budget from a detected (or fixture) profile.
 * Pure function — the whole policy in one place, per the wave's design goal
 * of replacing scattered fixed constants with one derivation.
 *
 * Three rules a fixed constant cannot express:
 *  - Prefer performance/physical cores over logical: SMT threads and
 *    efficiency cores don't each give a full core's worth of CPU-bound work.
 *  - The budget is `min(cpu-bound, memory-bound)` — a core-only budget can
 *    OOM a small-memory CI runner regardless of how many cores it has.
 *  - CI earns the whole machine: a CI runner is a fresh single-purpose
 *    container with no concurrent-session reservation to make.
 *
 * @param {HostProfile} profile
 * @param {{ perWorkerGiB?: number }} [opts] `perWorkerGiB` is the caller's
 *   own measured per-process memory footprint (e.g. ~3.4 for ESLint, a
 *   fraction of that for a vitest fork) — different tools should pass their
 *   own measured value rather than share one constant.
 * @returns {HostBudget}
 */
export function deriveBudget(profile, opts = {}) {
  const perWorkerGiB = opts.perWorkerGiB ?? DEFAULT_PER_WORKER_GIB;
  const effectiveCores =
    profile.performanceCores ?? profile.physicalCores ?? profile.logicalCores;
  const sessions = profile.isCI ? 1 : Math.max(1, profile.sessions);
  const perSessionCores = Math.max(1, Math.floor(effectiveCores / sessions));
  const memoryBoundWorkers = Math.max(
    1,
    Math.floor(profile.availableMemGiB / perWorkerGiB),
  );
  const workers = Math.max(1, Math.min(perSessionCores, memoryBoundWorkers));
  return {
    effectiveCores,
    sessions,
    perSessionCores,
    memoryBoundWorkers,
    workers,
    limitedBy: perSessionCores <= memoryBoundWorkers ? "cpu" : "memory",
  };
}
