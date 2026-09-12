/**
 * `agent-operator/steps/daily-counter` — the cross-run daily invocation
 * counter that makes ADR-0060's `budgets.invocationsPerDay` **observable**.
 *
 * Without it, `AgentRunLedger.snapshot()` omits `invocationsToday` and
 * `todayCountedAt`, so `Core.evaluateAgentAction` escalates every action on
 * `budget.invocations-per-day.unobservable` — and because budgets are step 3
 * of the evaluator while the decision-log rule is step 3b, that one
 * unobservable ceiling masks every other rule. The fix is metering, never a
 * defaulted ledger field: seeding `0` would be a false claim of *observed*
 * zero spend, which is the one direction this design must never fail in.
 *
 * Four decisions carry this module:
 *
 * 1. **It counts model INVOCATIONS, not runs.** The library defines the unit
 *    (`core/agent/policy-types.ts`, `core/agent/ledger-types.ts`) and this
 *    script does not get to redefine it. `invocationsPerRun` and
 *    `invocationsPerDay` sit in the same `M3LAgentBudgets` bag and are read by
 *    the same table: if per-day counted *runs*, the committed policy's
 *    `60`/`400` pair would silently mean 60 turns x 400 runs = 24,000
 *    turns/day — a 60x widening of a ceiling the operator believed they wrote,
 *    with no reviewable diff.
 * 2. **The day boundary is UTC.** {@link sameUtcDay} duplicates the library's
 *    own `Math.floor(t / 86_400_000)` formula, which is `internal/` and so
 *    off-limits under ADR-0029 — the same deliberate duplication
 *    `steps/metering-invoker.ts` already documents for `computeCost`, and it
 *    carries the same drift-guard test. A *local*-day roll would disagree with
 *    the evaluator by up to fourteen hours, resetting the counter at local
 *    midnight while the evaluator still called it the same UTC day: a silent
 *    doubling of the ceiling, invisible on a UTC CI runner and live only on
 *    operator laptops.
 * 3. **The state lives under `getDataDir()/agent-state`, not
 *    `getOutputDir()`.** `data/output/` holds run artifacts and is the natural
 *    thing for an operator to clear; clearing it must not silently reset a
 *    policy budget ceiling. `.gitignore` already carries the matching entry.
 * 4. **The filename is a fixed constant, never derived from `agentName`.**
 *    `agentName` is argv-settable, so an `agentName`-derived name would let
 *    `--agentName foo` mint a fresh 400-invocation budget with no policy diff.
 *    Same objection to an `agentStateDir` config parameter, which is why none
 *    exists. (`decisionLogDir` is different and stays: relocating an audit
 *    record widens no authority.)
 *
 * **Documented caveats.** Both are permissive rather than restrictive, and
 * both are stated rather than hidden:
 *
 * - **Concurrent runs lose updates.** Two overlapping runs both read baseline
 *   N; the later write wins. That UNDER-counts, bounded by (concurrent runs x
 *   `invocationsPerRun`). `writeFileAtomic` gives torn-write safety, not
 *   mutual exclusion, and a lock does not belong here: `data/agent-log/` is
 *   the compensating control, since every verdict is durably recorded and the
 *   true count is reconstructible from it.
 * - **A deleted file starts today at 0**, and standalone/Lambda mode with an
 *   ephemeral `M3L_BASE_DIR` resets per cold start.
 *
 * **Migration note (the workload slice).**
 * {@link AgentDailyInvocationCounter.record} is called exactly once, at the
 * end of a successful run, because in this slice no model invocation can occur
 * at all — there is no loop to crash halfway through. Once the Bedrock loop
 * lands, `record()` moves next to the invocation site, so a crash mid-loop
 * cannot forget the invocations it already made. Until then the
 * fail-open-on-crash window is a documented deferral, not an oversight.
 *
 * @packageDocumentation
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../lib/errors.js";
import type { AgentRunLedger } from "./run-ledger.js";

/** Milliseconds in a UTC day — the library's own `MS_PER_DAY`, re-derived. */
const MS_PER_DAY = 86_400_000;

/**
 * The fixed subdirectory of the data root the counter lives in. Matches
 * `.gitignore`'s `data/agent-state/` entry.
 */
const AGENT_STATE_DIRNAME = "agent-state";

/**
 * The fixed checkpoint name. **Never** derived from `agentName` or any other
 * argv-settable value — see decision 4 in the module doc.
 */
const DAILY_COUNTER_NAME = "daily-invocations";

/**
 * The persisted shape of the counter: a count, and the instant it was written.
 *
 * @remarks
 * The two fields are **correlated** — a count without its anchor cannot be
 * rolled, and an anchor without a count says nothing — so
 * {@link isAgentDailyCounterState} rejects a payload missing either one
 * rather than defaulting the absentee.
 *
 * Module-private: the persisted shape is this module's own business, and the
 * only thing a caller ever sees of it is
 * {@link AgentDailyInvocationCounter.priorToday}. Exporting it would publish
 * a file format nothing outside here reads.
 */
