import { afterEach, describe, expect, test, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

/**
 * Contract: spec-conformance-reviewer's `scripts/eventbridge-schedules`
 * contract §5. Thin dispatcher — reads `operation` (already oneOf-validated
 * by the declared schema) and dynamic-imports the matching step, forwarding
 * the deps object unchanged. For the 5 mutating operations
 * (create/update/delete/enable/disable) the dispatcher runs `Core.confirmDestructive`
 * BEFORE the dynamic import, with description
 * `${operation} rule '${ruleNameForDisplay}'`; `list`/`describe` skip the
 * gate entirely. `Core.confirmDestructive` is a stable library function, not
 * a locally dynamic-imported step, so it is intercepted via a package-level
 * `vi.mock("@m3l-automation/m3l-common", ...)` factory that spreads the real
 * module and overrides only `Core.confirmDestructive`, rather than a
 * `vi.mock` of a local module path.
 * `api-gateway-client/tests/run-api-gateway-client.test.ts`
 * is the direct model: dynamic import (not a top-level static import) so
 * this file can `vi.mock` each step before dispatch resolves it. This file
 * asserts ONLY the dispatch + gate wiring — never a step's internal logic
 * (that is each step's own test file's job).
 *
 * ADR-0048 (Issue #483, A2b) target-graded destructive-confirmation gate:
 * `RunEventbridgeSchedulesDeps` gains a hard-guarded `awsTarget:
 * Core.M3LDestructiveTarget`, and the dispatcher's `Core.confirmDestructive`
 * call gains `target`/`isSensitiveTarget`/`yesSensitive`, wired via a
 * per-script inline predicate `(target) => target.profile.toLowerCase()
 * .includes("prod")`. Because `destructiveGateMock` fully replaces
 * `Core.confirmDestructive` for the rest of this file's wiring-only
 * assertions, the target-graded escalation tests below cannot observe real
 * gate behavior (typed-echo prompt, state-3 bypass warning wording) through
 * that stub — they instead delegate `destructiveGateMock`'s implementation,
 * for exactly one call via `mockImplementationOnce`, to the REAL
 * `Core.confirmDestructive` captured off `importOriginal()` inside the mock
 * factory (`gateHolder.real`), then observe the outcome at the same
 * `prompt.confirm`/`prompt.text` boundary the sibling scripts
 * (`ecs-ops`/`eks-ops`/`s3-objects`) use directly. `mockImplementationOnce`
 * self-consumes after the dispatcher's single `confirmDestructive` call, so
 * no extra teardown is needed to keep this from leaking into later tests.
 */

const listRulesMock = vi.fn();
const describeRuleMock = vi.fn();
const createRuleMock = vi.fn();
const updateRuleMock = vi.fn();
const deleteRuleMock = vi.fn();
const enableRuleMock = vi.fn();
const disableRuleMock = vi.fn();
// vi.hoisted() is required here (unlike the plain vi.fn() step mocks below):
// @m3l-automation/m3l-common is imported statically below, so its vi.mock
// factory runs eagerly at module-eval time when that import is resolved —
// before a plain top-level `const` would have initialized. The relative-path
// step mocks are only resolved lazily via the dispatcher's dynamic import()
// inside a test body, by which point a plain const has long since run.
const destructiveGateMock = vi.hoisted(() => vi.fn());
// Holds the REAL (un-mocked) Core.confirmDestructive, captured inside the
// vi.mock factory below via importOriginal() — same hoisting requirement as
// destructiveGateMock above, since the factory assigns into it eagerly at
// static-import time.
const gateHolder = vi.hoisted<{ real: unknown }>(() => ({ real: undefined }));

vi.mock("../src/steps/list-rules.js", () => ({ listRules: listRulesMock }));
vi.mock("../src/steps/describe-rule.js", () => ({
  describeRule: describeRuleMock,
}));
vi.mock("../src/steps/create-rule.js", () => ({
  createRule: createRuleMock,
}));
vi.mock("../src/steps/update-rule.js", () => ({
  updateRule: updateRuleMock,
}));
vi.mock("../src/steps/delete-rule.js", () => ({
  deleteRule: deleteRuleMock,
}));
vi.mock("../src/steps/enable-rule.js", () => ({
  enableRule: enableRuleMock,
}));
vi.mock("../src/steps/disable-rule.js", () => ({
  disableRule: disableRuleMock,
}));
vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  gateHolder.real = actual.Core.confirmDestructive;
  return {
    ...actual,
    Core: { ...actual.Core, confirmDestructive: destructiveGateMock },
  };
});

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { runEventbridgeSchedules } from "../src/steps/run-eventbridge-schedules.js";

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

