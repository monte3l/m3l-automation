/**
 * `cli/flags` — the CLI-reserved `--json` flag constant and the exact-token
 * partitioning helper `main.ts`/`commands/dynamic.ts` use to recognize it
 * ahead of any script's own declared parameters (V2 slice 1, ADR-0063 /
 * #539). Mirrors the existing `--help`/`-h` precedent: a reserved flag is
 * stripped before a script's own `parseArgs` ever sees it, so it can never
 * collide with — or be shadowed by — a script's own declared parameter of
 * the same name.
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
