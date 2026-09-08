#!/usr/bin/env node
// Warns (non-blocking) when docs/research/typescript/refresh.md's recorded
// last-verified date is stale — the self-polling half of the
// refreshing-typescript-guidance cadence (ADR-0082's pattern, instantiated
// for a second subject per docs/decision-notes/0006-typescript-source-tiering.md):
// a stamp a gate actually reads, mirroring bin/check-harness-freshness.mjs
// one-for-one.
//
// Reads ONLY the tracker's header comment
// (<!-- typescript-refresh: last-verified=<date|unset> typescript-version=<version|unset> -->).
// Makes no network call — cheap enough for pre-push. `last-verified=unset`
// (the never-swept state) is treated the same as "older than the threshold":
// it warns immediately rather than reading a scaffolded-but-empty tracker as
// fresh.
//
// `typescript-version` records the newest UPSTREAM TypeScript release the
// last sweep verified against — deliberately distinct from package.json's
// own `typescript` devDependency pin. Conflating the two is how the
// tracker's diff baseline goes wrong; see refreshing-typescript-guidance
// Step 1 for the same distinction made in the skill body.
//
// Threshold is 120 days, not check-harness-freshness.mjs's 90 — TypeScript
// ships roughly every 4-6 months versus Claude Code's near-daily cadence, so
// 90 days would routinely warn with no upstream delta to find, training the
// maintainer to ignore it (exactly what ADR-0082 exists to avoid). This is a
// judgment call, not derived from an external signal, same honesty ADR-0082
// itself uses for its own 90-day figure.
//
// Structured identically to check-harness-freshness.mjs: pure helpers plus a
// dependency-injected runner, with every side effect behind the main guard at
// the bottom, so importing this module never runs the gate against the real
// tracker.
//
// Usage:
//   node bin/check-typescript-freshness.mjs   # always exits 0 (advisory only)
import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one file this gate reads, repo-root-relative. */
export const TRACKER_PATH = "docs/research/typescript/refresh.md";

/** Days after which a recorded sweep is considered stale. */
export const STALENESS_THRESHOLD_DAYS = 120;

/** The tracker's machine-readable header comment. */
export const HEADER_PATTERN =
  /<!--\s*typescript-refresh:\s*last-verified=(\S+)\s+typescript-version=(\S+)\s*-->/;

/**
 * @typedef {{ lastVerified: string, typescriptVersion: string }} TypescriptHeader
 * @typedef {{
 *   lastVerified: string | null,
 *   staleDays: number | null,
 *   typescriptVersion?: string,
 * }} FreshnessPayload
 * @typedef {{
 *   findings: string[],
 *   summary: string | null,
 *   payload: FreshnessPayload,
 * }} FreshnessResult
 */

/**
 * Extract the tracker's header comment.
 *
 * @param {string} contents the tracker's text
 * @returns {TypescriptHeader | null} null when no parseable header is present
 */
export function parseTypescriptHeader(contents) {
  const match = HEADER_PATTERN.exec(contents);
  if (!match) return null;
  return {
    lastVerified: /** @type {string} */ (match[1]),
    typescriptVersion: /** @type {string} */ (match[2]),
  };
}

/**
 * Turn a parsed header plus an injected clock into findings.
 *
 * `unset` is the never-swept state and is treated as stale rather than as
 * fresh — the same choice check-harness-freshness.mjs makes, and for the
 * same reason: a scaffolded-but-empty tracker read as "fresh" is how a gate
 * goes quiet forever.
 *
 * @param {TypescriptHeader | null} header
 * @param {Date} now injected clock, so staleness is assertable
 * @returns {FreshnessResult} `summary` is non-null only when findings is empty
 */
