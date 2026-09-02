/**
 * Tests for src/flow/validate.ts and src/flow/types.ts — the pure boundary
 * validation of a `m3l flow` definition (U10 slice 3, stage A).
 *
 * `validateFlowDefinition` is deliberately I/O-free: everything it needs to
 * check `script` and `parameters` arrives as injected data on its `context`
 * argument, so every rule below is exercised as a plain function call with no
 * filesystem, no discovery, and no mocks.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import { exitCodeForError, M3LCliError } from "../src/cli/errors.js";
import {
  DEFAULT_MAX_STEP_EXECUTIONS,
  FLOW_NAME_RE,
  FLOW_STEP_ID_RE,
} from "../src/flow/types.js";
import type {
  M3LCliFlowBranch,
  M3LCliFlowDefinition,
  M3LCliFlowExecution,
  M3LCliFlowStep,
} from "../src/flow/types.js";
import { validateFlowDefinition } from "../src/flow/validate.js";
import type {
  M3LCliFlowValidationContext,
  M3LCliFlowValidationParameter,
} from "../src/flow/validate.js";

/** A raw, unvalidated YAML-shaped record as it reaches the validator. */
type RawRecord = Record<string, unknown>;

/**
 * Builds a script's declared-parameter facts from names that are all
 * NON-secret.
 *
 * The context carries `{ name, secret }` pairs rather than bare names, which
 * is what makes the ADR-0085 screen unconditional: a caller physically cannot
 * hand the validator a parameter name without stating whether it is secret,
 * so the guard can never be silently skipped by an under-populated context.
 */
function declared(
  ...names: readonly string[]
): readonly M3LCliFlowValidationParameter[] {
  return names.map((name) => ({ name, secret: false }));
}

/** One declared parameter the script flagged `secret: true` (ADR-0085). */
function secretParameter(name: string): M3LCliFlowValidationParameter {
  return { name, secret: true };
}

/**
 * The injected script knowledge the validator narrows `script` and
 * `parameters` against. Mirrors ADR-0055: an operation is an ordinary
 * declared parameter (`sqs-etl` selects with `command`, `dynamodb-crud` with
 * `operation`, `json-etl` has no selector at all), so there is no separate
 * `operation:` step key.
 */
const context: M3LCliFlowValidationContext = {
  parametersByScript: new Map([
    ["sqs-etl", declared("command", "queueUrl", "input", "output")],
    ["json-etl", declared("input", "output", "format", "fields")],
    ["dynamodb-crud", declared("operation", "table", "input")],
  ]),
};

/** Builds a raw step record, `json-etl` with no parameters by default. */
function rawStep(overrides: RawRecord = {}): RawRecord {
  return { id: "one", script: "json-etl", parameters: {}, ...overrides };
}

/** Builds a raw flow record named `demo` with a single valid step. */
function rawFlow(overrides: RawRecord = {}): RawRecord {
  return { name: "demo", steps: [rawStep()], ...overrides };
}

/** Builds a raw flow whose single step carries `overrides`. */
function rawFlowWithStep(overrides: RawRecord): RawRecord {
  return rawFlow({ steps: [rawStep(overrides)] });
}

/**
 * Copies `base` and defines `key` as a genuine own enumerable property.
 * Needed for `__proto__`, which a plain object literal would treat as a
 * prototype assignment rather than an own key — the very shape a YAML
 * document can carry and the validator must screen.
 */
function withOwnKey(base: RawRecord, key: string, value: unknown): RawRecord {
  const record: RawRecord = { ...base };
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return record;
}

/**
 * Runs `run` and returns the `M3LCliError` it threw. Fails the test when the
 * call returns normally, and rethrows any non-`M3LCliError` value so a wrong
 * error class is visible rather than swallowed.
 */
