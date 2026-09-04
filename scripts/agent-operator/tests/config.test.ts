import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters, configValidators } from "../src/config.js";

/**
 * The declared schema, built exactly as `main.ts`/`command.ts` build it — the
 * subject of the validator tests at the bottom of this file. Constructed once:
 * `M3LConfigSchema` is immutable, and `validate` reads only its argument.
 */
const schema = new Core.M3LConfigSchema(configParameters, configValidators);

/**
 * Resolves every declared parameter against `raw` through the library's own
 * resolution chain, then runs the schema-level cross-parameter validators —
 * the two layers `M3LScript`'s `config-load` stage runs, in the same order,
 * against the same real objects.
 *
 * This mirrors `M3LScriptConfigLoader.load` deliberately rather than calling
 * it: that loader always layers in a real command-line and environment
 * provider, so this process's own argv/env could leak into a test. A single
 * in-memory provider keeps the run deterministic while still exercising the
 * real `M3LConfigParameter.resolveAsync` — which is what actually runs a
 * per-parameter `validate` (a resolved `defaultValue` deliberately does not).
 *
 * `raw` values are the CSV **strings** a provider really supplies: a
 * `STRING_ARRAY` is coerced by `splitCsv`, which rejects a bare JS array.
 *
 * @param raw - Raw provider values, keyed by declared parameter name.
 * @returns The populated store when every layer passes.
 * @throws `Core.M3LConfigValidationError` from either layer.
 */
async function loadAndValidate(
  raw: Readonly<Record<string, unknown>>,
): Promise<Core.M3LConfig> {
  const reader = new Core.M3LConfigReader([
    new Core.M3LInMemoryConfigProvider({ ...raw }),
  ]);
  const config = new Core.M3LConfig();
  for (const parameter of schema.parameters) {
    const resolved = await parameter.resolveAsync(reader);
    if (resolved !== undefined) {
      config.set(parameter.getName(), resolved.value, resolved.source);
    }
  }
  schema.validate(config);
  return config;
}

/** The three globally-required parameters, so a case can vary only its subject. */
const REQUIRED_RAW: Readonly<Record<string, string>> = {
  [Core.AWS_PROFILE_PARAM_NAME]: "sandbox",
  command: "explain-policy",
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
};

/** Loads `overrides` on top of {@link REQUIRED_RAW}, returning what it threw. */
async function captureLoadFailure(
  overrides: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  try {
    await loadAndValidate({ ...REQUIRED_RAW, ...overrides });
  } catch (error) {
    return error;
  }
  return undefined;
}

// The mandatory config-declaration smoke test (ADR-0022 §8). Importing the
// schema is itself an assertion: M3LConfigParameter validates a declared
// defaultValue eagerly in its constructor, so a default that violates its own
// validator fails this file at import time.
describe("agent-operator config declaration", () => {
  it("declares at least one parameter", () => {
    expect(configParameters.length).toBeGreaterThan(0);
  });

  it("declares every parameter via M3LConfigParameter with a unique name", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(new Set(names).size).toBe(names.length);
    for (const parameter of configParameters) {
      expect(parameter).toBeInstanceOf(Core.M3LConfigParameter);
    }
  });

  it("declares exactly the two PR-1 operations on the `command` parameter", () => {
    const command = configParameters.find(
      (parameter) => parameter.getName() === "command",
    );
    expect(command).toBeDefined();
    const operationNames = (command?.getOperations() ?? []).map(
      (operation) => operation.name,
    );
    // PR 1 is offline-only: no generic ask/prompt operation exists, because
    // that would let model output choose the workload (see config.ts's
    // deliberate-absence comment).
    expect(operationNames).toEqual(["health-check", "explain-policy"]);
  });

  it("declares at least one schema-level cross-parameter validator", () => {
    expect(configValidators.length).toBeGreaterThan(0);
  });

  it("declares exactly aws.profile, command, and modelId as required", () => {
    const requiredNames = configParameters
      .filter((parameter) => parameter.isRequired())
      .map((parameter) => parameter.getName())
      .sort();
    expect(requiredNames).toEqual(
      [Core.AWS_PROFILE_PARAM_NAME, "command", "modelId"].sort(),
    );
  });

  // Deliberate absences (see config.ts's comment): budgets are policy-file
  // fields, `dryRun` is the ADR-0054 context flag read once in main.ts, and
  // neither `yes` nor `yesSensitive` applies because the confirm-gate is not
  // what guards this workload's mutating path — the V6 policy layer is.
  // (Pre-V9 the reason was "it never mutates AWS state"; the `run` seam ends
  // that, but the parameters stay absent for the policy-layer reason.)
  // Widening any of these on argv would let an operator escape the declared,
  // diffable policy file.
  it.each(["dryRun", "yes", "yesSensitive"])(
    "never declares a '%s' parameter",
    (name) => {
      expect(
        configParameters.some((parameter) => parameter.getName() === name),
      ).toBe(false);
    },
  );

  it("never declares a budget* parameter — budgets are policy-file fields", () => {
    const budgetLike = configParameters.filter((parameter) =>
      /^budget/i.test(parameter.getName()),
    );
    expect(budgetLike).toEqual([]);
  });
});

