import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type {
  AgentOperatorDoctorCheck,
  AgentOperatorExitCodeName,
  AgentOperatorFlowBranch,
  AgentOperatorFlowEnvelope,
  AgentOperatorFlowRunStatus,
  AgentOperatorFlowStepEnvelope,
  AgentOperatorListRow,
  AgentOperatorParamDescriptor,
  AgentOperatorRunEnvelope,
  EnvelopeParseFailure,
  ParseResult,
} from "../../src/lib/cli-envelopes.js";
import {
  parseDoctorChecks,
  parseFlowEnvelope,
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

function validFlowStepEnvelope(
  overrides: Partial<AgentOperatorFlowStepEnvelope> = {},
): AgentOperatorFlowStepEnvelope {
  return {
    stepId: "step-1",
    script: "json-etl",
    attempt: 1,
    branch: "continue",
    run: validRunEnvelope(),
    ...overrides,
  };
}

function validFlowEnvelope(
  overrides: Partial<AgentOperatorFlowEnvelope> = {},
): AgentOperatorFlowEnvelope {
  return {
    kind: "m3l.flow.result",
    schemaVersion: 1,
    flow: "sqs-roundtrip",
    runId: "run-abc123",
    definitionHash: "sha256:deadbeef",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:05.000Z",
    durationMs: 5000,
    // A member of the closed `AgentOperatorFlowRunStatus` union (the bare
    // `string` type this field used to carry accepted anything, including
    // the now-invalid "success"). No existing case in this file asserts on
    // `.status`, so this default is free to move without weakening any of
    // them.
    status: "completed",
    exitCode: 0,
    exitCodeName: "SUCCESS",
    dryRun: false,
    stepExecutionCount: 2,
    haltingStepId: null,
    resumeStepId: null,
    steps: [
      validFlowStepEnvelope({
        stepId: "step-1",
        attempt: 1,
        branch: { goto: "step-1" },
      }),
      validFlowStepEnvelope({
        stepId: "step-2",
        attempt: 1,
        branch: "stop",
        run: validRunEnvelope({ exitCode: 3, exitCodeName: "PARTIAL" }),
      }),
    ],
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

describe("parseFlowEnvelope", () => {
  it("accepts a valid, fully-populated envelope with two steps, round-tripping nested fields", () => {
    const result = parseFlowEnvelope(validFlowEnvelope());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.flow).toBe("sqs-roundtrip");
      expect(result.value.steps).toHaveLength(2);
      expect(result.value.steps[0]?.branch).toEqual({ goto: "step-1" });
      expect(result.value.steps[1]?.branch).toBe("stop");
      expect(result.value.steps[1]?.run.exitCode).toBe(3);
      expect(result.value.steps[1]?.run.kind).toBe("m3l.run.result");
    }
  });

  it("accepts an empty steps array (a flow refused before its first step)", () => {
    const result = parseFlowEnvelope(validFlowEnvelope({ steps: [] }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps).toEqual([]);
    }
  });

  it("rejects kind: 'nope' with the same reason parseRunEnvelope uses for a wrong kind", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
        // Deliberately wrong kind to prove fail-closed behavior;
        // double-cast through `unknown` avoids `any`.
        kind: "nope" as unknown as "m3l.flow.result",
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong-kind");
    }
  });

  it("rejects schemaVersion: 2 with the same reason parseRunEnvelope uses for a wrong schemaVersion", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
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

  it("rejects the WHOLE envelope when a nested step's run has a wrong kind, not just that step", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
        steps: [
          validFlowStepEnvelope({
            run: validRunEnvelope({
              // Deliberately wrong kind on the nested run to prove a
              // malformed step rejects the whole flow envelope.
              kind: "nope" as unknown as "m3l.run.result",
            }),
          }),
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong-kind");
    }
  });

  it("rejects the WHOLE envelope when a nested step's run is missing a required field, not just that step", () => {
    const runWithoutScript = validRunEnvelope() as unknown as Record<
      string,
      unknown
    >;
    delete runWithoutScript["script"];

    const result = parseFlowEnvelope(
      validFlowEnvelope({
        steps: [
          validFlowStepEnvelope({
            run: runWithoutScript as unknown as AgentOperatorRunEnvelope,
          }),
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-field");
    }
  });

  // `branch` is the subtlest of these four: `parseFlowBranch` first tries
  // `readNullableLiteral`, whose nullable-passthrough only short-circuits on
  // an OWN `branch` key holding `null` — an absent key instead falls
  // through that helper's own `requireOwn` check (which also reports
  // `"missing-field"`) into `parseFlowBranch`'s second, explicit
  // `requireOwn(raw, "branch")` call. Both paths report the same reason,
  // but only actually deleting the key exercises the fallthrough at all.
  it.each(["stepId", "script", "attempt", "branch"] as const)(
    "rejects a step missing %s",
    (field) => {
      const step = validFlowStepEnvelope() as unknown as Record<
        string,
        unknown
      >;
      delete step[field];

      const result = parseFlowEnvelope(
        validFlowEnvelope({
          steps: [step as unknown as AgentOperatorFlowStepEnvelope],
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("missing-field");
      }
    },
  );

  it.each(["continue", "stop"] as const)(
    "accepts the branch literal %s",
    (branch) => {
      const result = parseFlowEnvelope(
        validFlowEnvelope({ steps: [validFlowStepEnvelope({ branch })] }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.steps[0]?.branch).toBe(branch);
      }
    },
  );

  it("accepts a valid { goto } branch object", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
        steps: [validFlowStepEnvelope({ branch: { goto: "step-2" } })],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps[0]?.branch).toEqual({ goto: "step-2" });
    }
  });

  it("rejects an unknown branch literal ('maybe')", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
        steps: [
          validFlowStepEnvelope({
            // Deliberately outside the closed branch union;
            // double-cast through `unknown` avoids `any`.
            branch: "maybe" as unknown as AgentOperatorFlowBranch,
          }),
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("field-wrong-type");
    }
  });

  it("rejects a branch object without a goto field", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
        steps: [
          validFlowStepEnvelope({
            // Deliberately missing the `goto` key;
            // double-cast through `unknown` avoids `any`.
            branch: {} as unknown as AgentOperatorFlowBranch,
          }),
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("field-wrong-type");
    }
  });

  it("rejects steps that is not an array", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
        // Deliberately wrong runtime type (string, not array) to prove the
        // parser rejects it; double-cast through `unknown` avoids `any`.
        steps: "nope" as unknown as readonly AgentOperatorFlowStepEnvelope[],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-an-array");
    }
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects flowEnvelope.durationMs = %s as non-finite-number",
    (badNumber) => {
      const result = parseFlowEnvelope(
        validFlowEnvelope({ durationMs: badNumber }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("non-finite-number");
      }
    },
  );

  it("types AgentOperatorFlowBranch as the closed union of continue/stop/{ goto }", () => {
    expectTypeOf<AgentOperatorFlowBranch>().toEqualTypeOf<
      "continue" | "stop" | { readonly goto: string }
    >();
  });

  // `AgentOperatorFlowEnvelope.status` mirrors `M3LCliFlowRunStatus`
  // (`packages/m3l-cli/src/flow/types.ts`) exactly — verified against that
  // file rather than assumed. The four rows below are the complete closed
  // set; anything outside it must fail closed.
  const VALID_FLOW_RUN_STATUSES = [
    "completed",
    "stopped",
    "failed",
    "loop-guard-exceeded",
  ] as const;

  it.each(VALID_FLOW_RUN_STATUSES)("accepts status %s", (status) => {
    const result = parseFlowEnvelope(validFlowEnvelope({ status }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(status);
    }
  });

  it("rejects an out-of-set status ('finished') with the same reason parseDoctorCheck uses for an unrecognised status", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
        // Deliberately outside the closed AgentOperatorFlowRunStatus union;
        // double-cast through `unknown` avoids `any`.
        status: "finished" as unknown as AgentOperatorFlowRunStatus,
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown-status");
    }
  });

  it("rejects a non-string status", () => {
    const result = parseFlowEnvelope(
      validFlowEnvelope({
        // Deliberately wrong runtime type (number, not string);
        // double-cast through `unknown` avoids `any`.
        status: 42 as unknown as AgentOperatorFlowRunStatus,
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("field-wrong-type");
    }
  });
});
