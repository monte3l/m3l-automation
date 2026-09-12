/**
 * `lib/flow-names` — the flow-name allowlist that anchors the argument
 * injection defence for the `m3l flow run` seam. A model-supplied flow name
 * is the one free-form value that reaches `flowRun`'s argv array
 * (`lib/cli-surface.ts`'s `buildArgv` interpolates it as the third
 * positional); this module is what keeps that value honest before the
 * operator-declared allowlist decides whether it is permitted at all.
 *
 * Mirrors `lib/cli-names.ts` and `lib/preset-names.ts`, but — unlike the
 * preset-name check — there is no separate `isAllowedFlowName` predicate
 * layer here: {@link assertAllowedFlowName} takes the operator-declared
 * allowlist directly and is the only function permitted to mint the brand.
 *
 * @packageDocumentation
 */

import { M3LAgentOperatorCliError } from "./errors.js";

declare const AGENT_OPERATOR_FLOW_NAME: unique symbol;

/**
 * A flow name that has already passed {@link assertAllowedFlowName} —
 * minted there and nowhere else. `cli-surface.ts`'s internal `CliOperation`
 * union types its `flowRun` arm's `flowName` field with this brand, so a
 * model-proposed `string` cannot reach `buildArgv` (and from there,
 * `runCliProcess`'s argv array) without first passing through both the
 * shape check and the allowlist.
 *
 * The brand is a **compile-time-only** device: it is erased by `tsc` and
 * carries no runtime representation or check of its own. The actual
 * guarantee — that a value tagged with this brand really did pass the name
 * and allowlist checks — is enforced entirely by
 * {@link assertAllowedFlowName}.
 *
 * @example
 * ```ts
 * import type { AgentOperatorFlowName } from "./flow-names.js";
 *
 * function buildArgv(flowName: AgentOperatorFlowName): readonly string[] {
 *   return ["flow", "run", flowName, "--json"];
 * }
 * ```
 */
export type AgentOperatorFlowName = string & {
  readonly [AGENT_OPERATOR_FLOW_NAME]: unique symbol;
};

/**
 * Flow-name shape pattern: one or more slug SEGMENTS of lowercase letters
 * and digits, joined by single hyphens — no leading or trailing `-`, and no
 * doubled `--`. Unlike a bare `[a-z0-9-]+` character class, hyphens are
 * only accepted as separators *between* segments, so `-x`, `trailing-`, and
 * `a--b` are all refused by this pattern alone, before the allowlist is
 * ever consulted.
 *
 * **This is load-bearing, not cosmetic.** `m3l flow`'s own `parseFlowArgs`
 * (`packages/m3l-cli/src/commands/flow.ts`) resolves positionals by
 * SKIPPING any token that starts with `-` rather than by position — a token
 * is pushed onto `positionals` only when it does not start with `-`; every
 * `-`-prefixed token is instead reduced by `flagName` and matched against
 * the command's known flags. So a flow "name" of `--dry-run` would never be
 * read as a name at all — it would silently ENABLE the dry-run flag, and
 * `flow run` would then fail for a missing name. A name of `--json` or `-x`
 * likewise. Refusing any leading `-` here — structurally, at the shape
 * stage — is what makes the shape check and the allowlist check genuinely
 * INDEPENDENT guards: the allowlist no longer has to carry the entire
 * burden of catching a flag-shaped "name" by itself.
 *
 * Record why the pattern is shaped this way, so nobody relaxes it back: an
 * earlier version of this pattern was the bare character class
 * `/^[a-z0-9-]+$/`. Under that pattern the shape check was decorative for
 * exactly these inputs — `--dry-run`, `--json`, `-x`, and `trailing-` all
 * MATCHED it (a leading or trailing `-` is a legal character-class member),
 * so only allowlist membership ever refused them. Widening this pattern
 * back to a plain character class reopens that hole and returns to relying
 * on the allowlist alone.
 *
 * This is DELIBERATELY stricter than the CLI's own `FLOW_NAME_RE`
 * (`packages/m3l-cli/src/flow/types.ts`, `/^[a-z0-9-]+$/`). `m3l flow` will
 * run a flow file named `-weird-.yaml`; the agent will not. A flow whose
 * file name carries a leading, trailing, or doubled hyphen is deliberately
 * not agent-runnable — do NOT "align" this pattern with the CLI's to close
 * that gap, doing so reopens the hole described above.
 *
 * Why this is a **local copy** rather than an import of the CLI's own
 * pattern: `scripts/agent-operator` declares exactly one runtime
 * dependency, `@monte3l/m3l-common` (ADR-0029) — `packages/m3l-cli`
 * is not on that list and is not importable from here. Do not "fix" this
 * duplication with an import; it cannot resolve.
 *
 * ReDoS-safety: the pattern is fully anchored (`^`...`$`) and the repeated
 * group (`(?:-[a-z0-9]+)*`) has no internal alternation or nested
 * quantifier that overlaps the preceding segment, so there is no ambiguous
 * split point for a pathological input to backtrack across.
 *
 * @example
 * ```ts
 * AGENT_OPERATOR_FLOW_NAME_RE.test("sqs-roundtrip"); // true
 * AGENT_OPERATOR_FLOW_NAME_RE.test("--dry-run"); // false
 * AGENT_OPERATOR_FLOW_NAME_RE.test("trailing-"); // false
 * ```
 */
