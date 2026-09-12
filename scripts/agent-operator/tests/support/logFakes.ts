/**
 * Test-only fakes for the `steps/decision-recorder` `AgentDecisionLogWriter`
 * port (ADR-0061) — the one-method sink `AgentDecisionRecorder` appends
 * entries to. Mirrors `tests/support/cliFakes.ts`'s builder style: small,
 * composable fakes plus a queue-driven variant for a scenario that needs a
 * write to succeed once and then fail (or vice versa), rather than a fresh
 * bespoke class per test file.
 *
 * These are the SAME shapes used inline in `tests/steps/preflight-log.test.ts`
 * (`ProbingWriter`/`FailingWriter`) and `tests/steps/decision-recorder.test.ts`
 * (`RecordingWriter`/`FailingWriter`) — centralized here so
 * `gate-tool.test.ts` and `build-tool-registry.test.ts` don't each redeclare
 * them, and so the gate-ordering matrix can share one vocabulary of writers.
 */

import { Core } from "@m3l-automation/m3l-common";

import type { AgentDecisionLogWriter } from "../../src/steps/decision-recorder.js";

/**
 * One scripted write outcome: `"ok"` resolves, an `Error` (or `M3LError`
 * subclass) rejects with that exact value.
 */
export type DecisionLogWriteOutcome = "ok" | Error;

/**
 * A writer whose per-call outcome is scripted in advance via a FIFO queue,
 * so a single instance can prove an ordering claim that spans a write
 * succeeding and a later write on the SAME instance failing (or the
 * reverse) — the shape every "post-record write fails, pre-record
 * succeeded" gate-ordering case needs. Once the queue is exhausted every
 * further call resolves — the safe default, so a test that only cares about
 * the first N calls need not pad the queue.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { ScriptedDecisionLogWriter } from "./logFakes.js";
 *
 * const calls: string[] = [];
 * const writer = new ScriptedDecisionLogWriter(
 *   ["ok", new Core.M3LAgentDecisionLogWriteError("append failed: EACCES")],
 *   () => calls.push("record"),
 * );
 * ```
 */
export class ScriptedDecisionLogWriter implements AgentDecisionLogWriter {
  /** Every entry handed to `write`, in call order. */
  readonly entries: Core.M3LAgentDecisionLogEntry[] = [];

  private readonly queue: DecisionLogWriteOutcome[];
  private readonly onWrite: () => void;

  constructor(
    outcomes: readonly DecisionLogWriteOutcome[] = [],
    onWrite: () => void = () => undefined,
  ) {
    this.queue = [...outcomes];
    this.onWrite = onWrite;
  }

  write(entry: Core.M3LAgentDecisionLogEntry): Promise<void> {
    this.entries.push(entry);
    this.onWrite();
    const outcome = this.queue.shift() ?? "ok";
    return outcome === "ok" ? Promise.resolve() : Promise.reject(outcome);
  }
}

/**
 * Records every entry handed to it and always resolves — the happy-path
 * writer for a gate-ordering case that must observe the log as available.
 *
 * @example
 * ```ts
 * import { RecordingDecisionLogWriter } from "./logFakes.js";
 *
 * const calls: string[] = [];
 * const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
 * ```
 */
export class RecordingDecisionLogWriter implements AgentDecisionLogWriter {
  private readonly delegate: ScriptedDecisionLogWriter;

  /**
   * @param onWrite - Invoked synchronously on every `write` call, before the
   *   returned promise settles, so a test can probe collaborator state (or
   *   push into a shared `calls` array) at the exact moment of the write.
   */
  constructor(onWrite: () => void = () => undefined) {
    this.delegate = new ScriptedDecisionLogWriter([], onWrite);
  }

  get entries(): readonly Core.M3LAgentDecisionLogEntry[] {
    return this.delegate.entries;
  }

  write(entry: Core.M3LAgentDecisionLogEntry): Promise<void> {
    return this.delegate.write(entry);
  }
}

/**
 * Records the attempt, then always rejects — the "the log is not writable"
 * seam a gate-ordering case drives to prove `execute` is never reached.
 *
 * @example
 * ```ts
 * import { FailingDecisionLogWriter } from "./logFakes.js";
 *
 * const writer = new FailingDecisionLogWriter();
 * ```
 */
export class FailingDecisionLogWriter implements AgentDecisionLogWriter {
  /** Every entry handed to `write`, in call order — every one then rejected. */
  readonly entries: Core.M3LAgentDecisionLogEntry[] = [];

  private readonly failure: Error;
  private readonly onWrite: () => void;

  /**
   * @param failure - The rejection value every call produces. Defaults to a
   *   real `Core.M3LAgentDecisionLogWriteError` rather than a plain `Error`,
   *   since that is what the real writer this fake stands in for actually
   *   throws.
   * @param onWrite - See {@link RecordingDecisionLogWriter}.
   */
  constructor(
    failure: Error = new Core.M3LAgentDecisionLogWriteError(
      "append failed: EACCES",
    ),
    onWrite: () => void = () => undefined,
  ) {
    this.failure = failure;
    this.onWrite = onWrite;
  }

  write(entry: Core.M3LAgentDecisionLogEntry): Promise<void> {
    this.entries.push(entry);
    this.onWrite();
    return Promise.reject(this.failure);
  }
}
