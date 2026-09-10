import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  VERIFY_STEPS,
  diffVerifySteps,
  findHermeticityViolations,
  groupStepsIntoLanes,
  parseCiJobStepNames,
  parseCiVerifyStepNames,
  parseVerifyNeeds,
} from "../../bin/lib/verify-steps.mjs";

// bin/tests/check-cli-docs.test.ts's pattern for resolving the repo root from
// a test file two directories under it (bin/tests/<file> -> ../../).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

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
// groupStepsIntoLanes
// ---------------------------------------------------------------------------
//
// Each case passes a custom `steps` array (never the real VERIFY_STEPS) so
// the test is self-contained and does not depend on ci.yml's real job
// layout (per .claude/rules/tests.md's synthetic-fixture rule for bin/
// checkers).

describe("groupStepsIntoLanes", () => {
  test("orders a job's lane by ci.yml's own step order, not the input steps array's order", () => {
    const yaml = [
      "jobs:",
      "  gates:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Step A",
      "        run: pnpm a",
      "      - name: Step B",
      "        run: pnpm b",
      "",
    ].join("\n");
    // Deliberately reversed relative to ci.yml's order above.
    const stepB = { ciStepName: "Step B", id: "step-b" };
    const stepA = { ciStepName: "Step A", id: "step-a" };
    const steps = [stepB, stepA];

    const lanes = groupStepsIntoLanes(yaml, steps);

    expect(lanes).toEqual([
      { jobName: "gates", steps: [stepA, stepB], dependsOn: [] },
    ]);
  });

  test("different ci.yml jobs land in different lanes, in ci.yml job declaration order", () => {
    const yaml = [
      "jobs:",
      "  lint:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Lint",
      "        run: pnpm lint",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "",
    ].join("\n");
    const buildStep = { ciStepName: "Build", id: "build" };
    const lintStep = { ciStepName: "Lint", id: "lint" };
    // Input array order is deliberately the reverse of ci.yml job order.
    const steps = [buildStep, lintStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    expect(lanes).toEqual([
      { jobName: "lint", steps: [lintStep], dependsOn: [] },
      { jobName: "build", steps: [buildStep], dependsOn: [] },
    ]);
  });

  test("a step whose ciStepName is not in any ci.yml job becomes a singleton unmatched lane after every job-derived lane", () => {
    const yaml = [
      "jobs:",
      "  lint:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Lint",
      "        run: pnpm lint",
      "",
    ].join("\n");
    const lintStep = { ciStepName: "Lint", id: "lint" };
    const mysteryStep = { ciStepName: "Mystery Step", id: "mystery" };
    const steps = [lintStep, mysteryStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    expect(lanes).toEqual([
      { jobName: "lint", steps: [lintStep], dependsOn: [] },
      { jobName: "unmatched:mystery", steps: [mysteryStep], dependsOn: [] },
    ]);
  });

  test("a ciStepName declared in two different ci.yml jobs is placed only in the FIRST (ci.yml declaration order) job's lane, never both", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Shared Step",
      "        run: pnpm shared",
      "      - name: A Only",
      "        run: pnpm a-only",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Shared Step",
      "        run: pnpm shared",
      "      - name: B Only",
      "        run: pnpm b-only",
      "",
    ].join("\n");
    const sharedStep = { ciStepName: "Shared Step", id: "shared" };
    const aOnlyStep = { ciStepName: "A Only", id: "a-only" };
    const bOnlyStep = { ciStepName: "B Only", id: "b-only" };
    const steps = [sharedStep, aOnlyStep, bOnlyStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    expect(lanes).toEqual([
      { jobName: "a", steps: [sharedStep, aOnlyStep], dependsOn: [] },
      { jobName: "b", steps: [bOnlyStep], dependsOn: [] },
    ]);

    // The shared step must appear in job "a"'s lane, and must NOT appear in
    // job "b"'s lane — the important regression case: the same VERIFY_STEPS
    // entry scheduled into two concurrently-run lanes would run twice.
    const laneA = lanes.find((l) => l.jobName === "a");
    const laneB = lanes.find((l) => l.jobName === "b");
    expect(laneA?.steps).toContain(sharedStep);
    expect(laneB?.steps).not.toContain(sharedStep);

    // sharedStep here has no `cmd` (skip-only shape, like "Cache turbo") —
    // it never actually runs, so losing it creates no dependency for job
    // "b" to wait on. See the dedicated "cmd-less duplicate creates no
    // dependency" test below for the case this distinguishes from.
    expect(laneB?.dependsOn).toEqual([]);

    // No step id appears in more than one lane anywhere in the result, and
    // every matched/unmatched step is accounted for exactly once (no
    // double-count, no silent drop).
    const allIds = lanes.flatMap((lane) => lane.steps.map((s) => s.id));
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.length).toBe(steps.length);
  });

  test("a job with zero matching runnable steps produces no lane entry at all (never a { steps: [] } lane)", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Real Step",
      "        run: pnpm real",
      "  ghost:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@abc123",
      "      - name: Untracked Step",
      "        run: pnpm untracked",
      "",
    ].join("\n");
    const realStep = { ciStepName: "Real Step", id: "real" };
    const steps = [realStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    expect(lanes).toEqual([{ jobName: "a", steps: [realStep], dependsOn: [] }]);
    expect(lanes.some((lane) => lane.steps.length === 0)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // dependsOn: cross-job step ownership creates a scheduling dependency
  // ---------------------------------------------------------------------
  //
  // Real bug this guards: ci.yml's `test` job re-runs "Build" as its own
  // prerequisite (separate CI runner, no shared dist/ with the `build`
  // job). groupStepsIntoLanes places a cross-job-duplicated step's
  // VERIFY_STEPS entry into only the FIRST job's lane (see the dedup test
  // above) — but when that step has a real `cmd`, the LATER job's lane
  // must record a dependency on the winning job, so verify-all.mjs's
  // scheduler holds it back until the winning lane has actually produced
  // whatever the step builds.

  test("a cmd-bearing step declared in two jobs adds the winning job's name to the losing job's dependsOn", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "      - name: Test",
      "        run: pnpm test",
      "",
    ].join("\n");
    const buildStep = {
      ciStepName: "Build",
      id: "build",
      cmd: () => "pnpm build",
    };
    const testStep = { ciStepName: "Test", id: "test", cmd: () => "pnpm test" };
    const steps = [buildStep, testStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    const laneA = lanes.find((l) => l.jobName === "a");
    const laneB = lanes.find((l) => l.jobName === "b");

    expect(laneA?.steps).toEqual([buildStep]);
    expect(laneA?.dependsOn).toEqual([]);

    expect(laneB?.steps).toEqual([testStep]);
    expect(laneB?.steps).not.toContain(buildStep);
    expect(laneB?.dependsOn).toEqual(["a"]);
  });

  test("a cmd-less duplicate (skip-only step, e.g. 'Cache turbo') never creates a dependency", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Cache turbo",
      "        uses: actions/cache@abc123",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Cache turbo",
      "        uses: actions/cache@abc123",
      "      - name: Lint",
      "        run: pnpm lint",
      "",
    ].join("\n");
    const cacheStep = { ciStepName: "Cache turbo", id: "cache-turbo" };
    const lintStep = { ciStepName: "Lint", id: "lint", cmd: () => "pnpm lint" };
    const steps = [cacheStep, lintStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    const laneB = lanes.find((l) => l.jobName === "b");
    // Losing job "b" never gets a dependency on "a" for the cache step —
    // it has no cmd, so it never actually runs and nothing needs to wait
    // on it.
    expect(laneB?.dependsOn).toEqual([]);
  });

  test("a cmd-bearing step claimed by the first of THREE jobs adds the winner to both other jobs' dependsOn", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "      - name: B Step",
      "        run: pnpm b",
      "  c:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "      - name: C Step",
      "        run: pnpm c",
      "",
    ].join("\n");
    const buildStep = {
      ciStepName: "Build",
      id: "build",
      cmd: () => "pnpm build",
    };
    const bStep = { ciStepName: "B Step", id: "b-step", cmd: () => "pnpm b" };
    const cStep = { ciStepName: "C Step", id: "c-step", cmd: () => "pnpm c" };
    const steps = [buildStep, bStep, cStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    const laneA = lanes.find((l) => l.jobName === "a");
    const laneB = lanes.find((l) => l.jobName === "b");
    const laneC = lanes.find((l) => l.jobName === "c");

    expect(laneA?.dependsOn).toEqual([]);
    expect(laneB?.dependsOn).toEqual(["a"]);
    expect(laneC?.dependsOn).toEqual(["a"]);
  });

  test("a lane can accumulate more than one dependency, one per distinct earlier job it loses a cmd-bearing step to", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Deploy",
      "        run: pnpm deploy",
      "  c:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        run: pnpm build",
      "      - name: Deploy",
      "        run: pnpm deploy",
      "      - name: C Step",
      "        run: pnpm c",
      "",
    ].join("\n");
    const buildStep = {
      ciStepName: "Build",
      id: "build",
      cmd: () => "pnpm build",
    };
    const deployStep = {
      ciStepName: "Deploy",
      id: "deploy",
      cmd: () => "pnpm deploy",
    };
    const cStep = { ciStepName: "C Step", id: "c-step", cmd: () => "pnpm c" };
    const steps = [buildStep, deployStep, cStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    const laneC = lanes.find((l) => l.jobName === "c");
    expect(laneC?.steps).toEqual([cStep]);
    expect(new Set(laneC?.dependsOn)).toEqual(new Set(["a", "b"]));
    expect(laneC?.dependsOn).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // dependsOnStepIds: cross-job dependency invisible to the ciStepName-
  // collision mechanism above
  // ---------------------------------------------------------------------
  //
  // Real bug this guards (found by claude-pr-review on PR #1167):
  // `build-cli-for-gates`'s scoped `turbo run build --filter=@m3l-automation/
  // m3l-cli` and `build`'s workspace-wide `pnpm build` (which also builds
  // that package) race against the same local `packages/m3l-cli/dist`, but
  // their ci.yml step NAMES genuinely differ ("Build CLI (scaffold checkers
  // read packages/m3l-cli/dist)" vs "Build"), so pass 1's ciStepName-keyed
  // dedup can never see the collision. `dependsOnStepIds` is the
  // hand-authored escape hatch, resolved in pass 2 once every step's owning
  // lane is known.

  test("a dependsOnStepIds entry pointing at a step claimed by a DIFFERENT job adds that job's name to dependsOn, even with no ciStepName collision", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: A Step",
      "        run: pnpm a",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: B Step",
      "        run: pnpm b",
      "",
    ].join("\n");
    const aStep = { ciStepName: "A Step", id: "a-step", cmd: () => "pnpm a" };
    const bStep = {
      ciStepName: "B Step",
      id: "b-step",
      cmd: () => "pnpm b",
      dependsOnStepIds: ["a-step"],
    };
    const steps = [aStep, bStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    const laneA = lanes.find((l) => l.jobName === "a");
    const laneB = lanes.find((l) => l.jobName === "b");
    // The ciStepName-collision path never fires here (the two step names are
    // genuinely different) — dependsOn only comes from dependsOnStepIds.
    expect(laneA?.dependsOn).toEqual([]);
    expect(laneB?.dependsOn).toEqual(["a"]);
  });

  test("a dependsOnStepIds entry pointing at a step claimed by the SAME lane is a no-op (no self-dependency)", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: First Step",
      "        run: pnpm first",
      "      - name: Second Step",
      "        run: pnpm second",
      "",
    ].join("\n");
    const firstStep = {
      ciStepName: "First Step",
      id: "first-step",
      cmd: () => "pnpm first",
    };
    const secondStep = {
      ciStepName: "Second Step",
      id: "second-step",
      cmd: () => "pnpm second",
      dependsOnStepIds: ["first-step"],
    };
    const steps = [firstStep, secondStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    expect(lanes).toHaveLength(1);
    const laneA = lanes.find((l) => l.jobName === "a");
    expect(laneA?.steps).toEqual([firstStep, secondStep]);
    // Both steps are claimed by job "a" itself — a's own name must never
    // appear in its own dependsOn.
    expect(laneA?.dependsOn).toEqual([]);
  });

  test("a dependsOnStepIds entry naming an id that matches no step at all is silently ignored, not thrown", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Lonely Step",
      "        run: pnpm lonely",
      "",
    ].join("\n");
    const lonelyStep = {
      ciStepName: "Lonely Step",
      id: "lonely-step",
      cmd: () => "pnpm lonely",
      dependsOnStepIds: ["nonexistent-id"],
    };
    const steps = [lonelyStep];

    expect(() => groupStepsIntoLanes(yaml, steps)).not.toThrow();
    const lanes = groupStepsIntoLanes(yaml, steps);
    const laneA = lanes.find((l) => l.jobName === "a");
    expect(laneA?.dependsOn).toEqual([]);
  });

  test("a lane's dependsOn combines a ciStepName-dedup dependency AND a dependsOnStepIds dependency, deduped, from both sources", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Shared Step",
      "        run: pnpm shared",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: B Step",
      "        run: pnpm b",
      "  target:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Shared Step",
      "        run: pnpm shared",
      "      - name: Target Own Step",
      "        run: pnpm target",
      "",
    ].join("\n");
    const sharedStep = {
      ciStepName: "Shared Step",
      id: "shared",
      cmd: () => "pnpm shared",
    };
    const bStep = { ciStepName: "B Step", id: "b-step", cmd: () => "pnpm b" };
    const targetStep = {
      ciStepName: "Target Own Step",
      id: "target-step",
      cmd: () => "pnpm target",
      dependsOnStepIds: ["b-step"],
    };
    const steps = [sharedStep, bStep, targetStep];

    const lanes = groupStepsIntoLanes(yaml, steps);

    const laneTarget = lanes.find((l) => l.jobName === "target");
    // "a" comes from the lost ciStepName-collision on "Shared Step"; "b"
    // comes from targetStep's own dependsOnStepIds. Both must be present,
    // deduped, with nothing missing.
    expect(new Set(laneTarget?.dependsOn)).toEqual(new Set(["a", "b"]));
    expect(laneTarget?.dependsOn).toHaveLength(2);
  });

  test("against the LIVE ci.yml and VERIFY_STEPS: the gates lane and the e2e lane both depend on the build lane via dependsOnStepIds", () => {
    // This is the actual regression the bot found on PR #1167, confirmed
    // against the real file rather than only a synthetic fixture:
    // build-cli-for-gates (gates lane) and build-m3l-common-for-e2e (e2e
    // lane) both declare dependsOnStepIds: ["build"] in VERIFY_STEPS.
    const ciYamlText = readFileSync(
      join(repoRoot, ".github/workflows/ci.yml"),
      "utf8",
    );

    const lanes = groupStepsIntoLanes(ciYamlText, VERIFY_STEPS);

    const gatesLane = lanes.find((l) => l.jobName === "gates");
    const e2eLane = lanes.find((l) => l.jobName === "e2e");
    expect(gatesLane).toBeDefined();
    expect(e2eLane).toBeDefined();
    expect(gatesLane?.dependsOn).toContain("build");
    expect(e2eLane?.dependsOn).toContain("build");
  });

  // ---------------------------------------------------------------------
  // Cycle detection (assertLaneGraphAcyclic, exercised only through
  // groupStepsIntoLanes since it is not itself exported)
  // ---------------------------------------------------------------------

  test("throws a clear cyclic-lane-dependency error when dependsOnStepIds creates a direct 2-node cycle", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: A Step",
      "        run: pnpm a",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: B Step",
      "        run: pnpm b",
      "",
    ].join("\n");
    const aStep = {
      ciStepName: "A Step",
      id: "a-step",
      cmd: () => "pnpm a",
      // a's lane depends on whichever job owns "b-step" (job "b")...
      dependsOnStepIds: ["b-step"],
    };
    const bStep = {
      ciStepName: "B Step",
      id: "b-step",
      cmd: () => "pnpm b",
      // ...and b's lane depends on whichever job owns "a-step" (job "a") —
      // a direct 2-node cycle.
      dependsOnStepIds: ["a-step"],
    };
    const steps = [aStep, bStep];

    expect(() => groupStepsIntoLanes(yaml, steps)).toThrow(
      /groupStepsIntoLanes: cyclic lane dependency:/i,
    );
  });

  test("a normal acyclic dependsOnStepIds graph does not throw", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: A Step",
      "        run: pnpm a",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: B Step",
      "        run: pnpm b",
      "",
    ].join("\n");
    const aStep = { ciStepName: "A Step", id: "a-step", cmd: () => "pnpm a" };
    const bStep = {
      ciStepName: "B Step",
      id: "b-step",
      cmd: () => "pnpm b",
      dependsOnStepIds: ["a-step"],
    };
    const steps = [aStep, bStep];

    expect(() => groupStepsIntoLanes(yaml, steps)).not.toThrow();
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
