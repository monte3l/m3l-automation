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

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

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

/**
 * V9 slice 2a — the `presetAllowlist` grammar (`parsePresetAllowlist`).
 *
 * `presetAllowlist` carries `"<name>=<path>"` entries and declares NO config
 * validator (the Option D decision): `config.ts` stays grammar-free and this
 * module is the single source of truth, exactly as `modelRates` already is.
 * These tests therefore drive the parser the same way every `modelRates` test
 * above does — through `resolveAgentOperatorRuntime`, never by importing a
 * module-private parser. The observable contract is
 * `settings.presetAllowlist`, a `ReadonlyMap<string, string>`.
 *
 * Every rejection is `M3LAgentOperatorCliError` coded
 * `ERR_AGENT_OPERATOR_CONFIG` with a FIXED message that never echoes the
 * offending entry: these entries are operator-supplied and embed a filesystem
 * path, so re-emitting one in a message would put an attacker-chosen string
 * into whatever renders the failure.
 *
 * The stored value is the entry's RELATIVE path, verbatim as declared — the
 * reviewable form that shows up in a config diff. Joining it onto
 * `workspaceRoot` happens later, at argv-build time in `lib/cli-surface.ts`,
 * because `m3l run` spawns the child with `cwd: scripts/<name>/` and a
 * relative `--preset=` token would resolve under the script directory rather
 * than the workspace.
 */
