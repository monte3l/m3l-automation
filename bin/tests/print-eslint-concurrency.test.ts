import { describe, expect, test } from "vitest";
import type { HostProfile } from "../lib/host-profile.mjs";
import { deriveBudget } from "../lib/host-profile.mjs";
import { resolveEslintConcurrency } from "../print-eslint-concurrency.mjs";

// print-eslint-concurrency.mjs's effectful top-level work (detectHostProfile,
// process.stdout.write, and process.exit — the last for the unknown-target
// pre-check that fails loudly before the try/catch, distinct from the
// try/catch's own environmental-failure fallback that writes "1" instead of
// exiting) lives inside an
// `if (process.argv[1] === fileURLToPath(import.meta.url))` guard — the
// same pattern as bin/verify-all.mjs and bin/bench-gates.mjs — so importing
// `resolveEslintConcurrency` alone never triggers a live host read or a
// process exit. That entry-point branch is exercised by a live run per
// .claude/rules/harness-artifacts.md, not by this unit suite.

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

describe("resolveEslintConcurrency", () => {
  test("'library' returns deriveBudget(profile, { perWorkerGiB: 3.1 }).workers", () => {
    const expected = deriveBudget(baseProfile, { perWorkerGiB: 3.1 }).workers;
    expect(resolveEslintConcurrency("library", baseProfile)).toBe(expected);
  });

  test("'workspace' returns deriveBudget(profile, { perWorkerGiB: 3.8 }).workers", () => {
    const expected = deriveBudget(baseProfile, { perWorkerGiB: 3.8 }).workers;
    expect(resolveEslintConcurrency("workspace", baseProfile)).toBe(expected);
  });

  test("an unknown target throws an Error naming the bad target and both valid options", () => {
    expect(() =>
      resolveEslintConcurrency(
        "bogus" as unknown as "library" | "workspace",
        baseProfile,
      ),
    ).toThrowError(Error);
    let thrown: unknown;
    try {
      resolveEslintConcurrency(
        "bogus" as unknown as "library" | "workspace",
        baseProfile,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("bogus");
    expect(message).toContain("library");
    expect(message).toContain("workspace");
  });

  test("an empty-string target also throws, naming both valid options", () => {
    let thrown: unknown;
    try {
      resolveEslintConcurrency(
        "" as unknown as "library" | "workspace",
        baseProfile,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("library");
    expect((thrown as Error).message).toContain("workspace");
  });

  // -------------------------------------------------------------------------
  // library (3.1) vs workspace (3.8) are different perWorkerGiB values, and
  // the whole point of the per-target split is that they can steer `workers`
  // to different numbers on the same host. A profile where both targets
  // land on the same `workers` value (e.g. baseProfile above, where cores
  // are the binding constraint for both) can't tell the split apart from a
  // single shared constant — these two profiles put memory in play so the
  // distinct perWorkerGiB values actually move the result.
  // -------------------------------------------------------------------------

  test("a crossover profile: library lands cpu-bound, workspace lands memory-bound, and the two workers values differ", () => {
    // 5 physical cores / 1 session -> perSessionCores = 5.
    // library: floor(15.5 / 3.1) = 5 memoryBoundWorkers -> tie -> "cpu", workers = 5.
    // workspace: floor(15.5 / 3.8) = 4 memoryBoundWorkers -> "memory" binds, workers = 4.
    const profile: HostProfile = {
      ...baseProfile,
      physicalCores: 5,
      logicalCores: 5,
      availableMemGiB: 15.5,
    };

    const libraryBudget = deriveBudget(profile, { perWorkerGiB: 3.1 });
    const workspaceBudget = deriveBudget(profile, { perWorkerGiB: 3.8 });
    expect(libraryBudget.limitedBy).toBe("cpu");
    expect(workspaceBudget.limitedBy).toBe("memory");

    expect(resolveEslintConcurrency("library", profile)).toBe(
      libraryBudget.workers,
    );
    expect(resolveEslintConcurrency("workspace", profile)).toBe(
      workspaceBudget.workers,
    );
    expect(resolveEslintConcurrency("library", profile)).not.toBe(
      resolveEslintConcurrency("workspace", profile),
    );
  });

  test("a memory-constrained profile: both targets are memory-bound, but at different magnitudes", () => {
    // 8 physical cores / 1 session -> perSessionCores = 8, never the binding
    // constraint here.
    // library: floor(15.5 / 3.1) = 5 memoryBoundWorkers -> workers = 5.
    // workspace: floor(15.5 / 3.8) = 4 memoryBoundWorkers -> workers = 4.
    const profile: HostProfile = {
      ...baseProfile,
      physicalCores: 8,
      logicalCores: 8,
      availableMemGiB: 15.5,
    };

    const libraryBudget = deriveBudget(profile, { perWorkerGiB: 3.1 });
    const workspaceBudget = deriveBudget(profile, { perWorkerGiB: 3.8 });
    expect(libraryBudget.limitedBy).toBe("memory");
    expect(workspaceBudget.limitedBy).toBe("memory");

    expect(resolveEslintConcurrency("library", profile)).toBe(
      libraryBudget.workers,
    );
    expect(resolveEslintConcurrency("workspace", profile)).toBe(
      workspaceBudget.workers,
    );
    expect(resolveEslintConcurrency("library", profile)).not.toBe(
      resolveEslintConcurrency("workspace", profile),
    );
  });
});
