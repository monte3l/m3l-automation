import { describe, expect, test } from "vitest";
import type { HostProfile } from "../lib/host-profile.mjs";
import {
  classifyOsFromPlatform,
  resolveSessions,
  countClaudeProcesses,
  parseLscpuJson,
  parseLscpuLogicalCores,
  parseCpuinfoCores,
  parseMeminfo,
  parseProcSwaps,
  parsePressureFile,
  parseOsReleasePrettyName,
  parseRootFsType,
  isLikelyContainer,
  parseDarwinSysctlCore,
  parseDarwinPerformanceCores,
  parseDarwinSwapUsage,
  detectHostProfile,
  deriveBudget,
} from "../lib/host-profile.mjs";

// ---------------------------------------------------------------------------
// classifyOsFromPlatform
// ---------------------------------------------------------------------------

describe("classifyOsFromPlatform", () => {
  test("classifies 'linux'", () => {
    expect(classifyOsFromPlatform("linux")).toBe("linux");
  });

  test("classifies 'darwin'", () => {
    expect(classifyOsFromPlatform("darwin")).toBe("darwin");
  });

  test("classifies anything else as 'other'", () => {
    expect(classifyOsFromPlatform("win32")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// resolveSessions
// ---------------------------------------------------------------------------

describe("resolveSessions", () => {
  test("a positive integer override wins over liveCount", () => {
    expect(resolveSessions({ override: 3, liveCount: 1 })).toBe(3);
  });

  test("override of 0 is ignored, falls back to liveCount", () => {
    expect(resolveSessions({ override: 0, liveCount: 2 })).toBe(2);
  });

  test("a negative override is ignored, falls back to liveCount", () => {
    expect(resolveSessions({ override: -1, liveCount: 2 })).toBe(2);
  });

  test("a non-integer override is ignored, falls back to liveCount", () => {
    expect(resolveSessions({ override: 1.5, liveCount: 2 })).toBe(2);
  });

  test("an absent override falls back to liveCount", () => {
    expect(resolveSessions({ liveCount: 4 })).toBe(4);
  });

  test("liveCount of 0 floors to 1", () => {
    expect(resolveSessions({ liveCount: 0 })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// countClaudeProcesses
// ---------------------------------------------------------------------------

describe("countClaudeProcesses", () => {
  test("counts only exact 'claude' lines among other process names", () => {
    expect(countClaudeProcesses("node\nclaude\nbash\nclaude\n")).toBe(2);
  });

  test("does not count a line that merely contains the substring 'claude'", () => {
    expect(
      countClaudeProcesses("claude-something\nnode-claude-wrapper\n"),
    ).toBe(0);
  });

  test("returns 0 for empty input", () => {
    expect(countClaudeProcesses("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseLscpuJson
// ---------------------------------------------------------------------------

describe("parseLscpuJson", () => {
  test("parses a non-SMT fixture", () => {
    const fixture = JSON.stringify({
      lscpu: [
        { field: "Architecture:", data: "aarch64" },
        { field: "CPU(s):", data: "4" },
        { field: "Thread(s) per core:", data: "1" },
        { field: "Core(s) per socket:", data: "4" },
        { field: "Socket(s):", data: "1" },
      ],
    });
    expect(parseLscpuJson(fixture)).toEqual({
      physicalCores: 4,
      smt: false,
    });
  });

  test("parses an SMT fixture", () => {
    const fixture = JSON.stringify({
      lscpu: [
        { field: "Thread(s) per core:", data: "2" },
        { field: "Core(s) per socket:", data: "4" },
        { field: "Socket(s):", data: "1" },
      ],
    });
    expect(parseLscpuJson(fixture)).toEqual({
      physicalCores: 4,
      smt: true,
    });
  });

  test("returns null for null input", () => {
    expect(parseLscpuJson(null)).toBeNull();
  });

  test("returns null for malformed JSON without throwing", () => {
    expect(() => parseLscpuJson("{not json")).not.toThrow();
    expect(parseLscpuJson("{not json")).toBeNull();
  });

  test("returns null when needed fields are missing", () => {
    const fixture = JSON.stringify({
      lscpu: [{ field: "Architecture:", data: "aarch64" }],
    });
    expect(parseLscpuJson(fixture)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseLscpuLogicalCores
// ---------------------------------------------------------------------------

describe("parseLscpuLogicalCores", () => {
  test("extracts the 'CPU(s):' field alongside unrelated fields", () => {
    const fixture = JSON.stringify({
      lscpu: [
        { field: "Architecture:", data: "x86_64" },
        { field: "CPU(s):", data: "8" },
        { field: "Thread(s) per core:", data: "2" },
        { field: "Core(s) per socket:", data: "4" },
        { field: "Socket(s):", data: "1" },
      ],
    });
    expect(parseLscpuLogicalCores(fixture)).toBe(8);
  });

  test("returns null for null input", () => {
    expect(parseLscpuLogicalCores(null)).toBeNull();
  });

  test("returns null for malformed JSON without throwing", () => {
    expect(() => parseLscpuLogicalCores("{not json")).not.toThrow();
    expect(parseLscpuLogicalCores("{not json")).toBeNull();
  });

  test("returns null when the 'CPU(s):' field is absent", () => {
    const fixture = JSON.stringify({
      lscpu: [{ field: "Architecture:", data: "x86_64" }],
    });
    expect(parseLscpuLogicalCores(fixture)).toBeNull();
  });

  test("returns null when 'CPU(s):' is non-numeric or zero/negative", () => {
    const nonNumeric = JSON.stringify({
      lscpu: [{ field: "CPU(s):", data: "not-a-number" }],
    });
    expect(parseLscpuLogicalCores(nonNumeric)).toBeNull();

    const zero = JSON.stringify({ lscpu: [{ field: "CPU(s):", data: "0" }] });
    expect(parseLscpuLogicalCores(zero)).toBeNull();

    const negative = JSON.stringify({
      lscpu: [{ field: "CPU(s):", data: "-1" }],
    });
    expect(parseLscpuLogicalCores(negative)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseCpuinfoCores
// ---------------------------------------------------------------------------

describe("parseCpuinfoCores", () => {
  test("computes physical/logical/smt from physical id + core id pairs (2 sockets x 2 cores, SMT)", () => {
    const block = (processor: number, physicalId: number, coreId: number) =>
      `processor\t: ${processor}\nphysical id\t: ${physicalId}\ncore id\t: ${coreId}\n`;
    const cpuinfo = [
      block(0, 0, 0),
      block(1, 0, 0), // SMT sibling of processor 0
      block(2, 0, 1),
      block(3, 0, 1), // SMT sibling of processor 2
    ].join("\n");
    expect(parseCpuinfoCores(cpuinfo)).toEqual({
      physicalCores: 2,
      smt: true,
      logicalCores: 4,
    });
  });

  test("falls back to logical count with smt:false when physical id/core id are absent", () => {
    const cpuinfo =
      "processor\t: 0\nmodel name\t: Neoverse-N1\n\nprocessor\t: 1\nmodel name\t: Neoverse-N1\n";
    expect(parseCpuinfoCores(cpuinfo)).toEqual({
      physicalCores: 2,
      smt: false,
      logicalCores: 2,
    });
  });

  test("returns null for null input", () => {
    expect(parseCpuinfoCores(null)).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseCpuinfoCores("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseMeminfo
// ---------------------------------------------------------------------------

describe("parseMeminfo", () => {
  test("parses MemTotal and MemAvailable with KiB->GiB rounding to 1 decimal", () => {
    const meminfo =
      "MemTotal:       32865024 kB\n" +
      "MemFree:         1234567 kB\n" +
      "MemAvailable:   23068672 kB\n";
    const result = parseMeminfo(meminfo);
    expect(result).toEqual({
      totalMemGiB: Math.round((32865024 / 1024 / 1024) * 10) / 10,
      availableMemGiB: Math.round((23068672 / 1024 / 1024) * 10) / 10,
    });
  });

  test("falls back to MemTotal for availableMemGiB when MemAvailable is missing", () => {
    const meminfo =
      "MemTotal:       16777216 kB\nMemFree:         1000000 kB\n";
    const result = parseMeminfo(meminfo);
    expect(result).toEqual({
      totalMemGiB: 16,
      availableMemGiB: 16,
    });
  });

  test("returns null when MemTotal is missing", () => {
    expect(parseMeminfo("MemFree: 1000 kB\n")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseMeminfo(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseProcSwaps
// ---------------------------------------------------------------------------

describe("parseProcSwaps", () => {
  test("sums swap size across a zram device and a file device, hasZram:true", () => {
    const swaps =
      "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n" +
      "/dev/zram0                              partition\t4194300\t0\t100\n" +
      "/swapfile                               file    \t2097148\t0\t-2\n";
    expect(parseProcSwaps(swaps)).toEqual({
      swapGiB: Math.round(((4194300 + 2097148) / 1024 / 1024) * 10) / 10,
      hasZram: true,
    });
  });

  test("hasZram:false when no device is zram-backed", () => {
    const swaps =
      "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n" +
      "/swapfile                               file    \t2097148\t0\t-2\n";
    expect(parseProcSwaps(swaps).hasZram).toBe(false);
  });

  test("returns zero swap/false zram for null input", () => {
    expect(parseProcSwaps(null)).toEqual({ swapGiB: 0, hasZram: false });
  });

  test("returns zero swap/false zram for empty input", () => {
    expect(parseProcSwaps("")).toEqual({ swapGiB: 0, hasZram: false });
  });
});

// ---------------------------------------------------------------------------
// parsePressureFile
// ---------------------------------------------------------------------------

describe("parsePressureFile", () => {
  test("parses both some/full lines (memory pressure shape)", () => {
    const pressure =
      "some avg10=0.10 avg60=0.05 avg300=0.02 total=12345\n" +
      "full avg10=0.02 avg60=0.01 avg300=0.00 total=678\n";
    expect(parsePressureFile(pressure)).toEqual({
      some: { avg10: 0.1, avg60: 0.05, avg300: 0.02, total: 12345 },
      full: { avg10: 0.02, avg60: 0.01, avg300: 0, total: 678 },
    });
  });

  test("full is null when only a some line is present (cpu pressure shape)", () => {
    const pressure = "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
    expect(parsePressureFile(pressure)).toEqual({
      some: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
      full: null,
    });
  });

  test("returns null for null input", () => {
    expect(parsePressureFile(null)).toBeNull();
  });

  test("returns null when the 'some' line is missing avg60/avg300/total", () => {
    const pressure = "some avg10=1.50\n";
    expect(parsePressureFile(pressure)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseOsReleasePrettyName
// ---------------------------------------------------------------------------

describe("parseOsReleasePrettyName", () => {
  test("extracts the quoted PRETTY_NAME value", () => {
    const osRelease =
      'NAME="Ubuntu"\nVERSION="24.04 LTS"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n';
    expect(parseOsReleasePrettyName(osRelease)).toBe("Ubuntu 24.04 LTS");
  });

  test("returns null when PRETTY_NAME is missing", () => {
    expect(parseOsReleasePrettyName('NAME="Ubuntu"\n')).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseOsReleasePrettyName(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseRootFsType
// ---------------------------------------------------------------------------

describe("parseRootFsType", () => {
  test("finds the fstype for the '/' mount line", () => {
    const mounts =
      "/dev/root / ext4 rw,relatime 0 0\n" +
      "proc /proc proc rw,nosuid 0 0\n" +
      "tmpfs /tmp tmpfs rw 0 0\n";
    expect(parseRootFsType(mounts)).toBe("ext4");
  });

  test("returns null when no '/' mount line is present", () => {
    const mounts = "proc /proc proc rw,nosuid 0 0\ntmpfs /tmp tmpfs rw 0 0\n";
    expect(parseRootFsType(mounts)).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseRootFsType(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isLikelyContainer
// ---------------------------------------------------------------------------

describe("isLikelyContainer", () => {
  test("true when /.dockerenv exists regardless of cgroup text", () => {
    expect(isLikelyContainer("1:name=systemd:/", true)).toBe(true);
  });

  test("true when cgroup text contains 'kubepods'", () => {
    expect(
      isLikelyContainer("1:name=systemd:/kubepods/besteffort/pod123", false),
    ).toBe(true);
  });

  test("false for plain cgroup text with no dockerenv", () => {
    expect(isLikelyContainer("1:name=systemd:/init.scope", false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseDarwinSysctlCore
// ---------------------------------------------------------------------------

describe("parseDarwinSysctlCore", () => {
  test("parses physicalcpu/logicalcpu/memsize with GiB rounding", () => {
    const output = "8\n10\n17179869184";
    expect(parseDarwinSysctlCore(output)).toEqual({
      physicalCores: 8,
      logicalCores: 10,
      totalMemGiB: 16,
    });
  });

  test("returns null for malformed (non-numeric) output", () => {
    expect(parseDarwinSysctlCore("8\nten\n17179869184")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseDarwinSysctlCore(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseDarwinPerformanceCores
// ---------------------------------------------------------------------------

describe("parseDarwinPerformanceCores", () => {
  test("parses a positive performance-core count", () => {
    expect(parseDarwinPerformanceCores("4")).toBe(4);
  });

  test("returns null for '0'", () => {
    expect(parseDarwinPerformanceCores("0")).toBeNull();
  });

  test("returns null for non-numeric output", () => {
    expect(parseDarwinPerformanceCores("not-a-number")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseDarwinPerformanceCores(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseDarwinSwapUsage
// ---------------------------------------------------------------------------

describe("parseDarwinSwapUsage", () => {
  test("parses total swap in GiB from vm.swapusage output", () => {
    const output =
      "vm.swapusage: total = 3072.00M  used = 0.00M  free = 3072.00M  (encrypted)";
    expect(parseDarwinSwapUsage(output)).toBe(3);
  });

  test("returns 0 for null input", () => {
    expect(parseDarwinSwapUsage(null)).toBe(0);
  });

  test("returns 0 for unparseable output", () => {
    expect(parseDarwinSwapUsage("garbage")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectHostProfile — composed, injected io. Runs the real linux branch since
// the test runner is always Linux here (see task instructions); Darwin/
// fallback gathering is private and covered indirectly via the pure parsers
// above.
// ---------------------------------------------------------------------------

/** A complete Linux-shaped io fixture with realistic content for every probe. */
function makeLinuxIo() {
  const lscpuJson = JSON.stringify({
    lscpu: [
      { field: "Architecture:", data: "aarch64" },
      { field: "CPU(s):", data: "4" },
      { field: "Thread(s) per core:", data: "1" },
      { field: "Core(s) per socket:", data: "4" },
      { field: "Socket(s):", data: "1" },
    ],
  });
  const cpuinfo =
    "processor\t: 0\nphysical id\t: 0\ncore id\t: 0\n\n" +
    "processor\t: 1\nphysical id\t: 0\ncore id\t: 1\n\n" +
    "processor\t: 2\nphysical id\t: 0\ncore id\t: 2\n\n" +
    "processor\t: 3\nphysical id\t: 0\ncore id\t: 3\n";
  const meminfo = "MemTotal:       23068672 kB\nMemAvailable:   16777216 kB\n";
  const swaps =
    "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n" +
    "/dev/zram0                              partition\t2097148\t0\t100\n";
  const cpuPressure = "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
  const memPressure =
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n" +
    "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
  const ioPressure =
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n" +
    "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
  const osRelease = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n';
  const cgroup = "1:name=systemd:/init.scope\n";
  const mounts = "/dev/root / ext4 rw,relatime 0 0\n";
  const psOutput = "node\nclaude\nbash\n";

  const files: Record<string, string> = {
    "/proc/cpuinfo": cpuinfo,
    "/proc/meminfo": meminfo,
    "/proc/swaps": swaps,
    "/proc/pressure/cpu": cpuPressure,
    "/proc/pressure/memory": memPressure,
    "/proc/pressure/io": ioPressure,
    "/etc/os-release": osRelease,
    "/proc/1/cgroup": cgroup,
    "/proc/mounts": mounts,
  };

  return {
    run(cmd: string, args: string[]): string | null {
      if (cmd === "lscpu" && args.includes("-J")) return lscpuJson;
      if (cmd === "ps") return psOutput;
      return null;
    },
    readFile(path: string): string | null {
      return files[path] ?? null;
    },
    exists(path: string): boolean {
      return path === "/.dockerenv" ? false : false;
    },
  };
}

describe("detectHostProfile", () => {
  test("gathers a full Linux profile matching the fixture", () => {
    const io = makeLinuxIo();
    const profile = detectHostProfile({ io });
    expect(profile.os).toBe("linux");
    expect(profile.arch).toBe(process.arch);
    expect(profile.distro).toBe("Ubuntu 24.04 LTS");
    expect(profile.physicalCores).toBe(4);
    expect(profile.logicalCores).toBe(4);
    expect(profile.smt).toBe(false);
    expect(profile.performanceCores).toBeNull();
    expect(profile.totalMemGiB).toBe(
      Math.round((23068672 / 1024 / 1024) * 10) / 10,
    );
    expect(profile.availableMemGiB).toBe(
      Math.round((16777216 / 1024 / 1024) * 10) / 10,
    );
    expect(profile.swapGiB).toBe(Math.round((2097148 / 1024 / 1024) * 10) / 10);
    expect(profile.hasZram).toBe(true);
    expect(profile.isContainer).toBe(false);
    expect(profile.fsType).toBe("ext4");
    expect(profile.pressure).not.toBeNull();
    expect(profile.pressure?.cpu?.full).toBeNull();
    expect(profile.pressure?.memory?.full).not.toBeNull();
    // 1 claude line in the fixture ps output, no override -> sessions = 1
    expect(profile.sessions).toBe(1);
  });

  test("an explicit sessions override wins regardless of the fixture's ps output", () => {
    const io = makeLinuxIo();
    const profile = detectHostProfile({ sessions: 3, io });
    expect(profile.sessions).toBe(3);
  });

  test("sessions floors to 1 when the fixture's ps output has zero claude lines", () => {
    const io = makeLinuxIo();
    const zeroClaudeIo = {
      ...io,
      run(cmd: string, args: string[]): string | null {
        if (cmd === "ps") return "node\nbash\n";
        return io.run(cmd, args);
      },
    };
    const profile = detectHostProfile({ io: zeroClaudeIo });
    expect(profile.sessions).toBe(1);
  });

  // Regression for the bot-review fix: on an SMT host where lscpu succeeds
  // but /proc/cpuinfo is unreadable, logicalCores must come from lscpu's own
  // `CPU(s):` field (via parseLscpuLogicalCores), not silently fall back to
  // the (smaller) physical core count.
  test("logicalCores recovers from lscpu's CPU(s) field when /proc/cpuinfo is unreadable (SMT host)", () => {
    const io = makeLinuxIo();
    const smtLscpuJson = JSON.stringify({
      lscpu: [
        { field: "Architecture:", data: "x86_64" },
        { field: "CPU(s):", data: "8" },
        { field: "Thread(s) per core:", data: "2" },
        { field: "Core(s) per socket:", data: "4" },
        { field: "Socket(s):", data: "1" },
      ],
    });
    const smtIoNoCpuinfo = {
      ...io,
      run(cmd: string, args: string[]): string | null {
        if (cmd === "lscpu" && args.includes("-J")) return smtLscpuJson;
        return io.run(cmd, args);
      },
      readFile(path: string): string | null {
        if (path === "/proc/cpuinfo") return null;
        return io.readFile(path);
      },
    };
    const profile = detectHostProfile({ io: smtIoNoCpuinfo });
    expect(profile.physicalCores).toBe(4);
    expect(profile.logicalCores).toBe(8);
    expect(profile.smt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveBudget
// ---------------------------------------------------------------------------

describe("deriveBudget", () => {
  const baseProfile: HostProfile = {
    os: "linux",
    distro: null,
    arch: "x64",
    logicalCores: 4,
    physicalCores: 4,
    performanceCores: null,
    smt: false,
    totalMemGiB: 24,
    availableMemGiB: 22,
    swapGiB: 0,
    hasZram: false,
    isCI: false,
    isContainer: false,
    fsType: null,
    pressure: null,
    sessions: 1,
  };

  test("cpu-bound: plenty of memory, single session, 4 physical cores", () => {
    const budget = deriveBudget(baseProfile);
    expect(budget.effectiveCores).toBe(4);
    expect(budget.perSessionCores).toBe(4);
    expect(budget.workers).toBe(4);
    expect(budget.limitedBy).toBe("cpu");
    expect(budget.memoryBoundWorkers).toBeGreaterThan(4);
  });

  test("memory-bound: a measured perWorkerGiB constrains workers below cpu-bound count", () => {
    const profile = { ...baseProfile, availableMemGiB: 6.8 };
    const budget = deriveBudget(profile, { perWorkerGiB: 3.4 });
    expect(budget.memoryBoundWorkers).toBe(2);
    expect(budget.workers).toBe(2);
    expect(budget.limitedBy).toBe("memory");
  });

  test("perSessionCores floors at 1, never 0, even with many sessions", () => {
    const profile = { ...baseProfile, sessions: 4, physicalCores: 4 };
    expect(deriveBudget(profile).perSessionCores).toBe(1);

    const manySessions = { ...baseProfile, sessions: 100, physicalCores: 4 };
    expect(deriveBudget(manySessions).perSessionCores).toBe(1);
  });

  test("performanceCores takes precedence over physicalCores when set", () => {
    const profile = {
      ...baseProfile,
      performanceCores: 8,
      physicalCores: 10,
      logicalCores: 10,
    };
    expect(deriveBudget(profile).effectiveCores).toBe(8);
  });

  test("CI ignores the profile's own session count and budgets for 1", () => {
    const profile = { ...baseProfile, isCI: true, sessions: 5 };
    expect(deriveBudget(profile).sessions).toBe(1);
  });

  test("cpu wins the tie when perSessionCores equals memoryBoundWorkers exactly", () => {
    // 4 physical cores, 1 session -> perSessionCores = 4; availableMemGiB = 4
    // with the default perWorkerGiB of 1 -> memoryBoundWorkers = 4 too. The
    // "cpu" branch must win on equality (perSessionCores <= memoryBoundWorkers).
    const profile = { ...baseProfile, availableMemGiB: 4 };
    const budget = deriveBudget(profile);
    expect(budget.perSessionCores).toBe(4);
    expect(budget.memoryBoundWorkers).toBe(4);
    expect(budget.limitedBy).toBe("cpu");
  });

  test("memoryBoundWorkers floors at 1 even with zero available memory", () => {
    const profile = { ...baseProfile, availableMemGiB: 0 };
    const budget = deriveBudget(profile);
    expect(budget.memoryBoundWorkers).toBe(1);
    expect(budget.workers).toBeGreaterThanOrEqual(1);
  });

  test("concurrentLaneWorkers halves an even workers count outside CI", () => {
    // 8 physical cores, plenty of memory, single session -> workers = 8.
    const profile = { ...baseProfile, physicalCores: 8, logicalCores: 8 };
    const budget = deriveBudget(profile);
    expect(budget.workers).toBe(8);
    expect(budget.concurrentLaneWorkers).toBe(4);
  });

  test("concurrentLaneWorkers floors at 1, never 0, when halving workers=1", () => {
    const profile = {
      ...baseProfile,
      availableMemGiB: 1,
    };
    const budget = deriveBudget(profile, { perWorkerGiB: 2 });
    expect(budget.workers).toBe(1);
    expect(budget.concurrentLaneWorkers).toBe(1);
  });

  test("concurrentLaneWorkers floors an odd workers count outside CI", () => {
    // 5 physical cores, plenty of memory, single session -> workers = 5.
    const profile = { ...baseProfile, physicalCores: 5, logicalCores: 5 };
    const budget = deriveBudget(profile);
    expect(budget.workers).toBe(5);
    expect(budget.concurrentLaneWorkers).toBe(2);
  });

  test("concurrentLaneWorkers equals the full workers value in CI, unhalved", () => {
    // CI budgets for a single session regardless of the profile's own count,
    // and earns the whole machine — no sibling-lane halving either.
    const profile = {
      ...baseProfile,
      isCI: true,
      sessions: 5,
      physicalCores: 8,
      logicalCores: 8,
    };
    const budget = deriveBudget(profile);
    expect(budget.workers).toBe(8);
    expect(budget.concurrentLaneWorkers).toBe(8);
  });
});
