import { describe, expect, test } from "vitest";
import {
  VERIFY_STEPS,
  diffVerifySteps,
  parseCiVerifyStepNames,
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
