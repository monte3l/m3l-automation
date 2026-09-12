/**
 * `agent-operator/steps/metering-invoker` — an `AWS.M3LBedrockToolLoopInvoker`
 * decorator that observes every Bedrock turn's usage/cost onto an
 * {@link AgentRunLedger} (V8 final slice, contract § B, as amended).
 *
 * `AWS.computeCost` (`aws/bedrock-runtime/tool-ledger.ts:202`) is NOT
 * re-exported by any barrel, and ADR-0029 forbids reaching past the barrel to
 * import it directly — so {@link sumObservedCost} below is a deliberate local
 * re-implementation of that formula. The duplication is made safe by
 * {@link reconcileMeteredCost}: the loop's own `outcome.cost` is treated as
 * the oracle, and a divergence throws loudly instead of letting a future
 * change to the library's pricing formula silently understate a budget
 * figure.
 *
 * @packageDocumentation
 */

import type { AWS } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";
import type { AgentRunLedger } from "./run-ledger.js";

/** The denominator in a `perPer1kTokens` rate — a rate is always quoted per 1000 tokens. */
const TOKENS_PER_RATE_UNIT = 1000;

/**
 * Sums cost across every observed iteration using each iteration's OWN
 * `modelId` rate — never a blended rate across a run that changed models
 * mid-way.
 *
 * @remarks
 * Returns `undefined` — never a partial sum, never `NaN` — the moment any
 * served `modelId` lacks a rate, matching the library's all-or-nothing
 * contract. That omission is what correctly yields
 * `budget.cost-per-run.unobservable` (escalate) rather than passing on an
 * understated total. `sumObservedCost([], rates)` is `0` for ANY rates map
 * (empty or not): there is nothing unpriceable yet, which is what makes the
 * construction-time seeding in {@link createMeteredInvoker} report an
 * observed zero rather than "unobservable". That empty-list case is load
 * bearing, not an edge case — keep it.
 *
 * @param iterations - The turns observed so far, in index order.
 * @param rates - Per-model rates; an entry missing for a served `modelId`
 *   makes the whole sum unobservable.
 * @returns The summed cost, or `undefined` when unobservable.
 */
function sumObservedCost(
  iterations: readonly AWS.M3LBedrockToolLoopIteration[],
  rates: ReadonlyMap<string, AWS.M3LBedrockModelRate>,
): number | undefined {
  let total = 0;
  for (const iteration of iterations) {
    const rate = rates.get(iteration.modelId);
    if (rate === undefined) return undefined;
    total +=
      (iteration.usage.inputTokens / TOKENS_PER_RATE_UNIT) *
        rate.inputPer1kTokens +
      (iteration.usage.outputTokens / TOKENS_PER_RATE_UNIT) *
        rate.outputPer1kTokens;
  }
  return total;
}

/** Sums `usage.totalTokens` across every observed iteration. */
function sumObservedTokens(
  iterations: readonly AWS.M3LBedrockToolLoopIteration[],
): number {
  return iterations.reduce(
    (total, iteration) => total + iteration.usage.totalTokens,
    0,
  );
}

/**
 * Constructor options for {@link createMeteredInvoker}.
 *
 * @example
 * ```ts
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import type { CreateMeteredInvokerOptions } from "./metering-invoker.js";
 * import { AgentRunLedger } from "./run-ledger.js";
 *
 * declare const inner: AWS.M3LBedrockToolLoopInvoker;
 * declare const rates: ReadonlyMap<string, AWS.M3LBedrockModelRate>;
 *
 * const options: CreateMeteredInvokerOptions = {
 *   inner,
 *   ledger: new AgentRunLedger(),
 *   rates,
 * };
 * ```
 */
export interface CreateMeteredInvokerOptions {
  /** The real invoker every metered call delegates to, unchanged. */
  readonly inner: AWS.M3LBedrockToolLoopInvoker;
  /** The ledger every turn's totals are observed onto. */
  readonly ledger: AgentRunLedger;
  /** Per-model rates; an EMPTY map means cost is unobservable, not free. */
  readonly rates: ReadonlyMap<string, AWS.M3LBedrockModelRate>;
}

/**
 * The metered invoker handle returned by {@link createMeteredInvoker}.
 *
 * @example
 * ```ts
 * import type { MeteredInvoker } from "./metering-invoker.js";
 *
 * declare const metered: MeteredInvoker;
 * const iterations = metered.observedIterations();
 * ```
 */
export interface MeteredInvoker {
  /** Hand THIS to `runBedrockToolLoop`, never `inner`. */
  readonly invoker: AWS.M3LBedrockToolLoopInvoker;
  /** The synthesized iteration records observed so far, frozen. */
  observedIterations(): readonly AWS.M3LBedrockToolLoopIteration[];
}

