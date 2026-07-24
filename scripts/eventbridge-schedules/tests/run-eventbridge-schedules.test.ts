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
  vi.clearAllMocks();
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
      const config = buildConfig({ operation, ruleName: "nightly-cleanup" });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const eventBridgeOperations = createFakeEventBridgeOperations();
      const prompt = new Core.M3LPrompt();

      await runEventbridgeSchedules({
        config,
        paths,
        logger,
        correlationId: "run-1",
        eventBridgeOperations,
        prompt,
      });

      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          paths,
          logger,
          correlationId: "run-1",
          eventBridgeOperations,
          prompt,
        }),
      );

      for (const other of ALL_STEP_MOCKS) {
        if (other !== mock) expect(other).not.toHaveBeenCalled();
      }
    },
  );

  test.each(MUTATING_STEP_MOCKS)(
    "runs destructiveGate before dispatching mutating operation '%s', with the rule description",
    async (operation, mock) => {
      const config = buildConfig({
        operation,
        ruleName: "nightly-cleanup",
        yes: false,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const eventBridgeOperations = createFakeEventBridgeOperations();
      const prompt = new Core.M3LPrompt();

      await runEventbridgeSchedules({
        config,
        paths,
        logger,
        correlationId: "run-2",
        eventBridgeOperations,
        prompt,
      });

      expect(destructiveGateMock).toHaveBeenCalledTimes(1);
      expect(destructiveGateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt,
          logger,
          description: `${operation} rule 'nightly-cleanup'`,
          yes: false,
        }),
      );
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );

  test.each(MUTATING_STEP_MOCKS)(
    "falls back to '(unspecified)' in the gate description for '%s' when ruleName is unset",
    async (operation) => {
      const config = buildConfig({ operation });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const eventBridgeOperations = createFakeEventBridgeOperations();
      const prompt = new Core.M3LPrompt();

      await runEventbridgeSchedules({
        config,
        paths,
        logger,
        correlationId: "run-3",
        eventBridgeOperations,
        prompt,
      });

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
      const config = buildConfig({
        operation,
        ruleName: "nightly-cleanup",
        yes: true,
      });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const eventBridgeOperations = createFakeEventBridgeOperations();
      const prompt = new Core.M3LPrompt();

      await runEventbridgeSchedules({
        config,
        paths,
        logger,
        correlationId: "run-4",
        eventBridgeOperations,
        prompt,
      });

      expect(destructiveGateMock).toHaveBeenCalledWith(
        expect.objectContaining({ yes: true }),
      );
    },
  );

  test.each([
    ["list", listRulesMock],
    ["describe", describeRuleMock],
  ] as const)(
    "does NOT run destructiveGate for the non-mutating operation '%s'",
    async (operation, mock) => {
      const config = buildConfig({ operation, ruleName: "nightly-cleanup" });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const eventBridgeOperations = createFakeEventBridgeOperations();
      const prompt = new Core.M3LPrompt();

      await runEventbridgeSchedules({
        config,
        paths,
        logger,
        correlationId: "run-5",
        eventBridgeOperations,
        prompt,
      });

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

    const config = buildConfig({
      operation: "delete",
      ruleName: "nightly-cleanup",
      yes: false,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const eventBridgeOperations = createFakeEventBridgeOperations();
    const prompt = new Core.M3LPrompt();

    await expect(
      runEventbridgeSchedules({
        config,
        paths,
        logger,
        correlationId: "run-6",
        eventBridgeOperations,
        prompt,
      }),
    ).rejects.toBeInstanceOf(Core.M3LError);

    expect(deleteRuleMock).not.toHaveBeenCalled();
  });

  test("defensively rejects an unrecognized 'operation' value with a typed M3LError", async () => {
    const config = buildConfig({ operation: "purge" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const eventBridgeOperations = createFakeEventBridgeOperations();
    const prompt = new Core.M3LPrompt();

    let thrown: unknown;
    try {
      await runEventbridgeSchedules({
        config,
        paths,
        logger,
        correlationId: "run-7",
        eventBridgeOperations,
        prompt,
      });
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
