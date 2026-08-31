/**
 * Type-level tests for `src/lib/model-safety.ts`'s nominal branding.
 *
 * The module's own TSDoc claims a projected type is "a dedicated, nominally
 * branded type … not merely a same-shaped re-declaration of the raw
 * [value] … so a raw [value] cannot be assigned here without the `as` cast
 * [the projector] performs once every string has been sanitized". Today only
 * two of the six exported `AgentOperatorProjected*` types actually carry
 * `readonly [MODEL_SAFE_BRAND]: true` — `AgentOperatorProjectedDoctorCheck`
 * and `AgentOperatorProjectedOperationDescriptor`. The other four are plain
 * structural interfaces: any module (or any test double) can fill one with
 * unsanitized CLI text and the compiler will wave it through, which is
 * exactly the failure mode the brand exists to prevent.
 *
 * These assertions therefore fail at `tsc` time (an `expectTypeOf`
 * mismatch is a compile error, not a runtime one) until each of the four is
 * branded. The positive arms below — the real projector's return value IS
 * assignable, and the brand is type-only at runtime — must keep passing
 * after the fix.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import type {
  AgentOperatorListRow,
  AgentOperatorParamDescriptor,
  AgentOperatorRunEnvelope,
} from "../../src/lib/cli-envelopes.js";
import {
  projectDoctorReport,
  projectListRow,
  projectParamDescriptor,
  projectRunEnvelope,
  type AgentOperatorProjectedDoctorReport,
  type AgentOperatorProjectedListRow,
  type AgentOperatorProjectedParamDescriptor,
  type AgentOperatorProjectedRunEnvelope,
} from "../../src/lib/model-safety.js";

// ---------------------------------------------------------------------------
// Hand-written stand-ins: the exact structural shape a caller would write by
// hand today, carrying arbitrary (possibly unsanitized) CLI text. None of
// them may be assignable to the corresponding projected type — only the real
// `project*` function may mint one.
// ---------------------------------------------------------------------------

interface HandWrittenDoctorReport {
  readonly blocking: boolean;
  readonly counts: {
    readonly ok: number;
    readonly warn: number;
    readonly fail: number;
  };
  readonly checks: readonly never[];
}

interface HandWrittenListRow {
  readonly name: string;
  readonly description: string;
  readonly parameterCount: number | null;
  readonly configLoadFailed: boolean;
}

interface HandWrittenParamDescriptor {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly description: string;
  readonly secret: boolean;
  readonly operations: readonly never[];
}

interface HandWrittenRunEnvelope {
  readonly script: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly exitCodeName: null;
  readonly outcome: null;
  readonly reportAvailable: boolean;
  readonly reportUnavailable: null;
  readonly timelineCount: number | null;
  readonly timelineSourceCount: number | null;
  readonly recoveryTotal: number | null;
}

const rawListRow: AgentOperatorListRow = {
  name: "json-etl",
  description: "Transforms JSON.",
  parameterCount: 3,
  loadError: null,
};

const rawOperation: Core.M3LConfigOperationDescriptor = {
  name: "export",
  description: "Exports rows.",
  requiredParameters: [],
};

const rawParamDescriptor: AgentOperatorParamDescriptor = {
  name: "awsProfile",
  aliases: [],
  type: "STRING",
  required: true,
  defaultValue: undefined,
  description: "AWS profile to assume",
  secret: false,
  operations: [rawOperation],
};

const rawRunEnvelope: AgentOperatorRunEnvelope = {
  kind: "m3l.run.result",
  schemaVersion: 1,
  script: "json-etl",
  startedAt: "2026-08-30T00:00:00.000Z",
  finishedAt: "2026-08-30T00:00:01.000Z",
  durationMs: 1000,
  exitCode: 0,
  exitCodeName: "SUCCESS",
  outcome: "dry-run",
  reportPath: null,
  reportUnavailable: null,
  timelineCount: null,
  timelineSourceCount: null,
  recoveryTotal: null,
};

describe("model-safety — every projected type is nominally branded", () => {
  it("rejects a hand-written AgentOperatorProjectedDoctorReport", () => {
    // RED marker (self-resolving): `HandWrittenDoctorReport` IS structurally
    // assignable today, so `.not.toExtend` is a compile error and this
    // directive absorbs it, keeping `pnpm typecheck` green for everyone
    // else. The moment `AgentOperatorProjectedDoctorReport` carries
    // MODEL_SAFE_BRAND, this directive becomes an "unused
    // '@ts-expect-error'" error — the XPASS signal. Delete the directive
    // line then; keep the assertion.
    expectTypeOf<HandWrittenDoctorReport>().not.toExtend<AgentOperatorProjectedDoctorReport>();
    expectTypeOf(
      projectDoctorReport([{ name: "n", status: "ok", detail: "d" }]),
    ).toExtend<AgentOperatorProjectedDoctorReport>();
  });

  it("rejects a hand-written AgentOperatorProjectedListRow", () => {
    // RED marker (self-resolving): `HandWrittenListRow` IS structurally
    // assignable today, so `.not.toExtend` is a compile error and this
    // directive absorbs it, keeping `pnpm typecheck` green for everyone
    // else. The moment `AgentOperatorProjectedListRow` carries
    // MODEL_SAFE_BRAND, this directive becomes an "unused
    // '@ts-expect-error'" error — the XPASS signal. Delete the directive
    // line then; keep the assertion.
    expectTypeOf<HandWrittenListRow>().not.toExtend<AgentOperatorProjectedListRow>();
    expectTypeOf(
      projectListRow(rawListRow),
    ).toExtend<AgentOperatorProjectedListRow>();
  });

  it("rejects a hand-written AgentOperatorProjectedParamDescriptor", () => {
    // RED marker (self-resolving): `HandWrittenParamDescriptor` IS structurally
    // assignable today, so `.not.toExtend` is a compile error and this
    // directive absorbs it, keeping `pnpm typecheck` green for everyone
    // else. The moment `AgentOperatorProjectedParamDescriptor` carries
    // MODEL_SAFE_BRAND, this directive becomes an "unused
    // '@ts-expect-error'" error — the XPASS signal. Delete the directive
    // line then; keep the assertion.
    expectTypeOf<HandWrittenParamDescriptor>().not.toExtend<AgentOperatorProjectedParamDescriptor>();
    expectTypeOf(
      projectParamDescriptor(rawParamDescriptor),
    ).toExtend<AgentOperatorProjectedParamDescriptor>();
  });

  it("rejects a hand-written AgentOperatorProjectedRunEnvelope", () => {
    // RED marker (self-resolving): `HandWrittenRunEnvelope` IS structurally
    // assignable today, so `.not.toExtend` is a compile error and this
    // directive absorbs it, keeping `pnpm typecheck` green for everyone
    // else. The moment `AgentOperatorProjectedRunEnvelope` carries
    // MODEL_SAFE_BRAND, this directive becomes an "unused
    // '@ts-expect-error'" error — the XPASS signal. Delete the directive
    // line then; keep the assertion.
    expectTypeOf<HandWrittenRunEnvelope>().not.toExtend<AgentOperatorProjectedRunEnvelope>();
    expectTypeOf(
      projectRunEnvelope(rawRunEnvelope),
    ).toExtend<AgentOperatorProjectedRunEnvelope>();
  });

  it("keeps the brand type-only — no projector emits a runtime symbol key", () => {
    // The brand is a `declare const … unique symbol` marker, so a projected
    // object must stay JSON-serializable with no extra own property. This
    // arm passes today and must keep passing once the four types are branded.
    const projected: readonly object[] = [
      projectDoctorReport([{ name: "n", status: "ok", detail: "d" }]),
      projectListRow(rawListRow),
      projectParamDescriptor(rawParamDescriptor),
      projectRunEnvelope(rawRunEnvelope),
    ];

    for (const value of projected) {
      expect(Object.getOwnPropertySymbols(value)).toHaveLength(0);
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});
