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
// Usage:
//   node bin/check-harness-freshness.mjs   # always exits 0 (advisory only)
import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRACKER_PATH = "docs/research/harness-refresh.md";
const STALENESS_THRESHOLD_DAYS = 90;
const HEADER_PATTERN =
  /<!--\s*harness-refresh:\s*last-verified=(\S+)\s+claude-code-version=(\S+)\s*-->/;

const { json } = parseJsonFlag();
const reporter = createReporter(json);

let contents;
try {
  contents = readFileSync(join(root, TRACKER_PATH), "utf8");
} catch (error) {
  reporter.warn(
    `${TRACKER_PATH} not found — run /refreshing-anthropic-guidance to create it. (${error.message})`,
    { file: TRACKER_PATH },
  );
  reporter.finish({ lastVerified: null, staleDays: null });
  process.exit(0);
}

const match = HEADER_PATTERN.exec(contents);
if (!match) {
  reporter.warn(
    `${TRACKER_PATH} has no parseable "harness-refresh: last-verified=... claude-code-version=..." header comment.`,
    { file: TRACKER_PATH },
  );
  reporter.finish({ lastVerified: null, staleDays: null });
  process.exit(0);
}

const [, lastVerified, claudeCodeVersion] = match;

if (lastVerified === "unset") {
  reporter.warn(
    `${TRACKER_PATH} has never been swept (last-verified=unset) — run /refreshing-anthropic-guidance.`,
    { file: TRACKER_PATH },
  );
  reporter.finish({ lastVerified: null, staleDays: null, claudeCodeVersion });
  process.exit(0);
}

const lastVerifiedDate = new Date(`${lastVerified}T00:00:00Z`);
if (Number.isNaN(lastVerifiedDate.getTime())) {
  reporter.warn(
    `${TRACKER_PATH}'s last-verified value "${lastVerified}" is not a parseable YYYY-MM-DD date.`,
    { file: TRACKER_PATH },
  );
  reporter.finish({ lastVerified: null, staleDays: null, claudeCodeVersion });
  process.exit(0);
}

const staleDays = Math.floor(
  (Date.now() - lastVerifiedDate.getTime()) / (1000 * 60 * 60 * 24),
);

if (staleDays > STALENESS_THRESHOLD_DAYS) {
  reporter.warn(
    `${TRACKER_PATH} was last verified ${staleDays} day(s) ago (${lastVerified}, Claude Code ${claudeCodeVersion}) — over the ${STALENESS_THRESHOLD_DAYS}-day threshold. Run /refreshing-anthropic-guidance.`,
    { file: TRACKER_PATH },
  );
  reporter.finish({ lastVerified, staleDays, claudeCodeVersion });
  process.exit(0);
}

reporter.succeed(
  `Harness refresh tracker is fresh: verified ${staleDays} day(s) ago (${lastVerified}, Claude Code ${claudeCodeVersion}), within the ${STALENESS_THRESHOLD_DAYS}-day threshold.`,
);
reporter.finish({ lastVerified, staleDays, claudeCodeVersion });
