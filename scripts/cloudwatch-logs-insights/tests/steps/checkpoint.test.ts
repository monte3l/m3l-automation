import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  buildCheckpointStore,
  EMPTY_CHECKPOINT,
  isLogsInsightsCheckpoint,
} from "../../src/steps/checkpoint.js";

/**
 * Contract: `scripts/cloudwatch-logs-insights/src/steps/checkpoint.ts` (issue
 * #237). `isLogsInsightsCheckpoint` is the `validate` predicate
 * `Core.M3LCheckpointStore` runs on every resumed checkpoint read — a JSON
 * file on disk that may be hand-edited or truncated by an interrupted write.
 * The tightened contract requires:
 *   - `completedWindows`: a non-negative integer (`Number.isInteger(value) &&
 *     value >= 0`) — rejects negative, non-integer, and `NaN` values.
 *   - `rows`: an array whose every element is a non-null, non-array plain
 *     object with only `string` own values (matching `LogsInsightsRow =
 *     Record<string, string>`).
 *   - `inFlightQueryId`: unchanged — `undefined` or `string`.
 * No I/O here — the predicate is a pure function over `unknown`.
 */

function baseCheckpoint(): Record<string, unknown> {
  return { completedWindows: 0, rows: [] };
}

describe("isLogsInsightsCheckpoint", () => {
  describe("accepts", () => {
    it("a well-formed empty checkpoint", () => {
      expect(isLogsInsightsCheckpoint(baseCheckpoint())).toBe(true);
    });

    it("a checkpoint with populated rows of string-only plain objects", () => {
      expect(
        isLogsInsightsCheckpoint({
          completedWindows: 2,
          rows: [
            { "@timestamp": "2026-07-01T00:00:00Z", "@message": "hello" },
            { field: "value" },
          ],
        }),
      ).toBe(true);
    });

    it("a checkpoint with inFlightQueryId present as a string", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          inFlightQueryId: "query-123",
        }),
      ).toBe(true);
    });

    it("a checkpoint with inFlightQueryId absent", () => {
      expect(isLogsInsightsCheckpoint(baseCheckpoint())).toBe(true);
    });

    it("a checkpoint with outputBytes present and a valid non-negative integer (JSON-format resume state)", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          outputBytes: 1024,
        }),
      ).toBe(true);
    });

    it("a checkpoint with outputBytes: 0 (a JSON-format run that has not appended any byte yet)", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          outputBytes: 0,
        }),
      ).toBe(true);
    });

    it("a checkpoint with outputBytes absent (CSV-format checkpoints never populate it)", () => {
      expect(isLogsInsightsCheckpoint(baseCheckpoint())).toBe(true);
    });
  });

  describe("rejects", () => {
    it("completedWindows: -1 (negative)", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          completedWindows: -1,
        }),
      ).toBe(false);
    });

    it("completedWindows: 1.5 (non-integer)", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          completedWindows: 1.5,
        }),
      ).toBe(false);
    });

    it("completedWindows: NaN", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          completedWindows: Number.NaN,
        }),
      ).toBe(false);
    });

    it("completedWindows: Infinity (non-integer per Number.isInteger)", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          completedWindows: Number.POSITIVE_INFINITY,
        }),
      ).toBe(false);
    });

    it("completedWindows: '0' (wrong type)", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          completedWindows: "0",
        }),
      ).toBe(false);
    });

    it("rows containing a non-object element (a number)", () => {
      expect(
        isLogsInsightsCheckpoint({ ...baseCheckpoint(), rows: [42] }),
      ).toBe(false);
    });

    it("rows containing a non-object element (a string)", () => {
      expect(
        isLogsInsightsCheckpoint({ ...baseCheckpoint(), rows: ["oops"] }),
      ).toBe(false);
    });

    it("rows containing null", () => {
      expect(
        isLogsInsightsCheckpoint({ ...baseCheckpoint(), rows: [null] }),
      ).toBe(false);
    });

    it("rows containing a nested array", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          rows: [["nested", "array"]],
        }),
      ).toBe(false);
    });

    it("rows containing an object with a non-string value", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          rows: [{ field: 123 }],
        }),
      ).toBe(false);
    });

    it("rows not an array at all", () => {
      expect(
        isLogsInsightsCheckpoint({ ...baseCheckpoint(), rows: "not-an-array" }),
      ).toBe(false);
    });

    it("inFlightQueryId present as a non-string", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          inFlightQueryId: 123,
        }),
      ).toBe(false);
    });

    it("outputBytes: NaN", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          outputBytes: Number.NaN,
        }),
      ).toBe(false);
    });

    it("outputBytes: Infinity", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          outputBytes: Number.POSITIVE_INFINITY,
        }),
      ).toBe(false);
    });

    it("outputBytes: -1 (negative)", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          outputBytes: -1,
        }),
      ).toBe(false);
    });

    it("outputBytes: 1.5 (non-integer)", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          outputBytes: 1.5,
        }),
      ).toBe(false);
    });

    it("outputBytes present as a non-number", () => {
      expect(
        isLogsInsightsCheckpoint({
          ...baseCheckpoint(),
          outputBytes: "1024",
        }),
      ).toBe(false);
    });

    it("the whole value is not an object", () => {
      expect(isLogsInsightsCheckpoint("not-an-object")).toBe(false);
    });

    it("the whole value is null", () => {
      expect(isLogsInsightsCheckpoint(null)).toBe(false);
    });
  });

  it("EMPTY_CHECKPOINT satisfies the validator (regression: fresh-run seed value)", () => {
    expect(isLogsInsightsCheckpoint(EMPTY_CHECKPOINT)).toBe(true);
  });
});

