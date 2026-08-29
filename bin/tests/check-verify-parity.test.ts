import { describe, expect, test } from "vitest";
import {
  VERIFY_STEPS,
  diffVerifySteps,
  findHermeticityViolations,
  parseCiJobStepNames,
  parseCiVerifyStepNames,
  parseVerifyNeeds,
} from "../../bin/lib/verify-steps.mjs";

describe("parseCiVerifyStepNames", () => {
  const yaml = [
    "jobs:",
    "  secrets:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@abc123",
    "      - name: Secret scan (gitleaks)",
    "        uses: gitleaks/gitleaks-action@abc123",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: ./.github/actions/setup",
    "      - name: Lint",
    "        run: pnpm lint",
    "  verify:",
    "    needs: [secrets, lint]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Check lane results",
    "        run: echo ok",
    "",
  ].join("\n");

  test("unions named steps across every non-verify job", () => {
    expect(parseCiVerifyStepNames(yaml)).toEqual(
      expect.arrayContaining(["Secret scan (gitleaks)", "Lint"]),
    );
    expect(parseCiVerifyStepNames(yaml)).toHaveLength(2);
  });

  test("excludes steps from the verify aggregator job", () => {
    expect(parseCiVerifyStepNames(yaml)).not.toContain("Check lane results");
  });

  test("collects named steps from a single non-verify job, in order", () => {
    const singleJobYaml = [
      "jobs:",
      "  lint:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ./.github/actions/setup",
      "      - name: Lint",
      "        run: pnpm lint",
      "      - name: Format check",
      "        run: pnpm format:check",
      "",
    ].join("\n");

    expect(parseCiVerifyStepNames(singleJobYaml)).toEqual([
      "Lint",
      "Format check",
    ]);
  });

  test("dedups an identical step name declared in two different jobs", () => {
    const dupYaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Shared step",
      "        run: pnpm shared",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Shared step",
      "        run: pnpm shared",
      "",
    ].join("\n");

    expect(parseCiVerifyStepNames(dupYaml)).toEqual(["Shared step"]);
  });

  test("does not require a verify job to exist", () => {
    expect(parseCiVerifyStepNames("jobs:\n  build:\n    steps: []\n")).toEqual(
      [],
    );

    const withSteps = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "",
    ].join("\n");
    expect(parseCiVerifyStepNames(withSteps)).toEqual(["Build"]);
  });

  test("throws when there is no jobs section at all", () => {
    expect(() => parseCiVerifyStepNames("")).toThrow(/jobs.*section/i);
    expect(() => parseCiVerifyStepNames("name: CI\non: push\n")).toThrow(
      /jobs.*section/i,
    );
  });

  test("throws when jobs exists but has no job definitions under it", () => {
    expect(() => parseCiVerifyStepNames("jobs:\n")).toThrow(/job definitions/i);
  });
});

describe("diffVerifySteps", () => {
  const steps = [
    { ciStepName: "Lint", id: "lint", cmd: () => "pnpm lint" },
    { ciStepName: "Build", id: "build", cmd: () => "pnpm build" },
  ];

  test("no drift when ci.yml and the list agree", () => {
    expect(diffVerifySteps(["Lint", "Build"], steps)).toEqual({
      missingFromList: [],
      staleInList: [],
    });
  });

  test("flags a step ci.yml added that the list doesn't track yet", () => {
    const { missingFromList, staleInList } = diffVerifySteps(
      ["Lint", "Build", "Check dup"],
      steps,
    );
    expect(missingFromList).toEqual(["Check dup"]);
    expect(staleInList).toEqual([]);
  });

  test("flags a step the list still tracks after ci.yml dropped it", () => {
    const { missingFromList, staleInList } = diffVerifySteps(["Lint"], steps);
    expect(missingFromList).toEqual([]);
    expect(staleInList).toEqual(["Build"]);
  });

  test("VERIFY_STEPS entries all have a cmd() or a skipReason", () => {
    for (const step of VERIFY_STEPS) {
      expect(step.cmd !== undefined || step.skipReason !== undefined).toBe(
        true,
      );
    }
  });

  test("every VERIFY_STEPS id is unique", () => {
    const ids = VERIFY_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a conditional entry participates in the diff the same as any other", () => {
    const conditionalSteps = [
      {
        ciStepName: "Lint",
        id: "lint",
        cmd: () => "pnpm lint",
        conditional: true,
      },
      { ciStepName: "Build", id: "build", cmd: () => "pnpm build" },
    ];

    expect(diffVerifySteps(["Lint", "Build"], conditionalSteps)).toEqual({
      missingFromList: [],
      staleInList: [],
    });
    expect(diffVerifySteps(["Build"], conditionalSteps)).toEqual({
      missingFromList: [],
      staleInList: ["Lint"],
    });
  });
});

// ---------------------------------------------------------------------------
// parseCiJobStepNames
// ---------------------------------------------------------------------------
//
// bin/check-verify-parity.mjs itself is NOT imported in this file: it runs
// its full CLI body unconditionally at module load (no
// `process.argv[1] === fileURLToPath(...)` main guard, no separately exported
// functions — the same shape documented in vitest.bin.config.ts's coverage
// comment). This file already followed that convention for
// parseCiVerifyStepNames/diffVerifySteps above; the three new exports below
// (added for the ADR-0079 hermeticity gate) are tested the same way, against
// synthetic ci.yml-shaped text, never the live .github/workflows/ci.yml.

