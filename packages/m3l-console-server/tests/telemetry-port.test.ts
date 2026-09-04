/**
 * Tests for src/telemetry/no-op.ts — `createNoOpTelemetryRecorder`, the
 * `M3LTelemetryRecorder` (`src/telemetry/port.ts`) that PRs 2b–3c's call
 * sites are wired against before any store-backed recorder or enable/disable
 * config exists, and that a storeless console (`M3LConsoleRuntimeOptions.store`
 * is optional) still has to satisfy.
 *
 * RED: `../src/telemetry/no-op.ts` and `../src/telemetry/port.ts` do not
 * exist yet — every import below is expected to fail to resolve until the
 * implementer lands both modules.
 *
 * This file only exercises `createNoOpTelemetryRecorder` in isolation
 * (totality + inertness). The store-backed adapter is covered by
 * `tests/telemetry-recorder.test.ts`, and the `main.ts` composition seam by
 * `tests/telemetry-seam.test.ts` (a later spoke's file — not touched here).
 */
import { describe, expect, test } from "vitest";

import { createNoOpTelemetryRecorder } from "../src/telemetry/no-op.js";
import type {
  M3LTelemetryHttpRequestSample,
  M3LTelemetryPolicyDecisionSample,
  M3LTelemetryRecorder,
  M3LTelemetryRunFinishedSample,
  M3LTelemetrySseStreamSample,
  M3LTelemetryStoreHealthSample,
} from "../src/telemetry/port.js";

/** A legal `httpRequest` sample with every field populated. */
const HTTP_REQUEST_SAMPLE: M3LTelemetryHttpRequestSample = {
  route: "/api/v1/runs",
  outcome: "2xx",
  latencyMs: 42,
};

/** A legal `runFinished` sample with the optional `operation` populated. */
const RUN_FINISHED_SAMPLE_FULL: M3LTelemetryRunFinishedSample = {
  script: "example-export",
  operation: "export",
  outcome: "succeeded",
  durationMs: 1234,
};

/** A legal `runFinished` sample with the optional `operation` omitted entirely. */
const RUN_FINISHED_SAMPLE_MINIMAL: M3LTelemetryRunFinishedSample = {
  script: "example-export",
  outcome: "succeeded",
  durationMs: 1234,
};

/** A legal `sseStream` sample with the optional `outcome` populated. */
const SSE_STREAM_SAMPLE_FULL: M3LTelemetrySseStreamSample = {
  outcome: "closed",
};

/** A legal `sseStream` sample with the optional `outcome` omitted entirely. */
const SSE_STREAM_SAMPLE_MINIMAL: M3LTelemetrySseStreamSample = {};

/**
 * A legal `policyDecision` sample with the optional `outcome` populated.
 *
 * `posture`/`outcome` are still plain `string` on the port, so any value
 * would typecheck — these use the SHIPPED vocabulary
 * (`M3LTelemetryPolicyDecisionSample.posture`: `"confirmation"` |
 * `"admission"`; `outcome`: `"allow"` | `"deny"` | `"accept"` | `"queue"` |
 * `"reject"`, all emitted by `src/runs/admission.ts`) rather than an
 * invented posture, so a fixture read here can be copied into a new call
 * site without carrying a value the port's own doc forbids.
 */
const POLICY_DECISION_SAMPLE_FULL: M3LTelemetryPolicyDecisionSample = {
  posture: "confirmation",
  outcome: "deny",
};

/** A legal `policyDecision` sample with the optional `outcome` omitted entirely. */
const POLICY_DECISION_SAMPLE_MINIMAL: M3LTelemetryPolicyDecisionSample = {
  posture: "confirmation",
};

/** A legal `storeHealth` sample. */
const STORE_HEALTH_SAMPLE: M3LTelemetryStoreHealthSample = {
  sizeBytes: 4_096,
};

describe("createNoOpTelemetryRecorder", () => {
  test("is total: exposes all five M3LTelemetryRecorder methods", () => {
    const recorder: M3LTelemetryRecorder = createNoOpTelemetryRecorder();

    expect(typeof recorder.httpRequest).toBe("function");
    expect(typeof recorder.runFinished).toBe("function");
    expect(typeof recorder.sseStream).toBe("function");
    expect(typeof recorder.policyDecision).toBe("function");
    expect(typeof recorder.storeHealth).toBe("function");
  });

  test("httpRequest returns undefined and does not throw", () => {
    const recorder = createNoOpTelemetryRecorder();

    expect(recorder.httpRequest(HTTP_REQUEST_SAMPLE)).toBeUndefined();
  });

  test.each([
    ["with operation", RUN_FINISHED_SAMPLE_FULL],
    ["with operation omitted", RUN_FINISHED_SAMPLE_MINIMAL],
  ])(
    "runFinished returns undefined and does not throw (%s)",
    (_label: string, sample: M3LTelemetryRunFinishedSample) => {
      const recorder = createNoOpTelemetryRecorder();

      expect(recorder.runFinished(sample)).toBeUndefined();
    },
  );

  test.each([
    ["with outcome", SSE_STREAM_SAMPLE_FULL],
    ["with outcome omitted", SSE_STREAM_SAMPLE_MINIMAL],
  ])(
    "sseStream returns undefined and does not throw (%s)",
    (_label: string, sample: M3LTelemetrySseStreamSample) => {
      const recorder = createNoOpTelemetryRecorder();

      expect(recorder.sseStream(sample)).toBeUndefined();
    },
  );

  test.each([
    ["with outcome", POLICY_DECISION_SAMPLE_FULL],
    ["with outcome omitted", POLICY_DECISION_SAMPLE_MINIMAL],
  ])(
    "policyDecision returns undefined and does not throw (%s)",
    (_label: string, sample: M3LTelemetryPolicyDecisionSample) => {
      const recorder = createNoOpTelemetryRecorder();

      expect(recorder.policyDecision(sample)).toBeUndefined();
    },
  );

  test("storeHealth returns undefined and does not throw", () => {
    const recorder = createNoOpTelemetryRecorder();

    expect(recorder.storeHealth(STORE_HEALTH_SAMPLE)).toBeUndefined();
  });

  test("each factory call returns an independent recorder (no shared mutable state to trip up)", () => {
    const first = createNoOpTelemetryRecorder();
    const second = createNoOpTelemetryRecorder();

    expect(first.httpRequest(HTTP_REQUEST_SAMPLE)).toBeUndefined();
    expect(second.httpRequest(HTTP_REQUEST_SAMPLE)).toBeUndefined();
  });
});