/**
 * PR #769 finding 2: `configValidators` had exactly one assertion —
 * `length > 0` — which holds no matter what the entries do, and the
 * per-parameter validators (`eachAllowedScriptName`, `eachNonEmptyModelId`)
 * had none at all. The regression these guard is a validator getting silently
 * DETACHED from a parameter: `config.ts` would still export a non-empty array,
 * every existing test would stay green, and a malformed script name would
 * reach `cli-surface.ts`'s per-call gate at first use instead of failing
 * closed at config-load time.
 *
 * Both layers are exercised through the real
 * `new Core.M3LConfigSchema(configParameters, configValidators)` and the real
 * `M3LConfigParameter.resolveAsync`, never by invoking a validator closure
 * directly — a closure called in isolation proves the closure works while
 * saying nothing about whether it is still wired to its parameter.
 */
describe("agent-operator config validation (through a real M3LConfigSchema)", () => {
  describe("includeDryRunProbes requires a non-empty dryRunAllowlist", () => {
    // The declared reason, asserted verbatim: this is the one case where the
    // message IS the contract — an operator reading it is how a config
    // mistake gets fixed, and `M3LConfigSchema.validate` surfaces it as both
    // the error message and `context.reason`.
    const DECLARED_REASON =
      "'includeDryRunProbes' requires a non-empty 'dryRunAllowlist'";

    it.each([
      ["dryRunAllowlist is left to its empty default", {}],
      ["dryRunAllowlist is supplied but empty", { dryRunAllowlist: "" }],
    ])("rejects the run when probes are on and %s", async (_label, extra) => {
      const thrown = await captureLoadFailure({
        includeDryRunProbes: "true",
        ...extra,
      });

      expect(thrown).toBeInstanceOf(Core.M3LConfigValidationError);
      const asError = thrown as Core.M3LConfigValidationError;
      expect(asError.code).toBe("ERR_CONFIG_VALIDATION");
      expect(asError.message).toBe(DECLARED_REASON);
      expect(asError.context["reason"]).toBe(DECLARED_REASON);
    });

    it("accepts probes enabled alongside a non-empty allowlist", async () => {
      const config = await loadAndValidate({
        ...REQUIRED_RAW,
        includeDryRunProbes: "true",
        dryRunAllowlist: "json-etl",
      });

      expect(config.get("includeDryRunProbes")).toBe(true);
      expect(config.get("dryRunAllowlist")).toEqual(["json-etl"]);
    });

    // The losing arm has to be reachable for the winning arm to mean
    // anything: the allowlist really is empty in both of these, so the
    // validator's `!== true` short-circuit is what lets them pass — not the
    // absence of the condition it checks.
    it.each([
      ["explicitly disabled", { includeDryRunProbes: "false" }],
      ["left to its false default", {}],
    ])(
      "accepts an empty allowlist when probes are %s",
      async (_label, extra) => {
        const config = await loadAndValidate({ ...REQUIRED_RAW, ...extra });

        expect(config.get("includeDryRunProbes")).toBe(false);
        expect(config.get("dryRunAllowlist")).toEqual([]);
      },
    );
  });

  /**
   * `eachAllowedScriptName` is attached to TWO parameters. Asserting it on
   * only one of them would let a future edit detach it from the other without
   * a single test going red — so each parameter gets its own case, and each
   * asserts the failure reason names ITS OWN parameter (the reason string is
   * built from the declaring parameter's name, so it is what discriminates
   * "attached here" from "attached to the sibling").
   */
  describe("eachAllowedScriptName is attached to both script-name parameters", () => {
    it.each(["scripts", "dryRunAllowlist"])(
      "rejects a malformed script name in '%s'",
      async (parameterName) => {
        const thrown = await captureLoadFailure({
          // Uppercase and spaces: rejected by `AGENT_OPERATOR_SCRIPT_NAME_RE`,
          // and it survives `splitCsv` intact (no comma to split on).
          [parameterName]: "Not A Script Name",
        });

        expect(thrown).toBeInstanceOf(Core.M3LConfigValidationError);
        const asError = thrown as Core.M3LConfigValidationError;
        expect(asError.code).toBe("ERR_CONFIG_VALIDATION");
        expect(asError.context["parameter"]).toBe(parameterName);
        expect(asError.context["reason"]).toBe(
          `every '${parameterName}' entry must be an allowed script name`,
        );
      },
    );

    it.each(["scripts", "dryRunAllowlist"])(
      "rejects a path-traversal script name in '%s' without echoing it",
      async (parameterName) => {
        const thrown = await captureLoadFailure({
          [parameterName]: "../../etc/passwd",
        });

        expect(thrown).toBeInstanceOf(Core.M3LConfigValidationError);
        // The rejected value is operator- or model-supplied; the reason names
        // only the parameter (see `eachAllowedScriptName`'s TSDoc).
        expect((thrown as Core.M3LConfigValidationError).message).not.toContain(
          "passwd",
        );
      },
    );

    it.each(["scripts", "dryRunAllowlist"])(
      "accepts a list of allowed script names in '%s'",
      async (parameterName) => {
        const config = await loadAndValidate({
          ...REQUIRED_RAW,
          [parameterName]: "json-etl,dynamodb-crud",
        });

        expect(config.get(parameterName)).toEqual([
          "json-etl",
          "dynamodb-crud",
        ]);
      },
    );

    // One malformed entry among valid ones must sink the whole array: the
    // validator is an "every" guarantee, so a case with a single bad entry
    // would pass identically under a `some`-shaped implementation.
    it("rejects a list whose LAST entry is malformed", async () => {
      const thrown = await captureLoadFailure({
        scripts: "json-etl,Bad Name",
      });

      expect(thrown).toBeInstanceOf(Core.M3LConfigValidationError);
      expect(
        (thrown as Core.M3LConfigValidationError).context["parameter"],
      ).toBe("scripts");
    });
  });

  describe("eachNonEmptyModelId is attached to fallbackModelIds", () => {
    it("rejects a blank entry among otherwise valid model ids", async () => {
      // `splitCsv` trims each segment, so the middle segment arrives as "".
      const thrown = await captureLoadFailure({
        fallbackModelIds: "anthropic.claude-3-haiku-20240307-v1:0, ,model-b",
      });

      expect(thrown).toBeInstanceOf(Core.M3LConfigValidationError);
      const asError = thrown as Core.M3LConfigValidationError;
      expect(asError.code).toBe("ERR_CONFIG_VALIDATION");
      expect(asError.context["parameter"]).toBe("fallbackModelIds");
      expect(asError.context["reason"]).toBe(
        "every 'fallbackModelIds' entry must be a non-empty model id",
      );
    });

    it("accepts a list of non-blank model ids", async () => {
      const config = await loadAndValidate({
        ...REQUIRED_RAW,
        fallbackModelIds:
          "anthropic.claude-3-haiku-20240307-v1:0,anthropic.claude-3-opus-20240229-v1:0",
      });

      expect(config.get("fallbackModelIds")).toEqual([
        "anthropic.claude-3-haiku-20240307-v1:0",
        "anthropic.claude-3-opus-20240229-v1:0",
      ]);
    });
  });

  it("passes every layer for a fully-populated, valid configuration", async () => {
    const config = await loadAndValidate({
      ...REQUIRED_RAW,
      scripts: "json-etl,sqs-etl",
      includeDryRunProbes: "true",
      dryRunAllowlist: "json-etl",
      fallbackModelIds: "anthropic.claude-3-haiku-20240307-v1:0",
    });

    expect(config.get("scripts")).toEqual(["json-etl", "sqs-etl"]);
    expect(config.get("command")).toBe("explain-policy");
  });
});

