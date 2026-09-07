/**
 * Tests for `steps/build-etl-tools` — the single `run_preset` two-phase tool
 * an ETL-shaped fleet script exposes over `AgentCliSurface.run`.
 *
 * Written RED, before `src/steps/build-etl-tools.ts` exists. Mirrors
 * `build-health-tools.test.ts`'s structure (a pure-boundary `unusedSurface`
 * plus a caller-supplied one for `execute` tests), but the trust boundary
 * here has THREE ordered steps instead of one: a `run` call carries a preset
 * name that is checked for shape, then membership against `presetAllowlist`.
 *
 * There is no per-call profile cross-check against the preset file's own
 * `aws.profile`: `json-etl` declares no `aws.profile` parameter, so
 * `M3LScriptPresetLoader` would reject any preset that tried to carry one
 * (`M3LPresetUnknownKeysError`), and a raw YAML read would miss a value
 * inherited through `extends` anyway (only the preset loader follows it).
 * Instead the guard is structural and fails closed at BUILD time:
 * `buildEtlTools` refuses to construct the tool at all when
 * `deps.scriptDeclaresAwsProfile` is `true`, because the action's `target` is
 * the *operator's own* `aws.profile` — a coarse "is this agent running in a
 * prod context" grade that is only honest for a child script with no AWS
 * target of its own. The moment the target script declares its own
 * `aws.profile`, that grade would be judging a different account than the
 * one actually being mutated, so there must be no path on which the
 * mis-graded tool is ever registered.
 *
 * The single most important property under test: `execute`'s returned
 * `outcome.dryRun` must honestly mirror the phase it was asked to run.
 * `build-health-tools.ts`'s `jsonExecution` helper hardcodes `dryRun: false`
 * for all four of its (single-phase, read-only) tools — reusing it here would
 * corrupt the `dryRunFirst` credit the gate mints from a dry-run phase's
 * reported outcome (see `gate-tool.ts`'s `applyDryRunCredit`).
 */

import { describe, expect, it, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { assertAllowedScriptName } from "../../src/lib/cli-names.js";
import type { AgentOperatorScriptName } from "../../src/lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import type { AgentCliSurface } from "../../src/lib/cli-surface.js";
import {
  AGENT_ETL_TOOL_NAMES,
  buildEtlTools,
} from "../../src/steps/build-etl-tools.js";
import type { BuildEtlToolsDeps } from "../../src/steps/build-etl-tools.js";
import type { TwoPhaseAgentToolSpec } from "../../src/steps/gate-tool.js";
import { makeRunEnvelope } from "../support/cliFakes.js";
import type { FakeRunEnvelope } from "../support/cliFakes.js";
import type { AgentOperatorProjectedRunEnvelope } from "../../src/lib/model-safety.js";

/** The `AWS.M3LBedrockToolContext` every `execute` call in this file uses. */
function toolContext(name: string): AWS.M3LBedrockToolContext {
  return { toolUseId: "tool-use-1", name };
}

/** A surface whose every method rejects — for the pure-boundary tests. */
function unusedSurface(): AgentCliSurface {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error("unexpected CLI call"));
  return {
    list: refuse,
    doctor: refuse,
    inspect: refuse,
    dryRun: refuse,
    run: refuse,
    triageRun: refuse,
  };
}

/** A branded script name, minted once so every fixture shares one value. */
const SCRIPT_NAME: AgentOperatorScriptName =
  assertAllowedScriptName("json-etl");

/** The operator's own resolved `aws.profile` for every fixture below. */
const OPERATOR_PROFILE = "ops-profile";

/** Two allowlisted presets, so a test can target one from `describeAction` and a different one from `execute`. */
function presetAllowlist(): Map<string, string> {
  return new Map([
    ["nightly", "data/config/presets/json-etl/nightly.json"],
    ["weekly", "data/config/presets/json-etl/weekly.json"],
  ]);
}

