/**
 * Tests for `steps/build-triage-tools` — the single `triage_logs`
 * single-phase tool that drives `cloudwatch-logs-analysis`'s `analyze` verb
 * through the existing `run` argv shape.
 *
 * Written RED, before `src/steps/build-triage-tools.ts` (and its
 * `src/lib/triage-presets.ts` dependency) exist. Mirrors
 * `build-etl-tools.test.ts`'s structure (a pure-boundary `unusedSurface` plus
 * a caller-supplied one for `execute` tests), but this module is
 * SINGLE-phase: `execute` takes `(input, context)` with no `phase` parameter,
 * because there is no dry-run rehearsal here — `analyze` is read-only by
 * construction (finding F3).
 *
 * Two properties this file exists specifically to close (slice 4 findings):
 *
 * - F3, structural half: `buildTriageTools` must refuse any `scriptName`
 *   other than `TRIAGE_TARGET_SCRIPT`. The read-only claim `describeAction`
 *   asserts is only sound for the one script whose read-only verb set this
 *   module knows; nothing in this module reads the target script's actual
 *   operation, so pinning the target at build time is the only thing
 *   standing between "cloudwatch-logs-analysis" and a mutating script (e.g.
 *   `json-etl`) reaching a `read-only` verdict through this tool.
 * - F3, execute half: `mode: "mutate"` passed to `surface.run` is a FIXED
 *   literal, never derived from `input` or from the judged `kind` — it means
 *   "omit the trailing `--dry-run` token", i.e. run `analyze` for real. A
 *   test asserting the exact third argument is what keeps a future refactor
 *   from quietly deriving it from something model-influenced.
 *
 * `VerifiedTriagePresets` is minted here by calling the real
 * `verifyTriagePresets` with an injected `readProvider` stub — never a cast
 * — so this file's `presetAllowlist` fixture is not vacuous about the brand
 * `build-triage-tools.ts` consumes.
 */

