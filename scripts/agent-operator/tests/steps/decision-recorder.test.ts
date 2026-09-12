/**
 * Tests for `steps/decision-recorder` — the owner of the agent identity, the
 * script-local decision-log writer port, and the write helpers.
 *
 * Written RED, before `steps/decision-recorder.ts` existed; the module now
 * exists and these tests pass, so they stand as the regression pin on its
 * contract — with one deliberate exception, the exact-boundary byte-ceiling
 * case at the end of this file, which is still RED.
 *
 * The contract these tests pin:
 *
 * ```ts
 * // The recorder declares its OWN one-method port rather than depending on
 * // `Core.M3LAgentDecisionLog`: that class carries a TS `private` member and
 * // is therefore nominal, so no test double could ever be assignable to it.
 * export interface AgentDecisionLogWriter {
 *   write(entry: Core.M3LAgentDecisionLogEntry): Promise<void>;
 * }
 * export function agentIdentity(fields: {
 *   readonly name: string;
 *   readonly modelId?: string | undefined;
 *   readonly awsPrincipal?: string | undefined;
 * }): Core.M3LAgentIdentity; // OMITS an absent key; never assigns `undefined`
 * export function serializedEntryByteLength(
 *   entry: Core.M3LAgentDecisionLogEntry,
 * ): number;
 * export interface AgentDecisionRecordInput {
 *   readonly decision: Core.M3LAgentDecision;
 *   readonly now: number;
 *   readonly outcome?: Core.M3LAgentDecisionOutcome;
 *   readonly tokens?: number;
 *   readonly cost?: number;
 * }
 * export class AgentDecisionRecorder {
 *   constructor(options: {
 *     readonly identity: Core.M3LAgentIdentity;
 *     readonly writer: AgentDecisionLogWriter;
 *   });
 *   // Resolves with the entry that was written — the resolution IS the
 *   // success signal the caller needs before `ledger.observeDecisionLog(true)`.
 *   record(input: AgentDecisionRecordInput): Promise<Core.M3LAgentDecisionLogEntry>;
 * }
 * ```
 *
 * The library's own `agentDecisionLogEntry` / `serializeAgentDecisionLogEntry`
 * are never faked here: an entry built any other way is exactly the defect
 * these tests exist to prevent.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  AgentDecisionRecorder,
  agentIdentity,
  serializedEntryByteLength,
  type AgentDecisionLogWriter,
} from "../../src/steps/decision-recorder.js";
import { minimalPolicy } from "../support/policyFixtures.js";

/** A fixed, caller-sampled instant. */
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

/**
 * Distinctive strings planted in the entry so a failure-path assertion can
 * prove the error text does not echo entry content back out.
 */
const SECRET_PARAMETER = "zzsecretparameternamezz";
const SECRET_AGENT_NAME = "zzsecretagentnamezz";

/**
 * The default granted action. Built as a whole object rather than by spreading
 * overrides onto a base: an action key present but holding `undefined` (what
 * `{ ...base, operation: undefined }` produces) is malformed input the library
 * rejects, exactly like the ledger's optional fields.
 */
function grantedAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "explain-policy",
    kind: "read-only",
    parameterNames: [SECRET_PARAMETER],
  };
}

/** A real decision, produced by the real evaluator against a real policy. */
function realDecision(action?: Core.M3LAgentAction): Core.M3LAgentDecision {
  return Core.evaluateAgentAction({
    action: action ?? grantedAction(),
    policy: minimalPolicy(),
  });
}

/** Records every entry handed to it and resolves — the happy-path writer. */
class RecordingWriter implements AgentDecisionLogWriter {
  readonly entries: Core.M3LAgentDecisionLogEntry[] = [];

