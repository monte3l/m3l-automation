/**
 * `agent-operator/steps/health-observations` — the script-owned collector
 * every gated health-check tool writes its projected result into.
 *
 * @remarks
 * This module exists because of a hard limit in the loop's own return value:
 * `AWS.M3LBedrockToolLoopOutcome`'s per-iteration `toolExecutions` carry only
 * `{ toolUseId, name, status }` — never the payload a handler produced. The
 * fleet findings the report is built from therefore have to be captured
 * **on the way past**, inside each tool's `execute`, or they are gone.
 *
 * The consequence is the design rule this whole slice rests on:
 *
 * **The report is built from these observations, never from the model's
 * message.**
 *
 * A report assembled by parsing the model's reply would be a report the model
 * authors — it could omit a failing check, invent a passing one, or restate a
 * name that never appeared. What the model says lands in exactly one leaf
 * (`model.summary`) and nowhere else.
 *
 * Every stored value is a `MODEL_SAFE_BRAND`-carrying projection from
 * `lib/model-safety`. The brand can only be minted by that module's own
 * projectors, so nothing unsanitized can reach the artifact **by
 * construction** rather than by a reviewer noticing — a raw
 * `AgentOperatorDoctorCheck` is not assignable here, and neither is a
 * hand-written object literal.
 *
 * @packageDocumentation
 */

import type {
  AgentOperatorProjectedDoctorReport,
  AgentOperatorProjectedListRow,
  AgentOperatorProjectedParamDescriptor,
  AgentOperatorProjectedRunEnvelope,
} from "../lib/model-safety.js";

/**
 * One `script_inspect` observation: the script the model asked about, and the
 * projected descriptors the CLI returned for it.
 */
export interface AgentHealthInspectObservation {
  /** The script name, already allowlist-validated before the call ran. */
  readonly script: string;
  /** The projected parameter descriptors `m3l inspect` reported. */
  readonly parameters: readonly AgentOperatorProjectedParamDescriptor[];
}

/** One `script_dry_run` observation: the script probed, and its run envelope. */
export interface AgentHealthDryRunObservation {
  /** The script name, already allowlist-validated before the probe ran. */
  readonly script: string;
  /** The projected `m3l.run.result` envelope the probe produced. */
  readonly envelope: AgentOperatorProjectedRunEnvelope;
}

/**
 * Everything the run actually observed, frozen for the report writer.
 *
 * @remarks
 * `doctor` and `list` are single-valued because the fleet has one of each;
 * they hold the **last** observation when the model calls a tool twice, which
 * is the honest answer (the later call is the more current fleet state). The
 * two per-script collections are arrays because the model may legitimately
 * inspect or probe several scripts in one run.
 *
 * @example
 * ```ts
 * import type { AgentHealthObservationSnapshot } from "./health-observations.js";
 *
 * function inspected(snapshot: AgentHealthObservationSnapshot): number {
 *   return snapshot.inspections.length;
 * }
 * ```
 */
export interface AgentHealthObservationSnapshot {
  /** The last `fleet_list` result, or `undefined` when never called. */
  readonly fleet: readonly AgentOperatorProjectedListRow[] | undefined;
  /** The last `fleet_doctor` result, or `undefined` when never called. */
  readonly doctor: AgentOperatorProjectedDoctorReport | undefined;
  /** Every `script_inspect` result, in call order. */
  readonly inspections: readonly AgentHealthInspectObservation[];
  /** Every `script_dry_run` result, in call order. */
  readonly dryRuns: readonly AgentHealthDryRunObservation[];
}

/**
 * The mutable collector handed to every gated tool's `execute`.
 *
 * @remarks
 * Deliberately write-only from a tool's point of view — a tool records, it
 * never reads back — so one tool's result can never influence another's
 * behaviour. Only {@link AgentHealthObservations.snapshot} reads, and only the
 * report writer calls it.
 *
 * @example
 * ```ts
 * import { AgentHealthObservations } from "./health-observations.js";
 *
 * const observations = new AgentHealthObservations();
 * const snapshot = observations.snapshot();
 * // snapshot.doctor === undefined until fleet_doctor has actually run
 * ```
 */
