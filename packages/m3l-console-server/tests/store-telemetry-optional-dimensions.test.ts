/**
 * Proves that the three optional-dimension call sites in
 * `telemetry-repository.ts` correctly normalize outer whitespace before
 * binding SQL parameters:
 *
 * - `recordRunFinished`   `:231` — `operation: measurement.operation ?? ""`
 * - `recordSseStream`     `:262` — `outcome: measurement.outcome ?? ""`
 * - `recordPolicyDecision` `:277` — `outcome: measurement.outcome ?? ""`
 *
 * Without normalization, `"export"` and `" export "` land as two distinct
 * PRIMARY KEY rows in `console_telemetry_rollup`, silently splitting one
 * rollup bucket in two. The centrepiece test in each describe block
 * (`bucket-merge`) asserts the two parameter tuples are deeply equal — that
 * is what makes the upsert's `ON CONFLICT` merge instead of inserting.
 *
 * Driven through a **typed fake `M3LStoreQueryExecutor`** — no real
 * database, no migration.
 *
 * Column order sourced from `upsertWithValue` / `upsertCounter`:
 *   SQL_UPSERT_WITH_VALUE: [granularity(0), bucket_start_ms(1), metric(2),
 *     route(3), script(4), operation(5), outcome(6), posture(7),
 *     sum_value(8), min_value(9), max_value(10)]
 *   SQL_UPSERT_COUNTER:    [granularity(0), bucket_start_ms(1), metric(2),
 *     route(3), script(4), operation(5), outcome(6), posture(7)]
 */
import { describe, expect, test } from "vitest";

import { createConsoleTelemetryRepository } from "../src/store/telemetry-repository.js";
import type { M3LTelemetryMeasurement } from "../src/store/telemetry-repository.js";
import type {
  M3LStoreParameters,
  M3LStoreQueryExecutor,
} from "../src/store/types.js";

// ---------------------------------------------------------------------------
// Typed recording executor — no database
// ---------------------------------------------------------------------------

interface CapturedRun {
  readonly sql: string;
  readonly parameters: M3LStoreParameters | undefined;
}

function makeRecordingExecutor(): {
  readonly executor: M3LStoreQueryExecutor;
  readonly calls: CapturedRun[];
} {
  const calls: CapturedRun[] = [];
  const executor: M3LStoreQueryExecutor = {
    all: () => [],
    get: () => undefined,
    run(sql, parameters) {
      calls.push({ sql, parameters });
      return { changes: 1, lastInsertRowid: 1 };
    },
    script: () => undefined,
  };
  return { executor, calls };
}

// ---------------------------------------------------------------------------
// run.finished — operation dimension (optional)
// ---------------------------------------------------------------------------
// SQL_UPSERT_WITH_VALUE column order (from upsertWithValue):
//   index 5 = operation
// ---------------------------------------------------------------------------

describe("optional-dimension normalization: run.finished — operation", () => {
  test("outer whitespace stripped: operation '  export  ' → params contain 'export' at index 5", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "run.finished",
      granularity: "minute",
      bucketStartMs: 60_000,
      script: "my-script",
      operation: "  export  ",
      outcome: "succeeded",
      valueMs: 100,
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    // Assert on the whole tuple so a column-order change surfaces.
    // Index 5 is `operation`; it must be "export", never "  export  ".
    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "run.finished",
      "",
      "my-script",
      "export",
      "succeeded",
      "",
      100,
      100,
      100,
    ]);
  });

  test("omitted operation (undefined) yields empty string sentinel in params", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "run.finished",
      granularity: "minute",
      bucketStartMs: 60_000,
      script: "my-script",
      outcome: "succeeded",
      valueMs: 100,
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "run.finished",
      "",
      "my-script",
      "",
      "succeeded",
      "",
      100,
      100,
      100,
    ]);
  });

  test("internal whitespace preserved: operation 'a  b' survives verbatim in params", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    // Two internal spaces — cannot be detected by a single-space fixture.
    const measurement: M3LTelemetryMeasurement = {
      metric: "run.finished",
      granularity: "minute",
      bucketStartMs: 60_000,
      script: "my-script",
      operation: "a  b",
      outcome: "succeeded",
      valueMs: 100,
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "run.finished",
      "",
      "my-script",
      "a  b",
      "succeeded",
      "",
      100,
      100,
      100,
    ]);
  });

  // CENTREPIECE: this is the assertion that would have caught the original bug.
  // Two calls differing only in outer whitespace must produce identical bound
  // parameter tuples — that is what makes ON CONFLICT merge instead of insert.
  test("[bucket-merge] 'export' and ' export ' yield identical parameter tuples", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const base = {
      metric: "run.finished",
      granularity: "minute",
      bucketStartMs: 60_000,
      script: "my-script",
      outcome: "succeeded",
      valueMs: 100,
    } as const;

    repo.record({ ...base, operation: "export" });
    repo.record({ ...base, operation: " export " });

    expect(calls).toHaveLength(2);
    const first = calls[0];
    const second = calls[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    // The two parameter tuples must be deeply equal. If they differ at index 5
    // (operation), the upsert would insert a second PK row instead of merging.
    expect(first.parameters).toEqual(second.parameters);
  });
});

