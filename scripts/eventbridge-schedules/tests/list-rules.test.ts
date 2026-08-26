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

  test("throws ERR_EVENTBRIDGE_SCHEDULES_CONFIG when 'namePrefix' is stored as a non-string (required-variant wrong-type rejection)", async () => {
    const listRulesMock = vi.fn().mockResolvedValue({ rules: [] });
    const eventBridgeOperations = createFakeEventBridgeOperations({
      listRules: listRulesMock,
    });
    const config = buildConfig({ namePrefix: 42 });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      listRules({
        config,
        paths,
        logger,
        correlationId: "run-2b",
        eventBridgeOperations,
      }),
    ).rejects.toMatchObject({ code: "ERR_EVENTBRIDGE_SCHEDULES_CONFIG" });
    expect(listRulesMock).not.toHaveBeenCalled();
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

  // A5b PR2 (issue #506): `drainRules`' hand-rolled
  // `do { … } while (nextToken !== undefined)` loop has no ceiling — if the
  // SDK/mock ever repeats the same `nextToken`, it spins forever. This
  // mirrors the bound already shipped for the library's own pagination
  // generators (packages/m3l-common/tests/dynamodb.test.ts's
  // "rejects with ERR_NO_PROGRESS ... instead of looping forever" tests).
  //
  // Unlike that generator case, `drainRules` cannot be stepped from the
  // outside (it returns one Promise wrapping the whole loop, not a
  // steppable async generator), so the safety bound here is placed INSIDE
  // the mock itself: the mock throws once it has been called more times
  // than any reasonable guard should ever allow, deterministically ending
  // the promise chain whether or not the real no-progress guard exists yet.
  // This avoids relying solely on the per-test timeout to interrupt an
  // unbounded synchronous-microtask loop (which starves Node's timer phase
  // rather than raising a clean timeout error, per the dynamodb.test.ts
  // precedent comment).
  test("rejects with ERR_NO_PROGRESS instead of looping forever when nextToken never changes across pages", async () => {
    let calls = 0;
    const listRulesMock = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls > 5) {
        throw new Error(
          "test bound exceeded: drainRules did not stop looping on a repeated nextToken",
        );
      }
      return Promise.resolve({
        rules: [ruleA],
        nextToken: "stuck-token",
      });
    });
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
        correlationId: "run-6",
        eventBridgeOperations,
      }),
    ).rejects.toMatchObject({ code: "ERR_NO_PROGRESS" });
  }, 2000);

  test("drains a genuinely advancing nextToken across 3 pages, accumulating rules from all of them", async () => {
    const { streams } = stubWriteStream();
    const ruleC: AWS.M3LEventBridgeRule = {
      name: "rule-c",
      arn: "arn:aws:events:eu-south-1:123456789012:rule/rule-c",
    };
    const listRulesMock = vi
      .fn()
      .mockResolvedValueOnce({ rules: [ruleA], nextToken: "page2" })
      .mockResolvedValueOnce({ rules: [ruleB], nextToken: "page3" })
      .mockResolvedValueOnce({ rules: [ruleC] });
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
      correlationId: "run-7",
      eventBridgeOperations,
    });

    expect(listRulesMock).toHaveBeenCalledTimes(3);
    const written = streams[0];
    expect(written).toBeDefined();
    if (written === undefined) throw new Error("unreachable");
    expect(JSON.parse(written.content())).toEqual([ruleA, ruleB, ruleC]);
  });

  test("completes after a single page with no nextToken, without ever suspecting a repeated token", async () => {
    stubWriteStream();
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
      correlationId: "run-8",
      eventBridgeOperations,
    });

    expect(listRulesMock).toHaveBeenCalledTimes(1);
  });
});
