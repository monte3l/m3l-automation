/**
 * Tests for `steps/triage-prompt` — the system and user prompts for the
 * `triage_logs` workload.
 *
 * Written RED, before `src/steps/triage-prompt.ts` exists. This is the
 * direct analogue of `steps/etl-prompt.ts`'s `run_preset` prompts, adapted
 * to the triage workload's shape: `triage_logs` is a single-phase,
 * READ-ONLY tool (unlike `run_preset`'s two-phase dry-run-then-mutate
 * contract), so the system prompt states the read-only guarantee rather
 * than an ordering guarantee. As with `run_preset`, there is no discovery
 * tool the model can call to list valid preset names, so the user prompt
 * is the model's only channel to the allowed preset names — and those
 * names are operator-declared config (`presetAllowlist`), never model
 * input.
 *
 * The seam this module protects: the model is handed a preset KEY, never
 * a filesystem path. The operator's own config resolves the key to a path
 * under `data/config/presets/`. Neither prompt may leak that path or the
 * directory it lives under — doing so would blur a boundary the whole
 * slice is built to keep sharp (see `slice4-contract.md` §3).
 */

import { describe, expect, it } from "vitest";

import {
  triageLogsSystemPrompt,
  triageLogsUserPrompt,
} from "../../src/steps/triage-prompt.js";

describe("triageLogsSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const system = triageLogsSystemPrompt();
    expect(typeof system).toBe("string");
    expect(system.length).toBeGreaterThan(0);
  });

  it("is deterministic across calls", () => {
    expect(triageLogsSystemPrompt()).toBe(triageLogsSystemPrompt());
  });

  it("names the triage_logs tool", () => {
    const system = triageLogsSystemPrompt();
    expect(system).toContain("triage_logs");
  });

  it("states that the tool is read-only", () => {
    const system = triageLogsSystemPrompt().toLowerCase();
    expect(system).toMatch(/read-only|read only|cannot mutate|no.*mutat/);
  });

  it("does not leak an absolute filesystem path or the presets directory", () => {
    const system = triageLogsSystemPrompt();
    // The model must never see a path — only the operator's config
    // resolves a preset KEY to a path under data/config/presets/.
    expect(system).not.toMatch(/^\/|[A-Za-z]:\\/m);
    expect(system).not.toContain("data/config/presets");
  });

  it("does not contain a credential-shaped value", () => {
    const system = triageLogsSystemPrompt();
    expect(system).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(system).not.toMatch(/password|secret|token/i);
  });
});

describe("triageLogsUserPrompt", () => {
  const scriptName = "cloudwatch-logs-analysis";
  const presetNames = [
    "triage-checkout-5xx",
    "triage-payments-timeout",
  ] as const;

  it("includes the script name", () => {
    const prompt = triageLogsUserPrompt({ scriptName, presetNames });
    expect(prompt).toContain(scriptName);
  });

  it("includes every supplied preset name", () => {
    const prompt = triageLogsUserPrompt({ scriptName, presetNames });
    for (const name of presetNames) {
      expect(prompt).toContain(name);
    }
  });

  it("does not leak an absolute filesystem path or the presets directory", () => {
    const prompt = triageLogsUserPrompt({ scriptName, presetNames });
    // The model is handed a preset KEY ("triage-checkout-5xx"), never a
    // path; the operator's config does the key-to-path resolution. A leak
    // here would erase the seam the contract calls out explicitly.
    expect(prompt).not.toMatch(/^\/|[A-Za-z]:\\/m);
    expect(prompt).not.toContain("data/config/presets");
  });

  it("does not contain a credential-shaped value", () => {
    const prompt = triageLogsUserPrompt({ scriptName, presetNames });
    expect(prompt).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(prompt).not.toMatch(/password|secret|token/i);
  });

  it("presents the allowed names as a closed set", () => {
    const prompt = triageLogsUserPrompt({ scriptName, presetNames });
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(
      /\bonly\b|\bexactly\b|\bone of\b|\ballowed\b|\ballowlist/,
    );
  });

  it("does not coach the model to invent, guess, or construct a preset name", () => {
    const prompt = triageLogsUserPrompt({ scriptName, presetNames });
    const lower = prompt.toLowerCase();
    expect(lower).not.toMatch(/\bguess\b/);
    expect(lower).not.toMatch(/\binvent\b/);
    expect(lower).not.toMatch(/\bmake up\b/);
    expect(lower).not.toMatch(/\btry (a |any )?(different |another )?name\b/);
  });

  // [DEFENSIVE, NOT REACHABLE IN PRODUCTION] `verifyTriagePresets` now
  // refuses an empty allowlist upstream (slice4-contract.md §3, "Empty
  // allowlist" refusal in `lib/triage-presets.ts`), so `run-log-triage.ts`
  // can never call this function with an empty `presetNames` array. This
  // test documents the behaviour the function should have anyway, mirroring
  // `run_preset`'s sibling prompt (`etl-prompt.ts`'s `runPresetUserPrompt`):
  // an explicit statement of emptiness, never a bare empty-looking list that
  // could be misread as "choose anything".
  it("[defensive, unreachable] states plainly that no presets are declared for an empty presetNames array", () => {
    const prompt = triageLogsUserPrompt({ scriptName, presetNames: [] });
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(
      /no presets? (are |is |have been )?declared|none declared|no allowed presets/,
    );
    expect(lower).not.toMatch(/\bchoose any\b/);
    expect(lower).not.toMatch(/\bany preset\b/);
    expect(prompt).not.toMatch(/:\s*\.?\s*$/m);
  });

  it("is deterministic for the same input", () => {
    const first = triageLogsUserPrompt({ scriptName, presetNames });
    const second = triageLogsUserPrompt({ scriptName, presetNames });
    expect(first).toBe(second);
  });
});
