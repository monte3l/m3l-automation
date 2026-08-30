/**
 * Tests for `steps/resolve-runtime` — the pure function narrowing a resolved
 * `Core.M3LConfig` (plus the validated policy and the paths port) into
 * `agent-operator`'s typed runtime settings (PR 1).
 *
 * Contract pins for this RED phase (test-author decision, since the PR 1
 * spec leaves the exact export name open): the step is named
 * `resolveAgentOperatorRuntime`, returning an `AgentOperatorRuntimeSettings`.
 * The implementer must match these names exactly — see the accompanying
 * report for the naming rationale.
 *
 * Every `Core.M3LConfigAccessor` failure and the `maxIterations` vs.
 * `policy.budgets.loopIterations` cross-check throw `Core.M3LError`/
 * `M3LAgentOperatorCliError` coded `ERR_AGENT_OPERATOR_CONFIG`. The
 * `cliEntrypoint` default additionally throws
 * `ERR_AGENT_OPERATOR_CLI_ENTRYPOINT` when `M3LPaths.getProjectRoot()` is
 * unavailable (standalone mode) and no explicit `cliEntrypoint` was set.
 */

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { resolveAgentOperatorRuntime } from "../../src/steps/resolve-runtime.js";
import { minimalPolicy } from "../support/policyFixtures.js";

/** A policy declaring `budgets.loopIterations`, so the cross-check has a ceiling to compare against. */
function policyWithLoopIterationsBudget(
  loopIterations: number,
): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy({
    version: 1,
    scripts: [{ script: "agent-operator", allOperations: true }],
    budgets: { loopIterations },
  });
}

function buildConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Core.M3LConfig {
  const config = new Core.M3LConfig();
  config.set(Core.AWS_PROFILE_PARAM_NAME, "sandbox");
  config.set("command", "explain-policy");
  config.set("modelId", "anthropic.claude-3-5-sonnet-20241022-v2:0");
  for (const [name, value] of Object.entries(overrides)) {
    config.set(name, value);
  }
  return config;
}

