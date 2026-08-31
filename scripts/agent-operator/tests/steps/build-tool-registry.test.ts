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

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  AgentDecisionRecorder,
  agentIdentity,
} from "../../src/steps/decision-recorder.js";
import type {
  AgentToolExecution,
  AgentToolSpec,
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