  write(entry: Core.M3LAgentDecisionLogEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** Records the attempt, then rejects with a caller-chosen failure value. */
class FailingWriter implements AgentDecisionLogWriter {
  readonly entries: Core.M3LAgentDecisionLogEntry[] = [];

  constructor(private readonly failure: unknown) {}

  write(entry: Core.M3LAgentDecisionLogEntry): Promise<void> {
    this.entries.push(entry);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately rejects with an unknown-typed value so the non-Error channel below is exercised, not normalized away
    return Promise.reject(this.failure);
  }
}

/**
 * The identity name the byte-boundary fixture measures against. It must match
 * the identity the recorder under test is constructed with, or the entry the
 * recorder builds will not be the byte-exact one this fixture solved for.
 */
const BOUNDARY_AGENT_NAME = "agent-operator";

/**
 * Returns a decision whose entry — built with `BOUNDARY_AGENT_NAME` and `NOW`,
 * exactly as the recorder builds it — serializes to `target` bytes precisely.
 *
 * Solved rather than hardcoded: the serialized line grows linearly in the
 * length of a single padded parameter name, so two measurements give the
 * per-character cost and the pad length follows. A hardcoded pad would silently
 * stop being the boundary the moment the library adds an entry field.
 */
function decisionSerializingToExactly(target: number): Core.M3LAgentDecision {
  const identity = agentIdentity({ name: BOUNDARY_AGENT_NAME });
  const decisionWithPad = (padLength: number): Core.M3LAgentDecision =>
    realDecision({
      script: "agent-operator",
      operation: "explain-policy",
      kind: "read-only",
      parameterNames: ["p".repeat(padLength)],
    });
  const measure = (padLength: number): number =>
    serializedEntryByteLength(
      Core.agentDecisionLogEntry({
        decision: decisionWithPad(padLength),
        identity,
        now: NOW,
      }),
    );

  const bytesAtLowPad = measure(1_000);
  const bytesPerPadCharacter = (measure(2_000) - bytesAtLowPad) / 1_000;
  const padLength = 1_000 + (target - bytesAtLowPad) / bytesPerPadCharacter;
  const decision = decisionWithPad(padLength);

  // A fixture guard, not the assertion under test: this whole case is about
  // the `===` boundary, so an inexact solve must fail loudly here instead of
  // quietly degrading into another "well past the ceiling" duplicate.
  expect(measure(padLength)).toBe(target);
  return decision;
}

/** Runs `body` and returns whatever it threw, or `undefined` if it did not. */
async function captureRejection(
  body: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await body();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("AgentDecisionLogWriter — the port exists because the library class is nominal", () => {
  it("is satisfied by the real Core.M3LAgentDecisionLog", () => {
    // The recorder must accept the real log without a cast: whatever the port
    // declares has to stay a subset of the library class's surface.
    expectTypeOf<Core.M3LAgentDecisionLog>().toExtend<AgentDecisionLogWriter>();
  });

  it("is NOT interchangeable with Core.M3LAgentDecisionLog in the other direction", () => {
    // Deliberately a bare object literal rather than a value annotated with the
    // port: the point is that a STRUCTURAL double, however well shaped, is not
    // assignable to the library class.
    const fake = {
      write: (_entry: Core.M3LAgentDecisionLogEntry): Promise<void> =>
        Promise.resolve(),
    };

    // @ts-expect-error -- `M3LAgentDecisionLog` has a TS `private` member, so it is nominal: no structural double is assignable to it. That is precisely why the recorder declares its own port instead of depending on the class.
    const asLibraryLog: Core.M3LAgentDecisionLog = fake;

    expect(asLibraryLog).toBe(fake);
    // …and the same double DOES satisfy the recorder's own port.
    expectTypeOf(fake).toExtend<AgentDecisionLogWriter>();
  });
});

describe("agentIdentity — omit-only, never present-holding-undefined", () => {
  it("omits modelId and awsPrincipal when they are explicitly undefined", () => {
    // This is the shape a config accessor actually produces: `string |
    // undefined`. Forwarding that `undefined` onto the identity would make the
    // library throw, because presence is read with `Object.hasOwn`.
    const identity = agentIdentity({
      name: "agent-operator",
      modelId: undefined,
      awsPrincipal: undefined,
    });

    expect(Object.hasOwn(identity, "name")).toBe(true);
    expect(Object.hasOwn(identity, "modelId")).toBe(false);
    expect(Object.hasOwn(identity, "awsPrincipal")).toBe(false);
  });

  it("keeps modelId and awsPrincipal when they are supplied", () => {
    const identity = agentIdentity({
      name: "agent-operator",
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      awsPrincipal: "arn:aws:sts::111111111111:assumed-role/agent/session",
    });

    expect(identity.modelId).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(identity.awsPrincipal).toBe(
      "arn:aws:sts::111111111111:assumed-role/agent/session",
    );
  });

  it("produces an identity the real entry builder accepts", () => {
    // The only proof that matters: a present-but-undefined key would throw here.
    const entry = Core.agentDecisionLogEntry({
      decision: realDecision(),
      identity: agentIdentity({ name: "agent-operator", modelId: undefined }),
      now: NOW,
    });

    expect(Object.hasOwn(entry.identity, "modelId")).toBe(false);
  });
});

describe("AgentDecisionRecorder — the happy path", () => {
  it("builds the entry through the real library builder and writes it once", async () => {
    const writer = new RecordingWriter();
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: SECRET_AGENT_NAME }),
      writer,
    });
    const decision = realDecision();

    const entry = await recorder.record({ decision, now: NOW });

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0]).toBe(entry);
    // The decision's own fields, carried verbatim — not re-derived.
    expect(entry.verdict).toBe(decision.verdict);
    expect(entry.rule).toBe(decision.rule);
    expect(entry.reason).toBe(decision.reason);
    expect(entry.shapeKey).toBe(decision.action.shapeKey);
    // The caller-sampled instant, not a clock the recorder read itself.
    expect(entry.timestamp).toBe(new Date(NOW).toISOString());
    expect(entry.identity.name).toBe(SECRET_AGENT_NAME);
  });

  it("resolves with the written entry so the caller can observe the decision log as available", async () => {
    const writer = new RecordingWriter();
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer,
    });
    const decision = realDecision();

    // The resolution IS the success signal: a recorder that resolved on a
    // failed write would have the caller record `observeDecisionLog(true)`
    // for a log that never received the entry. So assert WHAT resolved — the
    // very entry the writer accepted — rather than merely that something did.
    const resolved = await recorder.record({ decision, now: NOW });

    expect(writer.entries).toHaveLength(1);
    expect(resolved).toBe(writer.entries[0]);
    expect(resolved.verdict).toBe(decision.verdict);
    expect(resolved.rule).toBe(decision.rule);
  });

  it("honours the library's two absence conventions on the entry it returns", async () => {
    const writer = new RecordingWriter();
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer,
    });

    const entry = await recorder.record({
      // No operation on the action: the entry carries `operation` as a
      // REQUIRED key holding `undefined` …
      decision: realDecision({
        script: "agent-operator",
        kind: "read-only",
        parameterNames: [SECRET_PARAMETER],
      }),
      now: NOW,
    });

    expect(Object.hasOwn(entry, "operation")).toBe(true);
    expect(entry.operation).toBeUndefined();
    // … while `outcome` / `tokens` / `cost` are OMITTED when absent. The two
    // conventions live on the same object and are easy to conflate.
    expect(Object.hasOwn(entry, "outcome")).toBe(false);
    expect(Object.hasOwn(entry, "tokens")).toBe(false);
    expect(Object.hasOwn(entry, "cost")).toBe(false);
  });

  it("forwards a reported outcome, token count, and cost", async () => {
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer: new RecordingWriter(),
    });

    const entry = await recorder.record({
      decision: realDecision(),
      now: NOW,
      outcome: { dryRun: true, exitCode: 0 },
      tokens: 1234,
      cost: 0.5,
    });

    expect(entry.outcome).toEqual({ dryRun: true, exitCode: 0 });
    expect(entry.tokens).toBe(1234);
    expect(entry.cost).toBe(0.5);
  });
});