beforeEach(() => {
  // `M3LExecutionEnvironment.detect()` (invoked by `new Core.M3LPaths()`) is
  // memoized at module scope — without this reset, whichever test in this
  // file constructs an `M3LPaths` first permanently caches that test's
  // deployment mode, and every later `vi.stubEnv("M3L_DEPLOYMENT_MODE", …)`
  // becomes a no-op.
  Core.M3LExecutionEnvironment.resetForTesting();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAgentOperatorRuntime — model rate parsing", () => {
  it("parses '<modelId>=<inputPer1k>,<outputPer1k>' entries into a ReadonlyMap", () => {
    const config = buildConfig({
      modelRates: [
        "anthropic.claude-3-5-sonnet-20241022-v2:0=3,15",
        "anthropic.claude-3-haiku-20240307-v1:0=0.25,1.25",
      ],
    });

    const settings = resolveAgentOperatorRuntime({
      config,
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });

    expect(
      settings.modelRates.get("anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).toEqual({ inputPer1kTokens: 3, outputPer1kTokens: 15 });
    expect(
      settings.modelRates.get("anthropic.claude-3-haiku-20240307-v1:0"),
    ).toEqual({ inputPer1kTokens: 0.25, outputPer1kTokens: 1.25 });
  });

  it("defaults to an empty rate map when 'modelRates' is unset", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig(),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });
    expect(settings.modelRates.size).toBe(0);
  });

  it.each([
    ["missing '='", "anthropic.claude-3-5-sonnet-20241022-v2:0:3,15"],
    ["missing the output rate", "anthropic.claude-3-5-sonnet-20241022-v2:0=3"],
    [
      "a non-numeric input rate",
      "anthropic.claude-3-5-sonnet-20241022-v2:0=abc,15",
    ],
    [
      "a negative output rate",
      "anthropic.claude-3-5-sonnet-20241022-v2:0=3,-15",
    ],
    [
      "a non-finite input rate",
      "anthropic.claude-3-5-sonnet-20241022-v2:0=Infinity,15",
    ],
    [
      "a NaN-producing input rate",
      "anthropic.claude-3-5-sonnet-20241022-v2:0=NaN,15",
    ],
  ])("rejects a modelRates entry with %s", (_label, entry) => {
    const config = buildConfig({ modelRates: [entry] });
    expect(() =>
      resolveAgentOperatorRuntime({
        config,
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      }),
    ).toThrow(M3LAgentOperatorCliError);
    let thrown: unknown;
    try {
      resolveAgentOperatorRuntime({
        config,
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  // Regression: the parser used to validate the model id against its
  // trimmed form but key the resulting map entry with the UNTRIMMED
  // capture, so " my-model =3,15" was stored under " my-model " and every
  // later `settings.modelRates.get("my-model")` lookup silently missed —
  // making the model's cost unobservable rather than throwing. The fix
  // rejects a padded id outright; this locks that in for a leading space, a
  // trailing space, and an embedded tab.
  it.each([
    ["a leading space", " my-model=3,15"],
    ["a trailing space", "my-model =3,15"],
    ["a tab", "my-model\t=3,15"],
  ])(
    "rejects a modelRates entry whose model id has %s, without echoing the id",
    (_label, entry) => {
      const config = buildConfig({ modelRates: [entry] });
      let thrown: unknown;
      try {
        resolveAgentOperatorRuntime({
          config,
          policy: minimalPolicy(),
          paths: new Core.M3LPaths(),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const asError = thrown as M3LAgentOperatorCliError;
      expect(asError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
      expect(asError.message).not.toContain("my-model");
    },
  );
});

/**
 * PR #769 finding 3 — the `modelRates` grammar's two remaining
 * inconsistencies, both of which today produce a silently WRONG rate map
 * rather than a rejection:
 *
 * 1. A duplicate model id across two entries overwrites the first
 *    (`Map.set`), so the operator's earlier declaration disappears without a
 *    word and cost accounting silently uses the later one.
 * 2. Rates are coerced with a bare `Number(...)`, which tolerates surrounding
 *    whitespace (`Number("  3 ") === 3`) and treats a blank string as zero
 *    (`Number(" ") === 0`) — while a whitespace-padded model id is explicitly
 *    rejected on the very next line. One half of an entry may be padded and
 *    the other may not, which is not a grammar so much as an accident.
 *
 * Both must throw `M3LAgentOperatorCliError` coded
 * `ERR_AGENT_OPERATOR_CONFIG`, like every other `modelRates` rejection.
 */
describe("resolveAgentOperatorRuntime — model rate grammar consistency", () => {
  /** Resolves `modelRates` and returns whatever the step threw, if anything. */
  function captureFailure(entries: readonly string[]): unknown {
    try {
      resolveAgentOperatorRuntime({
        config: buildConfig({ modelRates: entries }),
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("rejects a duplicate model id instead of silently overwriting the first entry", () => {
    const thrown = captureFailure([
      "anthropic.claude-repeated-v1:0=1,2",
      "anthropic.claude-repeated-v1:0=3,4",
    ]);

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const asError = thrown as M3LAgentOperatorCliError;
    expect(asError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
    // Same non-echo rule as every other message in this module: a model id can
    // be operator- or model-supplied text and never belongs in an error.
    expect(asError.message).not.toContain("claude-repeated");
  });

  // Distinct ids must still coexist — the duplicate check must key on the id,
  // not merely on "more than one entry was supplied".
  it("still accepts two entries with distinct model ids", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({
        modelRates: ["model-a=1,2", "model-b=3,4"],
      }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });

    expect(settings.modelRates.size).toBe(2);
    expect(settings.modelRates.get("model-a")).toEqual({
      inputPer1kTokens: 1,
      outputPer1kTokens: 2,
    });
    expect(settings.modelRates.get("model-b")).toEqual({
      inputPer1kTokens: 3,
      outputPer1kTokens: 4,
    });
  });

  it.each([
    ["a padded input rate", "model-a=  3 ,15"],
    ["a leading-space input rate", "model-a= 3,15"],
    ["a padded output rate", "model-a=3, 15 "],
    ["a tab-padded output rate", "model-a=3,\t15"],
    ["a blank input rate", "model-a= ,15"],
    ["a blank output rate", "model-a=3,   "],
  ])(
    "rejects a modelRates entry with %s, matching how a padded model id is treated",
    (_label, entry) => {
      const thrown = captureFailure([entry]);

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    },
  );

  // The counterweight to the padded-rate rejections above: tightening the
  // grammar must not start rejecting the ordinary numeric forms the reference
  // page documents. These pass against today's code too — they are a
  // regression lock on the fix, not a proof of it.
  it.each([
    ["plain integers", "model-a=3,15", 3, 15],
    ["plain decimals", "model-a=0.003,0.015", 0.003, 0.015],
    ["a leading-zero decimal pair", "model-a=0.25,1.25", 0.25, 1.25],
    ["zero rates", "model-a=0,0", 0, 0],
  ])(
    "still parses a well-formed entry with %s",
    (_label, entry, expectedInput, expectedOutput) => {
      const settings = resolveAgentOperatorRuntime({
        config: buildConfig({ modelRates: [entry] }),
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      });

      expect(settings.modelRates.get("model-a")).toEqual({
        inputPer1kTokens: expectedInput,
        outputPer1kTokens: expectedOutput,
      });
    },
  );
});

/**
 * PR #769 audit — a `modelRates` model id may today contain an EMBEDDED
 * control character, and a rate of `-0` passes a guard whose own message
 * promises "non-negative".
 *
 * `MODEL_RATE_ENTRY_RE`'s id capture is `[^=]+`: it admits every character
 * except `=`, including a newline, a NUL, an ANSI CSI escape, a DEL, a C1
 * control, and a bidi override. The only id guard compares the capture with
 * its own `.trim()`, and `.trim()` strips the ENDS only — so an id whose
 * control character sits in the MIDDLE passes the guard unchanged and becomes
 * a `Map` key.
 *
 * That is inert while `modelRates` is unconsumed (`run-agent-operator.ts`
 * binds the runtime to `_runtime`), but the follow-up slice logs and renders
 * model ids, at which point an operator-supplied CSI sequence in a config
 * value is terminal injection and an embedded line feed is log-line
 * injection. Closing it here, before the first consumer exists, is cheaper
 * than auditing every future render site.
 *
 * Every case must throw `M3LAgentOperatorCliError` coded
 * `ERR_AGENT_OPERATOR_CONFIG`, and — per this module's standing rule that
 * config-supplied text never enters a message — must not echo the id.
 *
 * Control characters are assembled with `String.fromCodePoint(...)` rather
 * than pasted as literals: `pnpm check:control-chars` scans tracked files and
 * a literal control byte in this file would fail that gate.
 */
describe("resolveAgentOperatorRuntime — model id character safety", () => {
  /** Resolves `modelRates` and returns whatever the step threw, if anything. */
  function captureFailure(entries: readonly string[]): unknown {
    try {
      resolveAgentOperatorRuntime({
        config: buildConfig({ modelRates: entries }),
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  /**
   * Builds a `modelRates` entry whose model id carries `injected` between two
   * ordinary marker halves, so the character under test is unambiguously
   * EMBEDDED (not leading/trailing, which `.trim()` already catches) and the
   * markers give the non-echo assertion something specific to look for.
   */
  function entryWithInjectedId(injected: string): string {
    return `alpha${injected}omega=3,15`;
  }

  it.each([
    ["a line feed", String.fromCodePoint(0x0a)],
    ["a carriage return", String.fromCodePoint(0x0d)],
    ["a tab", String.fromCodePoint(0x09)],
    ["a NUL", String.fromCodePoint(0x00)],
    ["an ANSI CSI escape", `${String.fromCodePoint(0x1b)}[2J`],
    ["a DEL", String.fromCodePoint(0x7f)],
    ["a C1 control (NEL)", String.fromCodePoint(0x85)],
    ["a bidi override (RLO)", String.fromCodePoint(0x202e)],
  ])(
    "rejects a modelRates entry whose model id embeds %s, without echoing the id",
    (_label, injected) => {
      const thrown = captureFailure([entryWithInjectedId(injected)]);

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const asError = thrown as M3LAgentOperatorCliError;
      expect(asError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
      expect(asError.message).not.toContain("alpha");
      expect(asError.message).not.toContain("omega");
      expect(asError.message).not.toContain(injected);
    },
  );

  // The counterweight: rejecting control characters must not narrow the id
  // grammar down to something the real Bedrock ids no longer fit. Dots,
  // hyphens, underscores and the `:0` inference-profile suffix all stay legal.
  it.each([
    ["a full Bedrock model id", "anthropic.claude-sonnet-4-5-20250929-v1:0"],
    ["a bare hyphenated id", "model-a"],
    ["dot, underscore, hyphen and colon", "a.b_c-d:0"],
  ])("still parses a well-formed model id (%s)", (_label, modelId) => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ modelRates: [`${modelId}=3,15`] }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });

    expect(settings.modelRates.get(modelId)).toEqual({
      inputPer1kTokens: 3,
      outputPer1kTokens: 15,
    });
  });

  // `parseModelRateValue` rejects with `rate < 0`, which is `false` for `-0`
  // (`-0 < 0` is `false`), so `-0` survives a guard whose message says
  // "non-negative finite numbers". The stored rate then renders as `0`
  // everywhere, so the damage is cosmetic — but the guard should mean what it
  // says, and `Object.is(rate, -0)` is observable to any future consumer.
  it.each([
    ["a negative-zero output rate", "m=1,-0"],
    ["a negative-zero input rate", "m=-0,1"],
    ["a negative-zero decimal output rate", "m=1,-0.0"],
  ])("rejects a modelRates entry with %s", (_label, entry) => {
    const thrown = captureFailure([entry]);

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  // The counterweight to the `-0` rejections: a plain `0` is a legitimate
  // rate and must still parse — as POSITIVE zero, which `toEqual` would not
  // distinguish from `-0`, hence `Object.is`.
  it("still parses a zero rate, as positive zero", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ modelRates: ["m=0,0"] }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });

    const rate = settings.modelRates.get("m");
    expect(rate).toBeDefined();
    expect(Object.is(rate?.inputPer1kTokens, 0)).toBe(true);
    expect(Object.is(rate?.outputPer1kTokens, 0)).toBe(true);
  });
});

describe("resolveAgentOperatorRuntime — maxIterations vs. policy.budgets.loopIterations", () => {
  it("passes when maxIterations equals the declared loopIterations ceiling", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ maxIterations: 8 }),
      policy: policyWithLoopIterationsBudget(8),
      paths: new Core.M3LPaths(),
    });
    expect(settings.maxIterations).toBe(8);
  });

  it("throws ERR_AGENT_OPERATOR_CONFIG when maxIterations exceeds the declared loopIterations ceiling", () => {
    let thrown: unknown;
    try {
      resolveAgentOperatorRuntime({
        config: buildConfig({ maxIterations: 9 }),
        policy: policyWithLoopIterationsBudget(8),
        paths: new Core.M3LPaths(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it("skips the cross-check entirely when the policy declares no loopIterations budget", () => {
    // A ceiling this high would fail the cross-check if a budget were
    // declared — this proves absence genuinely skips the check rather than
    // comparing against an implicit ceiling.
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ maxIterations: 1000 }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });
    expect(settings.maxIterations).toBe(1000);
  });
});

describe("resolveAgentOperatorRuntime — cliEntrypoint default", () => {
  it("defaults to <projectRoot>/packages/m3l-cli/bin/m3l.mjs when unset", () => {
    const paths = new Core.M3LPaths();
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig(),
      policy: minimalPolicy(),
      paths,
    });
    expect(settings.cliEntrypoint).toBe(
      path.join(
        paths.getProjectRoot(),
        "packages",
        "m3l-cli",
        "bin",
        "m3l.mjs",
      ),
    );
  });

  it("uses the explicit cliEntrypoint when set, never touching getProjectRoot()", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ cliEntrypoint: "/opt/custom/m3l.mjs" }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });
    expect(settings.cliEntrypoint).toBe("/opt/custom/m3l.mjs");
  });

  it("throws ERR_AGENT_OPERATOR_CLI_ENTRYPOINT, not a raw M3LPathResolutionError, when getProjectRoot() is unavailable in standalone mode", () => {
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "standalone");
    vi.stubEnv("M3L_BASE_DIR", "/tmp");
    const paths = new Core.M3LPaths();

    // Sanity: this really is the standalone-mode throw the step must catch.
    expect(() => paths.getProjectRoot()).toThrow(Core.M3LPathResolutionError);

    let thrown: unknown;
    try {
      resolveAgentOperatorRuntime({
        config: buildConfig(),
        policy: minimalPolicy(),
        paths,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect(thrown).not.toBeInstanceOf(Core.M3LPathResolutionError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CLI_ENTRYPOINT",
    );
  });
});