describe("buildCheckpointStore", () => {
  const paths = new Core.M3LPaths();

  it("constructs an M3LCheckpointStore whose path is derived from the given output name", () => {
    const store = buildCheckpointStore(paths, "my-run", {
      kind: "empty",
      value: EMPTY_CHECKPOINT,
    });

    expect(store).toBeInstanceOf(Core.M3LCheckpointStore);
    expect(store.path.endsWith("my-run.checkpoint.json")).toBe(true);
  });

  it("does not throw when constructed with the 'error' missing policy", () => {
    const store = buildCheckpointStore(paths, "my-run", { kind: "error" });

    expect(store).toBeInstanceOf(Core.M3LCheckpointStore);
    expect(store.path.endsWith("my-run.checkpoint.json")).toBe(true);
  });
});

/**
 * Contract: issue #497 (A4b) — `buildCheckpointStore` gains an optional 4th
 * `definition?: unknown` parameter, forwarded verbatim into
 * `Core.M3LCheckpointStore`'s constructor options. Rather than mocking `new
 * Core.M3LCheckpointStore` (which would require rewriting every other test
 * in this file to keep `instanceof`/`.path` working against a real vs. mocked
 * class), these tests observe the forwarding through `M3LCheckpointStore`'s
 * own documented, synchronous construction-time contract: a `definition`
 * outside its allowlist throws `M3LCheckpointError` coded
 * `"ERR_CHECKPOINT_DEFINITION"` at construction, before any I/O — a throw
 * that can only happen if the value actually reached the store's
 * constructor. This proves the plumbing without depending on file I/O.
 */
describe("buildCheckpointStore — definition (issue #497 retrofit)", () => {
  const paths = new Core.M3LPaths();

  it("forwards an allowlisted definition through to M3LCheckpointStore (constructs without throwing)", () => {
    const store = buildCheckpointStore(
      paths,
      "my-run",
      { kind: "empty", value: EMPTY_CHECKPOINT },
      {
        query: "fields @timestamp",
        logGroups: ["/aws/lambda/a"],
        windowMinutes: 60,
      },
    );

    expect(store).toBeInstanceOf(Core.M3LCheckpointStore);
  });

  it("forwards a rejected (non-allowlisted) definition through to M3LCheckpointStore, surfacing ERR_CHECKPOINT_DEFINITION at construction — proves the value reaches the store rather than being swallowed by the factory", () => {
    let thrown: unknown;
    try {
      buildCheckpointStore(
        paths,
        "my-run",
        { kind: "empty", value: EMPTY_CHECKPOINT },
        // A function value is never on M3LCheckpointStore's definition
        // allowlist (string | boolean | finite number | null | plain
        // array/object) — this only throws if the factory actually forwards
        // it into the constructor.
        { onFailure: () => undefined },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
  });

  it("constructs identically to before when the definition argument is omitted (no fingerprinting opt-in)", () => {
    const store = buildCheckpointStore(paths, "my-run", {
      kind: "empty",
      value: EMPTY_CHECKPOINT,
    });

    expect(store).toBeInstanceOf(Core.M3LCheckpointStore);
  });
});