import { describe, expect, it, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { assertAllowedScriptName } from "../../src/lib/cli-names.js";
import type { AgentOperatorScriptName } from "../../src/lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import type { AgentCliSurface } from "../../src/lib/cli-surface.js";
import {
  AGENT_TRIAGE_TOOL_NAMES,
  TRIAGE_TARGET_SCRIPT,
  buildTriageTools,
} from "../../src/steps/build-triage-tools.js";
import type { BuildTriageToolsDeps } from "../../src/steps/build-triage-tools.js";
import { verifyTriagePresets } from "../../src/lib/triage-presets.js";
import type { VerifiedTriagePresets } from "../../src/lib/triage-presets.js";
import type { AgentToolSpec } from "../../src/steps/gate-tool.js";
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

/** The branded target-script name, minted once so every fixture shares one value. */
const SCRIPT_NAME: AgentOperatorScriptName =
  assertAllowedScriptName(TRIAGE_TARGET_SCRIPT);

/** The operator's own resolved `aws.profile` for every fixture below. */
const OPERATOR_PROFILE = "ops-profile";

/** The one allowlisted triage preset every fixture below shares. */
const PRESET_NAME = "checkout-5xx";
const PRESET_PATH = "data/config/presets/triage-checkout-5xx.yaml";

/** The workspace-relative name -> path map underlying `mintVerifiedPresets`. */
function presetAllowlistEntries(): Map<string, string> {
  return new Map([[PRESET_NAME, PRESET_PATH]]);
}

/**
 * Mints a real `VerifiedTriagePresets` by calling `verifyTriagePresets` with
 * an injected `readProvider` stub — never a cast. The stub deliberately
 * ignores the `absolutePath` argument it's called with (ties this fixture to
 * no particular path-join scheme `verifyTriagePresets` may choose) and
 * answers every lookup with a single raw record: `{ operation: "analyze" }`.
 * That record has no `extends` key and no `aws.profile` key, and its
 * `operation` value is a documented member of `TRIAGE_READ_ONLY_OPERATIONS`
 * ("analyze, validate, explain") — so it clears every one of
 * `verifyTriagePresets`'s four ordered checks for every entry in `entries`.
 */
function mintVerifiedPresets(
  entries: ReadonlyMap<string, string> = presetAllowlistEntries(),
): Promise<VerifiedTriagePresets> {
  const raw: Readonly<Record<string, unknown>> = Object.freeze({
    operation: "analyze",
  });
  return verifyTriagePresets({
    presetAllowlist: entries,
    workspaceRoot: "/workspace",
    readProvider: () => ({
      rawKeys: (): readonly string[] => Object.keys(raw),
      getRawValue: (key: string): unknown => raw[key],
    }),
  });
}

/**
 * Builds `BuildTriageToolsDeps`, overriding only what a scenario cares about.
 * `scriptName` defaults to the branded `TRIAGE_TARGET_SCRIPT` — the only
 * value under which `buildTriageTools` does not refuse (F3's structural
 * half).
 */
async function buildDeps(
  overrides: Partial<BuildTriageToolsDeps> = {},
): Promise<BuildTriageToolsDeps> {
  return {
    surface: unusedSurface(),
    scriptName: SCRIPT_NAME,
    operatorProfile: OPERATOR_PROFILE,
    presetAllowlist: overrides.presetAllowlist ?? (await mintVerifiedPresets()),
    ...overrides,
  };
}

/** Builds the specs over `deps` and returns the one `triage_logs` spec. */
function buildTriageLogsSpec(deps: BuildTriageToolsDeps): AgentToolSpec {
  const specs = buildTriageTools(deps);
  const found = specs.find(
    (candidate: AgentToolSpec) =>
      candidate.name === AGENT_TRIAGE_TOOL_NAMES.triageLogs,
  );
  if (found === undefined) {
    throw new Error(`${AGENT_TRIAGE_TOOL_NAMES.triageLogs} was not built`);
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

/**
 * Drives one malformed/rejected `input` through BOTH `describeAction` and
 * `execute`, asserting each throws `M3LAgentOperatorCliError` coded
 * `ERR_AGENT_OPERATOR_PRESET` and that `surface.run` is never called by
 * either. This is the shape requirement 4 of the contract demands: every
 * `readPresetName` rejection proven on both entry points, not just one.
 */
async function expectPresetRejectionOnBothEntryPoints(
  spec: AgentToolSpec,
  input: unknown,
  run: ReturnType<typeof vi.fn>,
): Promise<void> {
  const describeThrown = captureThrown(() => spec.describeAction(input));
  expect(describeThrown).toBeInstanceOf(M3LAgentOperatorCliError);
  expect((describeThrown as M3LAgentOperatorCliError).code).toBe(
    "ERR_AGENT_OPERATOR_PRESET",
  );

  let executeThrown: unknown;
  try {
    await spec.execute(input, toolContext(AGENT_TRIAGE_TOOL_NAMES.triageLogs));
  } catch (error) {
    executeThrown = error;
  }
  expect(executeThrown).toBeInstanceOf(M3LAgentOperatorCliError);
  expect((executeThrown as M3LAgentOperatorCliError).code).toBe(
    "ERR_AGENT_OPERATOR_PRESET",
  );
  expect(run).not.toHaveBeenCalled();
}

describe("buildTriageTools — registration", () => {
  it("returns exactly one frozen spec, named triage_logs", async () => {
    const specs = buildTriageTools(await buildDeps());

    expect(Object.isFrozen(specs)).toBe(true);
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec).toBeDefined();
    expect(spec?.name).toBe(AGENT_TRIAGE_TOOL_NAMES.triageLogs);
    expect(spec?.name).toBe("triage_logs");
  });

  it("declares an input schema with exactly one required string presetName, additionalProperties false", async () => {
    const spec = buildTriageLogsSpec(await buildDeps());
    const schema = spec.inputSchema as {
      readonly type?: string;
      readonly properties?: Record<string, { readonly type?: string }>;
      readonly required?: readonly string[];
      readonly additionalProperties?: boolean;
    };

    expect(Object.keys(schema.properties ?? {})).toEqual(["presetName"]);
    expect(schema.properties?.["presetName"]?.type).toBe("string");
    expect(schema.required).toEqual(["presetName"]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("buildTriageTools — the script pin (F3, structural half)", () => {
  // The read-only claim `describeAction` asserts is only sound for the one
  // script whose read-only verb set this module knows. Nothing here reads
  // the target script's actual declared operation, so pinning the target at
  // BUILD time is the only thing standing between "cloudwatch-logs-analysis"
  // and a mutating script reaching a read-only verdict through this tool.
  it("throws ERR_AGENT_OPERATOR_CONFIG and builds no spec when scriptName is not TRIAGE_TARGET_SCRIPT", async () => {
    const run = vi.fn();
    const deps = await buildDeps({
      scriptName: assertAllowedScriptName("json-etl"),
      surface: { ...unusedSurface(), run },
    });

    const thrown = captureThrown(() => buildTriageTools(deps));

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("succeeds and returns exactly one spec when scriptName IS TRIAGE_TARGET_SCRIPT", async () => {
    const specs = buildTriageTools(
      await buildDeps({ scriptName: SCRIPT_NAME }),
    );

    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe(AGENT_TRIAGE_TOOL_NAMES.triageLogs);
  });

  it("does not echo the rejected scriptName in the build-time rejection message", async () => {
    const deps = await buildDeps({
      scriptName: assertAllowedScriptName("json-etl"),
    });

    const thrown = captureThrown(() => buildTriageTools(deps));

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain("json-etl");
    expect(JSON.stringify(error.context ?? {})).not.toContain("json-etl");
  });
});

describe("buildTriageTools — describeAction's exact action shape", () => {
  it("returns exactly the declared action shape", async () => {
    const deps = await buildDeps();
    const spec = buildTriageLogsSpec(deps);

    const action = spec.describeAction({ presetName: PRESET_NAME });

    expect(action).toEqual({
      script: TRIAGE_TARGET_SCRIPT,
      operation: "run",
      kind: "read-only",
      target: { profile: deps.operatorProfile },
      parameterNames: ["presetName"],
    });
  });

  it("never derives kind from input — a model asserting kind: 'mutating' does not win", async () => {
    const spec = buildTriageLogsSpec(await buildDeps());

    const action = spec.describeAction({
      presetName: PRESET_NAME,
      kind: "mutating",
    });

    expect(action.kind).toBe("read-only");
  });
});

describe("buildTriageTools — execute (F3, execute half)", () => {
  /** A run envelope carrying `exitCode`, wrapped as `AgentCliSurface.triageRun` resolves it. */
  function runEnvelope(
    overrides: Partial<FakeRunEnvelope> = {},
  ): AgentOperatorProjectedRunEnvelope {
    const envelope = makeRunEnvelope(overrides);
    return envelope as unknown as AgentOperatorProjectedRunEnvelope;
  }

  it("calls surface.triageRun with exactly (scriptName, presetName, operatorProfile) — three arguments — and never calls surface.run", async () => {
    const envelope = runEnvelope({ exitCode: 0 });
    const triageRun = vi.fn(() => Promise.resolve(envelope));
    const run = vi.fn();
    const deps = await buildDeps({
      surface: { ...unusedSurface(), run, triageRun },
    });
    const spec = buildTriageLogsSpec(deps);

    await spec.execute(
      { presetName: PRESET_NAME },
      toolContext(AGENT_TRIAGE_TOOL_NAMES.triageLogs),
    );

    // The regression guard: a future edit reverting to `run` would silently
    // drop the `--operation=analyze` pin, and nothing else here would catch
    // it — see the module remarks' "why triageRun, not run" section. The
    // third argument closes PR #1081's Should-fix 1: without it, the
    // spawned child resolved its OWN `aws.profile` from the inherited
    // environment, independently of the profile the policy graded.
    expect(triageRun).toHaveBeenCalledWith(
      deps.scriptName,
      PRESET_NAME,
      deps.operatorProfile,
    );
    expect(triageRun).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("passes triageRun the SAME operatorProfile value describeAction stamped into target.profile — one source of truth, not a second lookup", async () => {
    const envelope = runEnvelope({ exitCode: 0 });
    const triageRun = vi.fn(() => Promise.resolve(envelope));
    const deps = await buildDeps({
      surface: { ...unusedSurface(), triageRun },
    });
    const spec = buildTriageLogsSpec(deps);

    // Read the graded value out of describeAction's OWN result — never out
    // of the `deps`/`OPERATOR_PROFILE` fixture directly. A surface dep (or
    // any other independent lookup) that happened to agree with the fixture
    // today would still pass a `deps.operatorProfile`-based assertion; only
    // comparing against describeAction's actual output proves execute
    // reused the value the gate already judged, rather than re-deriving one
    // that could diverge from it.
    const action = spec.describeAction({ presetName: PRESET_NAME });
    const gradedProfile = action.target?.profile;
    expect(gradedProfile).toBeDefined();

    await spec.execute(
      { presetName: PRESET_NAME },
      toolContext(AGENT_TRIAGE_TOOL_NAMES.triageLogs),
    );

    expect(triageRun).toHaveBeenCalledWith(
      deps.scriptName,
      PRESET_NAME,
      gradedProfile,
    );
  });

  it("reports outcome.dryRun === false, honestly — this run is not a rehearsal", async () => {
    const envelope = runEnvelope({ exitCode: 0 });
    const triageRun = vi.fn(() => Promise.resolve(envelope));
    const deps = await buildDeps({
      surface: { ...unusedSurface(), triageRun },
    });
    const spec = buildTriageLogsSpec(deps);

    const result = await spec.execute(
      { presetName: PRESET_NAME },
      toolContext(AGENT_TRIAGE_TOOL_NAMES.triageLogs),
    );

    expect(result.outcome).toEqual({
      dryRun: false,
      exitCode: envelope.exitCode,
    });
  });

  it("mirrors the envelope's non-zero exitCode onto outcome.exitCode and wraps it as json content", async () => {
    const envelope = runEnvelope({ exitCode: 7 });
    const triageRun = vi.fn(() => Promise.resolve(envelope));
    const deps = await buildDeps({
      surface: { ...unusedSurface(), triageRun },
    });
    const spec = buildTriageLogsSpec(deps);

    const result = await spec.execute(
      { presetName: PRESET_NAME },
      toolContext(AGENT_TRIAGE_TOOL_NAMES.triageLogs),
    );

    expect(result.outcome).toEqual({ dryRun: false, exitCode: 7 });
    expect(result.content).toEqual([{ type: "json", json: envelope }]);
  });
});

describe("buildTriageTools — readPresetName rejects before anything is authorized", () => {
  // Every case below is a shape/membership-boundary throw, driven through
  // BOTH describeAction and execute, coded ERR_AGENT_OPERATOR_PRESET, and
  // never reaching surface.run.

  it("rejects an array input (typeof [] === 'object', so it must be rejected before the shape check)", async () => {
    const run = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildTriageLogsSpec(deps);

    await expectPresetRejectionOnBothEntryPoints(spec, [PRESET_NAME], run);
  });

  it("rejects a non-object, non-null input", async () => {
    const run = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildTriageLogsSpec(deps);

    await expectPresetRejectionOnBothEntryPoints(spec, 42, run);
  });

  it("rejects null", async () => {
    const run = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildTriageLogsSpec(deps);

    await expectPresetRejectionOnBothEntryPoints(spec, null, run);
  });

  it("rejects an object with no own presetName", async () => {
    const run = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildTriageLogsSpec(deps);

    await expectPresetRejectionOnBothEntryPoints(spec, {}, run);
  });

  it("rejects an inherited presetName — {'__proto__': {presetName: ...}} must not satisfy the own-key read", async () => {
    const run = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildTriageLogsSpec(deps);
    // A real JS object literal with a literal `__proto__` key sets the
    // prototype of the created object (spec behaviour, not JSON.parse's
    // own-property behaviour) — so `presetName` really is answered only by
    // the prototype chain here, never by an own property.
    const hostileInput: unknown = { __proto__: { presetName: PRESET_NAME } };
    expect(Object.hasOwn(hostileInput as object, "presetName")).toBe(false);

    await expectPresetRejectionOnBothEntryPoints(spec, hostileInput, run);
  });

  it("rejects a well-formed presetName that is not a member of the allowlist", async () => {
    const run = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildTriageLogsSpec(deps);

    await expectPresetRejectionOnBothEntryPoints(
      spec,
      { presetName: "not-declared-anywhere" },
      run,
    );
  });

  it("rejects the literal name 'constructor' (the case that actually probes Map-vs-object lookup)", async () => {
    const run = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), run } });
    const spec = buildTriageLogsSpec(deps);

    await expectPresetRejectionOnBothEntryPoints(
      spec,
      { presetName: "constructor" },
      run,
    );
  });

  it("never echoes a rejected-but-well-formed presetName in the thrown message", async () => {
    const spec = buildTriageLogsSpec(await buildDeps());
    const hostile = "not-declared-anywhere-zz";

    const thrown = captureThrown(() =>
      spec.describeAction({ presetName: hostile }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain(hostile);
    expect(JSON.stringify(error.context ?? {})).not.toContain(hostile);
  });

  it("never echoes a hostile shape-rejected presetName in the thrown message", async () => {
    const spec = buildTriageLogsSpec(await buildDeps());
    const hostile = "HOSTILE_VALUE_zz".repeat(50);

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
});