describe("AgentDecisionRecorder — a write failure is never swallowed", () => {
  it("rejects with an M3LAgentOperatorCliError chaining the writer's cause", async () => {
    const failure = new Core.M3LAgentDecisionLogWriteError(
      "append failed: ENOSPC",
    );
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: SECRET_AGENT_NAME }),
      writer: new FailingWriter(failure),
    });

    const thrown = await captureRejection(() =>
      recorder.record({ decision: realDecision(), now: NOW }),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const asError = thrown as M3LAgentOperatorCliError;
    expect(asError.code).toBe("ERR_AGENT_OPERATOR_DECISION_LOG");
    // Chained, not re-messaged: the caller must still be able to reach the
    // library's own write error.
    expect(asError.cause).toBe(failure);
  });

  it("does not echo entry content in its message or context", async () => {
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: SECRET_AGENT_NAME }),
      writer: new FailingWriter(new Error("append failed")),
    });

    const thrown = await captureRejection(() =>
      recorder.record({ decision: realDecision(), now: NOW }),
    );

    const asError = thrown as M3LAgentOperatorCliError;
    const surfaced = `${asError.message} ${JSON.stringify(asError.context)}`;
    expect(surfaced).not.toContain(SECRET_PARAMETER);
    expect(surfaced).not.toContain(SECRET_AGENT_NAME);
  });

  it("normalizes a non-Error rejection instead of leaking it raw", async () => {
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer: new FailingWriter("disk went away"),
    });

    const thrown = await captureRejection(() =>
      recorder.record({ decision: realDecision(), now: NOW }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).cause).toBe("disk went away");
  });

  it("still attempted the write — the failure is the writer's, not a skipped call", async () => {
    const writer = new FailingWriter(new Error("append failed"));
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer,
    });

    await captureRejection(() =>
      recorder.record({ decision: realDecision(), now: NOW }),
    );

    expect(writer.entries).toHaveLength(1);
  });
});