export function evaluateFreshness(header, now) {
  if (header === null) {
    return {
      findings: [
        `${TRACKER_PATH} has no parseable "typescript-refresh: ` +
          `last-verified=... typescript-version=..." header comment.`,
      ],
      summary: null,
      payload: { lastVerified: null, staleDays: null },
    };
  }

  const { lastVerified, typescriptVersion } = header;

  if (lastVerified === "unset") {
    return {
      findings: [
        `${TRACKER_PATH} has never been swept (last-verified=unset) — run ` +
          `/refreshing-typescript-guidance.`,
      ],
      summary: null,
      payload: { lastVerified: null, staleDays: null, typescriptVersion },
    };
  }

  const lastVerifiedDate = new Date(`${lastVerified}T00:00:00Z`);
  if (Number.isNaN(lastVerifiedDate.getTime())) {
    return {
      findings: [
        `${TRACKER_PATH}'s last-verified value "${lastVerified}" is not a ` +
          `parseable YYYY-MM-DD date.`,
      ],
      summary: null,
      payload: { lastVerified: null, staleDays: null, typescriptVersion },
    };
  }

  const staleDays = Math.floor(
    (now.getTime() - lastVerifiedDate.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (staleDays > STALENESS_THRESHOLD_DAYS) {
    return {
      findings: [
        `${TRACKER_PATH} was last verified ${staleDays} day(s) ago ` +
          `(${lastVerified}, TypeScript ${typescriptVersion}) — over the ` +
          `${STALENESS_THRESHOLD_DAYS}-day threshold. Run ` +
          `/refreshing-typescript-guidance.`,
      ],
      summary: null,
      payload: { lastVerified, staleDays, typescriptVersion },
    };
  }

  return {
    findings: [],
    summary:
      `TypeScript refresh tracker is fresh: verified ${staleDays} day(s) ago ` +
      `(${lastVerified}, TypeScript ${typescriptVersion}), within the ` +
      `${STALENESS_THRESHOLD_DAYS}-day threshold.`,
    payload: { lastVerified, staleDays, typescriptVersion },
  };
}

/**
 * Run the gate against injected dependencies.
 *
 * Every outcome — including an unreadable tracker — is a WARNING, never an
 * error: this gate is advisory and the CLI below always exits 0. `ok` is
 * therefore about tracker health, not about whether the push may proceed.
 *
 * @param {{
 *   readTracker: () => string,
 *   now: Date,
 *   reporter: ReturnType<typeof createReporter>,
 * }} deps
 * @returns {{ ok: boolean, findings: string[] } & FreshnessPayload}
 */
export function runTypescriptFreshnessCheck({ readTracker, now, reporter }) {
  /**
   * Route one result through the reporter. Shared so the read-failure path
   * and the evaluated path cannot drift in how they report.
   *
   * @param {FreshnessResult} result
   * @returns {{ ok: boolean, findings: string[] } & FreshnessPayload}
   */
  const report = ({ findings, summary, payload }) => {
    for (const finding of findings) {
      reporter.warn(finding, { file: TRACKER_PATH });
    }
    if (summary !== null) reporter.succeed(summary);

    reporter.finish(payload);
    return { ok: findings.length === 0, findings, ...payload };
  };

  /** @type {string} */
  let contents;

  // ONLY readTracker() sits inside the try. Widening it to cover parsing and
  // evaluation would report a parse/evaluate throw under the hardcoded "not
  // found" message below — a real failure surfaced under a wrong cause, which
  // is close kin to swallowing it.
  try {
    contents = readTracker();
  } catch (cause) {
    return report({
      findings: [
        `${TRACKER_PATH} not found — run /refreshing-typescript-guidance to ` +
          `create it. (${
            cause instanceof Error ? cause.message : String(cause)
          })`,
      ],
      summary: null,
      payload: { lastVerified: null, staleDays: null },
    });
  }

  return report(evaluateFreshness(parseTypescriptHeader(contents), now));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();

  runTypescriptFreshnessCheck({
    readTracker: () => readFileSync(join(root, TRACKER_PATH), "utf8"),
    now: new Date(),
    reporter: createReporter(json),
  });

  // Advisory only — never blocks a push. See runTypescriptFreshnessCheck's note.
  process.exit(0);
}