describe("parseCiJobStepNames", () => {
  const yaml = [
    "jobs:",
    "  gates:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@abc123",
    "      - name: Check hub drift (push-only)",
    "        run: pnpm check:hub-drift",
    "      - name: Check dup",
    "        run: pnpm check:dup",
    "  hub-alarm:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Alarm on hub failure",
    "        run: echo alarm",
    "  verify:",
    "    needs: [gates, hub-alarm]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Check lane results",
    "        run: echo ok",
    "",
  ].join("\n");

  test("returns each non-verify job's own ordered step names", () => {
    const jobSteps = parseCiJobStepNames(yaml);
    expect(jobSteps.get("gates")).toEqual([
      "Check hub drift (push-only)",
      "Check dup",
    ]);
    expect(jobSteps.get("hub-alarm")).toEqual(["Alarm on hub failure"]);
  });

  test("excludes the verify aggregator job", () => {
    const jobSteps = parseCiJobStepNames(yaml);
    expect(jobSteps.has("verify")).toBe(false);
  });

  test("throws when there is no jobs section at all", () => {
    expect(() => parseCiJobStepNames("")).toThrow(/jobs.*section/i);
  });

  test("throws when jobs exists but has no job definitions under it", () => {
    expect(() => parseCiJobStepNames("jobs:\n")).toThrow(/job definitions/i);
  });
});

// ---------------------------------------------------------------------------
// parseVerifyNeeds
// ---------------------------------------------------------------------------

describe("parseVerifyNeeds", () => {
  test("parses the verify job's needs: array", () => {
    const yaml = [
      "jobs:",
      "  changes:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "  secrets:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "  verify:",
      "    needs: [changes, secrets, gates]",
      "    if: always()",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "",
    ].join("\n");

    expect(parseVerifyNeeds(yaml)).toEqual(["changes", "secrets", "gates"]);
  });

  test("throws when there is no verify job in ci.yml", () => {
    const yaml = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "",
    ].join("\n");

    expect(() => parseVerifyNeeds(yaml)).toThrow(/verify.*job/i);
  });

  test("throws when there is no jobs section at all", () => {
    expect(() => parseVerifyNeeds("")).toThrow(/jobs.*section/i);
  });
});

// ---------------------------------------------------------------------------
// findHermeticityViolations
// ---------------------------------------------------------------------------
//
// Each case passes a custom `steps` array rather than the real VERIFY_STEPS,
// so the test is self-contained and does not depend on ci.yml's real job
// layout (per .claude/rules/tests.md's synthetic-fixture rule for bin/
// checkers).

describe("findHermeticityViolations", () => {
  test("flags a needsLiveState step whose job feeds the required verify aggregate", () => {
    const steps = [
      {
        ciStepName: "Fake live check",
        id: "fake-live-check",
        needsLiveState: true,
      },
    ];
    const yaml = [
      "jobs:",
      "  changes:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Fake live check",
      "        run: pnpm check:fake-live",
      "  verify:",
      "    needs: [changes, gates]",
      "    if: always()",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "",
    ].join("\n");

    expect(findHermeticityViolations(yaml, steps)).toEqual([
      { ciStepName: "Fake live check", job: "gates" },
    ]);
  });

  test("does not flag a needsLiveState step whose job is NOT in verify's needs:", () => {
    const steps = [
      {
        ciStepName: "Fake live check",
        id: "fake-live-check",
        needsLiveState: true,
      },
    ];
    const yaml = [
      "jobs:",
      "  changes:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "  hub-alarm:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Fake live check",
      "        run: pnpm check:fake-live",
      "  verify:",
      "    needs: [changes]",
      "    if: always()",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "",
    ].join("\n");

    expect(findHermeticityViolations(yaml, steps)).toEqual([]);
  });

  test("never flags a step with no needsLiveState field, even living in a job feeding verify's needs:", () => {
    const steps = [{ ciStepName: "Ordinary check", id: "ordinary-check" }];
    const yaml = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Ordinary check",
      "        run: pnpm check:ordinary",
      "  verify:",
      "    needs: [gates]",
      "    if: always()",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "",
    ].join("\n");

    expect(findHermeticityViolations(yaml, steps)).toEqual([]);
  });

  test("never flags a step with needsLiveState: false, even living in a job feeding verify's needs:", () => {
    const steps = [
      {
        ciStepName: "Ordinary check",
        id: "ordinary-check",
        needsLiveState: false,
      },
    ];
    const yaml = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Ordinary check",
      "        run: pnpm check:ordinary",
      "  verify:",
      "    needs: [gates]",
      "    if: always()",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "",
    ].join("\n");

    expect(findHermeticityViolations(yaml, steps)).toEqual([]);
  });

  test("defaults to the real VERIFY_STEPS list when no steps argument is passed", () => {
    // Sanity check that the default parameter wiring works; the real
    // VERIFY_STEPS entries' job placement is exercised by check-verify-parity
    // against the live ci.yml (an integration concern), not asserted here.
    const yaml = ["jobs:", "  verify:", "    needs: []", "", ""].join("\n");
    expect(() => findHermeticityViolations(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VERIFY_STEPS — needsLiveState regression lock (ADR-0079)
// ---------------------------------------------------------------------------

describe("VERIFY_STEPS needsLiveState flags", () => {
  test("the four push-only live-state checks genuinely carry needsLiveState: true", () => {
    const liveStateNames = [
      "Check hub drift (push-only)",
      "Check GitHub platform-feature stance (push-only)",
      "Check label drift (push-only)",
      "Check hub board views (push-only)",
    ];
    for (const name of liveStateNames) {
      const step = VERIFY_STEPS.find((s) => s.ciStepName === name);
      expect(step).toBeDefined();
      expect(step?.needsLiveState).toBe(true);
    }
  });

  test("a step not named as a push-only live-state check does not carry needsLiveState: true", () => {
    const step = VERIFY_STEPS.find((s) => s.ciStepName === "Lint (library)");
    expect(step).toBeDefined();
    expect(step?.needsLiveState).toBeFalsy();
  });
});