/**
 * Structural fake of `AWS.M3LEventBridgeOperations` — the dispatcher never
 * calls any of its methods itself, only forwards it unchanged to whichever
 * step it dispatches to, so an empty object cast through `unknown` is
 * sufficient (same pattern as `api-gateway-client`'s `support/httpFakes.ts`).
 */
function createFakeEventBridgeOperations(): AWS.M3LEventBridgeOperations {
  return {} as unknown as AWS.M3LEventBridgeOperations;
}

/**
 * The default `awsTarget` fixture for every test that doesn't care about
 * target-graded escalation: a profile whose lowercased form does not contain
 * "prod", so it is never classified sensitive by the per-script inline
 * `(target) => target.profile.toLowerCase().includes("prod")` predicate
 * `run-eventbridge-schedules.ts` wires into `Core.confirmDestructive`'s
 * `isSensitiveTarget`.
 */
const NON_SENSITIVE_TARGET: Core.M3LDestructiveTarget = {
  profile: "dev-sandbox",
};

/** Builds the full deps object `runEventbridgeSchedules` expects, defaulting every collaborator except the config values under test. */
function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: {
    readonly eventBridgeOperations?: AWS.M3LEventBridgeOperations;
    readonly prompt?: Core.M3LPrompt;
    readonly awsTarget?: Core.M3LDestructiveTarget;
    readonly correlationId?: string;
  },
): Parameters<typeof runEventbridgeSchedules>[0] {
  return {
    config: buildConfig(configValues),
    paths: new Core.M3LPaths(),
    logger: new Core.M3LLogger([]),
    correlationId: overrides?.correlationId ?? "run-1",
    eventBridgeOperations:
      overrides?.eventBridgeOperations ?? createFakeEventBridgeOperations(),
    prompt: overrides?.prompt ?? new Core.M3LPrompt(),
    awsTarget: overrides?.awsTarget ?? NON_SENSITIVE_TARGET,
  };
}

/**
 * Delegates to the REAL `Core.confirmDestructive` captured off
 * `importOriginal()` inside the barrel mock factory above. Installed via
 * `destructiveGateMock.mockImplementationOnce(...)` in the target-graded
 * escalation tests below, which need the actual gate state machine (not the
 * plain stub the rest of this file relies on) to run.
 */
function callRealConfirmDestructive(
  options: Core.M3LConfirmDestructiveOptions,
): Promise<void> {
  return (gateHolder.real as typeof Core.confirmDestructive)(options);
}

/**
 * Builds a `Core.M3LPrompt` with both `confirm` and `text` spied — the two
 * seams `Core.confirmDestructive` calls through for the ungraded and the
 * escalated typed-echo paths respectively.
 */
function targetGatePrompt(overrides?: {
  readonly confirmed?: boolean;
  readonly textResponse?: string;
}) {
  const prompt = new Core.M3LPrompt();
  const confirm = vi
    .spyOn(prompt, "confirm")
    .mockResolvedValue(overrides?.confirmed ?? true);
  const text = vi
    .spyOn(prompt, "text")
    .mockResolvedValue(overrides?.textResponse ?? "");
  return { prompt, confirm, text };
}

const MUTATING_STEP_MOCKS = [
  ["create", createRuleMock, "create"],
  ["update", updateRuleMock, "update"],
  ["delete", deleteRuleMock, "delete"],
  ["enable", enableRuleMock, "enable"],
  ["disable", disableRuleMock, "disable"],
] as const;

const ALL_STEP_MOCKS = [
  listRulesMock,
  describeRuleMock,
  createRuleMock,
  updateRuleMock,
  deleteRuleMock,
  enableRuleMock,
  disableRuleMock,
];

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (M3LPrompt#confirm/#text in
  // targetGatePrompt below); it does not clear the plain vi.fn() mocks
  // created inside the top-level vi.mock() factories above, so their call
  // history would otherwise leak into the next test.
  vi.restoreAllMocks();
  destructiveGateMock.mockReset();
  for (const mock of ALL_STEP_MOCKS) mock.mockReset();
});

