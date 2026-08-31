import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type {
  AgentOperatorDoctorCheck,
  AgentOperatorExitCodeName,
  AgentOperatorListRow,
  AgentOperatorParamDescriptor,
  AgentOperatorRunEnvelope,
  EnvelopeParseFailure,
  ParseResult,
} from "../../src/lib/cli-envelopes.js";
import {
  parseDoctorChecks,
  parseJsonText,
  parseListRows,
  parseParamDescriptors,
  parseRunEnvelope,
} from "../../src/lib/cli-envelopes.js";

/**
 * Contract: PR 1 spec `src/lib/cli-envelopes.ts`. Parse functions (not type
 * predicates) that return a fresh, frozen literal rather than the parsed
 * input — never re-reading attacker-controlled memory. Function names
 * (`parseListRows`, `parseDoctorChecks`, `parseParamDescriptors`) are this
 * test-author's inference from the contract's stated array-parser shapes
 * (doctor/list/inspect) and the local mirror-type names it DOES pin
 * (`AgentOperatorListRow`, `AgentOperatorDoctorCheck`,
 * `AgentOperatorParamDescriptor`, `AgentOperatorRunEnvelope`); the contract
 * only pins `parseRunEnvelope` and `parseJsonText` by name. Flagged as an
 * ambiguity for the hub/code-implementer to confirm or correct.
 */

function validListRow(overrides: Partial<AgentOperatorListRow> = {}) {
  return {
    name: "json-etl",
    description: "Transforms JSON records.",
    parameterCount: 3,
    loadError: null,
    ...overrides,
  };
}

function validRunEnvelope(
  overrides: Partial<AgentOperatorRunEnvelope> = {},
): AgentOperatorRunEnvelope {
  return {
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
    ...overrides,
  };
}

