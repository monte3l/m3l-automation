/**
 * `agent-operator/steps/decision-recorder` — the agent identity, the
 * script-local decision-log writer port, and the write helpers (ADR-0061).
 *
 * The port exists for a type reason, not a taste one:
 * `Core.M3LAgentDecisionLog` carries a TS `private` member and is therefore
 * **nominal**, so no structural test double could ever be assignable to it.
 * Depending on a one-method port instead keeps this step testable without a
 * real file on disk, while the real library class still satisfies the port
 * structurally.
 *
 * Entries are built and serialized exclusively by the library's own
 * `Core.agentDecisionLogEntry` / `Core.serializeAgentDecisionLogEntry` — an
 * entry assembled any other way is precisely the audit defect this module
 * exists to prevent.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";

/**
 * The one method this script needs from a decision-log sink.
 *
 * @remarks
 * A strict subset of `Core.M3LAgentDecisionLog`'s surface, so the real class
 * is assignable here without a cast. Never widen it beyond what the recorder
 * actually calls — every added member is another thing a caller's own sink
 * must implement.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AgentDecisionLogWriter } from "./decision-recorder.js";
 *
 * const writer: AgentDecisionLogWriter = new Core.M3LAgentDecisionLog({
 *   directory: "/var/lib/agent-operator/agent-log",
 * });
 * ```
 */
export interface AgentDecisionLogWriter {
  /**
   * Appends one entry, resolving only once it is durably written.
   *
   * @param entry - The library-built entry to append.
   */
  write(entry: Core.M3LAgentDecisionLogEntry): Promise<void>;
}

/**
 * Builds a `Core.M3LAgentIdentity`, **omitting** any absent optional field.
 *
 * @remarks
 * The signature deliberately accepts `string | undefined` for the optional
 * fields, because that is what a config accessor actually returns —
 * forwarding that `undefined` onto the identity would make the library throw,
 * since it reads presence with `Object.hasOwn`. This function is the one
 * place that `string | undefined` is converted into genuine absence.
 *
 * @param fields - The identity fields; `modelId`/`awsPrincipal` may be
 *   `undefined` and are then omitted entirely.
 * @returns The identity, with no own key holding `undefined`.
 *
 * @example
 * ```ts
 * import { agentIdentity } from "./decision-recorder.js";
 *
 * const identity = agentIdentity({ name: "agent-operator", modelId: undefined });
 * // Object.hasOwn(identity, "modelId") === false
 * ```
 */
export function agentIdentity(fields: {
  readonly name: string;
  readonly modelId?: string | undefined;
  readonly awsPrincipal?: string | undefined;
}): Core.M3LAgentIdentity {
  return {
    name: fields.name,
    ...(fields.modelId === undefined ? {} : { modelId: fields.modelId }),
    ...(fields.awsPrincipal === undefined
      ? {}
      : { awsPrincipal: fields.awsPrincipal }),
  };
}

/**
 * Measures the exact byte length of the single JSONL line the library's own
 * serializer produces for `entry`.
 *
 * @remarks
 * `JSON.stringify` is typed `string` but returns `undefined` for an input it
 * cannot represent, so the result is narrowed before it is measured rather
 * than trusted. The library's serializer deliberately does **not** enforce
 * `Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES` — only the writer does — which is why
 * the recorder measures here, before the writer is ever called.
 *
 * @param entry - The library-built entry to measure.
 * @returns The UTF-8 byte length of the serialized line (no trailing
 *   newline; the writer owns the separator). The library's ceiling governs
 *   the line *including* that newline, so a caller comparing this figure
 *   against `Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES` must reject on `>=`, never
 *   on `>`.
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_DECISION_LOG` when the entry cannot be serialized at
 *   all.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { serializedEntryByteLength } from "./decision-recorder.js";
 *
 * declare const entry: Core.M3LAgentDecisionLogEntry;
 *
 * // `<`, not `<=`: the writer appends a newline this measurement omits.
 * const fits = serializedEntryByteLength(entry) < Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES;
 * ```
 */
