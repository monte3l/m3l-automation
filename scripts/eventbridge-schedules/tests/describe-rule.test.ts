import * as fsp from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept writeFile —
// mirrors scripts/dynamodb-crud/tests/scan-table.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { describeRule } from "../src/steps/describe-rule.js";

/**
 * Contract: docs/reference/scripts/eventbridge-schedules.md `describe-rule`
 * row, plus the spec-conformance-reviewer's correction C3 (`describe` must
 * use `Core.M3LJSONFileExporter`, NOT `M3LJSONListExporter` — a bare
 * whole-file JSON document, not an array). `describeRule(deps)`:
 *  - guard-requires `ruleName` (a non-empty string), else throws
 *    `Core.M3LError` coded `ERR_EVENTBRIDGE_SCHEDULES_CONFIG` with message
 *    `'ruleName' is required for 'describe'`;
 *  - reads optional `eventBusName`; calls
 *    `eventBridgeOperations.describeRule(ruleName, {...})`;
 *  - when `output` is configured, writes the resolved detail via
 *    `Core.M3LJSONFileExporter({ filePath }).export(detail)` — a single JSON
 *    object, never wrapped in an array; when unset, no file is written.
 */

/** Builds a real `M3LConfig` pre-populated with the given raw values. */
function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

/**
 * Builds a structural fake of `AWS.M3LEventBridgeOperations`, mocking only
 * `describeRule` (the sole method this step reads). `M3LEventBridgeOperations`
 * is a concrete class with a private client field, so a plain object literal
 * is cast through `unknown` — the same pattern `api-gateway-client`'s
 * `httpFakes.ts` uses for `Core.M3LHttpClient`.
 */
function createFakeEventBridgeOperations(overrides: {
  readonly describeRule?: ReturnType<typeof vi.fn>;
}): AWS.M3LEventBridgeOperations {
  const fake = {
    describeRule:
      overrides.describeRule ??
      vi.fn().mockResolvedValue({ name: "", arn: "" }),
  };
  return fake as unknown as AWS.M3LEventBridgeOperations;
}

const ruleDetail: AWS.M3LEventBridgeRuleDetail = {
  name: "nightly-report",
  arn: "arn:aws:events:eu-south-1:123456789012:rule/nightly-report",
  state: "ENABLED",
  createdBy: "123456789012",
};

beforeEach(() => {
  vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeRule", () => {
  test("throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG when ruleName is missing, never calling describeRule", async () => {
    const describeRuleMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      describeRule: describeRuleMock,
    });
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await describeRule({
        config,
        paths,
        logger,
        correlationId: "run-1",
        eventBridgeOperations,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect((thrown as Core.M3LError).message).toBe(
      "'ruleName' is required for 'describe'",
    );
    expect(describeRuleMock).not.toHaveBeenCalled();
  });

  test("throws the same error when ruleName is an empty string", async () => {
    const describeRuleMock = vi.fn();
    const eventBridgeOperations = createFakeEventBridgeOperations({
      describeRule: describeRuleMock,
    });
    const config = buildConfig({ ruleName: "" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await describeRule({
        config,
        paths,
        logger,
        correlationId: "run-2",
        eventBridgeOperations,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_EVENTBRIDGE_SCHEDULES_CONFIG",
    );
    expect(describeRuleMock).not.toHaveBeenCalled();
  });

  test("calls describeRule with the ruleName and eventBusName when eventBusName is configured", async () => {
    const describeRuleMock = vi.fn().mockResolvedValue(ruleDetail);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      describeRule: describeRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      eventBusName: "custom-bus",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await describeRule({
      config,
      paths,
      logger,
      correlationId: "run-3",
      eventBridgeOperations,
    });

    expect(describeRuleMock).toHaveBeenCalledWith(
      "nightly-report",
      expect.objectContaining({ eventBusName: "custom-bus" }),
    );
  });

  test("calls describeRule without an eventBusName key when eventBusName is unset", async () => {
    const describeRuleMock = vi.fn().mockResolvedValue(ruleDetail);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      describeRule: describeRuleMock,
    });
    const config = buildConfig({ ruleName: "nightly-report" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await describeRule({
      config,
      paths,
      logger,
      correlationId: "run-4",
      eventBridgeOperations,
    });

    const [name, options] = describeRuleMock.mock.calls[0] as [
      string,
      Record<string, unknown> | undefined,
    ];
    expect(name).toBe("nightly-report");
    if (options !== undefined) {
      expect(options).not.toHaveProperty("eventBusName");
    }
  });

  test("writes the detail via M3LJSONFileExporter as a single JSON document (not wrapped in an array) when 'output' is configured", async () => {
    const describeRuleMock = vi.fn().mockResolvedValue(ruleDetail);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      describeRule: describeRuleMock,
    });
    const config = buildConfig({
      ruleName: "nightly-report",
      output: "rule-detail.json",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await describeRule({
      config,
      paths,
      logger,
      correlationId: "run-5",
      eventBridgeOperations,
    });

    expect(fsp.writeFile).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fsp.writeFile).mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error("unreachable");
    const [, payload] = call;
    if (typeof payload !== "string") {
      throw new Error("expected a string payload");
    }
    expect(JSON.parse(payload)).toEqual(ruleDetail);
  });

  test("does not write any file when 'output' is unset", async () => {
    const describeRuleMock = vi.fn().mockResolvedValue(ruleDetail);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      describeRule: describeRuleMock,
    });
    const config = buildConfig({ ruleName: "nightly-report" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await describeRule({
      config,
      paths,
      logger,
      correlationId: "run-6",
      eventBridgeOperations,
    });

    expect(fsp.writeFile).not.toHaveBeenCalled();
  });
});
