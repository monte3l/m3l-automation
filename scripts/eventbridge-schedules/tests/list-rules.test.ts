import type { WriteStream } from "node:fs";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

// Make 'node:fs' configurable so vi.spyOn can intercept createWriteStream —
// mirrors packages/m3l-common/tests/exporters.test.ts and
// scripts/json-etl/tests/export-results.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { listRules } from "../src/steps/list-rules.js";

/**
 * Contract: docs/reference/scripts/eventbridge-schedules.md `list-rules` row,
 * plus the spec-conformance-reviewer's corrections (C1: `M3LJSONListExporter`
 * format is `'array'`, not `'json'`; C2: `.export()` accepts a `readonly`
 * array). `listRules(deps)`:
 *  - reads optional `namePrefix`/`eventBusName` config strings, treating an
 *    empty string as unset;
 *  - drains every `eventBridgeOperations.listRules()` page, accumulating
 *    `result.rules` and looping while `result.nextToken !== undefined`,
 *    passing that token back as `nextToken` on the next call;
 *  - when `output` is configured, writes the accumulated array via
 *    `Core.M3LJSONListExporter({ format: 'array' })` to
 *    `paths.resolveOutput(output)`; when unset, no file is written;
 *  - a `listRules()` rejection propagates unmodified (no wrapping).
 */

/** A minimal fake fs.WriteStream: records every chunk written to it. */
class FakeWriteStream extends EventEmitter {
  chunks: string[] = [];

  write(chunk: string | Buffer, cb?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk.toString());
    queueMicrotask(() => {
      cb?.();
    });
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.chunks.push(chunk.toString());
    }
    queueMicrotask(() => this.emit("finish"));
    return this;
  }

  content(): string {
    return this.chunks.join("");
  }
}

/**
 * Installs a fake `fs.createWriteStream`, recording every stream it created
 * (a step should open at most one output stream, but capturing all of them
 * makes an unexpected extra write visible too).
 */
function stubWriteStream(): { streams: FakeWriteStream[] } {
  const streams: FakeWriteStream[] = [];
  vi.spyOn(fs, "createWriteStream").mockImplementation(() => {
    const stream = new FakeWriteStream();
    streams.push(stream);
    return stream as unknown as WriteStream;
  });
  return { streams };
}

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
 * `listRules` (the sole method this step reads). `M3LEventBridgeOperations`
 * is a concrete class with a private client field, so a plain object literal
 * is cast through `unknown` — the same pattern `api-gateway-client`'s
 * `httpFakes.ts` uses for `Core.M3LHttpClient`.
 */
function createFakeEventBridgeOperations(overrides: {
  readonly listRules?: ReturnType<typeof vi.fn>;
}): AWS.M3LEventBridgeOperations {
  const fake = {
    listRules: overrides.listRules ?? vi.fn().mockResolvedValue({ rules: [] }),
  };
  return fake as unknown as AWS.M3LEventBridgeOperations;
}

const ruleA: AWS.M3LEventBridgeRule = {
  name: "rule-a",
  arn: "arn:aws:events:eu-south-1:123456789012:rule/rule-a",
};
const ruleB: AWS.M3LEventBridgeRule = {
  name: "rule-b",
  arn: "arn:aws:events:eu-south-1:123456789012:rule/rule-b",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listRules", () => {
  test("drains pagination across multiple pages, writing the accumulated rules from BOTH pages when 'output' is configured", async () => {
    const { streams } = stubWriteStream();
    const listRulesMock = vi
      .fn()
      .mockResolvedValueOnce({ rules: [ruleA], nextToken: "page2" })
      .mockResolvedValueOnce({ rules: [ruleB] });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      listRules: listRulesMock,
    });
    const config = buildConfig({ output: "rules.json" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await listRules({
      config,
      paths,
      logger,
      correlationId: "run-1",
      eventBridgeOperations,
    });

    expect(listRulesMock).toHaveBeenCalledTimes(2);
    const secondCallArgs = listRulesMock.mock.calls[1] as
      [Record<string, unknown>] | undefined;
    expect(secondCallArgs?.[0]).toMatchObject({ nextToken: "page2" });

    expect(streams).toHaveLength(1);
    const written = streams[0];
    expect(written).toBeDefined();
    if (written === undefined) throw new Error("unreachable");
    expect(JSON.parse(written.content())).toEqual([ruleA, ruleB]);
  });

  test("reads optional namePrefix/eventBusName from config, treating empty string as unset", async () => {
    stubWriteStream();
    const listRulesMock = vi.fn().mockResolvedValue({ rules: [] });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      listRules: listRulesMock,
    });
    const config = buildConfig({ namePrefix: "", eventBusName: "" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await listRules({
      config,
      paths,
      logger,
      correlationId: "run-2",
      eventBridgeOperations,
    });

    const [callArgs] = listRulesMock.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs).not.toHaveProperty("namePrefix");
    expect(callArgs).not.toHaveProperty("eventBusName");
  });

  test("passes namePrefix/eventBusName through to listRules() when non-empty", async () => {
    stubWriteStream();
    const listRulesMock = vi.fn().mockResolvedValue({ rules: [] });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      listRules: listRulesMock,
    });
    const config = buildConfig({
      namePrefix: "nightly-",
      eventBusName: "custom-bus",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await listRules({
      config,
      paths,
      logger,
      correlationId: "run-3",
      eventBridgeOperations,
    });

    const [callArgs] = listRulesMock.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs).toMatchObject({
      namePrefix: "nightly-",
      eventBusName: "custom-bus",
    });
  });

  test("does not write any file when 'output' is unset", async () => {
    const { streams } = stubWriteStream();
    const listRulesMock = vi.fn().mockResolvedValue({ rules: [ruleA] });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      listRules: listRulesMock,
    });
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await listRules({
      config,
      paths,
      logger,
      correlationId: "run-4",
      eventBridgeOperations,
    });

    expect(streams).toHaveLength(0);
  });

  test("propagates a listRules() rejection unmodified", async () => {
    stubWriteStream();
    const sentinelError = new Error("ListRules failed");
    const listRulesMock = vi.fn().mockRejectedValue(sentinelError);
    const eventBridgeOperations = createFakeEventBridgeOperations({
      listRules: listRulesMock,
    });
    const config = buildConfig({});
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      listRules({
        config,
        paths,
        logger,
        correlationId: "run-5",
        eventBridgeOperations,
      }),
    ).rejects.toBe(sentinelError);
  });
});