describe("parseJsonText", () => {
  it("parses well-formed JSON text", () => {
    const result = parseJsonText('{"a":1}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("returns { ok: false, reason: 'not-json' } for malformed JSON, never echoing the input", () => {
    const malformed = '{"a": SECRET_MARKER_UNPARSEABLE';
    const result = parseJsonText(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-json");
    }
    // F10/W5: never read SyntaxError.message (which embeds an input
    // snippet) nor chain it as `cause` — assert no trace of the input
    // survives anywhere in the returned object.
    expect(JSON.stringify(result)).not.toContain("SECRET_MARKER_UNPARSEABLE");
  });
});

describe("array-cap enforcement (MAX_ENVELOPE_ROWS = 512)", () => {
  it("accepts exactly 512 rows", () => {
    const rows = Array.from({ length: 512 }, (_, i) =>
      validListRow({ name: `script-${i}` }),
    );
    const result = parseListRows(rows);
    expect(result.ok).toBe(true);
  });

  it("rejects 513 rows with 'too-many-rows'", () => {
    const rows = Array.from({ length: 513 }, (_, i) =>
      validListRow({ name: `script-${i}` }),
    );
    const result = parseListRows(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("too-many-rows");
    }
  });
});

describe("prototype-pollution safety", () => {
  it("rejects a __proto__-keyed row without polluting Object.prototype", () => {
    const payload: unknown = JSON.parse('[{"__proto__": {"polluted": true}}]');
    const result = parseListRows(payload);

    expect(result.ok).toBe(false);
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBe(
      undefined,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBe(undefined);
  });

  it("rejects a row with only inherited (non-own) properties", () => {
    const base = {
      name: "json-etl",
      description: "d",
      parameterCount: 1,
      loadError: null,
    };
    const inheritingRow: unknown = Object.create(base);
    const result = parseListRows([inheritingRow]);

    expect(result.ok).toBe(false);
  });
});

describe("throwing getter safety", () => {
  it("yields { ok: false } instead of throwing when a row property getter throws", () => {
    const throwingRow: unknown = {};
    Object.defineProperty(throwingRow, "name", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });

    let result: ParseResult<readonly AgentOperatorListRow[]> | undefined;
    expect(() => {
      result = parseListRows([throwingRow]);
    }).not.toThrow();

    expect(result?.ok).toBe(false);
  });
});

describe("numeric field validation", () => {
  it.each([NaN, Infinity, -Infinity])(
    "rejects listRow.parameterCount = %s as non-finite-number",
    (badNumber) => {
      const result = parseListRows([
        validListRow({ parameterCount: badNumber, loadError: null }),
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("non-finite-number");
      }
    },
  );

  it("rejects listRow.parameterCount as a string with field-wrong-type", () => {
    const row: unknown = validListRow({
      // Deliberately wrong runtime type (string, not number) to prove the
      // parser rejects it; double-cast through `unknown` avoids `any`.
      parameterCount: "5" as unknown as number,
      loadError: null,
    });
    const result = parseListRows([row]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("field-wrong-type");
    }
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects runEnvelope.exitCode = %s as non-finite-number",
    (badNumber) => {
      const result = parseRunEnvelope(
        validRunEnvelope({ exitCode: badNumber }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("non-finite-number");
      }
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "rejects runEnvelope.durationMs = %s as non-finite-number",
    (badNumber) => {
      const result = parseRunEnvelope(
        validRunEnvelope({ durationMs: badNumber }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("non-finite-number");
      }
    },
  );

  it("rejects runEnvelope.exitCode as a string with field-wrong-type", () => {
    const envelope: unknown = validRunEnvelope({
      // Deliberately wrong runtime type (string, not number) to prove the
      // parser rejects it; double-cast through `unknown` avoids `any`.
      exitCode: "5" as unknown as number,
    });
    const result = parseRunEnvelope(envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("field-wrong-type");
    }
  });
});

describe("parseRunEnvelope fail-closed behavior", () => {
  it("rejects schemaVersion: 2 with 'unsupported-schema-version'", () => {
    const result = parseRunEnvelope(
      validRunEnvelope({
        // Deliberately wrong schema version to prove fail-closed behavior;
        // double-cast through `unknown` avoids `any`.
        schemaVersion: 2 as unknown as 1,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unsupported-schema-version");
    }
  });

  it("rejects kind: 'nope' with 'wrong-kind'", () => {
    const result = parseRunEnvelope(
      validRunEnvelope({
        // Deliberately wrong kind to prove fail-closed behavior;
        // double-cast through `unknown` avoids `any`.
        kind: "nope" as unknown as "m3l.run.result",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong-kind");
    }
  });

  it("accepts a valid, fully-populated envelope", () => {
    const result = parseRunEnvelope(validRunEnvelope());
    expect(result.ok).toBe(true);
  });
});

describe("the three array parsers carry no schemaVersion field", () => {
  it("parseListRows accepts a bare valid array with no version field", () => {
    const result = parseListRows([validListRow()]);
    expect(result.ok).toBe(true);
  });

  it("parseDoctorChecks accepts a bare valid array with no version field", () => {
    const checks: AgentOperatorDoctorCheck[] = [
      { name: "workspace-root", status: "ok", detail: "fine" },
    ];
    const result = parseDoctorChecks(checks);
    expect(result.ok).toBe(true);
  });

  it("parseParamDescriptors accepts a bare valid array with no version field", () => {
    const descriptors: AgentOperatorParamDescriptor[] = [
      {
        name: "batchSize",
        aliases: [],
        type: "INT",
        required: false,
        defaultValue: "100",
        description: "batch size",
        secret: false,
        operations: [],
      },
    ];
    const result = parseParamDescriptors(descriptors);
    expect(result.ok).toBe(true);
  });
});

describe("fresh, frozen output", () => {
  it("returns a value unaffected by post-parse mutation of the input, and the value is frozen", () => {
    const input = validRunEnvelope();
    const result = parseRunEnvelope(input);
    expect(result.ok).toBe(true);

    // Mutate the raw input object after parsing to prove the parser copied
    // it; double-cast through `unknown` to a mutable view avoids `any`.
    (input as unknown as { script: string }).script = "mutated-after-parse";

    if (result.ok) {
      expect(result.value.script).toBe("json-etl");
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });
});

describe("exit-code name derivation", () => {
  it("Object.keys(Core.M3L_EXIT_CODES) is exactly the seven documented names", () => {
    expect(new Set(Object.keys(Core.M3L_EXIT_CODES))).toEqual(
      new Set([
        "SUCCESS",
        "UNCLASSIFIED",
        "CONFIG_USAGE",
        "EXTERNAL",
        "LIBRARY",
        "INTERRUPTED",
        "PARTIAL",
      ]),
    );
  });

  it("types AgentOperatorExitCodeName as exactly the seven documented literal names", () => {
    // Deliberately hand-retyped literal union (not derived from
    // `Core.M3L_EXIT_CODES`): a type-level assertion only guards anything if
    // it can disagree with the thing it checks. Asserting
    // `AgentOperatorExitCodeName` against `keyof typeof Core.M3L_EXIT_CODES`
    // (its own definition) would be a tautology — see the runtime check
    // above for the `Object.keys`-derived membership check.
    expectTypeOf<AgentOperatorExitCodeName>().toEqualTypeOf<
      | "SUCCESS"
      | "UNCLASSIFIED"
      | "CONFIG_USAGE"
      | "EXTERNAL"
      | "LIBRARY"
      | "INTERRUPTED"
      | "PARTIAL"
    >();
  });
});

describe("EnvelopeParseFailure / ParseResult discriminated union", () => {
  it("narrows ParseResult<T> to { ok: true; value: T } vs { ok: false; reason }", () => {
    expectTypeOf<ParseResult<number>>().toEqualTypeOf<
      | { readonly ok: true; readonly value: number }
      | { readonly ok: false; readonly reason: EnvelopeParseFailure }
    >();
  });
});
