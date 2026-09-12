/**
 * Tests for `steps/create-invoker` — the one place a Bedrock client is
 * constructed, and therefore the network seam.
 *
 * Every other test in this package mocks this module wholesale, which is what
 * keeps them offline — and is exactly why it needs its own direct tests: the
 * `deps.aws === undefined` guard is the assertion `src/command.ts` deliberately
 * does **not** make (a guard there would force `explain-policy`, which never
 * touches AWS, to require a provisioned provider), so this is the only place
 * that failure is caught.
 *
 * Still offline. `M3LBedrockRuntimeOperations` stores the client it is handed
 * and touches nothing until the first `invoke` — the property ordering
 * constraint 1 in `steps/run-health-check` depends on — so a bare object stands
 * in for a real `BedrockRuntimeClient` and no test here ever calls `invoke`.
 */

import { describe, expect, it } from "vitest";

import { AWS } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { createInvoker } from "../../src/steps/create-invoker.js";
import { FAKE_MODEL_ID, fakeAwsProvider } from "../support/healthFakes.js";

describe("createInvoker", () => {
  it("builds an M3LBedrockRuntimeOperations from the provisioned client", () => {
    const invoker = createInvoker({
      aws: fakeAwsProvider(),
      models: [FAKE_MODEL_ID],
    });

    expect(invoker).toBeInstanceOf(AWS.M3LBedrockRuntimeOperations);
    // The structural port `runBedrockToolLoop` actually drives.
    expect(typeof invoker.invoke).toBe("function");
  });

  it("accepts a primary model plus fallbacks, in the caller's order", () => {
    // The tuple type is what forces the call site to prove `modelId` is
    // present rather than discover an empty list on the first run.
    expect(() =>
      createInvoker({
        aws: fakeAwsProvider(),
        models: [FAKE_MODEL_ID, "anthropic.claude-haiku-4-5", "us.fallback"],
      }),
    ).not.toThrow();
  });

  it("makes no network call at construction, which is what makes ordering constraint 1 safe", () => {
    // `steps/run-health-check` constructs the metered invoker BEFORE the
    // decision-log preflight, so that zero spend is an observed fact by the
    // time budgets are evaluated. That is only defensible because
    // construction costs nothing — a run the preflight then refuses must not
    // have reached the network. The stand-in client below has no methods at
    // all: touching it would throw.
    const invoker = createInvoker({
      aws: fakeAwsProvider(),
      models: [FAKE_MODEL_ID],
    });

    expect(invoker).toBeDefined();
  });

  it("rejects an absent AWS provider with ERR_AGENT_OPERATOR_CONFIG", () => {
    // `src/command.ts` passes `script.aws` straight through without asserting
    // it, on purpose: `explain-policy` never reads it, and a guard at that
    // seam would make a deterministic, offline operation require AWS. This
    // throw is the one that catches it, at the one place it matters.
    let thrown: unknown;
    try {
      createInvoker({ aws: undefined, models: [FAKE_MODEL_ID] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
    // A caller fault (exit 2), not an external one: `aws.profile` is
    // undeclared or the run bypassed the `M3LScript` lifecycle.
    expect((thrown as M3LAgentOperatorCliError).origin).toBe("caller");
  });

  it("names the remedy without echoing configuration", () => {
    let thrown: unknown;
    try {
      createInvoker({ aws: undefined, models: [FAKE_MODEL_ID] });
    } catch (error) {
      thrown = error;
    }

    const message = (thrown as M3LAgentOperatorCliError).message;
    expect(message).toMatch(/aws\.profile/);
    // The model id is configuration, not a diagnostic — it has no place in a
    // surfaced error message.
    expect(message).not.toContain(FAKE_MODEL_ID);
  });
});
