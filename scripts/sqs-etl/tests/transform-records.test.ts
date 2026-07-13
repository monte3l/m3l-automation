import * as fsp from "node:fs/promises";
import type * as fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";

import { transformRecords } from "../src/steps/transform-records.js";
import {
  stubInput,
  stubOutputStreams,
  writtenJsonlRecords,
} from "./support/fsFakes.js";
import { buildConfig } from "./support/sqsFakes.js";

/**
 * Contract: docs/reference/scripts/sqs-etl.md `transform-records` row +
 * design decisions #6/#7. No SQS calls. Streams `input` JSONL, JSON-parses
 * each message body with per-record tolerance, applies `fields` (extract,
 * via Core.extractAll) BEFORE `filters` (reusing filter-records.ts's exact
 * grammar/ops, code ERR_SQS_ETL_FILTER_RULE), streams to `output`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transformRecords", () => {
  test("streams input to output unprojected when fields/filters are both empty, including non-object bodies", async () => {
    const content = ['"a plain string"', "42", '{"id":1}'].join("\n");
    stubInput(content);
    const { streams } = stubOutputStreams();
    const config = buildConfig({
      input: "in.jsonl",
      output: "out.jsonl",
      fields: [],
      filters: [],
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    const summary = await transformRecords({
      config,
      paths,
      logger,
      correlationId: "run-1",
    });

    expect(summary.read).toBe(3);
    expect(summary.skipped).toBe(0);
    const [output] = streams;
    expect(output).toBeDefined();
    if (output !== undefined) {
      expect(writtenJsonlRecords(output)).toEqual([
        "a plain string",
        42,
        { id: 1 },
      ]);
    }
  });

  test("applies 'fields' projection before 'filters' — a filter path resolves against the POST-projection record", async () => {
    const content = ['{"status":"active","name":"Ada"}'].join("\n");
    stubInput(content);
    const { streams } = stubOutputStreams();
    const config = buildConfig({
      input: "in.jsonl",
      output: "out.jsonl",
      fields: ["who=name"],
      filters: ["who eq Ada"],
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    const summary = await transformRecords({
      config,
      paths,
      logger,
      correlationId: "run-2",
    });

    expect(summary.written).toBe(1);
    const [output] = streams;
    expect(output).toBeDefined();
    if (output !== undefined) {
      expect(writtenJsonlRecords(output)).toEqual([{ who: "Ada" }]);
    }
  });

  test("skips (counted) a non-object parsed body when 'fields' or 'filters' is non-empty", async () => {
    const content = ['"a plain string"', '{"status":"active"}'].join("\n");
    stubInput(content);
    stubOutputStreams();
    const config = buildConfig({
      input: "in.jsonl",
      output: "out.jsonl",
      fields: [],
      filters: ["status eq active"],
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    const summary = await transformRecords({
      config,
      paths,
      logger,
      correlationId: "run-3",
    });

    expect(summary.read).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.written).toBe(1);
  });

  test("a malformed JSONL line is a per-record skip (counted), surviving records still flow", async () => {
    const content = ['{"id":1}', "not-json", '{"id":2}'].join("\n");
    stubInput(content);
    const { streams } = stubOutputStreams();
    const config = buildConfig({
      input: "in.jsonl",
      output: "out.jsonl",
      fields: [],
      filters: [],
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    const summary = await transformRecords({
      config,
      paths,
      logger,
      correlationId: "run-4",
    });

    expect(summary).toEqual({ read: 2, written: 2, skipped: 1 });
    const [output] = streams;
    expect(output).toBeDefined();
    if (output !== undefined) {
      expect(writtenJsonlRecords(output)).toEqual([{ id: 1 }, { id: 2 }]);
    }
  });

  test("a malformed filter rule throws ERR_SQS_ETL_FILTER_RULE before any record is read", async () => {
    stubInput("");
    stubOutputStreams();
    const config = buildConfig({
      input: "in.jsonl",
      output: "out.jsonl",
      fields: [],
      filters: ["age gt not-a-number"],
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await transformRecords({
        config,
        paths,
        logger,
        correlationId: "run-5",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_FILTER_RULE");
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test.each(["input", "output"] as const)(
    "throws ERR_SQS_ETL_CONFIG when '%s' is missing",
    async (missing) => {
      stubInput("");
      stubOutputStreams();
      const base: Record<string, unknown> = {
        input: "in.jsonl",
        output: "out.jsonl",
        fields: [],
        filters: [],
      };
      delete base[missing];
      const config = buildConfig(base);
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);

      let thrown: unknown;
      try {
        await transformRecords({
          config,
          paths,
          logger,
          correlationId: `run-missing-${missing}`,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe("ERR_SQS_ETL_CONFIG");
      expect(fsp.readFile).not.toHaveBeenCalled();
    },
  );
});
