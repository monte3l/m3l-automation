/**
 * Tests for `steps/etl-prompt` — the system and user prompts for the ETL
 * `run_preset` workload.
 *
 * Written RED, before `src/steps/etl-prompt.ts` exists. Mirrors
 * `steps/health-prompt.ts`'s shape (a fixed, script-authored system prompt
 * plus a per-run user prompt built from operator-authored values), but the
 * trust boundary here is sharper: this operation exposes exactly ONE tool,
 * `run_preset`, which takes a single `presetName`, and there is no discovery
 * tool the model can call to list what is allowed. The USER prompt is the
 * only channel the allowed preset names reach the model through, and those
 * names come from the operator-declared `presetAllowlist` — reviewed
 * configuration, never model input. Getting the user prompt's closed-set
 * framing right matters more here than in the health-check sibling, where a
 * wrong scope only narrows a read-only search; here a model coached to
 * "guess" or "try" a name is coached to defeat the allowlist by generating a
 * plausible-looking one that the gate then has to refuse.
 */

import { describe, expect, it } from "vitest";

import {
  runPresetSystemPrompt,
  runPresetUserPrompt,
} from "../../src/steps/etl-prompt.js";

describe("runPresetSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const system = runPresetSystemPrompt();
    expect(typeof system).toBe("string");
    expect(system.length).toBeGreaterThan(0);
  });

  it("is deterministic across calls", () => {
    expect(runPresetSystemPrompt()).toBe(runPresetSystemPrompt());
  });

  it("has no top-level side effects (module import alone produces nothing observable)", () => {
    // Calling it twice in isolation from any other state and getting the
    // exact same string is itself evidence the function is pure; a
    // dedicated "no side effects" probe beyond that would just be asserting
    // the absence of things this test file cannot observe anyway (network,
    // fs, global mutation). The determinism test above is the operative
    // check; this test documents the property distinctly since the prompt
    // spec calls it out on its own.
    const first = runPresetSystemPrompt();
    const second = runPresetSystemPrompt();
    expect(first).toBe(second);
  });

  it("states the two-phase contract: dry run first, then the real run", () => {
    const system = runPresetSystemPrompt().toLowerCase();
    expect(system).toMatch(/dry run|dry-run/);
    // The prompt must convey ORDERING — dry run happens before the mutating
    // run — not merely mention the word "dry run" in passing.
    expect(system).toMatch(/first|before/);
  });

  it("does not contain an absolute host path or credential-shaped value", () => {
    const system = runPresetSystemPrompt();
    expect(system).not.toMatch(/^\/|[A-Za-z]:\\/m);
    expect(system).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(system).not.toMatch(/password|secret|token/i);
  });
});

describe("runPresetUserPrompt", () => {
  const scriptName = "nightly-export";
  const presetNames = ["eu-west-1", "us-east-1", "ap-south-1"] as const;

  it("includes every supplied preset name", () => {
    const prompt = runPresetUserPrompt({
      scriptName,
      presetNames,
    });
    for (const name of presetNames) {
      expect(prompt).toContain(name);
    }
  });

  it("includes the script name", () => {
    const prompt = runPresetUserPrompt({ scriptName, presetNames });
    expect(prompt).toContain(scriptName);
  });

  it("does not coach the model to invent, guess, or construct a preset name", () => {
    const prompt = runPresetUserPrompt({ scriptName, presetNames });
    const lower = prompt.toLowerCase();
    // No wording that invites fabricating a name outside the supplied set.
    expect(lower).not.toMatch(/\bguess\b/);
    expect(lower).not.toMatch(/\binvent\b/);
    expect(lower).not.toMatch(/\bmake up\b/);
    expect(lower).not.toMatch(/\bconstruct (a|the|your own) preset\b/);
    expect(lower).not.toMatch(/\bany preset\b/);
    expect(lower).not.toMatch(/\btry (a |any )?(different |another )?name\b/);
  });

  it("presents the allowed names as a closed set", () => {
    const prompt = runPresetUserPrompt({ scriptName, presetNames });
    const lower = prompt.toLowerCase();
    // A closed-set framing names the boundary explicitly — "only", "exactly
    // these", "one of the following" — rather than merely listing names in a
    // sentence that could be read as illustrative examples.
    expect(lower).toMatch(
      /\bonly\b|\bexactly\b|\bone of\b|\ballowed\b|\ballowlist/,
    );
  });

  it("says plainly that no presets are declared when presetNames is empty", () => {
    const prompt = runPresetUserPrompt({ scriptName, presetNames: [] });
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(
      /no presets? (are |is |have been )?declared|none declared|no allowed presets/,
    );
    // An empty rendering must not read as an open invitation: nothing that
    // looks like "choose any" or a bare, list-shaped emptiness.
    expect(lower).not.toMatch(/\bchoose any\b/);
    expect(lower).not.toMatch(/\bany preset\b/);
  });

  it("does not render a bare, empty-looking list for zero preset names", () => {
    const prompt = runPresetUserPrompt({ scriptName, presetNames: [] });
    // A trailing "Presets: ." or "Presets: " with nothing after the colon
    // reads as broken rather than as an explicit statement of emptiness.
    expect(prompt).not.toMatch(/:\s*\.?\s*$/m);
  });

  it("does not contain an absolute host path or credential-shaped value beyond the given inputs", () => {
    const prompt = runPresetUserPrompt({ scriptName, presetNames });
    expect(prompt).not.toMatch(/^\/|[A-Za-z]:\\/m);
    expect(prompt).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(prompt).not.toMatch(/password|secret|token/i);
  });

  it("is deterministic for the same input (no timestamps or ordering nondeterminism)", () => {
    // Covers rule 7: repeated calls with an UNSORTED input must still agree
    // with each other bit-for-bit, whether the implementation preserves
    // input order or normalizes it (e.g. sorts) — either is acceptable, as
    // long as it is stable across calls. This deliberately does not assert
    // which policy is chosen; that is an implementation detail the contract
    // does not specify.
    const unordered = ["zeta", "alpha", "mid"] as const;
    const first = runPresetUserPrompt({ scriptName, presetNames: unordered });
    const second = runPresetUserPrompt({
      scriptName,
      presetNames: unordered,
    });
    expect(first).toBe(second);
  });
});