export function serializedEntryByteLength(
  entry: Core.M3LAgentDecisionLogEntry,
): number {
  const line: string | undefined = Core.serializeAgentDecisionLogEntry(entry);
  if (typeof line !== "string") {
    throw new M3LAgentOperatorCliError(
      "the decision-log entry could not be serialized to a JSONL line",
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
  }
  return Buffer.byteLength(line, "utf8");
}

/**
 * One decision to record, plus the optional outcome/usage figures a later
 * slice will supply once it meters them.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AgentDecisionRecordInput } from "./decision-recorder.js";
 *
 * declare const decision: Core.M3LAgentDecision;
 *
 * const input: AgentDecisionRecordInput = { decision, now: Date.now() };
 * ```
 */
export interface AgentDecisionRecordInput {
  /** The verdict to record, exactly as the evaluator returned it. */
  readonly decision: Core.M3LAgentDecision;
  /** The caller-sampled instant; the recorder reads no clock of its own. */
  readonly now: number;
  /** What executing the action actually did, when it has already run. */
  readonly outcome?: Core.M3LAgentDecisionOutcome;
  /** Tokens consumed, when the caller meters them. */
  readonly tokens?: number;
  /** Cost incurred, when the caller meters it. */
  readonly cost?: number;
}

/** Constructor options for {@link AgentDecisionRecorder}. */
interface AgentDecisionRecorderOptions {
  /** The identity stamped onto every entry this recorder writes. */
  readonly identity: Core.M3LAgentIdentity;
  /** The sink entries are appended to. */
  readonly writer: AgentDecisionLogWriter;
}

/**
 * Writes one library-built decision-log entry per recorded decision.
 *
 * @remarks
 * Resolution **is** the success signal: the returned promise settles only
 * after the writer has accepted the entry, which is what lets a caller
 * treat a successful `record()` as the observation that the log is writable.
 * A failed write is always wrapped as an
 * `ERR_AGENT_OPERATOR_DECISION_LOG`-coded
 * {@link M3LAgentOperatorCliError} chaining the original failure as `cause` —
 * never swallowed, and never re-messaged in a way that loses the library's
 * own write error.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { AgentDecisionRecorder, agentIdentity } from "./decision-recorder.js";
 *
 * declare const decision: Core.M3LAgentDecision;
 *
 * const recorder = new AgentDecisionRecorder({
 *   identity: agentIdentity({ name: "agent-operator" }),
 *   writer: new Core.M3LAgentDecisionLog(),
 * });
 * await recorder.record({ decision, now: Date.now() });
 * ```
 */
export class AgentDecisionRecorder {
  private readonly identity: Core.M3LAgentIdentity;
  private readonly writer: AgentDecisionLogWriter;

  /**
   * @param options - See {@link AgentDecisionRecorderOptions}.
   */
  constructor(options: AgentDecisionRecorderOptions) {
    this.identity = options.identity;
    this.writer = options.writer;
  }

  /**
   * Builds the entry for `input` through the library's own builder, checks it
   * against the library's single-line byte ceiling, and appends it.
   *
   * @param input - See {@link AgentDecisionRecordInput}.
   * @returns The entry that was written.
   * @throws {@link M3LAgentOperatorCliError} coded
   *   `ERR_AGENT_OPERATOR_DECISION_LOG` when the serialized entry reaches or
   *   exceeds `Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES` — the ceiling governs the
   *   line including the newline the writer appends, so exactly the ceiling
   *   is already one byte too long, and nothing is handed to the writer — or
   *   when the writer itself fails.
   *
   * @example
   * ```ts
   * import { Core } from "@m3l-automation/m3l-common";
   * import { AgentDecisionRecorder } from "./decision-recorder.js";
   *
   * declare const recorder: AgentDecisionRecorder;
   * declare const decision: Core.M3LAgentDecision;
   *
   * const entry = await recorder.record({ decision, now: Date.now() });
   * ```
   */
  async record(
    input: AgentDecisionRecordInput,
  ): Promise<Core.M3LAgentDecisionLogEntry> {
    const entry = Core.agentDecisionLogEntry({
      decision: input.decision,
      identity: this.identity,
      now: input.now,
      // Conditional spreads: `outcome`/`tokens`/`cost` are omitted-when-absent
      // on this object, unlike `operation`, which the library materialises as
      // a required key holding `undefined`.
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
      ...(input.cost === undefined ? {} : { cost: input.cost }),
    });
    this.assertWithinLineCeiling(entry);
    try {
      await this.writer.write(entry);
    } catch (cause) {
      // Wrapped even when `cause` is already an M3LError: the code is the
      // discriminant a catch site reads, and the library's own write error is
      // preserved verbatim as `cause`.
      throw new M3LAgentOperatorCliError(
        "failed to append the agent decision-log entry",
        "ERR_AGENT_OPERATOR_DECISION_LOG",
        { cause },
      );
    }
    return entry;
  }

  /**
   * Fails closed when the serialized entry would exceed the library's
   * single-line ceiling, so the writer is never handed a line it must reject
   * mid-append. Neither the message nor the context echoes entry content —
   * an entry carries parameter names and model-adjacent identity fields.
   *
   * The comparison is `>=`, not `>`, and must stay that way: the library's
   * ceiling governs the whole **line including its trailing newline**
   * (`internal/storage/append-only-writer.ts` measures
   * `Buffer.byteLength(serialization + "\n")` and rejects anything above
   * `maxLineBytes`), while {@link serializedEntryByteLength} measures the
   * entry *without* the separator the writer owns. An entry serializing to
   * exactly `Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES` is therefore one byte over
   * on the wire, so a `>` precheck would wave it through and let it die
   * inside the writer — falsifying this method's own fail-closed promise.
   */
  private assertWithinLineCeiling(entry: Core.M3LAgentDecisionLogEntry): void {
    const byteLength = serializedEntryByteLength(entry);
    if (byteLength >= Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES) {
      throw new M3LAgentOperatorCliError(
        "the agent decision-log entry exceeds the library's single-line byte ceiling",
        "ERR_AGENT_OPERATOR_DECISION_LOG",
        {
          context: {
            byteLength,
            ceiling: Core.M3L_AGENT_MAX_LOG_ENTRY_BYTES,
          },
        },
      );
    }
  }
}