/**
 * V9 slice 2a, Option D: `presetAllowlist` carries `"<name>=<path>"` entries
 * and declares **no** `validate` — its grammar lives in
 * `steps/resolve-runtime.ts` (`parsePresetAllowlist`), the single source of
 * truth, exactly as `modelRates` already does.
 *
 * The declared shape is asserted structurally (type, default, requiredness).
 * The ABSENCE of a validator cannot be: `M3LConfigParameter` keeps `validate`
 * private and exposes no getter, so the only way to observe whether one is
 * attached is to resolve a value through the real
 * `M3LConfigParameter.resolveAsync` — which is also the only thing that
 * proves WIRING rather than that some closure exists (the reason the
 * `eachAllowedScriptName` block above resolves instead of calling closures).
 * Each absence case is therefore paired with the same raw value on
 * `dryRunAllowlist`, which DOES declare a validator: the pair is what makes
 * the absence discriminating rather than vacuous.
 */
describe("presetAllowlist declaration (V9 Option D)", () => {
  /**
   * A well-formed `"<name>=<path>"` entry. It is simultaneously an invalid
   * script name (`=`, `/` and `.` all fail `AGENT_OPERATOR_SCRIPT_NAME_RE`),
   * which is what lets the same string discriminate "no validator here" from
   * "a name validator here" across the two parameters.
   */
  const WELL_FORMED_ENTRY = "report=data/config/presets/report.yaml";

  it("declares presetAllowlist as a STRING_ARRAY defaulting to an empty list", () => {
    const parameter = configParameters.find(
      (candidate) => candidate.getName() === "presetAllowlist",
    );

    expect(parameter).toBeDefined();
    expect(parameter).toBeInstanceOf(Core.M3LConfigParameter);
    expect(parameter?.getType()).toBe(Core.M3LConfigParameterType.STRING_ARRAY);
    expect(parameter?.getDefaultValue()).toEqual([]);
    // Not required: an operator who never grants a preset simply declares
    // nothing, and the empty default makes every `run` call fail closed.
    expect(parameter?.isRequired()).toBe(false);
  });

  it("attaches no per-parameter validator to presetAllowlist", async () => {
    const config = await loadAndValidate({
      ...REQUIRED_RAW,
      presetAllowlist: WELL_FORMED_ENTRY,
    });

    expect(config.get("presetAllowlist")).toEqual([WELL_FORMED_ENTRY]);
  });

  // The paired losing arm: the identical raw value on the sibling parameter
  // that DOES declare `eachAllowedScriptName` really is rejected. Without
  // this, the test above would pass just as happily against a build where
  // every validator had been detached from every parameter.
  it("rejects that same entry on dryRunAllowlist, proving the absence above is observable", async () => {
    const thrown = await captureLoadFailure({
      dryRunAllowlist: WELL_FORMED_ENTRY,
    });

    expect(thrown).toBeInstanceOf(Core.M3LConfigValidationError);
    expect((thrown as Core.M3LConfigValidationError).context["parameter"]).toBe(
      "dryRunAllowlist",
    );
  });

  // The heart of Option D: config-load deliberately does NOT know the
  // grammar, so even a syntactically broken entry loads clean here and is
  // rejected later by `parsePresetAllowlist`. A validator re-implementing the
  // grammar in `config.ts` would fail this test — which is the point, since a
  // second copy of the grammar is exactly what would drift.
  it.each([
    ["no '=' separator", "no-equals-sign"],
    ["an escaping path", "report=data/config/presets/../../../etc/passwd"],
    ["an uppercase preset name", "Report=data/config/presets/report.yaml"],
  ])(
    "defers the entry grammar to resolve-runtime: an entry with %s still loads",
    async (_label, entry) => {
      const config = await loadAndValidate({
        ...REQUIRED_RAW,
        presetAllowlist: entry,
      });

      expect(config.get("presetAllowlist")).toEqual([entry]);
    },
  );

  it("defaults presetAllowlist to an empty list when nothing is supplied", async () => {
    const config = await loadAndValidate({ ...REQUIRED_RAW });

    expect(config.get("presetAllowlist")).toEqual([]);
  });
});
