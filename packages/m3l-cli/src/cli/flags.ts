/**
 * `cli/flags` — the CLI-reserved `--json` flag constant and the exact-token
 * partitioning helper `main.ts`/`commands/dynamic.ts` use to recognize it
 * ahead of any script's own declared parameters (V2 slice 1, ADR-0063 /
 * #539), plus its U7 sibling `--in-process`/`partitionInProcessFlag`
 * (ADR-0054) and the V3 `--env-file`/`--no-env-file` pair (ADR-0085). All
 * mirror the existing `--help`/`-h` precedent: a reserved flag is stripped
 * before a script's own `parseArgs` ever sees it, so it can never collide
 * with — or be shadowed by — a script's own declared parameter of the same
 * name.
 *
 * @packageDocumentation
 */

import { resolve } from "node:path";

import { M3LCliError } from "./errors.js";

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

/**
 * The CLI-reserved flag token naming an explicit env file for the spawned
 * child (ADR-0085). Unlike {@link JSON_FLAG} and {@link IN_PROCESS_FLAG} it
 * takes a value, in either the attached (`--env-file=path`) or the detached
 * (`--env-file path`) form.
 */
export const ENV_FILE_FLAG = "--env-file" as const;

/**
 * The CLI-reserved flag token suppressing env-file loading in the spawned
 * child entirely (ADR-0085) — the one way to opt out of the otherwise
 * unconditional `--env-file-if-exists=.env` the CLI has always passed.
 */
export const NO_ENV_FILE_FLAG = "--no-env-file" as const;

/**
 * The resolved env-file decision for a spawned child (ADR-0085).
 *
 * - `auto` — the unchanged default: the child loads `.env` from its own
 *   directory if one exists, and silently proceeds if not.
 * - `path` — load the caller-named file instead, still tolerantly (an absent
 *   file is a soft miss, not a startup crash — see
 *   {@link partitionEnvFileFlags}).
 * - `disabled` — pass no env-file token at all.
 *
 * @example
 * ```ts
 * import type { M3LCliEnvFileSetting } from "./flags.js";
 *
 * const setting: M3LCliEnvFileSetting = { kind: "path", path: "/repo/staging.env" };
 * ```
 */
export type M3LCliEnvFileSetting =
  | { readonly kind: "auto" }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "disabled" };

/**
 * The default {@link M3LCliEnvFileSetting} every caller that expressed no
 * explicit choice uses — the pre-ADR-0085 behaviour, unchanged.
 */
export const AUTO_ENV_FILE: M3LCliEnvFileSetting = { kind: "auto" };

/** Recognizes the attached `--env-file=<path>` form. */
const ENV_FILE_ASSIGNMENT_PREFIX = `${ENV_FILE_FLAG}=`;

/** The shared "you did not give me a usable path" failure for both forms. */
function missingEnvFilePath(): M3LCliError {
  return new M3LCliError(
    "ERR_CLI_INVALID_PARAMETER_VALUE",
    `${ENV_FILE_FLAG} requires a path — write '${ENV_FILE_FLAG}=<path>' or '${ENV_FILE_FLAG} <path>'`,
  );
}

/**
 * Reads the value for a detached `--env-file <path>` occurrence at `index`.
 *
 * @throws {@link M3LCliError} coded `ERR_CLI_INVALID_PARAMETER_VALUE` when
 *   the token is last, or is followed by another flag — rejecting
 *   `--env-file --json` loudly rather than silently swallowing the `--json`
 *   that followed it.
 */
function readDetachedEnvFileValue(
  args: readonly string[],
  index: number,
): string {
  const value = args[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw missingEnvFilePath();
  }
  return value;
}

