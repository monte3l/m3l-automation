/**
 * `agent-operator/steps/health-report` — the `m3l.agent-operator.health-check`
 * artifact, and the anomaly derivation the run's exit code is built from.
 *
 * @remarks
 * Two rules shape everything here.
 *
 * **1. The report is derived from observations, never from the model's
 * message.** {@link deriveHealthAnomalies} reads only the projected CLI
 * results `steps/health-observations` collected on the way past. A model
 * cannot suppress a failing check by not mentioning it, nor invent a passing
 * one by claiming it.
 *
 * **2. The model's free text is exactly one untrusted leaf.** It lands at
 * `model.summary` and nowhere else, never concatenated into prose. A reviewer
 * greps this file for `summary` and finds exactly one assignment site.
 *
 * That leaf is run through **`sanitizeForModel`** — the *outbound* sanitizer,
 * used inbound, deliberately. The four hazards are identical in both
 * directions: an echoed secret, an absolute host path, a bidi/C1 control that
 * turns `cat report.json` into terminal injection for whoever reads the
 * artifact, and unbounded length. Writing a second, inbound-only sanitizer
 * would mean two denylists to keep in step, and the one that got less
 * attention would be the one on the untrusted side.
 *
 * @packageDocumentation
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { sanitizeForModel } from "../lib/model-safety.js";
import type { AgentHealthObservationSnapshot } from "./health-observations.js";

/** The artifact's `kind` discriminant. */
const HEALTH_REPORT_KIND = "m3l.agent-operator.health-check";

/**
 * The artifact's schema version. Bump only on a breaking shape change — a
 * consumer pins this, exactly as `m3l.run.result` does.
 */
const HEALTH_REPORT_SCHEMA_VERSION = 1;

/**
 * The code-point cap on the model's summary. Roughly four times
 * `sanitizeForModel`'s own default: the summary is the one field a human
 * actually reads for narrative, and the default 512 truncates a useful
 * paragraph mid-sentence. It is still a hard bound — the point of the cap is
 * that an unbounded model reply cannot inflate the artifact without limit.
 */
const SUMMARY_MAX_CODE_POINTS = 2048;

/**
 * One thing the run found wrong, derived from a projected CLI result.
 *
 * @example
 * ```ts
 * import type { AgentHealthAnomaly } from "./health-report.js";
 *
 * const anomaly: AgentHealthAnomaly = {
 *   kind: "doctor-check-failed",
 *   subject: "workspace-root",
 *   detail: "no workspace marker found",
 * };
 * ```
 */
export interface AgentHealthAnomaly {
  /** What class of problem this is. A closed vocabulary a consumer can switch on. */
  readonly kind:
    | "doctor-check-failed"
    | "doctor-check-warned"
    | "script-config-load-failed"
    | "dry-run-probe-failed";
  /** What it is about — a check name or a script name. Always script- or CLI-authored. */
  readonly subject: string;
  /** A short, already-sanitized explanation. */
  readonly detail: string;
}

/**
 * The `m3l.agent-operator.health-check` artifact.
 *
 * @remarks
 * `blocking` is the field a scheduler reads. It is `true` when at least one
 * anomaly was found — which is what drives the run to `partial` (exit `6`),
 * never a throw: a failing health check is the *answer*, not an error, and
 * the same asymmetry the CLI seam already encodes by accepting `doctor`'s
 * exit `1`.
 *
 * @example
 * ```ts
 * import type { AgentHealthReport } from "./health-report.js";
 *
 * function isHealthy(report: AgentHealthReport): boolean {
 *   return !report.blocking;
 * }
 * ```
 */
export interface AgentHealthReport {
  /** The artifact discriminant. */
  readonly kind: typeof HEALTH_REPORT_KIND;
  /** The artifact schema version a consumer pins. */
  readonly schemaVersion: typeof HEALTH_REPORT_SCHEMA_VERSION;
  /** When the run concluded, ISO-8601, from the caller's single `now` sample. */
  readonly completedAt: string;
  /** `true` when at least one anomaly was found. */
  readonly blocking: boolean;
  /** Every anomaly, derived from observations only. */
  readonly anomalies: readonly AgentHealthAnomaly[];
  /** What the loop actually did — script-authored counters, never model claims. */
  readonly loop: {
    /** Completed model turns. */
    readonly iterations: number;
    /** Total tokens across every turn. */
    readonly tokens: number;
    /** Cost, or `null` when a served model had no declared rate. */
    readonly cost: number | null;
    /** Why the loop stopped, or `null` when it was cut short by a ceiling. */
    readonly stopReason: string | null;
  };
  /** What the run observed, as counts — the payloads stay in the decision log. */
  readonly observed: {
    /** Scripts the fleet roster reported, or `null` when never listed. */
    readonly fleetSize: number | null;
    /** Doctor checks run, or `null` when doctor was never called. */
    readonly doctorChecks: number | null;
    /** Scripts inspected. */
    readonly inspected: number;
    /** Scripts dry-run probed. */
    readonly dryRunProbes: number;
  };
  /** The model's own words. THE ONE untrusted leaf in this artifact. */
  readonly model: {
    /** Sanitized free text, or `null` when the model produced none. */
    readonly summary: string | null;
  };
}