// ---------------------------------------------------------------------------
// sse.stream — outcome dimension (optional)
// ---------------------------------------------------------------------------
// SQL_UPSERT_COUNTER column order (from upsertCounter):
//   index 6 = outcome
// ---------------------------------------------------------------------------

describe("optional-dimension normalization: sse.stream — outcome", () => {
  test("outer whitespace stripped: outcome '  2xx  ' → params contain '2xx' at index 6", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "sse.stream",
      granularity: "minute",
      bucketStartMs: 60_000,
      outcome: "  2xx  ",
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    // Assert on the whole tuple; index 6 is `outcome`.
    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "sse.stream",
      "",
      "",
      "",
      "2xx",
      "",
    ]);
  });

  test("omitted outcome (undefined) yields empty string sentinel in params", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "sse.stream",
      granularity: "minute",
      bucketStartMs: 60_000,
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "sse.stream",
      "",
      "",
      "",
      "",
      "",
    ]);
  });

  test("explicit outcome '' does not throw and yields empty string sentinel", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    // An explicit "" must not throw — undefined already produces the same row,
    // so making "" throw while undefined succeeds would be incoherent.
    const measurement: M3LTelemetryMeasurement = {
      metric: "sse.stream",
      granularity: "minute",
      bucketStartMs: 60_000,
      outcome: "",
    };

    expect(() => repo.record(measurement)).not.toThrow();

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "sse.stream",
      "",
      "",
      "",
      "",
      "",
    ]);
  });

  test("internal whitespace preserved: outcome 'a  b' survives verbatim in params", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "sse.stream",
      granularity: "minute",
      bucketStartMs: 60_000,
      outcome: "a  b",
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "sse.stream",
      "",
      "",
      "",
      "a  b",
      "",
    ]);
  });

  // CENTREPIECE: two calls differing only in outer whitespace must produce
  // identical bound parameter tuples.
  test("[bucket-merge] '2xx' and ' 2xx ' yield identical parameter tuples", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const base = {
      metric: "sse.stream",
      granularity: "minute",
      bucketStartMs: 60_000,
    } as const;

    repo.record({ ...base, outcome: "2xx" });
    repo.record({ ...base, outcome: " 2xx " });

    expect(calls).toHaveLength(2);
    const first = calls[0];
    const second = calls[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    // If they differ at index 6 (outcome), the upsert inserts a second PK row.
    expect(first.parameters).toEqual(second.parameters);
  });
});

// ---------------------------------------------------------------------------
// policy.decision — outcome dimension (optional)
// ---------------------------------------------------------------------------
// SQL_UPSERT_COUNTER column order (from upsertCounter):
//   index 6 = outcome
// ---------------------------------------------------------------------------

describe("optional-dimension normalization: policy.decision — outcome", () => {
  test("outer whitespace stripped: outcome '  deny  ' → params contain 'deny' at index 6", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "policy.decision",
      granularity: "minute",
      bucketStartMs: 60_000,
      posture: "enforce",
      outcome: "  deny  ",
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    // Assert on the whole tuple; index 6 is `outcome`, index 7 is `posture`.
    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "policy.decision",
      "",
      "",
      "",
      "deny",
      "enforce",
    ]);
  });

  test("omitted outcome (undefined) yields empty string sentinel in params", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "policy.decision",
      granularity: "minute",
      bucketStartMs: 60_000,
      posture: "enforce",
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "policy.decision",
      "",
      "",
      "",
      "",
      "enforce",
    ]);
  });

  test("explicit outcome '' does not throw and yields empty string sentinel", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "policy.decision",
      granularity: "minute",
      bucketStartMs: 60_000,
      posture: "enforce",
      outcome: "",
    };

    expect(() => repo.record(measurement)).not.toThrow();

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "policy.decision",
      "",
      "",
      "",
      "",
      "enforce",
    ]);
  });

  test("internal whitespace preserved: outcome 'a  b' survives verbatim in params", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const measurement: M3LTelemetryMeasurement = {
      metric: "policy.decision",
      granularity: "minute",
      bucketStartMs: 60_000,
      posture: "enforce",
      outcome: "a  b",
    };

    repo.record(measurement);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.parameters).toEqual([
      "minute",
      60_000,
      "policy.decision",
      "",
      "",
      "",
      "a  b",
      "enforce",
    ]);
  });

  // CENTREPIECE: two calls differing only in outer whitespace must produce
  // identical bound parameter tuples.
  test("[bucket-merge] 'deny' and ' deny ' yield identical parameter tuples", () => {
    const { executor, calls } = makeRecordingExecutor();
    const repo = createConsoleTelemetryRepository(executor);

    const base = {
      metric: "policy.decision",
      granularity: "minute",
      bucketStartMs: 60_000,
      posture: "enforce",
    } as const;

    repo.record({ ...base, outcome: "deny" });
    repo.record({ ...base, outcome: " deny " });

    expect(calls).toHaveLength(2);
    const first = calls[0];
    const second = calls[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    // If they differ at index 6 (outcome), the upsert inserts a second PK row.
    expect(first.parameters).toEqual(second.parameters);
  });
});