interface AgentDailyCounterState {
  /** The epoch-millisecond instant `invocations` was last written at. */
  readonly countedAt: number;
  /** Invocations recorded during `countedAt`'s UTC day. */
  readonly invocations: number;
}

/**
 * The state a virgin deployment starts from.
 *
 * `countedAt: 0` is chosen deliberately: the epoch's UTC day is never today,
 * so the **absent-file** case flows through the *same* rollover branch a
 * **stale-file** case does. One code path, not two — and no branch that only
 * a filesystem-less first run would ever exercise.
 */
const EMPTY_STATE: AgentDailyCounterState = Object.freeze({
  countedAt: 0,
  invocations: 0,
});

/**
 * `true` when both epoch-millisecond instants fall in the same UTC calendar
 * day.
 *
 * @remarks
 * A verbatim re-derivation of the library's own `isSameUtcDay`
 * (`internal/agent/budgets.ts`), which ADR-0029 forbids importing. The
 * library's TSDoc blesses the duplication in the same breath as defining it:
 * "epoch milliseconds are already timezone-independent, so a plain integer
 * division by the day length needs no timezone input and cannot drift between
 * a caller and the library." A drift-guard test pins the formula so a
 * `toDateString()` / local-time rewrite fails regardless of the runner's `TZ`.
 *
 * @param a - An epoch-millisecond instant.
 * @param b - An epoch-millisecond instant.
 * @returns `true` when `a` and `b` fall in the same UTC day.
 *
 * @example
 * ```ts
 * import { sameUtcDay } from "./daily-counter.js";
 *
 * sameUtcDay(Date.UTC(2026, 8, 1, 23, 59), Date.UTC(2026, 8, 1, 0, 0)); // true
 * ```
 */
export function sameUtcDay(a: number, b: number): boolean {
  return Math.floor(a / MS_PER_DAY) === Math.floor(b / MS_PER_DAY);
}

/**
 * Validates a decoded counter payload as a {@link AgentDailyCounterState}.
 *
 * Both fields are required, and both must be non-negative safe integers:
 * `invocations` because it is a count, `countedAt` because it is an epoch
 * millisecond that must survive the `Math.floor` in {@link sameUtcDay}
 * meaningfully. A payload failing this is CORRUPT, and the caller must reject
 * the run rather than degrade to zero — degrading would convert tampering
 * into a budget reset.
 */
function isAgentDailyCounterState(
  value: unknown,
): value is AgentDailyCounterState {
  if (typeof value !== "object" || value === null) return false;
  if (!Object.hasOwn(value, "countedAt")) return false;
  if (!Object.hasOwn(value, "invocations")) return false;
  const record = value as Record<string, unknown>;
  const countedAt = record["countedAt"];
  const invocations = record["invocations"];
  return (
    typeof countedAt === "number" &&
    Number.isSafeInteger(countedAt) &&
    countedAt >= 0 &&
    typeof invocations === "number" &&
    Number.isSafeInteger(invocations) &&
    invocations >= 0
  );
}

/**
 * The `M3LCheckpointPathsPort` adapter that redirects the store off
 * `getOutputDir()` and onto `getDataDir()/agent-state`.
 *
 * @remarks
 * `M3LCheckpointStore` resolves its file through `paths.resolveOutput(name)`;
 * this adapter satisfies that structural port while anchoring elsewhere. The
 * `name` it will be handed is {@link DAILY_COUNTER_NAME}, a module constant,
 * so no caller-supplied segment ever reaches the `path.join` — which is why
 * this adapter does not need `M3LPaths`' own containment guard.
 */
function agentStatePaths(paths: Core.M3LPaths): Core.M3LCheckpointPathsPort {
  const directory = path.join(paths.getDataDir(), AGENT_STATE_DIRNAME);
  return {
    resolveOutput: (name: string): string => path.join(directory, name),
  };
}

/** Inputs for {@link openDailyInvocationCounter}. */
export interface OpenDailyInvocationCounterDeps {
  /** The script's paths port. Only `getDataDir()` is read. */
  readonly paths: Core.M3LPaths;
  /**
   * The instant the caller sampled **once** for the whole run. The rollover
   * decision, the `todayCountedAt` the ledger emits, and every
   * `evaluateAgentAction` call must all agree on one instant, or a run
   * straddling UTC midnight rolls under one `now` and is judged under another.
   */
  readonly now: number;
}

/**
 * An opened counter: the day's prior total, already rolled, plus the two
 * operations the run performs against it.
 *
 * @example
 * ```ts
 * import type { AgentDailyInvocationCounter } from "./daily-counter.js";
 * import { AgentRunLedger } from "./run-ledger.js";
 *
 * declare const counter: AgentDailyInvocationCounter;
 *
 * const ledger = new AgentRunLedger();
 * counter.seed(ledger);
 * await counter.record(0);
 * ```
 */
