/**
 * Tests for src/run/envelope.ts — the `m3l run <script> --json` allowlisted-
 * scalar result envelope (V2 slice 2, ADR-0063 / #539).
 *
 * The module under test is pure: no I/O, no `process` access. These tests
 * assemble `M3LCliRunEnvelopeInput` fixtures directly and assert the
 * envelope-building and serialization contract.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { buildRunEnvelope, formatRunEnvelope } from "../src/run/envelope.js";
import type {
  M3LCliExitCodeName,
  M3LCliRunEnvelope,
  M3LCliRunEnvelopeInput,
  M3LCliRunOutcome,
  M3LCliRunReportLookup,
  M3LCliRunReportSummary,
  M3LCliRunReportUnavailableReason,
} from "../src/run/envelope.js";

/** The full, ordered set of documented envelope keys. */
const ENVELOPE_KEYS = [
  "kind",
  "schemaVersion",
  "script",
  "startedAt",
  "finishedAt",
  "durationMs",
  "exitCode",
  "exitCodeName",
  "outcome",
  "reportPath",
  "reportUnavailable",
  "timelineCount",
  "timelineSourceCount",
  "recoveryTotal",
] as const;

/** The exhaustive set of unavailability reasons the contract declares. */
const UNAVAILABLE_REASONS = [
  "output-directory-missing",
  "output-directory-unreadable",
  "no-matching-report",
  "report-unreadable",
  "report-malformed",
] as const satisfies readonly M3LCliRunReportUnavailableReason[];

/** Builds the expected `exitCodeName` from the registry itself — never hand-duplicated. */
function expectedExitCodeName(code: number): M3LCliExitCodeName | null {
  const entry = Object.entries(Core.M3L_EXIT_CODES).find(
    ([, value]) => value === code,
  );
  return (entry?.[0] as M3LCliExitCodeName | undefined) ?? null;
}

const STARTED_AT = new Date("2026-08-20T10:00:00.000Z");
const FINISHED_AT = new Date("2026-08-20T10:00:05.500Z");

function baseInput(
  overrides: Partial<M3LCliRunEnvelopeInput> = {},
): M3LCliRunEnvelopeInput {
  return {
    scriptName: "export-users",
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    exitCode: 0,
    lookup: { status: "unavailable", reason: "no-matching-report" },
    ...overrides,
  };
}

const foundSummary: M3LCliRunReportSummary = {
  outcome: "success",
  timelineCount: 42,
  timelineSourceCount: 3,
  recoveryTotal: null,
};

const foundLookup: M3LCliRunReportLookup = {
  status: "found",
  reportPath: "/data/output/2026-08-20T10-00-00.000Z/run-report.json",
  summary: foundSummary,
};

const partialSummary: M3LCliRunReportSummary = {
  outcome: "partial",
  timelineCount: 100,
  timelineSourceCount: 2,
  recoveryTotal: 7,
};

const partialLookup: M3LCliRunReportLookup = {
  status: "found",
  reportPath: "/data/output/2026-08-20T10-05-00.000Z/run-report.json",
  summary: partialSummary,
};

describe("buildRunEnvelope — literal fields", () => {
  test("kind is always the literal 'm3l.run.result'", () => {
    const envelope = buildRunEnvelope(baseInput());

    expect(envelope.kind).toBe("m3l.run.result");
  });

  test("schemaVersion is always the literal 1", () => {
    const envelope = buildRunEnvelope(baseInput());

    expect(envelope.schemaVersion).toBe(1);
  });

  test("script carries input.scriptName verbatim", () => {
    const envelope = buildRunEnvelope(
      baseInput({ scriptName: "reconcile-inventory" }),
    );

    expect(envelope.script).toBe("reconcile-inventory");
  });
});

describe("buildRunEnvelope — parent-observed timing, never derived from the lookup", () => {
  test("startedAt/finishedAt are ISO-8601 strings of input.startedAt/finishedAt", () => {
    const envelope = buildRunEnvelope(baseInput({ lookup: foundLookup }));

    expect(envelope.startedAt).toBe(STARTED_AT.toISOString());
    expect(envelope.finishedAt).toBe(FINISHED_AT.toISOString());
  });

  test("durationMs is finishedAt - startedAt in whole ms", () => {
    const envelope = buildRunEnvelope(baseInput());

    expect(envelope.durationMs).toBe(
      FINISHED_AT.getTime() - STARTED_AT.getTime(),
    );
  });

  test("durationMs still computes the raw difference when finishedAt precedes startedAt", () => {
    const inverted = baseInput({
      startedAt: FINISHED_AT,
      finishedAt: STARTED_AT,
    });

    const envelope = buildRunEnvelope(inverted);

    expect(envelope.durationMs).toBe(
      STARTED_AT.getTime() - FINISHED_AT.getTime(),
    );
  });

  test("a hostile lookup smuggling its own startedAt/finishedAt fields is ignored — timing always comes from input", () => {
    const hostileLookup = {
      status: "found",
      reportPath: "/x/run-report.json",
      summary: foundSummary,
      startedAt: "2000-01-01T00:00:00.000Z",
      finishedAt: "2000-01-01T00:00:00.000Z",
    } as unknown as M3LCliRunReportLookup;

    const envelope = buildRunEnvelope(baseInput({ lookup: hostileLookup }));

    expect(envelope.startedAt).toBe(STARTED_AT.toISOString());
    expect(envelope.finishedAt).toBe(FINISHED_AT.toISOString());
  });
});

