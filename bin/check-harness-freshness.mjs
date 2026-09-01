#!/usr/bin/env node
// Warns (non-blocking) when docs/research/harness-refresh.md's recorded
// last-verified date is stale — the self-polling half of the harness-refresh
// cadence (ADR-0082): a stamp a gate actually reads, unlike the periodic
// re-check reminder ADR-0030's 2026-08-14 amendment retired because nothing
// in the repo polled it.
//
// Reads ONLY the tracker's header comment
// (<!-- harness-refresh: last-verified=<date|unset> claude-code-version=<version|unset> -->).
// Makes no network call — cheap enough for pre-push. `last-verified=unset`
// (the never-swept state) is treated the same as "older than the threshold":
// it warns immediately rather than reading a scaffolded-but-empty tracker as
// fresh.
//
// Structured like its sibling bin/check-retrospective.mjs: pure helpers plus a
// dependency-injected runner, with every side effect behind the main guard at
// the bottom. That shape is what makes bin/tests/check-harness-freshness.test.ts
// possible — importing this module used to run the whole gate against the real
// tracker, which is also the top-level-side-effects violation CLAUDE.md's
// Forbidden Patterns lists as needing conscious care.
//
// Usage:
//   node bin/check-harness-freshness.mjs   # always exits 0 (advisory only)
import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one file this gate reads, repo-root-relative. */
export const TRACKER_PATH = "docs/research/harness-refresh.md";

/** Days after which a recorded sweep is considered stale. */
export const STALENESS_THRESHOLD_DAYS = 90;

/** The tracker's machine-readable header comment. */
export const HEADER_PATTERN =
  /<!--\s*harness-refresh:\s*last-verified=(\S+)\s+claude-code-version=(\S+)\s*-->/;

/**
 * @typedef {{ lastVerified: string, claudeCodeVersion: string }} HarnessHeader
 * @typedef {{
 *   lastVerified: string | null,
 *   staleDays: number | null,
 *   claudeCodeVersion?: string,
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
 * @returns {HarnessHeader | null} null when no parseable header is present
 */
export function parseHarnessHeader(contents) {
  const match = HEADER_PATTERN.exec(contents);
  if (!match) return null;
  return {
    lastVerified: /** @type {string} */ (match[1]),
    claudeCodeVersion: /** @type {string} */ (match[2]),
  };
}

/**
 * Turn a parsed header plus an injected clock into findings.
 *
 * `unset` is the never-swept state and is treated as stale rather than as
 * fresh — the same choice check-retrospective makes, and for the same reason:
 * a scaffolded-but-empty tracker read as "fresh" is how a gate goes quiet
 * forever.
 *
 * @param {HarnessHeader | null} header
 * @param {Date} now injected clock, so staleness is assertable
 * @returns {FreshnessResult} `summary` is non-null only when findings is empty
 */
export function evaluateFreshness(header, now) {
  if (header === null) {
    return {
      findings: [
        `${TRACKER_PATH} has no parseable "harness-refresh: ` +
          `last-verified=... claude-code-version=..." header comment.`,
      ],
      summary: null,
      payload: { lastVerified: null, staleDays: null },
    };
  }

  const { lastVerified, claudeCodeVersion } = header;

  if (lastVerified === "unset") {
    return {
      findings: [
        `${TRACKER_PATH} has never been swept (last-verified=unset) — run ` +
          `/refreshing-anthropic-guidance.`,
      ],
      summary: null,
      payload: { lastVerified: null, staleDays: null, claudeCodeVersion },
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
      payload: { lastVerified: null, staleDays: null, claudeCodeVersion },
    };
  }

  const staleDays = Math.floor(
    (now.getTime() - lastVerifiedDate.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (staleDays > STALENESS_THRESHOLD_DAYS) {
    return {
      findings: [
        `${TRACKER_PATH} was last verified ${staleDays} day(s) ago ` +
          `(${lastVerified}, Claude Code ${claudeCodeVersion}) — over the ` +
          `${STALENESS_THRESHOLD_DAYS}-day threshold. Run ` +
          `/refreshing-anthropic-guidance.`,
      ],
      summary: null,
      payload: { lastVerified, staleDays, claudeCodeVersion },
    };
  }

  return {
    findings: [],
    summary:
      `Harness refresh tracker is fresh: verified ${staleDays} day(s) ago ` +
      `(${lastVerified}, Claude Code ${claudeCodeVersion}), within the ` +
      `${STALENESS_THRESHOLD_DAYS}-day threshold.`,
    payload: { lastVerified, staleDays, claudeCodeVersion },
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
export function runHarnessFreshnessCheck({ readTracker, now, reporter }) {
  /** @type {FreshnessResult} */
  let result;

  try {
    result = evaluateFreshness(parseHarnessHeader(readTracker()), now);
  } catch (cause) {
    result = {
      findings: [
        `${TRACKER_PATH} not found — run /refreshing-anthropic-guidance to ` +
          `create it. (${
            cause instanceof Error ? cause.message : String(cause)
          })`,
      ],
      summary: null,
      payload: { lastVerified: null, staleDays: null },
    };
  }

  const { findings, summary, payload } = result;

  for (const finding of findings) {
    reporter.warn(finding, { file: TRACKER_PATH });
  }
  if (summary !== null) reporter.succeed(summary);

  reporter.finish(payload);
  return { ok: findings.length === 0, findings, ...payload };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();

  runHarnessFreshnessCheck({
    readTracker: () => readFileSync(join(root, TRACKER_PATH), "utf8"),
    now: new Date(),
    reporter: createReporter(json),
  });

  // Advisory only — never blocks a push. See runHarnessFreshnessCheck's note.
  process.exit(0);
}