/**
 * Builds `BuildEtlToolsDeps`, overriding only what a scenario cares about.
 * `scriptDeclaresAwsProfile` defaults to `false` — the only value under
 * which the target script (`json-etl`, which declares no `aws.profile`
 * parameter) can legitimately build this tool at all.
 */
function buildDeps(
  overrides: Partial<BuildEtlToolsDeps> = {},
): BuildEtlToolsDeps {
  return {
    surface: unusedSurface(),
    scriptName: SCRIPT_NAME,
    operatorProfile: OPERATOR_PROFILE,
    presetAllowlist: presetAllowlist(),
    scriptDeclaresAwsProfile: false,
    ...overrides,
  };
}

/** Builds the specs over `deps` and returns the one `run_preset` spec. */
function buildRunPresetSpec(
  deps: BuildEtlToolsDeps = buildDeps(),
): TwoPhaseAgentToolSpec {
  const specs = buildEtlTools(deps);
  const found = specs.find(
    (candidate: TwoPhaseAgentToolSpec) =>
      candidate.name === AGENT_ETL_TOOL_NAMES.runPreset,
  );
  if (found === undefined) {
    throw new Error(`${AGENT_ETL_TOOL_NAMES.runPreset} was not built`);
  }
  return found;
}

/** Captures the thrown value from a zero-argument function, or `undefined`. */
function captureThrown(thunk: () => unknown): unknown {
  try {
    thunk();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("buildEtlTools — registration", () => {
  it("returns exactly one spec, a valid registry tool name, two-phase", () => {
    const specs = buildEtlTools(buildDeps());

    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec).toBeDefined();
    expect(spec?.name).toBe(AGENT_ETL_TOOL_NAMES.runPreset);
    expect(spec?.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    expect(spec?.phases).toBe("dry-run-then-mutate");
  });

  it("declares an input schema with exactly one required property, presetName", () => {
    const spec = buildRunPresetSpec();
    const schema = spec.inputSchema as {
      readonly properties?: Record<string, unknown>;
      readonly required?: readonly string[];
    };

    expect(Object.keys(schema.properties ?? {})).toEqual(["presetName"]);
    expect(schema.required).toEqual(["presetName"]);
  });
});

describe("buildEtlTools — fails closed at BUILD time when the target script has its own AWS target", () => {
  // The action's `target` is the operator's own `aws.profile` — a coarse
  // "is this agent running in a prod context" grade, honest only for a
  // child script with no AWS target of its own. The moment the target
  // script declares its own `aws.profile`, that grade would be judging a
  // different account than the one actually being mutated, so the tool
  // must never be registered at all — refusing per call would still leave
  // a path where a mis-graded mutation gets authorized before the refusal.
  it("throws M3LAgentOperatorCliError at build time and returns no spec, never constructing surface.run", () => {
    const run = vi.fn();
    const deps = buildDeps({
      scriptDeclaresAwsProfile: true,
      surface: { ...unusedSurface(), run },
    });

    const thrown = captureThrown(() => buildEtlTools(deps));

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not echo the script name or any config value in the build-time rejection message", () => {
    const deps = buildDeps({
      scriptDeclaresAwsProfile: true,
      operatorProfile: "SENSITIVE_PROFILE_zz",
    });

    const thrown = captureThrown(() => buildEtlTools(deps));

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain(deps.scriptName);
    expect(error.message).not.toContain("SENSITIVE_PROFILE_zz");
    expect(JSON.stringify(error.context ?? {})).not.toContain(
      "SENSITIVE_PROFILE_zz",
    );
  });

  it("uses the identical fixed message text across two builds with different scriptName/operatorProfile values", () => {
    const first = captureThrown(() =>
      buildEtlTools(
        buildDeps({
          scriptDeclaresAwsProfile: true,
          operatorProfile: "profile-a",
        }),
      ),
    ) as M3LAgentOperatorCliError;
    const second = captureThrown(() =>
      buildEtlTools(
        buildDeps({
          scriptDeclaresAwsProfile: true,
          operatorProfile: "profile-b",
        }),
      ),
    ) as M3LAgentOperatorCliError;

    expect(first).toBeInstanceOf(M3LAgentOperatorCliError);
    expect(second).toBeInstanceOf(M3LAgentOperatorCliError);
    expect(second.message).toBe(first.message);
  });

  it("succeeds and returns exactly one spec when scriptDeclaresAwsProfile is false", () => {
    const specs = buildEtlTools(buildDeps({ scriptDeclaresAwsProfile: false }));

    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe(AGENT_ETL_TOOL_NAMES.runPreset);
  });
});

describe("buildEtlTools — describeAction rejects malformed input before anything is authorized", () => {
  it.each([
    ["a non-object input (number)", 42],
    ["a non-object input (string)", "nightly"],
    ["null", null],
    ["an array", ["nightly"]],
    ["undefined", undefined],
    ["an object with no presetName", {}],
    ["a numeric presetName", { presetName: 7 }],
    ["a null presetName", { presetName: null }],
    ["an object presetName", { presetName: {} }],
    ["a boolean presetName", { presetName: true }],
  ] as ReadonlyArray<readonly [label: string, input: unknown]>)(
    "rejects %s and never calls surface.run",
    (_label, input) => {
      const run = vi.fn();
      const deps = buildDeps({ surface: { ...unusedSurface(), run } });
      const spec = buildRunPresetSpec(deps);

      const thrown = captureThrown(() => spec.describeAction(input));

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      // Every one of these cases is a malformed-input shape-boundary throw
      // from readPresetName — non-object input, an object missing its own
      // presetName, or a presetName that is not a string — and all three
      // are documented as ERR_AGENT_OPERATOR_PRESET, never the copy-pasted
      // ERR_AGENT_OPERATOR_SCRIPT_NAME from build-health-tools.ts's
      // readScriptName (this is a preset name, not a script name).
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_PRESET",
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["uppercase", "Nightly"],
    ["embedded spaces", "night ly"],
    ["path traversal", "../../etc/passwd"],
    ["over the length cap", "a".repeat(100)],
  ] as ReadonlyArray<readonly [label: string, presetName: string]>)(
    "rejects a presetName failing the shape check (%s) and never calls surface.run",
    (_label, presetName) => {
      const run = vi.fn();
      const deps = buildDeps({ surface: { ...unusedSurface(), run } });
      const spec = buildRunPresetSpec(deps);

      const thrown = captureThrown(() => spec.describeAction({ presetName }));

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      // assertAllowedPresetName's shape-check rejection is re-thrown from
      // readPresetName as ERR_AGENT_OPERATOR_PRESET — a bad preset name, not
      // ERR_AGENT_OPERATOR_SCRIPT_NAME (that code names a different failure
      // entirely, on the operator-declared script name, never model input).
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_PRESET",
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects a well-formed presetName that is not a key of presetAllowlist (the membership gate)", () => {
    const run = vi.fn();
    const deps = buildDeps({
      surface: { ...unusedSurface(), run },
    });
    const spec = buildRunPresetSpec(deps);

    // Well-formed per AGENT_OPERATOR_PRESET_NAME_RE, but never declared in
    // presetAllowlist — the regex alone would accept it.
    const thrown = captureThrown(() =>
      spec.describeAction({ presetName: "unlisted-preset" }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    // The membership gate is the load-bearing layer (the shape check alone
    // accepts "-h" and "123"), and it too is coded ERR_AGENT_OPERATOR_PRESET
    // — an operator triaging by code must land on "bad preset name" here,
    // not on the unrelated ERR_AGENT_OPERATOR_SCRIPT_NAME.
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("never echoes the rejected presetName back in the thrown message", () => {
    const hostile = "HOSTILE_VALUE_zz".repeat(50);
    const deps = buildDeps();
    const spec = buildRunPresetSpec(deps);

    const thrown = captureThrown(() =>
      spec.describeAction({ presetName: hostile }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain("HOSTILE_VALUE_zz");
    expect(JSON.stringify(error.context ?? {})).not.toContain(
      "HOSTILE_VALUE_zz",
    );
  });

  it("never echoes a valid-but-unlisted presetName back in the thrown message either", () => {
    const hostile = "not-declared-anywhere-zz";
    const deps = buildDeps();
    const spec = buildRunPresetSpec(deps);

    const thrown = captureThrown(() =>
      spec.describeAction({ presetName: hostile }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain(hostile);
    expect(JSON.stringify(error.context ?? {})).not.toContain(hostile);
  });
});

describe("buildEtlTools — describeAction rejects any array outright, regardless of what it carries", () => {
  // `gate-tool.ts`'s `snapshotInputOrRefuse` freezes ONE reading of `input`
  // so `describeAction` and every `execute` call see identical values —
  // fixing the hole where phase 1 authorized one preset and phase 2 mutated
  // a different one. It deliberately passes ARRAYS through un-snapshotted
  // (`{ ...someArray }` would convert an array into an object with numeric
  // keys and corrupt the shape a spec's own rejection depends on).
  //
  // `readPresetName`'s own `typeof input !== "object"` guard does not close
  // that gap: `typeof [] === "object"`, so an array reaches every check below
  // exactly like a plain object would. An array carrying an own `presetName`
  // getter that returns a different value per read is therefore still able
  // to diverge between `describeAction` and `execute` UNLESS arrays are
  // rejected outright, before the shape check and before the allowlist check
  // ever run. Reachability today is blocked upstream (the Bedrock document
  // layer's `isPlainObject` rejects arrays before dispatch), so this is
  // defence-in-depth on a security boundary — closed anyway, per this
  // programme's own prior "unreachable today" mistake.

  it("rejects a bare empty array", () => {
    const run = vi.fn();
    const deps = buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildRunPresetSpec(deps);

    const thrown = captureThrown(() => spec.describeAction([]));

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
    expect(run).not.toHaveBeenCalled();
  });

  // The discriminating case. Today the module rejects a bare array only
  // INCIDENTALLY: `Object.hasOwn(["nightly"], "presetName")` is false, so it
  // trips the missing-own-property branch. The moment an array carries its
  // own VALID presetName — one that both passes the shape regex and is a
  // member of `presetAllowlist` — every existing check passes and the call
  // currently SUCCEEDS. It must still be rejected for BEING AN ARRAY: if it
  // were not, the array path would authorize successfully with an
  // operator-allowlisted name, which is exactly the shape the getter case
  // below exploits to diverge between describeAction and execute.
  it("rejects an array whose own static presetName IS a member of the allowlist", () => {
    const run = vi.fn();
    const deps = buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildRunPresetSpec(deps);
    const hostileArray: unknown = Object.assign([], {
      presetName: "nightly",
    });

    const thrown = captureThrown(() => spec.describeAction(hostileArray));

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an array carrying an own presetName getter that returns a different value per read, in both describeAction and execute, without ever calling surface.run", async () => {
    const run = vi.fn();
    const deps = buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildRunPresetSpec(deps);
    const readings = ["nightly", "weekly"];
    let readIndex = 0;
    const hostileArray: unknown[] = [];
    Object.defineProperty(hostileArray, "presetName", {
      enumerable: true,
      configurable: true,
      get: () => {
        const value = readings[readIndex % readings.length];
        readIndex += 1;
        return value;
      },
    });

    const describeThrown = captureThrown(() =>
      spec.describeAction(hostileArray),
    );
    let executeThrown: unknown;
    try {
      await spec.execute(
        hostileArray,
        toolContext(AGENT_ETL_TOOL_NAMES.runPreset),
        { dryRun: true },
      );
    } catch (error) {
      executeThrown = error;
    }

    expect(describeThrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((describeThrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
    expect(executeThrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((executeThrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe("buildEtlTools — describeAction's action shape", () => {
  it("returns the exact declared action shape, kind never derived from input", () => {
    const deps = buildDeps();
    const spec = buildRunPresetSpec(deps);

    const action = spec.describeAction({
      presetName: "nightly",
      // A model asserting its own kind must never win.
      kind: "read-only",
    });

    expect(action).toEqual({
      script: deps.scriptName,
      operation: "run",
      kind: "mutating",
      target: { profile: deps.operatorProfile },
      parameterNames: ["presetName"],
    });
  });

  it("does NOT set dryRun on the described action (checked via Object.hasOwn, not toHaveProperty)", () => {
    // `not.toHaveProperty` falls back to the `in` operator and walks the
    // prototype chain, so it can never fail here — Object.hasOwn is the only
    // check that can actually catch a stray `dryRun` own-property.
    const spec = buildRunPresetSpec();

    const action = spec.describeAction({ presetName: "nightly" });

    expect(Object.hasOwn(action, "dryRun")).toBe(false);
  });

  it("produces the identical shape-key fields across two calls with the same presetName", () => {
    const spec = buildRunPresetSpec();

    const first = spec.describeAction({ presetName: "nightly" });
    const second = spec.describeAction({ presetName: "nightly" });

    expect({
      script: second.script,
      operation: second.operation,
      kind: second.kind,
      parameterNames: second.parameterNames,
    }).toEqual({
      script: first.script,
      operation: first.operation,
      kind: first.kind,
      parameterNames: first.parameterNames,
    });
  });
});

describe("buildEtlTools — execute", () => {
  /** A run envelope carrying `exitCode`, wrapped as `AgentCliSurface.run` resolves it. */
  function runEnvelope(
    overrides: Partial<FakeRunEnvelope> = {},
  ): AgentOperatorProjectedRunEnvelope {
    const envelope = makeRunEnvelope(overrides);
    return envelope as unknown as AgentOperatorProjectedRunEnvelope;
  }

  it("phase.dryRun === true calls surface.run with mode 'dry-run' and reports outcome.dryRun === true", async () => {
    const run = vi.fn(() => Promise.resolve(runEnvelope({ exitCode: 0 })));
    const deps = buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildRunPresetSpec(deps);

    const result = await spec.execute(
      { presetName: "nightly" },
      toolContext(AGENT_ETL_TOOL_NAMES.runPreset),
      { dryRun: true },
    );

    expect(run).toHaveBeenCalledWith(deps.scriptName, "nightly", {
      mode: "dry-run",
    });
    expect(result.outcome.dryRun).toBe(true);
  });

  it("phase.dryRun === false calls surface.run with mode 'mutate' and reports outcome.dryRun === false", async () => {
    const run = vi.fn(() => Promise.resolve(runEnvelope({ exitCode: 0 })));
    const deps = buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildRunPresetSpec(deps);

    const result = await spec.execute(
      { presetName: "nightly" },
      toolContext(AGENT_ETL_TOOL_NAMES.runPreset),
      { dryRun: false },
    );

    expect(run).toHaveBeenCalledWith(deps.scriptName, "nightly", {
      mode: "mutate",
    });
    expect(result.outcome.dryRun).toBe(false);
  });

  it("mirrors the envelope's non-zero exitCode onto outcome.exitCode", async () => {
    const run = vi.fn(() => Promise.resolve(runEnvelope({ exitCode: 7 })));
    const deps = buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildRunPresetSpec(deps);

    const result = await spec.execute(
      { presetName: "nightly" },
      toolContext(AGENT_ETL_TOOL_NAMES.runPreset),
      { dryRun: false },
    );

    expect(result.outcome.exitCode).toBe(7);
  });

  it("re-reads presetName from its own input rather than a value threaded from describeAction", async () => {
    const run = vi.fn(() => Promise.resolve(runEnvelope({ exitCode: 0 })));
    const deps = buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildRunPresetSpec(deps);

    // describeAction is called with "nightly" — the gate's actual call
    // pattern — but execute is handed a DIFFERENT (also allowlisted) preset
    // name directly, exactly as the gate would if it re-derived input per
    // call. A cached value from describeAction would still report "nightly".
    spec.describeAction({ presetName: "nightly" });
    await spec.execute(
      { presetName: "weekly" },
      toolContext(AGENT_ETL_TOOL_NAMES.runPreset),
      { dryRun: false },
    );

    expect(run).toHaveBeenCalledWith(deps.scriptName, "weekly", {
      mode: "mutate",
    });
  });
});

describe("buildEtlTools — [KNOWN BUG src/steps/build-etl-tools.ts:249] the build-time refusal fails OPEN on anything but literal false", () => {
  // Proven by an executed probe, not by reading: deleting the
  // `scriptDeclaresAwsProfile` key from deps yields `BUILT 1`. The guard at
  // build-etl-tools.ts:249 is `if (deps.scriptDeclaresAwsProfile)` — a
  // truthiness test — so `undefined`, `null`, and an entirely ABSENT key all
  // build the tool. The module's whole soundness argument ("no spec is ever
  // registered, so no call can reach a mis-graded authorization") rests on
  // this one boolean, and the failure direction is toward REGISTERING a
  // mutating tool whose judged `target` is the wrong AWS account.
  //
  // The canonical treatment of exactly this shape already lives in this repo
  // at packages/m3l-common/src/internal/agent/decide.ts:166-181 (a VERDICT
  // guard that escalates on truthiness because `=== true` there "would be a
  // fail-open hole in the place with the widest blast radius") and its
  // `allOperations` sibling a few lines below (an OPT-IN gate requiring the
  // literal `=== true`, never a plain truthiness read). This guard is the
  // OPT-OUT mirror of that opt-in: it must require the opposite literal,
  // `=== false`, to let construction proceed. Anything else — including an
  // absent key — must refuse.

  /** Every non-`false` value the current truthiness guard mishandles. */
  const NOT_LITERAL_FALSE: ReadonlyArray<
    readonly [label: string, value: unknown]
  > = [
    ["boolean true", true],
    ["undefined", undefined],
    ["null", null],
    ["number 0", 0],
    ["empty string", ""],
    ['string "false"', "false"],
    ["empty object", {}],
    ["empty array", []],
  ];

  it.each(NOT_LITERAL_FALSE)(
    "refuses and returns no spec when scriptDeclaresAwsProfile is %s (not the literal false)",
    (_label, value) => {
      // Cast through `unknown`: these values simulate what an untyped JSON
      // config load can hand `BuildEtlToolsDeps` at runtime, which the
      // static `boolean` type in the interface does not itself prevent.
      const deps = {
        ...buildDeps(),
        scriptDeclaresAwsProfile: value,
      } as unknown as BuildEtlToolsDeps;

      const thrown = captureThrown(() => buildEtlTools(deps));

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    },
  );

  it("refuses when scriptDeclaresAwsProfile is entirely ABSENT from deps, not merely falsy", () => {
    const full = buildDeps();
    const { scriptDeclaresAwsProfile: _omitted, ...rest } = full;
    // The key never exists on this object at all — distinct from every case
    // above, where the key is present with a falsy-but-not-false value.
    const deps = rest as unknown as BuildEtlToolsDeps;

    const thrown = captureThrown(() => buildEtlTools(deps));

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it("succeeds and returns exactly one spec ONLY when scriptDeclaresAwsProfile is the literal false", () => {
    const specs = buildEtlTools(buildDeps({ scriptDeclaresAwsProfile: false }));

    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe(AGENT_ETL_TOOL_NAMES.runPreset);
  });

  it("keeps the rejection message fixed text that never echoes the rejected value", () => {
    const deps = {
      ...buildDeps(),
      scriptDeclaresAwsProfile: "SENSITIVE_VALUE_zz",
    } as unknown as BuildEtlToolsDeps;

    const thrown = captureThrown(() => buildEtlTools(deps));

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain("SENSITIVE_VALUE_zz");
    expect(JSON.stringify(error.context ?? {})).not.toContain(
      "SENSITIVE_VALUE_zz",
    );
  });
});