/** Collects the doctor-derived anomalies. */
function doctorAnomalies(
  snapshot: AgentHealthObservationSnapshot,
): readonly AgentHealthAnomaly[] {
  const report = snapshot.doctor;
  if (report === undefined) return [];
  const found: AgentHealthAnomaly[] = [];
  for (const check of report.checks) {
    if (check.status === "fail") {
      found.push({
        kind: "doctor-check-failed",
        subject: check.name,
        detail: check.detail,
      });
    } else if (check.status === "warn") {
      found.push({
        kind: "doctor-check-warned",
        subject: check.name,
        detail: check.detail,
      });
    }
  }
  return found;
}

/** Collects the fleet-roster-derived anomalies. */
function fleetAnomalies(
  snapshot: AgentHealthObservationSnapshot,
): readonly AgentHealthAnomaly[] {
  const rows = snapshot.fleet;
  if (rows === undefined) return [];
  return rows
    .filter((row) => row.configLoadFailed)
    .map((row) => ({
      kind: "script-config-load-failed" as const,
      subject: row.name,
      // The row's `loadError` text is DROPPED by `projectListRow` — the model
      // gets the fact, not the text — so the artifact reports the same fact.
      // Do not "enrich" this with the error string; that asymmetry is the
      // deliberate one `lib/model-safety` documents.
      detail: "the script's declared configuration could not be loaded",
    }));
}

/** Collects the dry-run-probe-derived anomalies. */
function dryRunAnomalies(
  snapshot: AgentHealthObservationSnapshot,
): readonly AgentHealthAnomaly[] {
  return snapshot.dryRuns
    .filter((probe) => probe.envelope.exitCode !== 0)
    .map((probe) => ({
      kind: "dry-run-probe-failed" as const,
      subject: probe.script,
      detail: `the --dry-run probe exited ${String(probe.envelope.exitCode)}`,
    }));
}

/**
 * Derives every anomaly the run observed.
 *
 * @remarks
 * Reads **only** `snapshot`. A `warn` counts as an anomaly deliberately: this
 * workload exists for unattended monitoring, and a scheduler that only ever
 * hears about hard failures learns nothing from a fleet degrading gradually.
 * The `kind` discriminates the two, so a consumer that wants to ignore warns
 * can — explicitly, in its own code, rather than because this function
 * silently dropped them.
 *
 * @param snapshot - What the gated tools actually observed.
 * @returns Every anomaly found, in a stable order: doctor, then fleet, then
 *   probes. Stable so two runs over the same fleet produce byte-identical
 *   artifacts.
 *
 * @example
 * ```ts
 * import { deriveHealthAnomalies } from "./health-report.js";
 * import { AgentHealthObservations } from "./health-observations.js";
 *
 * const anomalies = deriveHealthAnomalies(
 *   new AgentHealthObservations().snapshot(),
 * );
 * // [] — nothing was observed, so nothing is wrong
 * ```
 */
export function deriveHealthAnomalies(
  snapshot: AgentHealthObservationSnapshot,
): readonly AgentHealthAnomaly[] {
  return Object.freeze([
    ...doctorAnomalies(snapshot),
    ...fleetAnomalies(snapshot),
    ...dryRunAnomalies(snapshot),
  ]);
}

/**
 * Extracts the model's free text from its final message — the one untrusted
 * value that reaches the artifact.
 *
 * @remarks
 * Only `text` blocks are read. A `toolUse` block is the model asking for
 * something, and a `toolResult` block is this script's own output echoed
 * back; neither is narrative, and stringifying either would smuggle
 * structured content into a prose field. Blocks are joined with a blank line
 * rather than concatenated, and the whole result goes through
 * `sanitizeForModel` **once, at the end** — after joining, so a control
 * character split across a block boundary cannot slip past.
 *
 * A consequence worth stating rather than discovering: the sanitizer escapes
 * C0, **line feed included**, so `summary` is a single line by construction
 * and a paragraph break renders as the literal text `\u000a\u000a`. That is
 * the price of reusing the outbound sanitizer instead of writing an
 * inbound-only variant, and it is the right price — an unescaped control in a
 * field a human will `cat` is terminal injection, and a second denylist is
 * one more thing to keep in step.
 *
 * Returns `null`, never `""`, when there is no text: an empty string reads as
 * "the model said nothing meaningful", which is a different claim from "the
 * model produced no text block at all", and only the latter is true here.
 */
function extractModelSummary(
  message: AWS.M3LBedrockMessage,
  workspaceRoot: string | undefined,
): string | null {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  if (parts.length === 0) return null;
  const sanitized = sanitizeForModel(
    parts.join("\n\n"),
    SUMMARY_MAX_CODE_POINTS,
    workspaceRoot === undefined ? {} : { workspaceRoot },
  );
  return sanitized.length === 0 ? null : sanitized;
}