describe("buildRunEnvelope — lookup.status === 'found'", () => {
  test("reportPath and every summary scalar flow straight into the matching envelope fields", () => {
    const envelope = buildRunEnvelope(baseInput({ lookup: foundLookup }));

    expect(envelope.reportPath).toBe(foundLookup.reportPath);
    expect(envelope.outcome).toBe(foundSummary.outcome);
    expect(envelope.timelineCount).toBe(foundSummary.timelineCount);
    expect(envelope.timelineSourceCount).toBe(foundSummary.timelineSourceCount);
    expect(envelope.recoveryTotal).toBe(foundSummary.recoveryTotal);
    expect(envelope.reportUnavailable).toBeNull();
  });

  test("recoveryTotal passes through as a number for a 'partial' outcome", () => {
    const envelope = buildRunEnvelope(baseInput({ lookup: partialLookup }));

    expect(envelope.outcome).toBe("partial");
    expect(envelope.recoveryTotal).toBe(7);
    expect(envelope.reportUnavailable).toBeNull();
  });

  test("a minimal summary with every scalar null passes through untouched (no fabrication)", () => {
    const minimalLookup: M3LCliRunReportLookup = {
      status: "found",
      reportPath: "/data/output/2026-08-20T10-10-00.000Z/run-report.json",
      summary: {
        outcome: null,
        timelineCount: null,
        timelineSourceCount: null,
        recoveryTotal: null,
      },
    };

    const envelope = buildRunEnvelope(baseInput({ lookup: minimalLookup }));

    expect(envelope.reportPath).toBe(minimalLookup.reportPath);
    expect(envelope.outcome).toBeNull();
    expect(envelope.timelineCount).toBeNull();
    expect(envelope.timelineSourceCount).toBeNull();
    expect(envelope.recoveryTotal).toBeNull();
    expect(envelope.reportUnavailable).toBeNull();
  });

  test("an outcome value outside the five recognized literals is surfaced as null, not passed through", () => {
    const hostileOutcomeLookup = {
      status: "found",
      reportPath: "/x/run-report.json",
      summary: {
        outcome: "unknown-outcome",
        timelineCount: 1,
        timelineSourceCount: 1,
        recoveryTotal: null,
      },
    } as unknown as M3LCliRunReportLookup;

    const envelope = buildRunEnvelope(
      baseInput({ lookup: hostileOutcomeLookup }),
    );

    expect(envelope.outcome).toBeNull();
  });

  test("does not throw when a 'found' lookup's summary is missing expected keys", () => {
    const hostileFoundLookup = {
      status: "found",
      reportPath: "/x/run-report.json",
      summary: { outcome: "success" },
    } as unknown as M3LCliRunReportLookup;

    expect(() =>
      buildRunEnvelope(baseInput({ lookup: hostileFoundLookup })),
    ).not.toThrow();
  });

  test("does not throw when a 'found' lookup's summary property is a throwing getter — every summary-derived field degrades to null", () => {
    const hostileLookup: Record<string, unknown> = {
      status: "found",
      reportPath: "/some/path",
    };
    Object.defineProperty(hostileLookup, "summary", {
      get() {
        throw new Error("hostile getter");
      },
      enumerable: true,
    });

    const envelope = buildRunEnvelope(
      baseInput({ lookup: hostileLookup as unknown as M3LCliRunReportLookup }),
    );

    expect(envelope.outcome).toBeNull();
    expect(envelope.timelineCount).toBeNull();
    expect(envelope.timelineSourceCount).toBeNull();
    expect(envelope.recoveryTotal).toBeNull();
  });

  test("does not throw when summary.outcome is a throwing getter — the guard is per-field, sibling scalars still come through", () => {
    const hostileSummary: Record<string, unknown> = {
      timelineCount: 5,
      timelineSourceCount: 2,
      recoveryTotal: null,
    };
    Object.defineProperty(hostileSummary, "outcome", {
      get() {
        throw new Error("hostile getter");
      },
      enumerable: true,
    });
    const lookup = {
      status: "found",
      reportPath: "/x/run-report.json",
      summary: hostileSummary,
    } as unknown as M3LCliRunReportLookup;

    const envelope = buildRunEnvelope(baseInput({ lookup }));

    expect(envelope.outcome).toBeNull();
    expect(envelope.timelineCount).toBe(5);
    expect(envelope.timelineSourceCount).toBe(2);
  });

  test("does not throw when summary.timelineCount is a throwing getter — that field alone degrades to null", () => {
    const hostileSummary: Record<string, unknown> = {
      outcome: "success",
      timelineSourceCount: 3,
      recoveryTotal: null,
    };
    Object.defineProperty(hostileSummary, "timelineCount", {
      get() {
        throw new Error("hostile getter");
      },
      enumerable: true,
    });
    const lookup = {
      status: "found",
      reportPath: "/x/run-report.json",
      summary: hostileSummary,
    } as unknown as M3LCliRunReportLookup;

    const envelope = buildRunEnvelope(baseInput({ lookup }));

    expect(envelope.timelineCount).toBeNull();
    expect(envelope.outcome).toBe("success");
    expect(envelope.timelineSourceCount).toBe(3);
  });
});

