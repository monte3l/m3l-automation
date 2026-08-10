import { describe, expect, test } from "vitest";
import {
  VERIFY_STEPS,
  diffVerifySteps,
  parseCiVerifyStepNames,
} from "../../bin/lib/verify-steps.mjs";

describe("parseCiVerifyStepNames", () => {
  const yaml = [
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@abc123",
    "      - name: Secret scan (gitleaks)",
    "        uses: gitleaks/gitleaks-action@abc123",
    "      - name: Lint",
    "        run: pnpm lint",
    "      - name: Build",
    "        run: pnpm build",
    "  other-job:",
    "    steps:",
    "      - name: Unrelated",
    "        run: pnpm nope",
    "",
  ].join("\n");

  test("extracts every named step from the verify job, in order", () => {
    expect(parseCiVerifyStepNames(yaml)).toEqual([
      "Secret scan (gitleaks)",
      "Lint",
      "Build",
    ]);
  });

  test("ignores steps from other jobs", () => {
    expect(parseCiVerifyStepNames(yaml)).not.toContain("Unrelated");
  });

  test("throws when there is no verify job", () => {
    expect(() =>
      parseCiVerifyStepNames("jobs:\n  build:\n    steps: []\n"),
    ).toThrow(/verify.*job/);
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
});