describe("runEventbridgeSchedules dispatch", () => {
  test.each([
    ["list", listRulesMock],
    ["describe", describeRuleMock],
    ["create", createRuleMock],
    ["update", updateRuleMock],
    ["delete", deleteRuleMock],
    ["enable", enableRuleMock],
    ["disable", disableRuleMock],
  ] as const)(
    "dispatches operation '%s' to its matching step, passing deps through unchanged",
    async (operation, mock) => {
      const deps = buildDeps({ operation, ruleName: "nightly-cleanup" });

      await runEventbridgeSchedules(deps);

      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(expect.objectContaining(deps));

      for (const other of ALL_STEP_MOCKS) {
        if (other !== mock) expect(other).not.toHaveBeenCalled();
      }
    },
  );

  test.each(MUTATING_STEP_MOCKS)(
    "runs destructiveGate before dispatching mutating operation '%s', with the rule description and target wiring",
    async (operation, mock) => {
      const deps = buildDeps({
        operation,
        ruleName: "nightly-cleanup",
        yes: false,
      });

      await runEventbridgeSchedules(deps);

      expect(destructiveGateMock).toHaveBeenCalledTimes(1);
      expect(destructiveGateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: deps.prompt,
          logger: deps.logger,
          description: `${operation} rule 'nightly-cleanup'`,
          yes: false,
          target: deps.awsTarget,
          isSensitiveTarget: expect.any(Function) as unknown as (
            target: Core.M3LDestructiveTarget,
          ) => boolean,
          yesSensitive: false,
        }),
      );
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );

  test.each(MUTATING_STEP_MOCKS)(
    "falls back to '(unspecified)' in the gate description for '%s' when ruleName is unset",
    async (operation) => {
      const deps = buildDeps({ operation });

      await runEventbridgeSchedules(deps);

      expect(destructiveGateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: `${operation} rule '(unspecified)'`,
        }),
      );
    },
  );

  test.each(MUTATING_STEP_MOCKS)(
    "forwards yes=true to the gate for '%s'",
    async (operation) => {
      const deps = buildDeps({
        operation,
        ruleName: "nightly-cleanup",
        yes: true,
      });

      await runEventbridgeSchedules(deps);

      expect(destructiveGateMock).toHaveBeenCalledWith(
        expect.objectContaining({ yes: true }),
      );
    },
  );

  test("throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG when 'yes' is stored as a non-boolean (silent-default-to-false regression)", async () => {
    const deps = buildDeps({
      operation: "delete",
      ruleName: "nightly-cleanup",
      yes: "yep",
    });

    await expect(runEventbridgeSchedules(deps)).rejects.toMatchObject({
      code: "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    });
    expect(destructiveGateMock).not.toHaveBeenCalled();
    expect(deleteRuleMock).not.toHaveBeenCalled();
  });

  test.each([
    ["list", listRulesMock],
    ["describe", describeRuleMock],
  ] as const)(
    "does NOT run destructiveGate for the non-mutating operation '%s'",
    async (operation, mock) => {
      const deps = buildDeps({ operation, ruleName: "nightly-cleanup" });

      await runEventbridgeSchedules(deps);

      expect(destructiveGateMock).not.toHaveBeenCalled();
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );

  test("aborts dispatch when destructiveGate rejects (user declined)", async () => {
    destructiveGateMock.mockRejectedValueOnce(
      new Core.M3LError("aborted: delete rule 'nightly-cleanup'", {
        code: "ERR_EVENTBRIDGE_SCHEDULES_ABORTED",
      }),
    );

    const deps = buildDeps({
      operation: "delete",
      ruleName: "nightly-cleanup",
      yes: false,
    });

    await expect(runEventbridgeSchedules(deps)).rejects.toBeInstanceOf(
      Core.M3LError,
    );

    expect(deleteRuleMock).not.toHaveBeenCalled();
  });

  test("defensively rejects an unrecognized 'operation' value with a typed M3LError", async () => {
    const deps = buildDeps({ operation: "purge" });

    let thrown: unknown;
    try {
      await runEventbridgeSchedules(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    for (const mock of ALL_STEP_MOCKS) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});

/**
 * Contract: ADR-0048's target-graded destructive-confirmation gate (Issue
 * #483, A2b), wired into `eventbridge-schedules`'s existing `delete` gate via
 * a hard-guarded `awsTarget: Core.M3LDestructiveTarget` dep and an inline
 * `isSensitiveTarget` predicate,
 * `(target) => target.profile.toLowerCase().includes("prod")`. Only
 * `delete` is exercised here — `create`/`update`/`enable`/`disable` share the
 * same `Core.confirmDestructive` call site and are not re-tested per state
 * (mirrors `ecs-ops`'s equivalent describe block, which exercises only
 * `delete-service`).
 *
 * Every test in this describe installs `destructiveGateMock
 * .mockImplementationOnce(callRealConfirmDestructive)` so the actual gate
 * logic runs for that one call, observed at the `prompt.confirm`/
 * `prompt.text` boundary via `targetGatePrompt`.
 */
describe("runEventbridgeSchedules — destructive-gate target-graded escalation (delete)", () => {
  test("escalates to the typed-echo prompt when the target's profile contains 'prod'", async () => {
    destructiveGateMock.mockImplementationOnce(callRealConfirmDestructive);
    const { prompt, confirm, text } = targetGatePrompt({
      textResponse: "prod",
    });
    const deps = buildDeps(
      { operation: "delete", ruleName: "nightly-cleanup" },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await runEventbridgeSchedules(deps);

    expect(text).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteRuleMock).toHaveBeenCalledTimes(1);
  });

  test("throws ERR_EVENTBRIDGE_SCHEDULES_ABORTED when the typed-echo input doesn't match the profile", async () => {
    destructiveGateMock.mockImplementationOnce(callRealConfirmDestructive);
    const { prompt } = targetGatePrompt({ textResponse: "not-prod" });
    const deps = buildDeps(
      { operation: "delete", ruleName: "nightly-cleanup" },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await expect(runEventbridgeSchedules(deps)).rejects.toMatchObject({
      code: "ERR_EVENTBRIDGE_SCHEDULES_ABORTED",
    });
    expect(deleteRuleMock).not.toHaveBeenCalled();
  });

  test("bypasses confirmation with a warning when yes and yesSensitive are both true for a sensitive target", async () => {
    destructiveGateMock.mockImplementationOnce(callRealConfirmDestructive);
    const { prompt, confirm, text } = targetGatePrompt({
      textResponse: "prod",
    });
    const deps = buildDeps(
      {
        operation: "delete",
        ruleName: "nightly-cleanup",
        yes: true,
        yesSensitive: true,
      },
      { prompt, awsTarget: { profile: "prod" } },
    );
    const warningSpy = vi.spyOn(deps.logger, "warning");

    await runEventbridgeSchedules(deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("prod"));
    expect(deleteRuleMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["absent", undefined],
    ["false", false],
  ])(
    "still escalates when yes:true but yesSensitive is %s, for a sensitive target",
    async (_label, yesSensitiveValue) => {
      destructiveGateMock.mockImplementationOnce(callRealConfirmDestructive);
      const { prompt, confirm, text } = targetGatePrompt({
        textResponse: "prod",
      });
      const configValues: Record<string, unknown> = {
        operation: "delete",
        ruleName: "nightly-cleanup",
        yes: true,
      };
      if (yesSensitiveValue !== undefined) {
        configValues["yesSensitive"] = yesSensitiveValue;
      }
      const deps = buildDeps(configValues, {
        prompt,
        awsTarget: { profile: "prod" },
      });

      await runEventbridgeSchedules(deps);

      expect(text).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      expect(deleteRuleMock).toHaveBeenCalledTimes(1);
    },
  );

  test("uses the plain confirm (not escalated) when the target is not sensitive", async () => {
    destructiveGateMock.mockImplementationOnce(callRealConfirmDestructive);
    const { prompt, confirm, text } = targetGatePrompt({ confirmed: true });
    const deps = buildDeps(
      { operation: "delete", ruleName: "nightly-cleanup" },
      { prompt, awsTarget: { profile: "dev-sandbox" } },
    );

    await runEventbridgeSchedules(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(deleteRuleMock).toHaveBeenCalledTimes(1);
  });
});