describe("buildRunEnvelope — lookup.status === 'unavailable'", () => {
  test.each(UNAVAILABLE_REASONS)(
    "reason '%s' is surfaced verbatim as reportUnavailable, with every report-derived field null",
    (reason) => {
      const envelope = buildRunEnvelope(
        baseInput({ lookup: { status: "unavailable", reason } }),
      );

      expect(envelope.reportUnavailable).toBe(reason);
      expect(envelope.reportPath).toBeNull();
      expect(envelope.outcome).toBeNull();
      expect(envelope.timelineCount).toBeNull();
      expect(envelope.timelineSourceCount).toBeNull();
      expect(envelope.recoveryTotal).toBeNull();
    },
  );

  test("smuggled report-shaped data on a hostile unavailable lookup never leaks into the envelope", () => {
    const hostileUnavailableLookup = {
      status: "unavailable",
      reason: "report-malformed",
      reportPath: "/should/not/leak/run-report.json",
      summary: {
        outcome: "success",
        timelineCount: 999,
        timelineSourceCount: 999,
        recoveryTotal: 999,
      },
    } as unknown as M3LCliRunReportLookup;

    const envelope = buildRunEnvelope(
      baseInput({ lookup: hostileUnavailableLookup }),
    );

    expect(envelope.reportUnavailable).toBe("report-malformed");
    expect(envelope.reportPath).toBeNull();
    expect(envelope.outcome).toBeNull();
    expect(envelope.timelineCount).toBeNull();
    expect(envelope.timelineSourceCount).toBeNull();
    expect(envelope.recoveryTotal).toBeNull();
  });

  test("does not throw for an unavailable lookup missing the reason field", () => {
    const hostileUnavailableLookup = {
      status: "unavailable",
    } as unknown as M3LCliRunReportLookup;

    expect(() =>
      buildRunEnvelope(baseInput({ lookup: hostileUnavailableLookup })),
    ).not.toThrow();
  });

  test("does not throw for an unavailable lookup whose reason is a throwing getter — reportUnavailable degrades to null", () => {
    const hostileUnavailableLookup: Record<string, unknown> = {
      status: "unavailable",
    };
    Object.defineProperty(hostileUnavailableLookup, "reason", {
      get() {
        throw new Error("hostile getter");
      },
      enumerable: true,
    });

    const envelope = buildRunEnvelope(
      baseInput({
        lookup: hostileUnavailableLookup as unknown as M3LCliRunReportLookup,
      }),
    );

    expect(envelope.reportUnavailable).toBeNull();
  });
});

describe("buildRunEnvelope — exitCodeName reverse lookup", () => {
  test.each([0, 1, 2, 3, 4, 5, 6])(
    "exit code %i maps to its ADR-0035 registry name",
    (code) => {
      const envelope = buildRunEnvelope(baseInput({ exitCode: code }));

      expect(envelope.exitCode).toBe(code);
      expect(envelope.exitCodeName).toBe(expectedExitCodeName(code));
      expect(envelope.exitCodeName).not.toBeNull();
    },
  );

  test.each([143, 255, -1])(
    "exit code %i, outside the registry, maps to exitCodeName null",
    (code) => {
      const envelope = buildRunEnvelope(baseInput({ exitCode: code }));

      expect(envelope.exitCode).toBe(code);
      expect(envelope.exitCodeName).toBeNull();
    },
  );
});