export class AgentHealthObservations {
  /** The last `fleet_list` projection; `undefined` until the tool runs. */
  private fleet: readonly AgentOperatorProjectedListRow[] | undefined =
    undefined;
  /** The last `fleet_doctor` projection; `undefined` until the tool runs. */
  private doctor: AgentOperatorProjectedDoctorReport | undefined = undefined;
  /** Every `script_inspect` projection, in call order. */
  private readonly inspections: AgentHealthInspectObservation[] = [];
  /** Every `script_dry_run` projection, in call order. */
  private readonly dryRuns: AgentHealthDryRunObservation[] = [];

  /**
   * Records the fleet roster `m3l list --json` returned.
   *
   * @param rows - The projected list rows.
   *
   * @example
   * ```ts
   * import { AgentHealthObservations } from "./health-observations.js";
   *
   * declare const observations: AgentHealthObservations;
   * observations.recordFleet([]);
   * ```
   */
  recordFleet(rows: readonly AgentOperatorProjectedListRow[]): void {
    this.fleet = rows;
  }

  /**
   * Records the report `m3l doctor --json` returned.
   *
   * @param report - The projected doctor report.
   *
   * @example
   * ```ts
   * import { AgentHealthObservations } from "./health-observations.js";
   * import type { AgentOperatorProjectedDoctorReport } from "../lib/model-safety.js";
   *
   * declare const observations: AgentHealthObservations;
   * declare const report: AgentOperatorProjectedDoctorReport;
   * observations.recordDoctor(report);
   * ```
   */
  recordDoctor(report: AgentOperatorProjectedDoctorReport): void {
    this.doctor = report;
  }

  /**
   * Records one `m3l inspect <name> --json` result.
   *
   * @param script - The inspected script name.
   * @param parameters - The projected parameter descriptors.
   *
   * @example
   * ```ts
   * import { AgentHealthObservations } from "./health-observations.js";
   *
   * declare const observations: AgentHealthObservations;
   * observations.recordInspection("s3-objects", []);
   * ```
   */
  recordInspection(
    script: string,
    parameters: readonly AgentOperatorProjectedParamDescriptor[],
  ): void {
    this.inspections.push(Object.freeze({ script, parameters }));
  }

  /**
   * Records one `m3l run <name> --json -- --dry-run` result.
   *
   * @param script - The probed script name.
   * @param envelope - The projected run envelope.
   *
   * @example
   * ```ts
   * import { AgentHealthObservations } from "./health-observations.js";
   * import type { AgentOperatorProjectedRunEnvelope } from "../lib/model-safety.js";
   *
   * declare const observations: AgentHealthObservations;
   * declare const envelope: AgentOperatorProjectedRunEnvelope;
   * observations.recordDryRun("json-etl", envelope);
   * ```
   */
  recordDryRun(
    script: string,
    envelope: AgentOperatorProjectedRunEnvelope,
  ): void {
    this.dryRuns.push(Object.freeze({ script, envelope }));
  }

  /**
   * Freezes what has been observed so far into a snapshot for the report.
   *
   * @remarks
   * Both arrays are **copied**, not aliased: the report writer must not hold
   * a live view a later tool call could still mutate, and an artifact must
   * stay what it recorded.
   *
   * The two single-valued fields are typed `| undefined` and written
   * unconditionally, deliberately unlike `steps/run-ledger`'s conditional
   * spreads. Nothing downstream reads them with `Object.hasOwn` — this
   * snapshot never crosses a library boundary that treats a present
   * `undefined` as malformed — and an explicit `undefined` is the clearer
   * signal at the one place it matters: `undefined` means the tool was never
   * called, which `steps/health-report` distinguishes from "called and found
   * nothing".
   *
   * @returns A frozen {@link AgentHealthObservationSnapshot}.
   *
   * @example
   * ```ts
   * import { AgentHealthObservations } from "./health-observations.js";
   *
   * const snapshot = new AgentHealthObservations().snapshot();
   * // snapshot.inspections === []
   * ```
   */
  snapshot(): AgentHealthObservationSnapshot {
    return Object.freeze({
      fleet: this.fleet,
      doctor: this.doctor,
      inspections: Object.freeze([...this.inspections]),
      dryRuns: Object.freeze([...this.dryRuns]),
    });
  }
}
