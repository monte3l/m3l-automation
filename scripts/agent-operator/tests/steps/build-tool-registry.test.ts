/**
 * Tests for `steps/build-tool-registry` — the only door through which a set
 * of `AgentToolSpec`s becomes an `AWS.M3LBedrockToolRegistry`: every entry
 * MUST go through `gateToolSpec`, there is no bypass parameter.
 *
 * The contract (see the wave 1 contract doc, section D):
 *
 * ```ts
 * export function buildAgentToolRegistry(
 *   specs: readonly AgentToolSpec[],
 *   deps: GateToolDeps,
 * ): AWS.M3LBedrockToolRegistry;
 * ```
 *
 * - Returns a `Map` (never a plain object) — a `Map` is what keeps
 *   `"__proto__"`/`"constructor"` from resolving to anything.
 * - Every entry is gated: calling a returned handler produces a
 *   decision-log record.
 * - Rejects a duplicate `name`, an empty spec list, and a blank or
 *   non-conforming tool name — all `M3LAgentOperatorCliError` coded
 *   `ERR_AGENT_OPERATOR_CONFIG`.
 * - Freezes what it returns.
 *
 * Written RED, before `steps/build-tool-registry.ts` exists.
 */

import { describe, expect, it, vi } from "vitest";

import { Core } from "@monte3l/m3l-common";
import type { AWS } from "@monte3l/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  AgentDecisionRecorder,
  agentIdentity,
} from "../../src/steps/decision-recorder.js";
import type {
  AgentToolExecution,
  AgentToolPhase,
  AgentToolSpec,
  TwoPhaseAgentToolSpec,
} from "../../src/steps/gate-tool.js";
import { buildAgentToolRegistry } from "../../src/steps/build-tool-registry.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import { RecordingDecisionLogWriter } from "../support/logFakes.js";
import { minimalPolicy } from "../support/policyFixtures.js";

/** A fixed, caller-sampled instant. */
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

/** The `AWS.M3LBedrockToolContext` every handler call in this file uses. */
function toolContext(name: string): AWS.M3LBedrockToolContext {
  return { toolUseId: "tool-use-1", name };
}

/** A minimal, always-approved `AgentToolSpec` named `name`. */
function spec(name: string): AgentToolSpec {
  return {
    name,
    description: "A sample gated tool, for tests only.",
    inputSchema: {},
    describeAction: (): Core.M3LAgentAction => ({
      script: "agent-operator",
      operation: "explain-policy",
      kind: "read-only",
    }),
    execute: (): Promise<AgentToolExecution> =>
      Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        outcome: { dryRun: false, exitCode: 0 },
      }),
  };
}

/** Builds a `GateToolDeps`-shaped bag over `writer`, for direct reuse. */
function makeDeps(writer: RecordingDecisionLogWriter): {
  readonly policy: Core.M3LAgentPolicy;
  readonly ledger: AgentRunLedger;
  readonly recorder: AgentDecisionRecorder;
  readonly now: () => number;
  readonly logger: Core.M3LLogger;
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
} {
  return {
    policy: minimalPolicy(),
    ledger: new AgentRunLedger(),
    recorder: new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer,
    }),
    now: () => NOW,
    logger: new Core.M3LLogger([]),
    reportRecovery: vi.fn(),
  };
}

