#!/usr/bin/env node
/**
 * Dev-only preview harness for the statusLine renderer
 * (`.claude/hooks/statusline-context-pressure.mjs`). Not wired as a
 * statusLine command itself — it renders a fixed set of representative
 * fixtures at several terminal widths so a layout change can be eyeballed
 * without waiting on a live session to reach each payload shape. This file
 * may use whatever Node built-ins it needs (including `node:child_process`
 * for the malformed-JSON probe below); it is not bound by the "no
 * subprocess" invariant that governs the statusLine script itself — that
 * invariant exists to keep the per-render hot path fast, and this harness
 * is never on that hot path.
 *
 * Registered as `pnpm statusline:preview`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderStatusLine } from "../.claude/hooks/statusline-context-pressure.mjs";

const COLUMN_WIDTHS = [60, 80, 120, 160];

const FULL_NOW_MS = Date.UTC(2026, 8, 2, 12, 0, 0);
const FULL_NOW_SEC = FULL_NOW_MS / 1000;

const fullPayload = {
  session_name: "feat-statusline-redesign",
  model: { display_name: "Sonnet 5" },
  effort: { level: "high" },
  thinking: { enabled: true },
  context_window: {
    used_percentage: 72,
    total_input_tokens: 144_000,
    context_window_size: 200_000,
    remaining_percentage: 28,
  },
  cost: {
    total_cost_usd: 4.24,
    total_duration_ms: 5_400_000,
    total_api_duration_ms: 900_000,
    total_lines_added: 412,
    total_lines_removed: 55,
  },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: FULL_NOW_SEC + 2 * 3600 },
    seven_day: { used_percentage: 61, resets_at: FULL_NOW_SEC + 3 * 24 * 3600 },
  },
  prompt_cache: { warm: true, hit_ratio: 0.86 },
  workspace: {
    git_worktree: "statusline-redesign",
    repo: { owner: "monte3l", name: "m3l-automation" },
  },
};

const fullEnv = {
  now: FULL_NOW_MS,
  freemem: 13_600_000_000,
  totalmem: 16_000_000_000,
  branch: "feat/statusline-redesign",
};

const noRateLimitsPayload = { ...fullPayload };
delete noRateLimitsPayload.rate_limits;

const sliceDerivedEnv = {
  ...fullEnv,
  slice: { current: 2, total: 4, label: "V6" },
};
const sliceLiteralEnv = {
  ...fullEnv,
  slice: { current: 2, total: 4, label: "V9" },
};
const sliceAllLandedEnv = {
  ...fullEnv,
  slice: { current: 4, total: 4, label: "V6" },
};
const noSliceEnv = { ...fullEnv, slice: null };

const noGitPayload = {
  ...fullPayload,
  workspace: { ...fullPayload.workspace },
};
delete noGitPayload.workspace.git_worktree;
const noGitEnv = { ...fullEnv, branch: null };

const FIXTURES = [
  { name: "full", payload: fullPayload, env: fullEnv },
  {
    name: "early-session-nulls",
    payload: {
      model: { display_name: "Sonnet 5" },
      context_window: { used_percentage: 4 },
    },
    env: {
      now: Date.now(),
      freemem: 13_000_000_000,
      totalmem: 16_000_000_000,
      branch: "main",
    },
  },
  {
    name: "high-pressure-90pct",
    payload: {
      context_window: {
        used_percentage: 93,
        total_input_tokens: 186_000,
        context_window_size: 200_000,
        remaining_percentage: 7,
      },
      rate_limits: {
        five_hour: { used_percentage: 96, resets_at: FULL_NOW_SEC + 15 * 60 },
        seven_day: {
          used_percentage: 98,
          resets_at: FULL_NOW_SEC + 2 * 24 * 3600,
        },
        spend_limit: {
          used_percentage: 127,
          resets_at: FULL_NOW_SEC + 10 * 24 * 3600,
        },
      },
      model: { display_name: "Opus 5" },
    },
    env: {
      now: FULL_NOW_MS,
      freemem: 800_000_000,
      totalmem: 16_000_000_000,
      branch: "feat/urgent-fix",
    },
  },
  { name: "no-rate-limits", payload: noRateLimitsPayload, env: fullEnv },
  { name: "slice-derived", payload: fullPayload, env: sliceDerivedEnv },
  { name: "slice-literal", payload: fullPayload, env: sliceLiteralEnv },
  { name: "slice-all-landed", payload: fullPayload, env: sliceAllLandedEnv },
  { name: "no-slice", payload: fullPayload, env: noSliceEnv },
  { name: "no-git", payload: noGitPayload, env: noGitEnv },
];

for (const fixture of FIXTURES) {
  for (const width of COLUMN_WIDTHS) {
    const env = { ...fixture.env, COLUMNS: String(width) };
    const rendered = renderStatusLine(fixture.payload, env);
    console.log(`=== ${fixture.name} @ COLUMNS=${width} ===`);
    console.log("-".repeat(width));
    console.log(rendered);
    console.log("");
  }
}

const scriptPath = fileURLToPath(
  new URL("../.claude/hooks/statusline-context-pressure.mjs", import.meta.url),
);
const probe = spawnSync(process.execPath, [scriptPath], {
  input: "not valid json",
  encoding: "utf8",
});
console.log("=== malformed JSON (live script) ===");
console.log(`exit code: ${probe.status}`);
console.log(`stdout: ${probe.stdout}`);
console.log(`stderr: ${probe.stderr}`);

// Corrupt tmp/slice-progress.json (harness-artifacts.md: prove a hook quiet
// on the failure case, not just correct on the case it was built from) —
// the five-row output must still render, with the slice segment simply
// absent, exactly like a missing file.
const scratchDir = mkdtempSync(join(tmpdir(), "slice-progress-probe-"));
mkdirSync(join(scratchDir, "tmp"), { recursive: true });
writeFileSync(join(scratchDir, "tmp/slice-progress.json"), "not valid json");
const corruptProbe = spawnSync(process.execPath, [scriptPath], {
  input: JSON.stringify({ workspace: { current_dir: scratchDir } }),
  encoding: "utf8",
});
rmSync(scratchDir, { recursive: true, force: true });
console.log("=== corrupt tmp/slice-progress.json (live script) ===");
console.log(`exit code: ${corruptProbe.status}`);
console.log(`stdout: ${corruptProbe.stdout}`);
console.log(`stderr: ${corruptProbe.stderr}`);
