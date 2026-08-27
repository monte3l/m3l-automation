/**
 * `cli/flags` — the CLI-reserved `--json` flag constant and the exact-token
 * partitioning helper `main.ts`/`commands/dynamic.ts` use to recognize it
 * ahead of any script's own declared parameters (V2 slice 1, ADR-0063 /
 * #539), plus its U7 sibling `--in-process`/`partitionInProcessFlag`
 * (ADR-0054). Both mirror the existing `--help`/`-h` precedent: a reserved
 * flag is stripped before a script's own `parseArgs` ever sees it, so it can
 * never collide with — or be shadowed by — a script's own declared parameter
 * of the same name.
 *
 * @packageDocumentation
 */

/** The CLI-reserved flag token requesting machine-readable output. */
export const JSON_FLAG = "--json" as const;

/**
 * Splits `args` into whether the exact `--json` token is present and the
 * remaining tokens with every `--json` occurrence removed, preserving the
 * original order of everything else.
 *
 * Matches the literal `--json` token only — `--json=true` is a distinct
 * token and passes through untouched in `rest`, exactly like `parseArgs`
 * would treat any other unrecognized `--flag=value` form.
 *
 * @param args - The argument tokens to scan, typically the pre-`--` slice of
 *   `argv` before it reaches a script's own `parseArgs` call.
 * @returns `jsonOutput`: `true` when `--json` appears at least once;
 *   `rest`: `args` with every `--json` token removed, order preserved.
 *
 * @example
 * ```ts
 * import { partitionJsonFlag } from "./flags.js";
 *
 * const { jsonOutput, rest } = partitionJsonFlag(["--region", "us-east-1", "--json"]);
 * // jsonOutput === true, rest === ["--region", "us-east-1"]
 * ```
 */
export function partitionJsonFlag(args: readonly string[]): {
  readonly jsonOutput: boolean;
  readonly rest: readonly string[];
} {
  const rest = args.filter((arg) => arg !== JSON_FLAG);
  return {
    jsonOutput: rest.length !== args.length,
    rest,
  };
}

/**
 * The CLI-reserved flag token requesting in-process execution (ADR-0054,
 * U7): when present, `commands/dynamic.ts` diverts a script's dispatch to
 * `run/in-process.ts` instead of spawning `dist/main.js` as a child process.
 */
export const IN_PROCESS_FLAG = "--in-process" as const;

/**
 * Splits `args` into whether the exact `--in-process` token is present and
 * the remaining tokens with every `--in-process` occurrence removed,
 * preserving the original order of everything else.
 *
 * Matches the literal `--in-process` token only — `--in-process=true` is a
 * distinct token and passes through untouched in `rest`, exactly like
 * {@link partitionJsonFlag} treats `--json=true`.
 *
 * @param args - The argument tokens to scan, typically the pre-`--` slice of
 *   `argv` before it reaches a script's own `parseArgs` call.
 * @returns `inProcess`: `true` when `--in-process` appears at least once;
 *   `rest`: `args` with every `--in-process` token removed, order preserved.
 *
 * @example
 * ```ts
 * import { partitionInProcessFlag } from "./flags.js";
 *
 * const { inProcess, rest } = partitionInProcessFlag(["--region", "us-east-1", "--in-process"]);
 * // inProcess === true, rest === ["--region", "us-east-1"]
 * ```
 */
export function partitionInProcessFlag(args: readonly string[]): {
  readonly inProcess: boolean;
  readonly rest: readonly string[];
} {
  const rest = args.filter((arg) => arg !== IN_PROCESS_FLAG);
  return {
    inProcess: rest.length !== args.length,
    rest,
  };
}