describe("buildAgentToolRegistry — the happy path", () => {
  it("returns a Map keyed by tool name, one entry per spec", () => {
    const writer = new RecordingDecisionLogWriter();
    const registry = buildAgentToolRegistry(
      [spec("first_tool"), spec("second_tool")],
      makeDeps(writer),
    );

    expect(registry).toBeInstanceOf(Map);
    expect(registry.size).toBe(2);
    expect([...registry.keys()].sort()).toEqual(["first_tool", "second_tool"]);
  });

  it("gates every entry — invoking a returned handler produces a decision-log record", async () => {
    const writer = new RecordingDecisionLogWriter();
    const registry = buildAgentToolRegistry(
      [spec("gated_tool")],
      makeDeps(writer),
    );

    const registration = registry.get("gated_tool");
    expect(registration).toBeDefined();
    await registration?.handler(undefined, toolContext("gated_tool"));

    // A structural proof, not a spot-check: the underlying writer only ever
    // sees entries `AgentDecisionRecorder.record` builds, so any entry at
    // all is proof the call passed through `gateToolSpec`.
    expect(writer.entries.length).toBeGreaterThan(0);
  });

  it("freezes the returned registry", () => {
    const writer = new RecordingDecisionLogWriter();
    const registry = buildAgentToolRegistry(
      [spec("frozen_tool")],
      makeDeps(writer),
    );

    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("accepts a tool name at the 64-character ceiling", () => {
    const longName = `a${"b".repeat(63)}`;
    expect(longName).toHaveLength(64);
    const writer = new RecordingDecisionLogWriter();

    const registry = buildAgentToolRegistry([spec(longName)], makeDeps(writer));

    expect(registry.has(longName)).toBe(true);
  });
});

describe("buildAgentToolRegistry — configuration mistakes fail closed", () => {
  it("rejects a duplicate tool name", () => {
    const writer = new RecordingDecisionLogWriter();

    expect(() =>
      buildAgentToolRegistry(
        [spec("dup_tool"), spec("dup_tool")],
        makeDeps(writer),
      ),
    ).toThrow(M3LAgentOperatorCliError);

    let thrown: unknown;
    try {
      buildAgentToolRegistry(
        [spec("dup_tool"), spec("dup_tool")],
        makeDeps(writer),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it("rejects an empty spec list — a tool-free agent run is a configuration mistake", () => {
    const writer = new RecordingDecisionLogWriter();

    let thrown: unknown;
    try {
      buildAgentToolRegistry([], makeDeps(writer));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it.each([
    ["empty string", ""],
    ["uppercase letters", "Foobar"],
    ["a leading digit", "1foobar"],
    ["a hyphen", "foo-bar"],
    ["a doubled underscore", "foo__bar"],
    ["a leading underscore", "_foobar"],
    ["a trailing underscore", "foobar_"],
    ["one character past the 64-char ceiling", `a${"b".repeat(64)}`],
  ])("rejects a tool name with %s", (_label, badName) => {
    const writer = new RecordingDecisionLogWriter();

    let thrown: unknown;
    try {
      buildAgentToolRegistry([spec(badName)], makeDeps(writer));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * V9 slice 3a — `buildAgentToolRegistry` grows a third, optional parameter:
 *
 * ```ts
 * export function buildAgentToolRegistry(
 *   specs: readonly AgentToolSpec[],
 *   deps: GateToolDeps,
 *   twoPhaseSpecs: readonly TwoPhaseAgentToolSpec[] = [],
 * ): AWS.M3LBedrockToolRegistry;
 * ```
 *
 * A two-phase entry is gated through `gateTwoPhaseToolSpec` (never
 * `gateToolSpec`) but otherwise joins the SAME registry, under the SAME
 * name-validation and duplicate-detection rules as `specs` — spanning both
 * arrays, not just its own.
 * ---------------------------------------------------------------------------
 */

/** A policy that auto-approves a non-sensitive `put-item` mutation, no dry-run-first opt-in. */
function twoPhasePolicy(): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy({
    version: 1,
    scripts: [{ script: "agent-operator", operations: ["put-item"] }],
    sensitiveTargets: { profiles: ["prod"] },
  });
}

/** A granted, non-sensitive mutating action `twoPhasePolicy` auto-approves in both phases. */
function gradedMutatingAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "put-item",
    kind: "mutating",
    target: { profile: "sandbox", region: "eu-central-1" },
    parameterNames: ["table"],
  };
}

/** {@link makeDeps}, but built over {@link twoPhasePolicy} rather than `minimalPolicy`. */
function makeTwoPhaseDeps(writer: RecordingDecisionLogWriter): {
  readonly policy: Core.M3LAgentPolicy;
  readonly ledger: AgentRunLedger;
  readonly recorder: AgentDecisionRecorder;
  readonly now: () => number;
  readonly logger: Core.M3LLogger;
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
} {
  return {
    policy: twoPhasePolicy(),
    ledger: new AgentRunLedger(),
    recorder: new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer,
    }),
    now: () => NOW,
    logger: new Core.M3LLogger([]),
    reportRecovery: vi.fn(),
  };
}

/**
 * A minimal, always-approved `TwoPhaseAgentToolSpec` named `name`. `onExecute`
 * (when supplied) records each phase flag handed to `execute`, in call
 * order — how behaviour-based tests prove the handler drove two real calls
 * rather than asserting on any internal identity.
 */
function twoPhaseSpec(
  name: string,
  onExecute?: (phase: AgentToolPhase) => void,
): TwoPhaseAgentToolSpec {
  return {
    name,
    description: "A sample two-phase gated tool, for tests only.",
    inputSchema: {},
    phases: "dry-run-then-mutate",
    describeAction: (): Core.M3LAgentAction => gradedMutatingAction(),
    execute: (
      _input: unknown,
      _context: AWS.M3LBedrockToolContext,
      phase: AgentToolPhase,
    ): Promise<AgentToolExecution> => {
      onExecute?.(phase);
      return Promise.resolve({
        content: [{ type: "text", text: phase.dryRun ? "planned" : "applied" }],
        outcome: { dryRun: phase.dryRun, exitCode: 0 },
      });
    },
  };
}

describe("buildAgentToolRegistry — the twoPhaseSpecs parameter (V9 slice 3a)", () => {
  it("registers a two-phase spec through gateTwoPhaseToolSpec — one handler call drives TWO execute calls, phase 1 then phase 2", async () => {
    const writer = new RecordingDecisionLogWriter();
    const phases: AgentToolPhase[] = [];
    const registry = buildAgentToolRegistry([], makeTwoPhaseDeps(writer), [
      twoPhaseSpec("two_phase_tool", (phase) => phases.push(phase)),
    ]);

    const registration = registry.get("two_phase_tool");
    expect(registration).toBeDefined();
    await registration?.handler(undefined, toolContext("two_phase_tool"));

    expect(phases).toEqual([{ dryRun: true }, { dryRun: false }]);
  });

  it("still routes a single-phase spec through gateToolSpec — one handler call drives exactly ONE execute call", async () => {
    const writer = new RecordingDecisionLogWriter();
    let executeCalls = 0;
    const registry = buildAgentToolRegistry(
      [
        {
          ...spec("single_phase_tool"),
          execute: (): Promise<AgentToolExecution> => {
            executeCalls += 1;
            return Promise.resolve({
              content: [{ type: "text", text: "ok" }],
              outcome: { dryRun: false, exitCode: 0 },
            });
          },
        },
      ],
      makeDeps(writer),
    );

    const registration = registry.get("single_phase_tool");
    await registration?.handler(undefined, toolContext("single_phase_tool"));

    expect(executeCalls).toBe(1);
  });

  it("the 'at least one spec' guard counts BOTH arrays — an empty specs list with a non-empty twoPhaseSpecs succeeds", () => {
    const writer = new RecordingDecisionLogWriter();

    const registry = buildAgentToolRegistry([], makeTwoPhaseDeps(writer), [
      twoPhaseSpec("only_two_phase_tool"),
    ]);

    expect(registry.size).toBe(1);
    expect(registry.has("only_two_phase_tool")).toBe(true);
  });

  it("still throws ERR_AGENT_OPERATOR_CONFIG when BOTH arrays are empty", () => {
    const writer = new RecordingDecisionLogWriter();

    let thrown: unknown;
    try {
      buildAgentToolRegistry([], makeDeps(writer), []);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it.each([
    ["uppercase letters", "Bad Name"],
    ["empty string", ""],
  ])(
    "rejects a two-phase spec with a non-conforming name (%s)",
    (_label, badName) => {
      const writer = new RecordingDecisionLogWriter();

      let thrown: unknown;
      try {
        buildAgentToolRegistry([], makeTwoPhaseDeps(writer), [
          twoPhaseSpec(badName),
        ]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_CONFIG",
      );
    },
  );

  it("rejects a duplicate discovered while walking `specs` (2nd entry) against a name already taken by `twoPhaseSpecs`", () => {
    // The single-phase array holds the LATER-positioned duplicate, so a
    // check that only compares each array's first element (or only checks
    // `specs[0]` against `twoPhaseSpecs`) would miss this.
    const writer = new RecordingDecisionLogWriter();

    let thrown: unknown;
    try {
      buildAgentToolRegistry(
        [spec("other_a"), spec("dup_a")],
        makeTwoPhaseDeps(writer),
        [twoPhaseSpec("dup_a")],
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it("rejects a duplicate discovered while walking `twoPhaseSpecs` (2nd entry) against a name already taken by `specs`", () => {
    // Same shape, reversed: the two-phase array holds the LATER-positioned
    // duplicate, colliding with a name `specs` already registered — the
    // opposite order from the case above.
    const writer = new RecordingDecisionLogWriter();

    let thrown: unknown;
    try {
      buildAgentToolRegistry([spec("dup_b")], makeTwoPhaseDeps(writer), [
        twoPhaseSpec("other_b"),
        twoPhaseSpec("dup_b"),
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it('rejects a two-phase spec literally named "__proto__" — name validation is the FIRST of two independent layers, and it never lets the name reach the registry at all', () => {
    // `TOOL_NAME_PATTERN` requires the first character to be a lowercase
    // LETTER, so "__proto__" fails `assertValidToolName` before
    // `buildAgentToolRegistry` ever calls `registry.set`. The Map-not-object
    // guarantee (the second, independent layer) is real, but it is never
    // exercised by this particular name — see the "constructor" test below
    // for the case that actually reaches the Map.
    const writer = new RecordingDecisionLogWriter();

    let thrown: unknown;
    try {
      buildAgentToolRegistry([], makeTwoPhaseDeps(writer), [
        twoPhaseSpec("__proto__"),
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it('registers a two-phase spec literally named "constructor" as its own gated entry, not `Object`\'s constructor — "constructor" is all lowercase letters, so it PASSES name validation and actually reaches the Map', async () => {
    // Unlike "__proto__", "constructor" clears `TOOL_NAME_PATTERN` and is a
    // legitimate tool name — so this is the name that actually probes the
    // Map-vs-plain-object choice `buildAgentToolRegistry`'s docs call out.
    // On a plain object, `registry["constructor"]` would resolve to
    // `Object`'s constructor: a real handler-confusion hazard.
    const writer = new RecordingDecisionLogWriter();
    const phases: AgentToolPhase[] = [];
    const registry = buildAgentToolRegistry([], makeTwoPhaseDeps(writer), [
      twoPhaseSpec("constructor", (phase) => phases.push(phase)),
    ]);

    expect(Map.prototype.has.call(registry, "constructor")).toBe(true);
    const registration = registry.get("constructor");
    expect(registration).toBeDefined();
    expect(registration?.handler).toBeTypeOf("function");

    // Behaves as a real two-phase gated tool: one handler call drives two
    // `execute` calls, dry-run phase then mutate phase — not whatever
    // `Object`'s constructor would do if it had leaked through.
    await registration?.handler(undefined, toolContext("constructor"));
    expect(phases).toEqual([{ dryRun: true }, { dryRun: false }]);
  });

  it('a registry that never registered "constructor" does not fall back to the prototype chain — `get` returns `undefined`, not `Object`\'s constructor', () => {
    const writer = new RecordingDecisionLogWriter();
    const registry = buildAgentToolRegistry([], makeTwoPhaseDeps(writer), [
      twoPhaseSpec("unrelated_tool"),
    ]);

    expect(Map.prototype.has.call(registry, "constructor")).toBe(false);
    expect(registry.get("constructor")).toBeUndefined();
  });
});
