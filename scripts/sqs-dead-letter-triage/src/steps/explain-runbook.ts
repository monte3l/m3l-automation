import type { Core } from "@m3l-automation/m3l-common";

import { buildTriageProcedure } from "./build-procedure.js";
import { loadRunbook, PRESET_EXTENSION } from "./load-runbook.js";

/**
 * Resolves a queue name to its preset path inside the runbook directory.
 * Exported so every caller that needs a preset's path — `explainRunbook`
 * here and `triageQueue` in `triage-queue.ts` — derives it from this one
 * place rather than re-interpolating `<runbookDir>/<queue>.json` a second
 * time; `config.ts`'s `queue` traversal guard is written assuming exactly
 * one such interpolation exists for THIS template. `queue` is also
 * interpolated separately into an archive filename (`drain-queue.ts`'s
 * `archiveNameFor`) and a report artifact name (`dispatchTriage`'s own
 * `${queue}/triage-...` interpolation) — three sites in total, not one. That is not a gap: the guard validates the raw `queue` value
 * itself before any of the three interpolations run, so all three are
 * equally protected, and `M3LPaths.resolveOutput` throws
 * `M3LPathResolutionError` on escape as a second layer regardless of which
 * call site produced the path. This function is simply the one preset-path
 * template, not the sole anchor for path safety.
 *
 * @param runbookDir - The preset directory, relative to the input directory.
 * @param queue - The queue name; already guarded against `/`/`..` by
 *   `config.ts`'s cross-parameter validator before it reaches here.
 * @returns The preset's path, relative to the input directory.
 *
 * @example
 * ```typescript
 * import { presetPathFor } from "./explain-runbook.js";
 *
 * presetPathFor("runbooks", "orders-dlq"); // "runbooks/orders-dlq.json"
 * ```
 */
export function presetPathFor(runbookDir: string, queue: string): string {
  return `${runbookDir}/${queue}${PRESET_EXTENSION}`;
}

/** What {@link explainRunbook} needs. */
export interface ExplainRunbookDeps {
  readonly reader: Core.M3LInputFileReader;
  readonly logger: Core.M3LLogger;
  readonly runbookDir: string;
  readonly queue: string;
}

/**
 * Builds one queue's procedure and prints what it would do: every step in
 * execution order with its kind and jump targets, every case in descending
 * priority order with its condition, the mandatory fallback, and the
 * definition digest.
 *
 * Offline, like `validate` — nothing here executes a step or reaches AWS.
 *
 * @param deps - The input-file reader, logger, preset directory, and queue name.
 * @returns The built procedure's summary, so a caller can assert on it.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { explainRunbook } from "./explain-runbook.js";
 *
 * const paths = new Core.M3LPaths();
 * const summary = await explainRunbook({
 *   reader: new Core.M3LInputFileReader({ paths, code: "ERR_DLQ_TRIAGE_PRESET" }),
 *   logger: new Core.M3LLogger([]),
 *   runbookDir: "runbooks",
 *   queue: "orders-dlq",
 * });
 * console.log(summary.name);
 * ```
 */
export async function explainRunbook(
  deps: ExplainRunbookDeps,
): Promise<Core.M3LProcedureSummary> {
  const preset = await loadRunbook(
    deps.reader,
    presetPathFor(deps.runbookDir, deps.queue),
  );
  const procedure = buildTriageProcedure(preset);
  const summary = procedure.describe();

  deps.logger.section(`${summary.name} — ${preset.title}`);
  // Rendered as text, not as a `logger.info` data bag: the default console
  // handler prints the message only, and the digest is the whole point of
  // `explain` — it is what makes two runs comparable.
  deps.logger.text(`digest: ${procedure.digest}`);
  deps.logger.text(
    `${String(summary.steps.length)} step(s), ${String(summary.cases.length)} case(s) + fallback`,
  );

  deps.logger.section("Steps, in execution order");
  for (const step of summary.steps) {
    deps.logger.text(
      `- ${step.id} (${step.kind})${step.jumpsTo.length > 0 ? ` -> ${step.jumpsTo.join(", ")}` : ""}${step.loop !== undefined ? ` [loop x${String(step.loop.maxRevisits)}]` : ""}`,
    );
  }

  deps.logger.section("Cases, in priority order");
  for (const entry of [...summary.cases].sort(
    (a, b) => b.priority - a.priority,
  )) {
    deps.logger.text(
      `- ${String(entry.priority)} ${entry.id}: ${entry.description}`,
    );
  }
  deps.logger.text(`- fallback: ${summary.fallback.description}`);
  return summary;
}