export const AGENT_OPERATOR_FLOW_NAME_RE: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Asserts that `flowName` is an allowed flow name, returning the narrowed,
 * **branded** {@link AgentOperatorFlowName} on success. This is the only
 * function permitted to mint the brand. Refuses in this exact order, each
 * throwing {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 * with a fixed message that never echoes `flowName`:
 *
 * 1. not a string, or empty — the type signature says `string`, but the
 *    value originates in model-supplied JSON (a cast such as
 *    `JSON.parse(text) as SomeShape` typechecks with zero errors), so the
 *    runtime guard treats the parameter as `unknown` for this check rather
 *    than trusting the static type of the cast path that produced it.
 * 2. fails {@link AGENT_OPERATOR_FLOW_NAME_RE}
 * 3. not a member of `allowlist` — proves the guard is not shape-only; a
 *    shape-valid name the operator never declared is still refused.
 *
 * No rejection message echoes `flowName`: a rejected value is exactly the
 * kind of content (shell metacharacters, path traversal, control bytes)
 * that must never be threaded into a log or error message. No `cause` is
 * attached to any of the three refusals either — nothing underneath failed,
 * the value simply did not qualify.
 *
 * @param flowName - A candidate flow name, potentially model-supplied.
 * @param allowlist - The operator-declared set of flow names permitted to
 *   run.
 * @returns The narrowed, allowed, branded flow name.
 * @throws {@link M3LAgentOperatorCliError} when `flowName` fails any of the
 *   three checks above.
 *
 * @example
 * ```ts
 * import { assertAllowedFlowName } from "./flow-names.js";
 *
 * const allowlist = new Set(["sqs-roundtrip", "log-triage"]);
 * const flowName = assertAllowedFlowName("sqs-roundtrip", allowlist);
 * ```
 */
export function assertAllowedFlowName(
  flowName: string,
  allowlist: ReadonlySet<string>,
): AgentOperatorFlowName {
  // Guard the cast path first: `flowName` is typed `string`, but the
  // realistic caller decodes model-supplied JSON through an upstream cast
  // (`JSON.parse(text) as SomeShape`), so a non-string value can and does
  // arrive here at runtime despite the static type.
  if (typeof flowName !== "string" || flowName.length === 0) {
    throw new M3LAgentOperatorCliError(
      "flow name must be a non-empty string",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  if (!AGENT_OPERATOR_FLOW_NAME_RE.test(flowName)) {
    throw new M3LAgentOperatorCliError(
      "flow name has an invalid shape",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  if (!allowlist.has(flowName)) {
    throw new M3LAgentOperatorCliError(
      "flow name is not on the allowlist",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }
  return flowName as AgentOperatorFlowName;
}