describe("resolveAgentOperatorRuntime — presetAllowlist parsing", () => {
  /** The fixed rejection messages, verbatim from the slice-2a contract. */
  const MESSAGE = {
    grammar: "'presetAllowlist' entry must be '<name>=<path>'",
    blankName:
      "'presetAllowlist' entry must declare a non-blank preset name with no leading or trailing whitespace",
    disallowedName:
      "'presetAllowlist' entry name must be an allowed preset name",
    duplicateName:
      "'presetAllowlist' must not declare the same preset name more than once",
    blankPath:
      "'presetAllowlist' entry paths must be non-blank with no leading or trailing whitespace",
    controlCharacters:
      "'presetAllowlist' entry must not contain control or format characters",
    absolutePath:
      "'presetAllowlist' entry paths must be workspace-relative, not absolute",
    outsidePresetsDirectory:
      "'presetAllowlist' entry paths must stay within the workspace presets directory",
  } as const;

  /** Resolves `presetAllowlist` and returns whatever the step threw, if anything. */
  function captureFailure(entries: readonly string[]): unknown {
    try {
      resolveAgentOperatorRuntime({
        config: buildConfig({ presetAllowlist: entries }),
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  /** Resolves `presetAllowlist` and returns the parsed map. */
  function resolveAllowlist(
    entries: readonly string[],
  ): ReadonlyMap<string, string> {
    return resolveAgentOperatorRuntime({
      config: buildConfig({ presetAllowlist: entries }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    }).presetAllowlist;
  }

  /**
   * Asserts `entries` is rejected with the contract's exact `message`, coded
   * `ERR_AGENT_OPERATOR_CONFIG`, without echoing any entry.
   */
  function expectRejection(entries: readonly string[], message: string): void {
    const thrown = captureFailure(entries);

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const asError = thrown as M3LAgentOperatorCliError;
    expect(asError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
    expect(asError.message).toBe(message);
    for (const entry of entries) {
      // Guarded because `toContain("")` is true of every string: an empty
      // entry has nothing to echo, so the non-echo check is vacuous for it.
      if (entry !== "") expect(asError.message).not.toContain(entry);
    }
  }

  it("parses '<name>=<path>' entries into a ReadonlyMap of relative paths", () => {
    const allowlist = resolveAllowlist([
      "report=data/config/presets/report.yaml",
      "nightly-sweep=data/config/presets/nightly-sweep.json",
    ]);

    expect(allowlist.size).toBe(2);
    expect(allowlist.get("report")).toBe("data/config/presets/report.yaml");
    expect(allowlist.get("nightly-sweep")).toBe(
      "data/config/presets/nightly-sweep.json",
    );
  });

  // The relative-vs-absolute split is the whole point of storing the declared
  // form: absolutising here would put a machine-specific path in the runtime
  // settings and hide the reviewable one. `cli-surface.ts` joins it onto
  // `workspaceRoot` at argv-build time instead.
  it("stores the declared relative path, never an absolute one", () => {
    const allowlist = resolveAllowlist([
      "report=data/config/presets/report.yaml",
    ]);

    const stored = allowlist.get("report");
    expect(stored).toBeDefined();
    expect(path.isAbsolute(stored ?? "/")).toBe(false);
    expect(stored?.startsWith(path.sep)).toBe(false);
  });

  it("types presetAllowlist as a ReadonlyMap<string, string>", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig(),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });

    expectTypeOf(settings.presetAllowlist).toEqualTypeOf<
      ReadonlyMap<string, string>
    >();
  });

  it("defaults to an empty allowlist when 'presetAllowlist' is unset", () => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig(),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });

    expect(settings.presetAllowlist.size).toBe(0);
  });

  it("rejects an entry with no '=' separator", () => {
    expectRejection(["reportdata/config/presets/report.yaml"], MESSAGE.grammar);
  });

  it("rejects an empty entry", () => {
    expectRejection([""], MESSAGE.grammar);
  });

  /*
   * The two half-empty forms. Both land on the GRAMMAR message rather than on
   * the blank-path (row 5) or blank-name (row 2) message, and they do so by
   * construction: the entry regex is `/^([^=]+)=(.+)$/`, mirroring
   * `MODEL_RATE_ENTRY_RE` exactly, so `(.+)` rejects a wholly absent path and
   * `([^=]+)` rejects a wholly absent name BEFORE either half-specific check
   * can be reached. Keeping one regex shape across both parsers in this module
   * is the reason; the message is also the more useful one for an operator who
   * simply left a half out.
   *
   * These two are therefore the tripwire on that regex: relaxing `(.+)` to
   * `(.*)`, or `([^=]+)` to `([^=]*)`, would reroute these entries to the
   * blank-path/blank-name messages and fail here loudly instead of silently
   * changing which rejection an operator sees.
   */
  it.each([
    ["an absent path", "report="],
    ["an absent name", "=data/config/presets/report.yaml"],
  ])(
    "rejects an entry with %s as a grammar miss, not a blank-half failure",
    (_label, entry) => {
      expectRejection([entry], MESSAGE.grammar);
    },
  );

  // A padded name is rejected rather than trimmed, for the reason the
  // `modelRates` id already is: a trimmed key and an untrimmed capture drift
  // apart silently, and a lookup for `"report"` then misses an entry the
  // operator believes they granted. The contract's table orders the
  // blank/padded-name check BEFORE the allowed-name check, so a padded name
  // surfaces this message and not the allowed-name one (the allowlist regex
  // would reject the space too).
  it.each([
    ["a leading space", " report=data/config/presets/report.yaml"],
    ["a trailing space", "report =data/config/presets/report.yaml"],
    ["a trailing tab", "report\t=data/config/presets/report.yaml"],
    ["only whitespace", " =data/config/presets/report.yaml"],
  ])("rejects an entry whose preset name has %s", (_label, entry) => {
    expectRejection([entry], MESSAGE.blankName);
  });

  // `isAllowedPresetName` is `/^[a-z0-9-]+$/` capped at 64 characters. Each
  // fixture here is non-blank and unpadded and carries no control character,
  // so the allowed-name check is unambiguously the one that must fire.
  it.each([
    ["an uppercase letter", "Report=data/config/presets/report.yaml"],
    ["an underscore", "night_ly=data/config/presets/report.yaml"],
    ["a dot", "report.v2=data/config/presets/report.yaml"],
    ["a slash", "team/report=data/config/presets/report.yaml"],
    [
      "more than 64 characters",
      `${"a".repeat(65)}=data/config/presets/report.yaml`,
    ],
  ])("rejects an entry whose preset name contains %s", (_label, entry) => {
    expectRejection([entry], MESSAGE.disallowedName);
  });

  // The counterweight: tightening the name grammar must not reject the plain
  // forms `/^[a-z0-9-]+$/` really admits. Digits and a leading hyphen are
  // legal here (unlike `AGENT_OPERATOR_SCRIPT_NAME_RE`) — safety comes from
  // allowlist MEMBERSHIP plus the attached `--preset=<path>` argv form, not
  // from the name's shape.
  it.each(["report", "nightly-sweep", "v2", "123", "a"])(
    "still accepts the allowed preset name '%s'",
    (name) => {
      const allowlist = resolveAllowlist([
        `${name}=data/config/presets/report.yaml`,
      ]);

      expect(allowlist.get(name)).toBe("data/config/presets/report.yaml");
    },
  );

  it("still accepts a 64-character preset name (the cap is inclusive)", () => {
    const name = "a".repeat(64);
    const allowlist = resolveAllowlist([
      `${name}=data/config/presets/report.yaml`,
    ]);

    expect(allowlist.get(name)).toBe("data/config/presets/report.yaml");
  });

  // A duplicate is rejected, never merged: `Map.set` would drop the
  // operator's first grant silently, so `run` would target a preset file
  // nobody reading the config diff top-to-bottom would predict. The PATHS
  // differ here deliberately — the check must key on the NAME, not on "two
  // identical entries".
  it("rejects a duplicate preset name even when the two paths differ", () => {
    expectRejection(
      [
        "report=data/config/presets/report.yaml",
        "report=data/config/presets/report-v2.yaml",
      ],
      MESSAGE.duplicateName,
    );
  });

  it("still accepts two entries with distinct preset names", () => {
    const allowlist = resolveAllowlist([
      "report=data/config/presets/report.yaml",
      "sweep=data/config/presets/sweep.yaml",
    ]);

    expect(allowlist.size).toBe(2);
    expect(allowlist.get("report")).toBe("data/config/presets/report.yaml");
    expect(allowlist.get("sweep")).toBe("data/config/presets/sweep.yaml");
  });

  // A padded path gets the same treatment as a padded name, for the same
  // reason: `path.join` would happily absolutise `" data/…"` into a
  // whitespace-prefixed directory name, so tolerating the padding produces a
  // path nobody declared.
  it.each([
    ["only whitespace", "report=   "],
    ["a leading space", "report= data/config/presets/report.yaml"],
    ["a trailing space", "report=data/config/presets/report.yaml "],
    ["a leading tab", "report=\tdata/config/presets/report.yaml"],
  ])("rejects an entry whose path is %s", (_label, entry) => {
    expectRejection([entry], MESSAGE.blankPath);
  });

  it("rejects a path outside the presets directory", () => {
    expectRejection(
      ["report=data/config/other/report.yaml"],
      MESSAGE.outsidePresetsDirectory,
    );
  });

  // The prefix trap: `data/config/presetsevil` starts with the presets
  // directory as a STRING but is a different directory, so a bare
  // `startsWith(presetsDir)` without a separator boundary would accept it.
  it("rejects a sibling directory that merely shares the presets prefix", () => {
    expectRejection(
      ["report=data/config/presetsevil/report.yaml"],
      MESSAGE.outsidePresetsDirectory,
    );
  });

  it("rejects a path that escapes the presets directory with '..'", () => {
    expectRejection(
      ["report=data/config/presets/../../../etc/passwd"],
      MESSAGE.outsidePresetsDirectory,
    );
  });

  // Deliberately stricter than "where does it land": this path NORMALISES
  // back inside the presets directory (`presets/sub/../report.yaml` ->
  // `presets/report.yaml`) and is still rejected, because the contract bans
  // ANY `..` segment. The reason is reviewability, not reachability — a
  // reviewer reading the config diff must be able to see the target directory
  // in the declared string without mentally normalising it, and a
  // normalise-then-compare rule makes the reviewed text and the resolved text
  // two different things (also the point where a symlinked `sub/` would make
  // them genuinely disagree).
  it("rejects a '..' segment even when the path normalises back inside the presets directory", () => {
    expectRejection(
      ["report=data/config/presets/sub/../report.yaml"],
      MESSAGE.outsidePresetsDirectory,
    );
  });

  // A nested path with no `..` stays legal: the rule is about escaping, not
  // about forbidding subdirectories.
  it("still accepts a path in a presets subdirectory", () => {
    const allowlist = resolveAllowlist([
      "report=data/config/presets/team/report.yaml",
    ]);

    expect(allowlist.get("report")).toBe(
      "data/config/presets/team/report.yaml",
    );
  });

  // Absolute is rejected before the containment check (the contract's table
  // order), so even an absolute path that names the presets directory fails
  // with the absolute message. `m3l run`'s child resolves `--preset=` against
  // its own cwd, so the config must declare the workspace-relative form and
  // let `cli-surface.ts` do the joining.
  it.each([
    ["a POSIX absolute path", "report=/etc/passwd"],
    [
      "an absolute path naming the presets directory",
      "report=/data/config/presets/report.yaml",
    ],
  ])("rejects %s", (_label, entry) => {
    expectRejection([entry], MESSAGE.absolutePath);
  });

  /*
   * V9 slice 2a review fix S6 — the three entry helpers are module-private and
   * about to be renamed / made convention-uniform, so nothing below reaches
   * for one. These three rows close the rejection arms that were reachable
   * through `resolveAgentOperatorRuntime` but untested, so the rename lands
   * against a complete behavioural net.
   *
   * They pass against the pre-fix code: they are regression locks on existing
   * behaviour, not proofs of a new contract.
   *
   * One arm stays unobservable from here and cannot be covered at this seam:
   * each helper's `=== undefined` branch (a capture group that "somehow did
   * not participate"). `PRESET_ALLOWLIST_ENTRY_RE` is `/^([^=]+)=(.+)$/s` —
   * both groups are non-optional, so a successful `exec` always fills both and
   * a failed one throws the grammar rejection first. Those branches are
   * defensive only.
   */
  it("rejects the presets directory itself, which names no preset file", () => {
    // The `presetPath.length === prefix.length` arm: `--preset=<a directory>`
    // is never a preset the CLI can load, so the trailing-separator form must
    // not slip through the containment check that its prefix satisfies.
    expectRejection(
      ["report=data/config/presets/"],
      MESSAGE.outsidePresetsDirectory,
    );
  });

  it("rejects the presets directory with no trailing separator", () => {
    // Fails the `startsWith(prefix)` arm instead — the prefix carries the
    // separator, so the bare directory name is not inside it.
    expectRejection(
      ["report=data/config/presets"],
      MESSAGE.outsidePresetsDirectory,
    );
  });

  it("rejects a win32-style '..' segment inside the presets directory", () => {
    // The discriminating fixture for `PATH_SEPARATOR_RE` (`/[/\\]/`): this
    // path DOES satisfy the presets-directory prefix, so the only rule left to
    // reject it is the `..` ban — and splitting on `/` alone would see one
    // segment `sub\..\report.yaml`, never a bare `..`, and accept it. A
    // POSIX host still has to see a `..` written with a backslash, because the
    // declared string is the reviewable artifact and a reviewer must not have
    // to guess which separator the host honours.
    expectRejection(
      ["report=data/config/presets/sub\\..\\report.yaml"],
      MESSAGE.outsidePresetsDirectory,
    );
  });

  /**
   * V9 slice 2a review fix S5 — a REAL drift guard for the presets-directory
   * boundary this parser compares against,
   * `AGENT_OPERATOR_PRESETS_DIRECTORY_PREFIX`, and so for the single private
   * `PRESETS_DIRECTORY` literal in `src/lib/preset-names.ts` that the prefix
   * is derived from.
   *
   * The claim this block answers — "the containment tests are its drift
   * guard" — was made by the parser's own TSDoc; it now lives with the
   * constant, in `PRESETS_DIRECTORY`'s TSDoc, which records its negation.
   * Deliberately cited by symbol and not by line: that citation has already
   * rotted twice, once to a corrected line and once to a deleted one.
   * Before this block the claim was false: every containment fixture in this
   * file hardcodes the same literal the constant holds, so if the CLI's own
   * preset store moved its directory, both sides would stay green together
   * while `--preset=` pointed at a directory the CLI no longer reads. That is
   * a vacuous guard.
   *
   * The real one is modelled on `tests/lib/preset-names.test.ts`'s regex
   * guard: read `packages/m3l-cli/src/presets/store.ts` as TEXT (ADR-0029
   * bars a `scripts/*` package from importing `m3l-cli`, and `presetsDirectory`
   * is module-private upstream anyway) and derive the directory from the
   * helper that composes it. Unlike the regex, upstream builds this value from
   * SEGMENTS — `join(workspaceRoot, ...)` over one segment per path level —
   * so the extraction has to collect the segment list, not a single string
   * literal.
   *
   * `PRESETS_DIRECTORY` is still module-private, but private to
   * `lib/preset-names.ts` now rather than to the module under test — which
   * sees only the exported, derived prefix. Either way no test can read it, so
   * the comparison runs through the observable containment behaviour instead
   * of comparing strings: a path under the upstream-derived directory must be
   * ACCEPTED, and a path one level above it must be rejected. If either side
   * moves independently, that pair fails.
   *
   * Since the hoist that guard reaches further than this file. Both of this
   * script's containment checks — this parser's and `lib/cli-surface.ts`'s
   * use-site re-check — now derive from that one literal, so pinning it here
   * TRANSITIVELY pins the `cli-surface.ts` boundary too. It did not before,
   * when each consumer spelled its own copy and only this one was ever pinned
   * to upstream.
   */
  describe("presets directory — drift guard against the CLI preset store", () => {
    /**
     * Extracts the segment list from upstream's `presetsDirectory` helper in
     * `store.ts` and joins it with `/`, the form `resolve-runtime.ts`
     * compares against a config-declared string.
     */
    function readUpstreamPresetsDirectory(): {
      readonly matched: boolean;
      readonly segments: readonly string[];
      readonly directory: string;
    } {
      // Resolved from this test file's own URL, never `process.cwd()`, so the
      // guard is stable regardless of the invoking working directory.
      const storePath = fileURLToPath(
        new URL(
          "../../../../packages/m3l-cli/src/presets/store.ts",
          import.meta.url,
        ),
      );
      const storeText = readFileSync(storePath, "utf8");
      // Anchored on the helper's full signature so the capture cannot drift
      // onto some other `join(workspaceRoot, ...)` call in the file, and
      // `[^)]*` for the parameter list keeps a rename of `workspaceRoot`'s
      // TYPE annotation from breaking the guard silently. `"[^"]+"` admits
      // only double-quoted segments, which is what Prettier enforces here.
      const match =
        /function presetsDirectory\([^)]*\): string \{\s*return join\(\s*workspaceRoot,\s*((?:"[^"]+"\s*,?\s*)+)\)\s*;/.exec(
          storeText,
        );
      const segments =
        match === null
          ? []
          : [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].flatMap((segment) => {
              const value = segment[1];
              return value === undefined ? [] : [value];
            });
      return {
        matched: match !== null,
        segments,
        directory: segments.join("/"),
      };
    }

    // A guard that silently matches nothing is worse than no guard, so the
    // extraction proves itself FIRST: the helper must have been found and it
    // must have yielded segments.
    it("finds the presets-directory helper in the CLI preset store", () => {
      const upstream = readUpstreamPresetsDirectory();

      expect(upstream.matched).toBe(true);
      expect(upstream.segments.length).toBeGreaterThan(0);
      // Today's value, recorded so a legitimate upstream MOVE is reported
      // here as a drift to follow rather than as a puzzling rejection in the
      // containment tests above (whose fixtures also spell this literal).
      expect(upstream.directory).toBe("data/config/presets");
      // Relative, because the declared entry path is joined onto
      // `workspaceRoot` only at argv-build time.
      expect(path.isAbsolute(upstream.directory)).toBe(false);
    });

    it("accepts a path under the directory the CLI preset store itself composes", () => {
      const { directory } = readUpstreamPresetsDirectory();
      const presetPath = `${directory}/report.yaml`;

      // This is the load-bearing half: the value under test is DERIVED from
      // upstream, so if `store.ts` moves its directory and
      // `resolve-runtime.ts` keeps the old literal, this entry stops being
      // "inside the presets directory" and the parse rejects it here.
      expect(resolveAllowlist([`report=${presetPath}`]).get("report")).toBe(
        presetPath,
      );
    });

    it("rejects a path one level above the derived directory", () => {
      const { segments } = readUpstreamPresetsDirectory();
      const parent = segments.slice(0, -1).join("/");

      // The counterweight: without it, an implementation that accepted
      // everything would pass the test above. Anchoring the parent on the
      // derived segments keeps this side drift-guarded too.
      expectRejection(
        [`report=${parent}/report.yaml`],
        MESSAGE.outsidePresetsDirectory,
      );
    });

    it("rejects a sibling directory that merely shares the derived prefix", () => {
      const { directory } = readUpstreamPresetsDirectory();

      expectRejection(
        [`report=${directory}evil/report.yaml`],
        MESSAGE.outsidePresetsDirectory,
      );
    });
  });
});

/**
 * V9 slice 2a — control/format characters in a `presetAllowlist` entry.
 *
 * The same `\p{C}` class `CONTROL_OR_FORMAT_RE` (`resolve-runtime.ts`)
 * already applies to a model id: Cc, Cf, Co, Cs, Cn — a line feed, a NUL, an
 * ANSI CSI introducer, a DEL, a C1 control, a bidi override. `.trim()` cannot
 * substitute for it: it strips the ENDS only, and does not treat U+0085 (NEL)
 * or U+202E (RLO) as trimmable at all, so an EMBEDDED one otherwise survives
 * into a `Map` value and from there into a spawned `--preset=` argv token, a
 * log line, or a terminal.
 *
 * Every character is assembled with `String.fromCodePoint(...)` rather than
 * pasted as a literal or written as a `\uXXXX` escape: `pnpm
 * check:control-chars` scans tracked files, and a literal control byte in
 * this file would fail that gate.
 */
describe("resolveAgentOperatorRuntime — presetAllowlist character safety", () => {
  const CONTROL_MESSAGE =
    "'presetAllowlist' entry must not contain control or format characters";

  /** Resolves `presetAllowlist` and returns whatever the step threw, if anything. */
  function captureFailure(entries: readonly string[]): unknown {
    try {
      resolveAgentOperatorRuntime({
        config: buildConfig({ presetAllowlist: entries }),
        policy: minimalPolicy(),
        paths: new Core.M3LPaths(),
      });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  const INJECTED: readonly (readonly [string, string])[] = [
    ["a line feed", String.fromCodePoint(0x0a)],
    ["a carriage return", String.fromCodePoint(0x0d)],
    ["a NUL", String.fromCodePoint(0x00)],
    ["an ANSI CSI escape", `${String.fromCodePoint(0x1b)}[2J`],
    ["a DEL", String.fromCodePoint(0x7f)],
    ["a C1 control (NEL)", String.fromCodePoint(0x85)],
    ["a bidi override (RLO)", String.fromCodePoint(0x202e)],
  ];

  // The path side is where the exact message is unambiguous: a path carries
  // no name-grammar check, so the control/format guard is the only rule that
  // can fire. The character sits BETWEEN two ordinary halves of the file
  // name, so `.trim()` genuinely cannot reach it.
  it.each(INJECTED)(
    "rejects an entry whose path embeds %s, without echoing the entry",
    (_label, injected) => {
      const entry = `report=data/config/presets/rep${injected}ort.yaml`;
      const thrown = captureFailure([entry]);

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const asError = thrown as M3LAgentOperatorCliError;
      expect(asError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
      expect(asError.message).toBe(CONTROL_MESSAGE);
      expect(asError.message).not.toContain(entry);
      expect(asError.message).not.toContain(injected);
      expect(asError.message).not.toContain("data/config");
    },
  );

  /*
   * The name side asserts the code and the non-echo rule but NOT one exact
   * message: `isAllowedPresetName`'s `/^[a-z0-9-]+$/` already excludes every
   * `\p{C}` character, and the contract's table orders the allowed-name check
   * before the control-character check — so either message satisfies the
   * contract here. Pinning one would pin an ordering the contract does not
   * promise. What must NOT happen is the character surviving into a `Map` key.
   */
  it.each(INJECTED)(
    "rejects an entry whose preset name embeds %s, without echoing the entry",
    (_label, injected) => {
      // Two distinctive marker halves, as the model-id tests use, so the
      // non-echo assertion has something unambiguous to look for.
      const entry = `alpha${injected}omega=data/config/presets/report.yaml`;
      const thrown = captureFailure([entry]);

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const asError = thrown as M3LAgentOperatorCliError;
      expect(asError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
      expect(asError.message).not.toContain(injected);
      expect(asError.message).not.toContain("alpha");
      expect(asError.message).not.toContain("omega");
    },
  );

  // The counterweight: rejecting control characters must not narrow the path
  // grammar below what a real preset file needs — dots, hyphens, digits,
  // underscores and nested directories all stay legal.
  it.each([
    ["a yaml file", "data/config/presets/nightly-sweep.yaml"],
    ["a json file", "data/config/presets/report_v2.json"],
    ["a nested yml file", "data/config/presets/team/2026-report.yml"],
  ])("still accepts a well-formed path (%s)", (_label, presetPath) => {
    const settings = resolveAgentOperatorRuntime({
      config: buildConfig({ presetAllowlist: [`report=${presetPath}`] }),
      policy: minimalPolicy(),
      paths: new Core.M3LPaths(),
    });

    expect(settings.presetAllowlist.get("report")).toBe(presetPath);
  });
});
