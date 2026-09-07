/**
 * Tests for `steps/flow-prompt` — the system and user prompts for the
 * `queue-reconcile` workload's `reconcile_queue` tool conversation.
 *
 * The direct analogue of `steps/triage-prompt.ts`'s `triage_logs` prompts,
 * adapted to `reconcile_queue`'s shape: it is a MUTATING, single-tool
 * operation (not read-only), so the system prompt states the "at most one
 * flow" constraint rather than a read-only guarantee. As with the triage
 * prompt, there is no discovery tool the model can call to list valid flow
 * names, so the user prompt is the model's only channel to the allowed
 * names — and those names are operator-verified config (every entry already
 * passed `verifyFlowNames`), never raw model input.
 */

import { describe, expect, it } from "vitest";

import {
  queueReconcileSystemPrompt,
  queueReconcileUserPrompt,
} from "../../src/steps/flow-prompt.js";

describe("queueReconcileSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const system = queueReconcileSystemPrompt();
    expect(typeof system).toBe("string");
    expect(system.length).toBeGreaterThan(0);
  });

  it("is deterministic across calls", () => {
    expect(queueReconcileSystemPrompt()).toBe(queueReconcileSystemPrompt());
  });

  it("names the reconcile_queue tool", () => {
    const system = queueReconcileSystemPrompt();
    expect(system).toContain("reconcile_queue");
  });

  it("states that at most one flow may be run", () => {
    const system = queueReconcileSystemPrompt().toLowerCase();
    expect(system).toMatch(/at most one/);
  });

  it("instructs the model to decline in plain text when no action is needed", () => {
    const system = queueReconcileSystemPrompt().toLowerCase();
    expect(system).toMatch(/plain text/);
    expect(system).toMatch(/no action is needed|not warranted/);
  });

  it("does not leak an absolute filesystem path", () => {
    const system = queueReconcileSystemPrompt();
    expect(system).not.toMatch(/^\/|[A-Za-z]:\\/m);
  });

  it("does not contain a credential-shaped value", () => {
    const system = queueReconcileSystemPrompt();
    expect(system).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(system).not.toMatch(/password|secret|token/i);
  });
});

describe("queueReconcileUserPrompt", () => {
  const flowNames = ["nightly-queue-drain", "dead-letter-reprocess"] as const;

  it("includes every supplied flow name", () => {
    const prompt = queueReconcileUserPrompt(flowNames);
    for (const name of flowNames) {
      expect(prompt).toContain(name);
    }
  });

  it("includes a single supplied flow name", () => {
    const prompt = queueReconcileUserPrompt(["nightly-queue-drain"]);
    expect(prompt).toContain("nightly-queue-drain");
  });

  it("does not leak an absolute filesystem path", () => {
    const prompt = queueReconcileUserPrompt(flowNames);
    expect(prompt).not.toMatch(/^\/|[A-Za-z]:\\/m);
  });

  it("does not contain a credential-shaped value", () => {
    const prompt = queueReconcileUserPrompt(flowNames);
    expect(prompt).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(prompt).not.toMatch(/password|secret|token/i);
  });

  it("presents the allowed names as a closed set", () => {
    const prompt = queueReconcileUserPrompt(flowNames).toLowerCase();
    expect(prompt).toMatch(
      /\bonly\b|\bexactly\b|\bone of\b|\ballowed\b|\ballowlist/,
    );
  });

  it("does not coach the model to invent, guess, or construct a flow name", () => {
    const prompt = queueReconcileUserPrompt(flowNames).toLowerCase();
    expect(prompt).not.toMatch(/\bguess\b/);
    expect(prompt).not.toMatch(/\binvent\b/);
    expect(prompt).not.toMatch(/\bmake up\b/);
    expect(prompt).not.toMatch(/\btry (a |any )?(different |another )?name\b/);
  });

  it("is deterministic for the same input", () => {
    const first = queueReconcileUserPrompt(flowNames);
    const second = queueReconcileUserPrompt(flowNames);
    expect(first).toBe(second);
  });

  // [DEFENSIVE, NOT REACHABLE IN PRODUCTION] `verifyFlowNames` refuses an
  // empty allowlist upstream (`deps.flowAllowlist.size === 0` is its first
  // check, `lib/flow-definitions.ts`), so this function can never be called
  // with an empty `flowNames` array in production — mirroring
  // `triageLogsUserPrompt`'s equivalent case (`triage-prompt.test.ts`), whose
  // upstream refusal is `verifyTriagePresets`. This test documents the
  // behaviour the function has anyway: an explicit statement of emptiness,
  // never a bare empty-looking list that collapses into a dangling colon.
  it("[defensive, unreachable] states plainly that no flows are declared for an empty flowNames array", () => {
    const prompt = queueReconcileUserPrompt([]).toLowerCase();
    expect(prompt).toMatch(
      /no flows? (are |is |have been )?declared|none declared|no allowed flows/,
    );
    expect(prompt).not.toMatch(/:\s*\.?\s*$/m);
  });
});