/**
 * Splits `args` into the resolved {@link M3LCliEnvFileSetting} and the
 * remaining tokens, with every `--env-file`/`--env-file=<path>`/
 * `--no-env-file` occurrence — and a detached `--env-file`'s value token —
 * removed.
 *
 * Unlike {@link partitionJsonFlag} and {@link partitionInProcessFlag} this is
 * not a pure exact-token filter, because `--env-file` carries a value. A
 * relative path is resolved against `cwd` — the CLI's own working directory,
 * deliberately, **not** the script directory the child is spawned in: an
 * operator who types `--env-file staging.env` means the file they can see,
 * not one inside `scripts/<name>/`. The `auto` default stays
 * script-directory-relative, exactly as before.
 *
 * Repeating `--env-file` is last-wins; combining it with `--no-env-file` is
 * not. The two express opposite intents, and letting token order silently
 * decide whether an entire configuration file reaches a command that is
 * about to receive secrets is precisely the class of mistake ADR-0085
 * refuses to hide.
 *
 * @param args - The argument tokens to scan, the pre-`--` slice of `argv`.
 * @param cwd - The directory a relative `--env-file` path resolves against.
 * @returns `envFile`: the resolved setting; `rest`: `args` with every
 *   env-file token removed, order otherwise preserved.
 * @throws {@link M3LCliError} coded `ERR_CLI_INVALID_PARAMETER_VALUE` when
 *   both flags are present, or when `--env-file` has no usable value.
 *
 * @example
 * ```ts
 * import { partitionEnvFileFlags } from "./flags.js";
 *
 * const { envFile, rest } = partitionEnvFileFlags(
 *   ["--region", "us-east-1", "--env-file", "staging.env"],
 *   "/repo",
 * );
 * // envFile === { kind: "path", path: "/repo/staging.env" }
 * // rest === ["--region", "us-east-1"]
 * ```
 */
/**
 * The raw scan {@link partitionEnvFileFlags} resolves: the last `--env-file`
 * path seen (unresolved), whether `--no-env-file` appeared, and every token
 * that is neither.
 */
interface M3LCliEnvFileScan {
  readonly path: string | undefined;
  readonly disabled: boolean;
  readonly rest: readonly string[];
}

/**
 * Walks `args` once, pulling out every env-file token (and a detached
 * `--env-file`'s value) and leaving everything else in `rest`. Split from
 * {@link partitionEnvFileFlags} so the scan and the resolution stay under the
 * ESLint `complexity` ceiling independently.
 *
 * @throws {@link M3LCliError} coded `ERR_CLI_INVALID_PARAMETER_VALUE` when
 *   `--env-file` carries no usable value.
 */
function scanEnvFileFlags(args: readonly string[]): M3LCliEnvFileScan {
  const rest: string[] = [];
  let path: string | undefined;
  let disabled = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === NO_ENV_FILE_FLAG) {
      disabled = true;
    } else if (arg.startsWith(ENV_FILE_ASSIGNMENT_PREFIX)) {
      path = arg.slice(ENV_FILE_ASSIGNMENT_PREFIX.length) || undefined;
      if (path === undefined) {
        throw missingEnvFilePath();
      }
    } else if (arg === ENV_FILE_FLAG) {
      path = readDetachedEnvFileValue(args, index);
      index += 1;
    } else {
      rest.push(arg);
    }
  }

  return { path, disabled, rest };
}

export function partitionEnvFileFlags(
  args: readonly string[],
  cwd: string,
): {
  readonly envFile: M3LCliEnvFileSetting;
  readonly rest: readonly string[];
} {
  const { path, disabled, rest } = scanEnvFileFlags(args);

  if (disabled && path !== undefined) {
    throw new M3LCliError(
      "ERR_CLI_INVALID_PARAMETER_VALUE",
      `${ENV_FILE_FLAG} and ${NO_ENV_FILE_FLAG} are mutually exclusive — pass one or the other`,
    );
  }
  if (disabled) {
    return { envFile: { kind: "disabled" }, rest };
  }
  if (path !== undefined) {
    return { envFile: { kind: "path", path: resolve(cwd, path) }, rest };
  }
  return { envFile: AUTO_ENV_FILE, rest };
}