/** Inputs for {@link buildHealthReport}. */
export interface BuildHealthReportOptions {
  /** What the gated tools observed. The sole source of every anomaly. */
  readonly snapshot: AgentHealthObservationSnapshot;
  /**
   * The model's final message, or `undefined` when the loop never produced
   * one (a ceiling breach). Absent is not an error — the report is still
   * complete, because it was never built from this.
   */
  readonly message: AWS.M3LBedrockMessage | undefined;
  /** Completed model turns, from the metering seam. */
  readonly iterations: number;
  /** Total tokens, from the metering seam. */
  readonly tokens: number;
  /** Cost, or `undefined` when a served model lacked a declared rate. */
  readonly cost: number | undefined;
  /** Why the loop stopped, or `undefined` when a ceiling cut it short. */
  readonly stopReason: string | undefined;
  /** The caller's single `now` sample, stamped as `completedAt`. */
  readonly now: number;
  /** The workspace root to scrub out of the model's summary, when resolvable. */
  readonly workspaceRoot: string | undefined;
}

/**
 * Builds the frozen `m3l.agent-operator.health-check` artifact.
 *
 * @param options - See {@link BuildHealthReportOptions}.
 * @returns The frozen report.
 *
 * @example
 * ```ts
 * import { buildHealthReport } from "./health-report.js";
 * import { AgentHealthObservations } from "./health-observations.js";
 *
 * const report = buildHealthReport({
 *   snapshot: new AgentHealthObservations().snapshot(),
 *   message: undefined,
 *   iterations: 0,
 *   tokens: 0,
 *   cost: 0,
 *   stopReason: "end_turn",
 *   now: Date.now(),
 *   workspaceRoot: undefined,
 * });
 * ```
 */
export function buildHealthReport(
  options: BuildHealthReportOptions,
): AgentHealthReport {
  const anomalies = deriveHealthAnomalies(options.snapshot);
  return Object.freeze({
    kind: HEALTH_REPORT_KIND,
    schemaVersion: HEALTH_REPORT_SCHEMA_VERSION,
    completedAt: new Date(options.now).toISOString(),
    blocking: anomalies.length > 0,
    anomalies,
    loop: Object.freeze({
      iterations: options.iterations,
      tokens: options.tokens,
      // `null`, not an omitted key: this artifact is JSON on disk, where an
      // absent key and a null are indistinguishable to a reader who did not
      // write the schema. `null` says "unpriceable" out loud.
      cost: options.cost ?? null,
      stopReason: options.stopReason ?? null,
    }),
    observed: Object.freeze({
      fleetSize: options.snapshot.fleet?.length ?? null,
      doctorChecks: options.snapshot.doctor?.checks.length ?? null,
      inspected: options.snapshot.inspections.length,
      dryRunProbes: options.snapshot.dryRuns.length,
    }),
    model: Object.freeze({
      // THE one untrusted leaf. Exactly one assignment site in this module.
      summary:
        options.message === undefined
          ? null
          : extractModelSummary(options.message, options.workspaceRoot),
    }),
  });
}

/** Inputs for {@link writeHealthReport}. */
export interface WriteHealthReportOptions {
  /** The report to persist. */
  readonly report: AgentHealthReport;
  /** The paths port, for resolving `output` under `M3L_OUTPUT_DIR`. */
  readonly paths: Core.M3LPaths;
  /** The `output` config override, or `undefined` for the default filename. */
  readonly output: string | undefined;
}

/** The artifact's default filename under the output directory. */
const HEALTH_REPORT_DEFAULT_FILENAME = "agent-operator-health-check.json";

/**
 * Writes the artifact under `M3L_OUTPUT_DIR` via `Core.M3LJSONFileExporter`.
 *
 * @remarks
 * The output directory, not `data/agent-state/`: this **is** a run artifact,
 * the kind an operator is meant to read and then clear. That is the exact
 * opposite of the cross-run counter, and the two live apart for that reason.
 *
 * The parent directory is created here. `M3LJSONFileExporter.export` is a
 * bare `writeFile` and does not create it — the same gap
 * `steps/daily-counter` covers for `writeFileAtomic`, and the same fix.
 *
 * @param options - See {@link WriteHealthReportOptions}.
 * @returns The absolute path written, so the caller can log it.
 * @throws {@link Core.M3LPathResolutionError} When `output` is absolute or
 *   escapes the output directory. Not wrapped: the library's own message
 *   already names the constraint, and the value is operator-supplied config,
 *   not model output.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { writeHealthReport } from "./health-report.js";
 * import type { AgentHealthReport } from "./health-report.js";
 *
 * declare const report: AgentHealthReport;
 *
 * await writeHealthReport({
 *   report,
 *   paths: new Core.M3LPaths(),
 *   output: undefined,
 * });
 * ```
 */
export async function writeHealthReport(
  options: WriteHealthReportOptions,
): Promise<string> {
  const filePath = options.paths.resolveOutput(
    options.output ?? HEALTH_REPORT_DEFAULT_FILENAME,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await new Core.M3LJSONFileExporter({ filePath }).export(options.report);
  return filePath;
}