/**
 * Wraps `options.inner` so every resolved `invoke()` call is recorded as a
 * synthesized {@link AWS.M3LBedrockToolLoopIteration} and the cumulative
 * totals are pushed onto `options.ledger` via `observeSpend` — the seam that
 * makes token/cost/loop-iteration budgets observable at all.
 *
 * @remarks
 * Seeds the ledger immediately, before any `invoke()` call, with
 * `{ tokensThisRun: 0, loopIterations: 0, costThisRun: sumObservedCost([], rates) }`
 * — this is what makes zero spend an OBSERVED fact rather than an
 * assumption. `sumObservedCost([], rates)` is `0` regardless of whether
 * `rates` is empty, so the seeded `costThisRun` is always `0`, never
 * unobservable; cost only goes unobservable once a served model without a
 * rate actually appears.
 *
 * A rejected `invoke()` records nothing: the only usage figure available on
 * a rejection is none, so there is nothing honest to record. This is a
 * known, documented under-count on the failure path — a failed invoke may
 * still have been billed by the provider.
 *
 * @param options - See {@link CreateMeteredInvokerOptions}.
 * @returns The {@link MeteredInvoker} handle.
 *
 * @example
 * ```ts
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { createMeteredInvoker } from "./metering-invoker.js";
 * import { AgentRunLedger } from "./run-ledger.js";
 *
 * declare const inner: AWS.M3LBedrockToolLoopInvoker;
 * declare const rates: ReadonlyMap<string, AWS.M3LBedrockModelRate>;
 *
 * const metered = createMeteredInvoker({
 *   inner,
 *   ledger: new AgentRunLedger(),
 *   rates,
 * });
 * // Hand metered.invoker to runBedrockToolLoop, never `inner` directly.
 * ```
 */
export function createMeteredInvoker(
  options: CreateMeteredInvokerOptions,
): MeteredInvoker {
  const { inner, ledger, rates } = options;
  const iterations: AWS.M3LBedrockToolLoopIteration[] = [];

  const observeTotals = (): void => {
    ledger.observeSpend({
      tokensThisRun: sumObservedTokens(iterations),
      loopIterations: iterations.length,
      costThisRun: sumObservedCost(iterations, rates),
    });
  };

  // Seed immediately, before any turn: zero spend must be an OBSERVED fact.
  observeTotals();

  const invoker: AWS.M3LBedrockToolLoopInvoker = {
    async invoke(request, invokeOptions) {
      // `toolExecutions: []` is correct and safe here — `sumObservedCost`
      // (and the library's own `computeCost`) reads only `modelId` and
      // `usage`. Do not "fix" this into a real tool-execution list.
      const result = await inner.invoke(request, invokeOptions);
      iterations.push({
        index: iterations.length + 1,
        modelId: result.modelId,
        stopReason: result.stopReason,
        usage: result.usage,
        toolExecutions: [],
      });
      // Ordering matters: the ledger must be current before the caller's
      // next gate evaluation, which is why totals are recomputed and
      // observed synchronously right after the push above.
      observeTotals();
      return result;
    },
  };

  return {
    invoker,
    observedIterations: () => Object.freeze([...iterations]),
  };
}

/**
 * The floating-point tolerance for {@link reconcileMeteredCost}'s agreement
 * check. Both sides sum floats in a different order (per-turn here, however
 * the library accumulates internally), so a reordering alone must not trip a
 * false alarm — `1e-6` rather than a razor-thin `1e-9` because two sums that
 * agree to nine decimal places of *intent* can still differ by slightly more
 * than `1e-9` in their actual float bits.
 */
const COST_RECONCILIATION_TOLERANCE = 1e-6;

/**
 * Compares the locally metered cost against the loop's own end-of-run
 * figure. The library's value is the ORACLE; a divergence means the local
 * {@link sumObservedCost} formula has drifted from the library's, and the
 * ledger's budget figures can no longer be trusted.
 *
 * @param options - `metered` is the cost computed by this module's
 *   {@link sumObservedCost}, or `undefined` when unobservable. `reported` is
 *   `outcome.cost` from `runBedrockToolLoop`'s resolved outcome (an omitted
 *   key reads as `undefined` here, which is the correct way to read it), or
 *   `undefined` when the loop could not price the run.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   on divergence.
 *
 * @example
 * ```ts
 * import { reconcileMeteredCost } from "./metering-invoker.js";
 *
 * reconcileMeteredCost({ metered: 1.5, reported: 1.5 }); // agrees, no throw
 * ```
 */
export function reconcileMeteredCost(options: {
  readonly metered: number | undefined;
  readonly reported: number | undefined;
}): void {
  const { metered, reported } = options;
  if (metered === undefined && reported === undefined) return;
  if (metered === undefined || reported === undefined) {
    throw new M3LAgentOperatorCliError(
      "metered cost and the loop's reported cost disagree on whether cost is observable at all",
      "ERR_AGENT_OPERATOR_CONFIG",
      { context: { metered, reported } },
    );
  }
  if (Math.abs(metered - reported) > COST_RECONCILIATION_TOLERANCE) {
    throw new M3LAgentOperatorCliError(
      "metered cost diverges from the loop's own reported cost beyond tolerance",
      "ERR_AGENT_OPERATOR_CONFIG",
      { context: { metered, reported } },
    );
  }
}