export interface AgentDailyInvocationCounter {
  /**
   * Invocations already recorded for today's UTC day, **after** the rollover
   * — `0` when the stored instant belongs to another day, or to the future.
   */
  readonly priorToday: number;
  /**
   * Seeds `ledger` with {@link priorToday}, making `invocationsPerDay`
   * observable. Must be called before the run's first policy evaluation.
   */
  seed(ledger: AgentRunLedger): void;
  /**
   * Persists `priorToday + invocationsThisRun` as today's total.
   *
   * Idempotent: both operands are fixed at open time and at the call site, so
   * repeating the call rewrites identical bytes. `record(0)` is therefore not
   * a deletable no-op — it creates the state directory, exercises the atomic
   * write and the envelope round-trip in production rather than only in
   * tests, and materialises the rollover so the file reflects today.
   */
  record(invocationsThisRun: number): Promise<void>;
}

/**
 * Wraps a failure from the checkpoint store as this script's own coded error.
 *
 * The store's `cause` is chained, never re-messaged: `M3LCheckpointError`'s
 * message embeds the resolved path, so it must not be read into ours.
 */
function budgetStateFailure(
  what: string,
  cause: unknown,
): M3LAgentOperatorCliError {
  return new M3LAgentOperatorCliError(
    `the cross-run daily invocation counter could not be ${what}; refusing to run rather than treating an unreadable counter as zero spend`,
    "ERR_AGENT_OPERATOR_BUDGET_STATE",
    { cause },
  );
}

/**
 * Opens the cross-run daily invocation counter, rolling the stored count to
 * `0` when it belongs to a different UTC day than `deps.now`.
 *
 * @remarks
 * A **corrupt, unparseable, or checksum-mismatched** file makes this reject.
 * It never degrades to zero — that is the one place this module could silently
 * convert tampering (or a truncated write) into a budget reset. Only a genuine
 * `ENOENT` reads as `0`, via the store's `{ kind: "empty" }` policy, and even
 * that flows through the same rollover branch a stale file does.
 *
 * The store is constructed with **no `definition`**: nothing about
 * "invocations made today" depends on configuration, so there is nothing to
 * fingerprint against — and binding one would hard-fail the counter on an
 * unrelated config change, which is exactly the fail-open-adjacent surprise
 * this module exists to avoid.
 *
 * @param deps - See {@link OpenDailyInvocationCounterDeps}.
 * @returns The opened counter — see {@link AgentDailyInvocationCounter}.
 * @throws {@link M3LAgentOperatorCliError} coded
 *   `ERR_AGENT_OPERATOR_BUDGET_STATE` when the stored counter cannot be read
 *   or is not a valid {@link AgentDailyCounterState}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { openDailyInvocationCounter } from "./daily-counter.js";
 *
 * const counter = await openDailyInvocationCounter({
 *   paths: new Core.M3LPaths(),
 *   now: Date.now(),
 * });
 * ```
 */
export async function openDailyInvocationCounter(
  deps: OpenDailyInvocationCounterDeps,
): Promise<AgentDailyInvocationCounter> {
  const statePaths = agentStatePaths(deps.paths);
  const store = new Core.M3LCheckpointStore<AgentDailyCounterState>({
    paths: statePaths,
    name: DAILY_COUNTER_NAME,
    validate: isAgentDailyCounterState,
    missing: { kind: "empty", value: EMPTY_STATE },
  });

  let stored: AgentDailyCounterState;
  try {
    stored = await store.read();
  } catch (cause) {
    throw budgetStateFailure("read", cause);
  }

  // One rollover branch for both the stale-file and the absent-file case (see
  // EMPTY_STATE). A stored instant in the FUTURE — a clock stepped backwards
  // — also fails `sameUtcDay` and therefore grants no stale baseline.
  const priorToday = sameUtcDay(stored.countedAt, deps.now)
    ? stored.invocations
    : 0;

  // The directory the store writes into. `writeFileAtomic` explicitly does
  // not create the parent, so this module must.
  const directory = path.dirname(statePaths.resolveOutput(DAILY_COUNTER_NAME));

  return Object.freeze({
    priorToday,
    seed(ledger: AgentRunLedger): void {
      // `deps.now`, never `stored.countedAt`: after a rollover the stored
      // instant belongs to a previous UTC day, and the evaluator would read
      // the (already-rolled) count as belonging to a day that is not today.
      ledger.observeDailyBaseline({
        invocationsToday: priorToday,
        countedAt: deps.now,
      });
    },
    async record(invocationsThisRun: number): Promise<void> {
      try {
        await mkdir(directory, { recursive: true });
        await store.write({
          countedAt: deps.now,
          invocations: priorToday + invocationsThisRun,
        });
      } catch (cause) {
        throw budgetStateFailure("written", cause);
      }
    },
  });
}