describe("serializedEntryByteLength — one line, measured against the library ceiling", () => {
  it("measures exactly what the library's serializer produces", () => {
    const entry = Core.agentDecisionLogEntry({
      decision: realDecision(),
      identity: agentIdentity({ name: "agent-operator" }),
      now: NOW,
    });
    const line = Core.serializeAgentDecisionLogEntry(entry);

    expect(serializedEntryByteLength(entry)).toBe(Buffer.byteLength(line));
  });

  it("measures a single line with no trailing newline", () => {
    const entry = Core.agentDecisionLogEntry({
      decision: realDecision(),
      identity: agentIdentity({ name: "agent-operator" }),
      now: NOW,
    });
    const line = Core.serializeAgentDecisionLogEntry(entry);

    // The writer owns the separator; a serializer that appended one would
    // produce a blank record between entries.
    expect(line.split("\n")).toHaveLength(1);
    expect(line.endsWith("\n")).toBe(false);
    expect(serializedEntryByteLength(entry)).toBeLessThan(
      Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES,
    );
  });

  it("rejects an oversized entry before the writer is ever called", async () => {
    // 256 long parameter names — within the library's structural ceiling on
    // `parameterNames` (256, reject-above) but well past the 65 536-byte
    // ceiling on one log line. `serializeAgentDecisionLogEntry` does NOT
    // enforce that ceiling; only the writer does — so a recorder that skipped
    // the measurement would hand the writer a line it must reject.
    const names = Array.from(
      { length: Core.M3L_AGENT_MAX_PARAMETER_NAMES },
      (_unused, index) => `parameter-${String(index)}-${"x".repeat(300)}`,
    );
    const writer = new RecordingWriter();
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer,
    });

    const thrown = await captureRejection(() =>
      recorder.record({
        decision: realDecision({
          script: "agent-operator",
          operation: "explain-policy",
          kind: "read-only",
          parameterNames: names,
        }),
        now: NOW,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
    // Fails closed: nothing was handed to the writer at all.
    expect(writer.entries).toHaveLength(0);
  });

  it("rejects an entry serializing to EXACTLY the ceiling, which the writer would reject too", async () => {
    // The boundary case, which "well past the ceiling" and "comfortably under
    // it" both miss. The library's ceiling governs the whole LINE:
    // `internal/storage/append-only-writer.ts` computes
    // `Buffer.byteLength(serialization + "\n")` and rejects `> maxLineBytes`,
    // so an entry whose serialization is exactly
    // `M3L_AGENT_MAX_LOG_ENTRY_BYTES` is 65 537 bytes on the wire and the
    // writer refuses it. `serializedEntryByteLength` measures the entry
    // WITHOUT its newline (the writer owns the separator), so a precheck of
    // `byteLength > M3L_AGENT_MAX_LOG_ENTRY_BYTES` is one byte loose at
    // precisely this point — and at that point the documented promise, "an
    // oversized entry fails closed before the writer is touched", is false:
    // the entry sails past the precheck and dies inside the writer instead.
    const writer = new RecordingWriter();
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: BOUNDARY_AGENT_NAME }),
      writer,
    });

    const thrown = await captureRejection(() =>
      recorder.record({
        decision: decisionSerializingToExactly(
          Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES,
        ),
        now: NOW,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
    // The point of the precheck: the writer is never touched, so the failure
    // is this module's own fail-closed refusal and not a `M3LAgentDecision
    // LogWriteError` surfacing from a half-attempted append.
    expect(writer.entries).toHaveLength(0);
  });
});