describe("formatRunEnvelope", () => {
  test("returns a single line with no embedded or trailing newline", () => {
    const envelope = buildRunEnvelope(baseInput({ lookup: foundLookup }));

    const text = formatRunEnvelope(envelope);

    expect(text).not.toContain("\n");
    expect(text.endsWith("\n")).toBe(false);
  });

  test("round-trips a 'found' envelope through JSON without dropping or altering any field", () => {
    const envelope = buildRunEnvelope(baseInput({ lookup: foundLookup }));

    const parsed: unknown = JSON.parse(formatRunEnvelope(envelope));

    expect(parsed).toEqual(envelope);
  });

  test("round-trips an 'unavailable' envelope, preserving explicit nulls (JSON.parse would not restore a dropped undefined)", () => {
    const envelope = buildRunEnvelope(baseInput());

    const text = formatRunEnvelope(envelope);
    const parsed: unknown = JSON.parse(text);

    expect(parsed).toEqual(envelope);
    expect(text).toContain('"reportPath":null');
    expect(text).toContain('"outcome":null');
    expect(text).toContain('"reportUnavailable":"no-matching-report"');
    expect(text).toContain('"timelineCount":null');
    expect(text).toContain('"timelineSourceCount":null');
    expect(text).toContain('"recoveryTotal":null');
  });

  test("every documented key is present in the serialized text for a 'found' envelope", () => {
    const envelope = buildRunEnvelope(baseInput({ lookup: foundLookup }));

    const parsed = JSON.parse(formatRunEnvelope(envelope)) as Record<
      string,
      unknown
    >;

    expect(Object.keys(parsed).sort()).toEqual(
      [...ENVELOPE_KEYS].sort((a, b) => a.localeCompare(b)),
    );
    expect(parsed["reportUnavailable"]).toBeNull();
  });

  test("every documented key is present in the serialized text for an 'unavailable' envelope", () => {
    const envelope = buildRunEnvelope(baseInput());

    const parsed = JSON.parse(formatRunEnvelope(envelope)) as Record<
      string,
      unknown
    >;

    expect(Object.keys(parsed).sort()).toEqual(
      [...ENVELOPE_KEYS].sort((a, b) => a.localeCompare(b)),
    );
    expect(parsed["reportPath"]).toBeNull();
  });
});

describe("type contract — M3LCliExitCodeName", () => {
  test("equals keyof typeof Core.M3L_EXIT_CODES", () => {
    expectTypeOf<M3LCliExitCodeName>().toEqualTypeOf<
      keyof typeof Core.M3L_EXIT_CODES
    >();
  });
});

describe("type contract — M3LCliRunOutcome", () => {
  test("every literal of Core.M3LRunOutcome is assignable into this module's five-member union", () => {
    expectTypeOf<Core.M3LRunOutcome>().toMatchTypeOf<M3LCliRunOutcome>();
  });

  test("is exactly the five documented outcome literals", () => {
    expectTypeOf<M3LCliRunOutcome>().toEqualTypeOf<
      "success" | "failure" | "dry-run" | "interrupted" | "partial"
    >();
  });
});

describe("type contract — M3LCliRunReportSummary allowlist", () => {
  test("outcome is a closed union or null, never a bare string", () => {
    expectTypeOf<
      M3LCliRunReportSummary["outcome"]
    >().toEqualTypeOf<M3LCliRunOutcome | null>();
  });

  test("timelineCount is number or null, never a bare string", () => {
    expectTypeOf<M3LCliRunReportSummary["timelineCount"]>().toEqualTypeOf<
      number | null
    >();
  });

  test("timelineSourceCount is number or null, never a bare string", () => {
    expectTypeOf<M3LCliRunReportSummary["timelineSourceCount"]>().toEqualTypeOf<
      number | null
    >();
  });

  test("recoveryTotal is number or null, never a bare string", () => {
    expectTypeOf<M3LCliRunReportSummary["recoveryTotal"]>().toEqualTypeOf<
      number | null
    >();
  });
});

describe("type contract — envelope literals", () => {
  test("kind is the literal type 'm3l.run.result'", () => {
    expectTypeOf<M3LCliRunEnvelope["kind"]>().toEqualTypeOf<"m3l.run.result">();
  });

  test("schemaVersion is the literal type 1", () => {
    expectTypeOf<M3LCliRunEnvelope["schemaVersion"]>().toEqualTypeOf<1>();
  });
});