function captureCliError(run: () => unknown): M3LCliError {
  try {
    run();
  } catch (error) {
    if (error instanceof M3LCliError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an M3LCliError, but the call returned normally");
}

/** Validates `raw` as the flow named `demo`. */
function validateDemo(raw: unknown): M3LCliFlowDefinition {
  return validateFlowDefinition(raw, "demo", context);
}

/** Captures the rejection of `raw` validated as the flow named `demo`. */
function rejectDemo(raw: unknown): M3LCliError {
  return captureCliError(() => validateDemo(raw));
}

/** Validates `raw` as the flow named `demo` against `injected`. */
function validateWith(
  raw: unknown,
  injected: M3LCliFlowValidationContext,
): M3LCliFlowDefinition {
  return validateFlowDefinition(raw, "demo", injected);
}

/** Captures the rejection of `raw` validated against `injected`. */
function rejectWith(
  raw: unknown,
  injected: M3LCliFlowValidationContext,
): M3LCliError {
  return captureCliError(() => validateWith(raw, injected));
}

/**
 * The prototype-pollution vectors `Core.isDangerousKey` matches, as a tuple so
 * the case name union derives from the fixture rather than being restated.
 */
const DANGEROUS_NAMES = ["__proto__", "constructor", "prototype"] as const;

type DangerousName = (typeof DANGEROUS_NAMES)[number];

/** The three vectors as single-element `test.each` rows. */
const DANGEROUS_ROWS: readonly [DangerousName][] = DANGEROUS_NAMES.map(
  (key): [DangerousName] => [key],
);

/**
 * The distinctive fragment of the dangerous-key rejection, read from
 * `screenDangerousKeys` in `src/flow/validate.ts`. Only a fragment, not the
 * whole sentence: a reworded message must not break the suite, but the phrase
 * has to be specific enough that no OTHER rule can produce it.
 */
const POLLUTION_MESSAGE = "declares prototype-pollution key(s)";

/** The fragment the unknown-key rule produces, which must NOT appear instead. */
const UNKNOWN_KEY_MESSAGE = "declares unknown key(s)";

/** The fragment the undeclared-parameter rule produces. */
const UNDECLARED_PARAMETER_MESSAGE = "does not accept";

/**
 * A context whose `json-etl` declares the three pollution vectors as ORDINARY
 * parameter names, plus one safe name as a control.
 *
 * This is what makes the `parameters` cases below discriminating instead of
 * vacuous: against the default {@link context} a `parameters` key named
 * `constructor` is also an UNDECLARED parameter, so removing the dangerous-key
 * screen simply moves the rejection to the undeclared-parameter rule and a
 * test asserting "some M3LCliError" cannot tell the two apart. Here the name
 * IS declared, so the undeclared path is unreachable and the dangerous-key
 * screen is the only rule that can reject the document — gut the screen and
 * the definition validates successfully.
 */
const declaringContext: M3LCliFlowValidationContext = {
  parametersByScript: new Map([
    ["json-etl", declared(...DANGEROUS_NAMES, "safe")],
  ]),
};

/** Returns the sole step of a validated single-step definition. */
function soleStep(definition: M3LCliFlowDefinition): M3LCliFlowStep {
  const [step] = definition.steps;
  if (step === undefined) {
    throw new Error("expected the validated definition to declare one step");
  }
  return step;
}

/** The three branch arms, as a tuple so the union derives from the fixture. */
const BRANCH_ARMS = ["onSuccess", "onFailure", "onPartial"] as const;

describe("flow types", () => {
  test("DEFAULT_MAX_STEP_EXECUTIONS is 50", () => {
    expect(DEFAULT_MAX_STEP_EXECUTIONS).toBe(50);
  });

  test("FLOW_NAME_RE and FLOW_STEP_ID_RE both match /^[a-z0-9-]+$/", () => {
    expect(FLOW_NAME_RE.source).toBe("^[a-z0-9-]+$");
    expect(FLOW_STEP_ID_RE.source).toBe("^[a-z0-9-]+$");
  });

  test.each([
    ["dlq-reconcile", true],
    ["a", true],
    ["step-2", true],
    ["Upper", false],
    ["has_underscore", false],
    ["has space", false],
    ["dot.name", false],
    ["", false],
  ])("FLOW_NAME_RE accepts %s: %s", (candidate: string, accepted: boolean) => {
    expect(FLOW_NAME_RE.test(candidate)).toBe(accepted);
  });

  test("M3LCliFlowExecution is the closed auto | in-process | spawn union", () => {
    expectTypeOf<M3LCliFlowExecution>().toEqualTypeOf<
      "auto" | "in-process" | "spawn"
    >();
  });

  test("M3LCliFlowBranch is continue | stop | { goto }", () => {
    expectTypeOf<M3LCliFlowBranch>().toEqualTypeOf<
      "continue" | "stop" | { readonly goto: string }
    >();
  });

  test("M3LCliFlowDefinition declares readonly steps and a numeric guard", () => {
    expectTypeOf<M3LCliFlowDefinition["steps"]>().toEqualTypeOf<
      readonly M3LCliFlowStep[]
    >();
    expectTypeOf<
      M3LCliFlowDefinition["maxStepExecutions"]
    >().toEqualTypeOf<number>();
    expectTypeOf<M3LCliFlowDefinition["name"]>().toEqualTypeOf<string>();
  });

  test("M3LCliFlowStep declares an opaque readonly parameters record", () => {
    expectTypeOf<M3LCliFlowStep["parameters"]>().toEqualTypeOf<
      Readonly<Record<string, unknown>>
    >();
    expectTypeOf<
      M3LCliFlowStep["execution"]
    >().toEqualTypeOf<M3LCliFlowExecution>();
    expectTypeOf<
      M3LCliFlowStep["onSuccess"]
    >().toEqualTypeOf<M3LCliFlowBranch>();
    expectTypeOf<
      M3LCliFlowStep["onFailure"]
    >().toEqualTypeOf<M3LCliFlowBranch>();
  });

  test("validateFlowDefinition returns a fully-narrowed definition, never a partial", () => {
    expectTypeOf(
      validateFlowDefinition,
    ).returns.toEqualTypeOf<M3LCliFlowDefinition>();
  });
});

describe("M3LCliFlowValidationContext", () => {
  test("a declared parameter is a name PAIRED with its secret-ness, both required", () => {
    // Both fields required, and no third: the pair is the smallest shape that
    // makes the ADR-0085 screen impossible to bypass. A separate
    // `secretParametersByScript` map would let a caller populate the names and
    // omit the secrets — the guard would then be optional in practice, and
    // silently absent exactly where it matters.
    expectTypeOf<M3LCliFlowValidationParameter>().toEqualTypeOf<{
      readonly name: string;
      readonly secret: boolean;
    }>();
  });

  test("the context names only parametersByScript, so the known-script set and the parameter facts cannot disagree", () => {
    expectTypeOf<M3LCliFlowValidationContext>().toEqualTypeOf<{
      readonly parametersByScript: ReadonlyMap<
        string,
        readonly M3LCliFlowValidationParameter[]
      >;
    }>();
  });

  test("a Core parameter descriptor is assignable as-is, so the CLI needs no lossy projection to build the context", () => {
    // `commands/flow.ts` already holds `Core.M3LConfigParameterDescriptor`s;
    // both `name` and `secret` are required there too, so it can pass them
    // straight through instead of projecting down to names (the projection
    // that discarded `secret` and let this leak exist).
    expectTypeOf<Core.M3LConfigParameterDescriptor>().toExtend<M3LCliFlowValidationParameter>();
  });
});

describe("validateFlowDefinition — happy path", () => {
  test("returns the normalized definition for a minimal valid flow", () => {
    const definition = validateDemo(rawFlow());

    expect(definition.name).toBe("demo");
    expect(definition.steps).toHaveLength(1);
    expect(soleStep(definition).id).toBe("one");
    expect(soleStep(definition).script).toBe("json-etl");
    expect(soleStep(definition).parameters).toEqual({});
  });

  test("defaults maxStepExecutions to DEFAULT_MAX_STEP_EXECUTIONS when absent", () => {
    expect(validateDemo(rawFlow()).maxStepExecutions).toBe(
      DEFAULT_MAX_STEP_EXECUTIONS,
    );
  });

  test("keeps an explicit maxStepExecutions", () => {
    expect(
      validateDemo(rawFlow({ maxStepExecutions: 12 })).maxStepExecutions,
    ).toBe(12);
  });

  test("accepts maxStepExecutions of 1 as the lower boundary", () => {
    expect(
      validateDemo(rawFlow({ maxStepExecutions: 1 })).maxStepExecutions,
    ).toBe(1);
  });

  test("keeps a declared description", () => {
    expect(
      validateDemo(rawFlow({ description: "drain a DLQ" })).description,
    ).toBe("drain a DLQ");
  });

  test("leaves description undefined when absent", () => {
    expect(validateDemo(rawFlow()).description).toBeUndefined();
  });

  test("defaults onSuccess to continue and onFailure to stop when absent", () => {
    const step = soleStep(validateDemo(rawFlow()));

    expect(step.onSuccess).toBe("continue");
    expect(step.onFailure).toBe("stop");
  });

  test("records the onFailure fallback as onPartial when onPartial is absent", () => {
    const step = soleStep(
      validateDemo(rawFlowWithStep({ onFailure: { goto: "one" } })),
    );

    expect(step.onFailure).toEqual({ goto: "one" });
    expect(step.onPartial).toEqual({ goto: "one" });
  });

  test("preserves an explicit onPartial distinct from onFailure", () => {
    const step = soleStep(
      validateDemo(
        rawFlowWithStep({ onFailure: "stop", onPartial: "continue" }),
      ),
    );

    expect(step.onFailure).toBe("stop");
    expect(step.onPartial).toBe("continue");
  });

  test("defaults execution to auto when absent", () => {
    expect(soleStep(validateDemo(rawFlow())).execution).toBe("auto");
  });

  test.each([["auto"], ["in-process"], ["spawn"]])(
    "accepts execution %s",
    (execution: string) => {
      expect(
        soleStep(validateDemo(rawFlowWithStep({ execution }))).execution,
      ).toBe(execution);
    },
  );

  test("accepts auto and spawn identically, preserving the declared literal (resolution is stage B)", () => {
    // `auto` means spawn — only the spawn path writes the run-report.json the
    // engine reads — but that resolution happens at execution time. The
    // validator must not silently rewrite `auto` to `spawn`, or the run
    // record could not report what the author actually declared.
    expect(
      soleStep(validateDemo(rawFlowWithStep({ execution: "auto" }))).execution,
    ).toBe("auto");
    expect(
      soleStep(validateDemo(rawFlowWithStep({ execution: "spawn" }))).execution,
    ).toBe("spawn");
  });

  test.each([[true], [false]])("accepts dryRun %s", (dryRun: boolean) => {
    expect(soleStep(validateDemo(rawFlowWithStep({ dryRun }))).dryRun).toBe(
      dryRun,
    );
  });

  test("leaves dryRun undefined when absent", () => {
    expect(soleStep(validateDemo(rawFlow())).dryRun).toBeUndefined();
  });

  test("accepts parameters the target script declares, including an operation selector", () => {
    const definition = validateFlowDefinition(
      {
        name: "demo",
        steps: [
          rawStep({
            id: "dump",
            script: "sqs-etl",
            parameters: { command: "dump", output: "data/output/d.jsonl" },
          }),
        ],
      },
      "demo",
      context,
    );

    expect(soleStep(definition).parameters).toEqual({
      command: "dump",
      output: "data/output/d.jsonl",
    });
  });

  test.each([
    ["sqs-etl", "command"],
    ["dynamodb-crud", "operation"],
  ])(
    "accepts %s's operation selector %s as an ordinary declared parameter",
    (script: string, selector: string) => {
      const definition = validateDemo(
        rawFlowWithStep({ script, parameters: { [selector]: "value" } }),
      );

      expect(soleStep(definition).parameters).toEqual({ [selector]: "value" });
    },
  );

  test("accepts a forward goto to a later declared step", () => {
    const definition = validateDemo(
      rawFlow({
        steps: [
          rawStep({ id: "first", onSuccess: { goto: "second" } }),
          rawStep({ id: "second" }),
        ],
      }),
    );

    expect(definition.steps[0]?.onSuccess).toEqual({ goto: "second" });
  });

  test("accepts a backward goto to an earlier declared step", () => {
    // The acceptance flow revisits sqs-etl, so a backward goto is legal and
    // the loop guard — not the validator — is what bounds it.
    const definition = validateDemo(
      rawFlow({
        steps: [
          rawStep({ id: "first" }),
          rawStep({ id: "second", onFailure: { goto: "first" } }),
        ],
      }),
    );

    expect(definition.steps[1]?.onFailure).toEqual({ goto: "first" });
  });

  test("accepts a self-referential goto to the step's own id", () => {
    const definition = validateDemo(
      rawFlowWithStep({ onFailure: { goto: "one" } }),
    );

    expect(soleStep(definition).onFailure).toEqual({ goto: "one" });
  });
});

describe("validateFlowDefinition — name rules", () => {
  test.each([[null], [undefined], [[]], ["text"], [42], [true]])(
    "rejects a non-record raw value: %s",
    (raw: unknown) => {
      expect(rejectDemo(raw).code).toBe("ERR_CLI_FLOW_INVALID");
    },
  );

  test("rejects a missing name", () => {
    const error = rejectDemo({ steps: [rawStep()] });

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("name");
  });

  test("rejects a non-string name", () => {
    expect(rejectDemo(rawFlow({ name: 7 })).code).toBe("ERR_CLI_FLOW_INVALID");
  });

  test.each([["Demo"], ["has_underscore"], ["has space"], ["dot.name"], [""]])(
    "rejects the name %s, which does not match FLOW_NAME_RE",
    (name: string) => {
      const error = captureCliError(() =>
        validateFlowDefinition(rawFlow({ name }), name, context),
      );

      expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    },
  );

  test("rejects a name that does not equal the expected filename stem", () => {
    // A renamed file would otherwise silently shadow another flow.
    const error = captureCliError(() =>
      validateFlowDefinition(rawFlow({ name: "other" }), "demo", context),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("other");
    expect(error.message).toContain("demo");
  });

  test("accepts a name that equals the expected filename stem", () => {
    expect(
      validateFlowDefinition(rawFlow({ name: "other" }), "other", context).name,
    ).toBe("other");
  });

  test("rejects a non-string description", () => {
    expect(rejectDemo(rawFlow({ description: 7 })).code).toBe(
      "ERR_CLI_FLOW_INVALID",
    );
  });
});

describe("validateFlowDefinition — steps rules", () => {
  test("rejects a missing steps key", () => {
    const error = rejectDemo({ name: "demo" });

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("steps");
  });

  test.each([[{}], ["dump"], [42], [null]])(
    "rejects a non-array steps value: %s",
    (steps: unknown) => {
      expect(rejectDemo(rawFlow({ steps })).code).toBe("ERR_CLI_FLOW_INVALID");
    },
  );

  test("rejects an empty steps array", () => {
    const error = rejectDemo(rawFlow({ steps: [] }));

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("steps");
  });

  test.each([[null], ["dump"], [42], [[]]])(
    "rejects a non-record step entry: %s",
    (step: unknown) => {
      expect(rejectDemo(rawFlow({ steps: [step] })).code).toBe(
        "ERR_CLI_FLOW_INVALID",
      );
    },
  );

  test("rejects a missing step id", () => {
    const error = rejectDemo(
      rawFlow({ steps: [{ script: "json-etl", parameters: {} }] }),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("id");
  });

  test.each([["One"], ["has_underscore"], ["has space"], [""], ["dot.id"]])(
    "rejects the step id %s, which does not match FLOW_STEP_ID_RE",
    (id: string) => {
      expect(rejectDemo(rawFlowWithStep({ id })).code).toBe(
        "ERR_CLI_FLOW_INVALID",
      );
    },
  );

  test("rejects a non-string step id", () => {
    expect(rejectDemo(rawFlowWithStep({ id: 3 })).code).toBe(
      "ERR_CLI_FLOW_INVALID",
    );
  });

  test("rejects a duplicate step id, naming it", () => {
    const error = rejectDemo(
      rawFlow({ steps: [rawStep({ id: "dump" }), rawStep({ id: "dump" })] }),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("dump");
  });
});

describe("validateFlowDefinition — script rules", () => {
  test("rejects a missing script", () => {
    const error = rejectDemo(
      rawFlow({ steps: [{ id: "one", parameters: {} }] }),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("script");
  });

  test("rejects a non-string script", () => {
    expect(rejectDemo(rawFlowWithStep({ script: 7 })).code).toBe(
      "ERR_CLI_FLOW_INVALID",
    );
  });

  test("rejects an unknown script with ranked suggestions over the injected script names", () => {
    const error = rejectDemo(rawFlowWithStep({ script: "json-et" }));

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("json-et");
    expect(error.suggestions).toContain("json-etl");
  });

  test("rejects an unknown script with no suggestions when nothing is close", () => {
    const error = rejectDemo(rawFlowWithStep({ script: "zzzzzzzzzz" }));

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.suggestions).toEqual([]);
  });
});

describe("validateFlowDefinition — parameters rules", () => {
  test("rejects a missing parameters key", () => {
    expect(
      rejectDemo(rawFlow({ steps: [{ id: "one", script: "json-etl" }] })).code,
    ).toBe("ERR_CLI_FLOW_INVALID");
  });

  test.each([[null], [[]], ["input=x"], [42]])(
    "rejects a non-record parameters value: %s",
    (parameters: unknown) => {
      expect(rejectDemo(rawFlowWithStep({ parameters })).code).toBe(
        "ERR_CLI_FLOW_INVALID",
      );
    },
  );

  test("rejects a parameters key the target script does not declare, with suggestions over that script's names", () => {
    const error = rejectDemo(
      rawFlowWithStep({ script: "json-etl", parameters: { inpt: "x" } }),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("inpt");
    expect(error.suggestions).toContain("input");
  });

  test("rejects a parameters key declared by a different script than the step's own", () => {
    // `command` is sqs-etl's selector; json-etl declares no selector at all.
    const error = rejectDemo(
      rawFlowWithStep({ script: "json-etl", parameters: { command: "dump" } }),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("command");
  });

  test("rejects a step-level operation key, since ADR-0055 has no separate operation selector", () => {
    // `operation` is an ordinary declared parameter of dynamodb-crud, so it
    // belongs under `parameters:` — never as a sibling of `script:`.
    const error = rejectDemo(
      rawFlowWithStep({ script: "dynamodb-crud", operation: "batch-write" }),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("operation");
  });
});

describe("validateFlowDefinition — execution rules", () => {
  test.each([["Auto"], ["in_process"], ["fork"], [""], ["AUTO"]])(
    "rejects the unrecognized execution value %s",
    (execution: string) => {
      const error = rejectDemo(rawFlowWithStep({ execution }));

      expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
      expect(error.message).toContain("execution");
    },
  );

  test.each([[null], [42], [true], [{}]])(
    "rejects a non-string execution value: %s",
    (execution: unknown) => {
      expect(rejectDemo(rawFlowWithStep({ execution })).code).toBe(
        "ERR_CLI_FLOW_INVALID",
      );
    },
  );

  test("rejects a non-boolean dryRun", () => {
    expect(rejectDemo(rawFlowWithStep({ dryRun: "yes" })).code).toBe(
      "ERR_CLI_FLOW_INVALID",
    );
  });
});

describe.each(BRANCH_ARMS)(
  "validateFlowDefinition — branch algebra (%s)",
  (arm: (typeof BRANCH_ARMS)[number]) => {
    test.each([["continue"], ["stop"]])(
      `accepts %s for ${arm}`,
      (value: string) => {
        const step = soleStep(validateDemo(rawFlowWithStep({ [arm]: value })));

        expect(step[arm]).toBe(value);
      },
    );

    test(`accepts a { goto } naming a declared step id for ${arm}`, () => {
      const step = soleStep(
        validateDemo(rawFlowWithStep({ [arm]: { goto: "one" } })),
      );

      expect(step[arm]).toEqual({ goto: "one" });
    });

    test.each([["retry"], ["goto"], ["CONTINUE"], [""], ["one"]])(
      `rejects the unrecognized string %s for ${arm}`,
      (value: string) => {
        expect(rejectDemo(rawFlowWithStep({ [arm]: value })).code).toBe(
          "ERR_CLI_FLOW_INVALID",
        );
      },
    );

    test(`rejects a { goto } whose value is not a string for ${arm}`, () => {
      expect(rejectDemo(rawFlowWithStep({ [arm]: { goto: 1 } })).code).toBe(
        "ERR_CLI_FLOW_INVALID",
      );
    });

    test(`rejects an object carrying extra keys alongside goto for ${arm}`, () => {
      const error = rejectDemo(
        rawFlowWithStep({ [arm]: { goto: "one", retry: true } }),
      );

      expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
      expect(error.message).toContain("retry");
    });

    test(`rejects an object with no goto key for ${arm}`, () => {
      expect(rejectDemo(rawFlowWithStep({ [arm]: {} })).code).toBe(
        "ERR_CLI_FLOW_INVALID",
      );
    });

    test(`rejects a dangling goto naming an undeclared step id for ${arm}`, () => {
      const error = rejectDemo(rawFlowWithStep({ [arm]: { goto: "nowhere" } }));

      expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
      expect(error.message).toContain("nowhere");
    });

    test.each([[null], [42], [true], [[]], [["continue"]]])(
      `rejects a non-string, non-record arm value %s for ${arm}`,
      (value: unknown) => {
        expect(rejectDemo(rawFlowWithStep({ [arm]: value })).code).toBe(
          "ERR_CLI_FLOW_INVALID",
        );
      },
    );
  },
);

describe("validateFlowDefinition — maxStepExecutions rules", () => {
  test.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "rejects the non-positive-safe-integer maxStepExecutions %s",
    (maxStepExecutions: number) => {
      const error = rejectDemo(rawFlow({ maxStepExecutions }));

      expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
      expect(error.message).toContain("maxStepExecutions");
    },
  );

  test("rejects a maxStepExecutions above Number.MAX_SAFE_INTEGER", () => {
    expect(
      rejectDemo(rawFlow({ maxStepExecutions: Number.MAX_SAFE_INTEGER + 2 }))
        .code,
    ).toBe("ERR_CLI_FLOW_INVALID");
  });

  test.each([["12"], [null], [true], [{}]])(
    "rejects a non-number maxStepExecutions: %s",
    (maxStepExecutions: unknown) => {
      expect(rejectDemo(rawFlow({ maxStepExecutions })).code).toBe(
        "ERR_CLI_FLOW_INVALID",
      );
    },
  );
});

describe("validateFlowDefinition — unknown keys", () => {
  test("rejects an unknown flow-level key, naming it", () => {
    const error = rejectDemo(rawFlow({ retries: 3 }));

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("retries");
  });

  test("rejects multiple unknown flow-level keys, naming all of them", () => {
    const error = rejectDemo(rawFlow({ retries: 3, timeout: 5 }));

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("retries");
    expect(error.message).toContain("timeout");
  });

  test("rejects an unknown step-level key, naming it and the step it came from", () => {
    const error = rejectDemo(rawFlowWithStep({ id: "dump", onError: "stop" }));

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("onError");
    expect(error.message).toContain("dump");
  });

  test("rejects multiple unknown step-level keys, naming all of them", () => {
    const error = rejectDemo(rawFlowWithStep({ onError: "stop", retries: 2 }));

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain("onError");
    expect(error.message).toContain("retries");
  });

  test("accepts every documented flow-level and step-level key together", () => {
    const definition = validateDemo(
      rawFlow({
        description: "everything",
        maxStepExecutions: 3,
        steps: [
          {
            id: "one",
            script: "json-etl",
            parameters: { input: "a", output: "b" },
            execution: "spawn",
            onSuccess: "continue",
            onFailure: "stop",
            onPartial: "continue",
            dryRun: true,
          },
        ],
      }),
    );

    expect(soleStep(definition).dryRun).toBe(true);
    expect(definition.maxStepExecutions).toBe(3);
  });
});

describe("validateFlowDefinition — dangerous nested keys", () => {
  test("rejects a flow-level pollution vector before reporting it as an unknown key", () => {
    // `Core.M3LYAMLConfigProvider` screens the document's top-level keys, but
    // `validateFlowDefinition` is also called directly (and unit-tested) with
    // a raw record, so it screens the flow level itself.
    const flow = withOwnKey(rawFlow(), "__proto__", { polluted: true });
    expect(Object.hasOwn(flow, "__proto__")).toBe(true);

    const error = rejectDemo(flow);

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain(POLLUTION_MESSAGE);
    expect(error.message).toContain("__proto__");
    expect(error.message).not.toContain(UNKNOWN_KEY_MESSAGE);
  });

  test.each(DANGEROUS_ROWS)(
    "rejects the step-level key %s as a pollution vector, not as an unknown key",
    (key: DangerousName) => {
      // The YAML provider screens only TOP-LEVEL keys, so a step-level
      // prototype-pollution vector is this validator's own responsibility.
      //
      // At step level BOTH arms are reachable — none of the three names is a
      // declared step key either — so asserting only the error class would
      // pass identically with the dangerous screen removed: the unknown-key
      // rule rejects the same input. Pinning the pollution phrase (and
      // excluding the unknown-key phrase) is what makes the two outcomes
      // distinguishable, and therefore what makes this a precedence proof
      // rather than a restatement of "the input is invalid".
      const step = withOwnKey(rawStep(), key, {});
      expect(Object.hasOwn(step, key)).toBe(true);

      const error = rejectDemo(rawFlow({ steps: [step] }));

      expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
      expect(error.message).toContain(POLLUTION_MESSAGE);
      expect(error.message).toContain(key);
      expect(error.message).not.toContain(UNKNOWN_KEY_MESSAGE);
    },
  );

  test.each(DANGEROUS_ROWS)(
    "rejects the parameters key %s as a pollution vector, not as an undeclared parameter",
    (key: DangerousName) => {
      // Same precedence shape one level down: against the default context the
      // key is also a parameter `json-etl` does not accept, so only the
      // message tells which rule fired.
      const parameters = withOwnKey({}, key, "x");
      expect(Object.hasOwn(parameters, key)).toBe(true);

      const error = rejectDemo(rawFlowWithStep({ parameters }));

      expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
      expect(error.message).toContain(POLLUTION_MESSAGE);
      expect(error.message).toContain(key);
      expect(error.message).not.toContain(UNDECLARED_PARAMETER_MESSAGE);
    },
  );

  test.each(DANGEROUS_ROWS)(
    "rejects the parameters key %s even though the script declares it, so no other rule can be doing the work",
    (key: DangerousName) => {
      // The sharpest form: `declaringContext` lists all three vectors as real
      // parameter names, so the undeclared-parameter rule cannot fire and the
      // dangerous-key screen is the ONLY rule left that can reject this
      // document. Remove the screen and the call returns a valid definition
      // carrying the vector — which is exactly the failure this test kills.
      const parameters = withOwnKey({}, key, "x");
      expect(Object.hasOwn(parameters, key)).toBe(true);

      const error = rejectWith(
        rawFlowWithStep({ parameters }),
        declaringContext,
      );

      expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
      expect(error.message).toContain(POLLUTION_MESSAGE);
      expect(error.message).toContain(key);
    },
  );

  test("accepts a safe declared parameter under the same context, proving only the screen rejects the vectors", () => {
    // The control for the three tests above: `declaringContext` is not
    // rejecting everything for some unrelated reason.
    const definition = validateWith(
      rawFlowWithStep({ parameters: { safe: "x" } }),
      declaringContext,
    );

    expect(soleStep(definition).parameters).toEqual({ safe: "x" });
  });

  test("rejects a pollution vector inside a { goto } branch mapping", () => {
    const goto = withOwnKey({ goto: "one" }, "__proto__", { polluted: true });
    expect(Object.hasOwn(goto, "__proto__")).toBe(true);

    const error = rejectDemo(rawFlowWithStep({ onFailure: goto }));

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain(POLLUTION_MESSAGE);
    expect(error.message).toContain("__proto__");
    expect(error.message).not.toContain(UNKNOWN_KEY_MESSAGE);
  });

  test("carries no suggestions for a pollution rejection, so the vector is never echoed as a hint", () => {
    // A pollution vector is also a near-miss candidate for a "did you mean"
    // ranking; the screen deliberately passes no suggestions. Paired with the
    // message assertion so it cannot pass on an unrelated rejection that
    // happens to have no suggestions either.
    const error = rejectWith(
      rawFlowWithStep({ parameters: withOwnKey({}, "constructor", "x") }),
      declaringContext,
    );

    expect(error.message).toContain(POLLUTION_MESSAGE);
    expect(error.suggestions).toEqual([]);
  });

  test("rejects a pollution vector nested inside a parameter value's own mapping", () => {
    // `fields` is an opaque parameter value from the validator's point of
    // view — its shape belongs to `json-etl`, not to this format — so only
    // `screenDangerousKeysDeep`'s walk down into it can catch a vector
    // buried a level below `parameters` itself.
    const nested = withOwnKey({ keep: 2 }, "__proto__", { payload: 1 });
    expect(Object.hasOwn(nested, "__proto__")).toBe(true);

    const error = rejectDemo(
      rawFlowWithStep({ parameters: { fields: nested } }),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain(POLLUTION_MESSAGE);
    expect(error.message).toContain("__proto__");
    // The label is path-extended with the descended key, not just "parameters".
    expect(error.message).toContain("'s 'parameters'.fields");
  });

  test("rejects a pollution vector nested inside an array element of a parameter value", () => {
    // Pins that the recursive walk descends into arrays, not only records —
    // a mapping sitting at `parameters.fields[1]` is just as reachable as one
    // sitting directly under `fields`.
    const nested = withOwnKey({ keep: 2 }, "__proto__", { payload: 1 });
    expect(Object.hasOwn(nested, "__proto__")).toBe(true);

    const error = rejectDemo(
      rawFlowWithStep({ parameters: { fields: [{ keep: 1 }, nested] } }),
    );

    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain(POLLUTION_MESSAGE);
    expect(error.message).toContain("__proto__");
    expect(error.message).toContain("'s 'parameters'.fields[1]");
  });
});

/**
 * An obvious placeholder for every secret-valued fixture below. A flow YAML is
 * a committed file; nothing that could be mistaken for a real credential
 * belongs in a fixture that models one.
 */
const PLACEHOLDER_SECRET = "PLACEHOLDER-NOT-A-REAL-SECRET";

/**
 * A context whose `json-etl` declares TWO secret parameters beside two
 * ordinary ones.
 *
 * Both secret names are genuinely declared, and that is what makes the cases
 * below discriminating rather than vacuous: a declared name cannot trip the
 * undeclared-parameter rule, so the ADR-0085 secret screen is the only rule
 * left that can reject these documents. Remove the screen and every rejection
 * case here returns a valid definition whose step carries the secret straight
 * into child argv — the leak this block exists to kill.
 */
const secretsContext: M3LCliFlowValidationContext = {
  parametersByScript: new Map([
    [
      "json-etl",
      [
        ...declared("input", "output"),
        secretParameter("api-token"),
        secretParameter("signing-key"),
      ],
    ],
  ]),
};

/**
 * The ADR reference the secret rejection must carry. Pinned instead of the
 * whole sentence: the wording may be reworded freely, but the message has to
 * keep pointing the author at the decision that explains WHY a secret may not
 * live in a committed flow file.
 */
const SECRET_ADR = "ADR-0085";

/** The unambiguous word the secret rejection must use to name its rule. */
const SECRET_WORD = "secret";

describe("validateFlowDefinition — secret parameters (ADR-0085)", () => {
  /**
   * Asserts `error` is the ADR-0085 secret rejection: the shared
   * definition-fault code, the word `secret`, the ADR reference, and every key
   * in `named` — and specifically NOT the undeclared-parameter phrasing, since
   * a declared-secret key is not an unknown key.
   */
  function expectSecretRejection(
    error: M3LCliError,
    named: readonly string[],
  ): void {
    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(error.message).toContain(SECRET_WORD);
    expect(error.message).toContain(SECRET_ADR);
    for (const key of named) {
      expect(error.message).toContain(key);
    }
    expect(error.message).not.toContain(UNDECLARED_PARAMETER_MESSAGE);
  }

  test("rejects a parameters key the target script declares secret", () => {
    // ADR-0085: a secret reaches a child through its ENVIRONMENT, never its
    // argv. `flow/step.ts` builds `--name=value` for every parameter it is
    // given, so a secret accepted here would land in the child's
    // /proc/<pid>/cmdline — and resolve from argv (provider priority 1)
    // instead of env (priority 4). The definition file is where that is
    // stopped, because a flow YAML is committed.
    const error = rejectWith(
      rawFlowWithStep({
        script: "json-etl",
        parameters: { "api-token": PLACEHOLDER_SECRET },
      }),
      secretsContext,
    );

    expectSecretRejection(error, ["api-token"]);
  });

  test("accepts a non-secret declared key on the same script, so the screen is not rejecting everything", () => {
    // The control: `secretsContext` is not simply making every step invalid.
    const definition = validateWith(
      rawFlowWithStep({ script: "json-etl", parameters: { input: "a.jsonl" } }),
      secretsContext,
    );

    expect(soleStep(definition).parameters).toEqual({ input: "a.jsonl" });
  });

  test("rejects only the secret key of a mixed step, naming it and no non-secret sibling", () => {
    const error = rejectWith(
      rawFlowWithStep({
        script: "json-etl",
        parameters: {
          input: "a.jsonl",
          "api-token": PLACEHOLDER_SECRET,
          output: "b.jsonl",
        },
      }),
      secretsContext,
    );

    expectSecretRejection(error, ["api-token"]);
    // Only the offending key is named: the message is a fix list, so a
    // non-secret sibling (or an "accepted names" hint listing them) would
    // leave the author guessing which key to actually remove.
    expect(error.message).not.toContain("input");
    expect(error.message).not.toContain("output");
  });

  test("names every secret key of one step in a single message, so one pass over the file fixes them all", () => {
    // Matches the unknown-key rule's existing behaviour: report the whole set,
    // never the first offender and then a second round trip.
    const error = rejectWith(
      rawFlowWithStep({
        script: "json-etl",
        parameters: {
          "api-token": PLACEHOLDER_SECRET,
          input: "a.jsonl",
          "signing-key": PLACEHOLDER_SECRET,
        },
      }),
      secretsContext,
    );

    expectSecretRejection(error, ["api-token", "signing-key"]);
  });

  test("the secret rejection carries the shared definition-fault code and maps to the usage exit code 2", () => {
    const error = rejectWith(
      rawFlowWithStep({
        script: "json-etl",
        parameters: { "signing-key": PLACEHOLDER_SECRET },
      }),
      secretsContext,
    );

    expect(error).toBeInstanceOf(M3LCliError);
    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
    expect(exitCodeForError(error)).toBe(2);
  });

  test("rejects a secret key as a SECRET, never as an unknown or undeclared one", () => {
    // The precedence proof. `api-token` IS declared by `json-etl`, so neither
    // the unknown-step-key rule nor the undeclared-parameter rule can fire on
    // it — the only way this document gets rejected is the secret screen, and
    // the two excluded fragments are what prove which rule spoke.
    const error = rejectWith(
      rawFlowWithStep({
        script: "json-etl",
        parameters: { "api-token": PLACEHOLDER_SECRET },
      }),
      secretsContext,
    );

    expect(error.message).toContain("api-token");
    expect(error.message).not.toContain(UNDECLARED_PARAMETER_MESSAGE);
    expect(error.message).not.toContain(UNKNOWN_KEY_MESSAGE);
    expect(error.message).not.toContain(POLLUTION_MESSAGE);
  });

  test("the secret value itself is never echoed back in the rejection message", () => {
    // A rejection is logged and often pasted into a ticket; naming the KEY is
    // the whole fix instruction, so the value has no reason to appear.
    const error = rejectWith(
      rawFlowWithStep({
        script: "json-etl",
        parameters: { "api-token": PLACEHOLDER_SECRET },
      }),
      secretsContext,
    );

    expect(error.message).not.toContain(PLACEHOLDER_SECRET);
  });
});

describe("validateFlowDefinition — error classification", () => {
  test("every rejection is an M3LCliError, never a partial definition", () => {
    const error = rejectDemo(rawFlow({ steps: [] }));

    expect(error).toBeInstanceOf(M3LCliError);
    expect(error.code).toBe("ERR_CLI_FLOW_INVALID");
  });

  test("a definition fault maps to the usage exit code 2", () => {
    expect(exitCodeForError(rejectDemo(rawFlow({ steps: [] })))).toBe(2);
  });

  test("a rejection carries no cause when nothing was chained", () => {
    expect(rejectDemo(rawFlow({ steps: [] })).cause).toBeUndefined();
  });
});
