/**
 * `commands/new` — scaffolds a new `scripts/<name>/` consumer package by
 * delegating to {@link generateScript}, rendering its result as JSON or a
 * human-readable summary depending on `context.jsonOutput` (`m3l new`,
 * ADR-0022 fleet conventions, U9, issue #533).
 *
 * @packageDocumentation
 */

import { parseArgs } from "node:util";

import type { M3LCliExitCode } from "../cli/errors.js";
import { sanitizeTerminalText } from "../cli/output.js";
import type { M3LCliCommandContext } from "./context.js";
import { generateScript } from "../scaffold/generate.js";
import type {
  GenerateScriptResult,
  GenerateScriptChange,
} from "../scaffold/generate.js";
import type { ScaffoldVariant } from "../scaffold/manifest.js";

/** Exit code returned for the missing-`<name>`-positional usage error. */
const USAGE_EXIT_CODE: M3LCliExitCode = 2;

/** The default `--purpose` value, mirroring `bin/scaffold-script.mjs`. */
const DEFAULT_PURPOSE = "TODO: describe what this automation does.";

/** The `new` command's own parsed argument shape. */
interface ParsedNewArgs {
  /** The new script's kebab-case name, or `undefined` if omitted. */
  readonly name: string | undefined;
  /** The new script's one-line purpose description. */
  readonly purpose: string;
  /** Which entry-point/README shape to emit. */
  readonly variant: ScaffoldVariant;
  /** Render every file but write nothing. */
  readonly dryRun: boolean;
  /** Overwrite a pre-existing package dir / doc page instead of failing. */
  readonly force: boolean;
}

/**
 * Parses `new`'s own raw `rawArgs` slice with `node:util`'s `parseArgs`.
 *
 * This is a SEPARATE parse from `main.ts`'s shared static-command parser
 * (which only recognizes `--json`/`--help`) — `rawArgs` is the raw,
 * unparsed slice `main.ts` passes after the literal `"new"` token, so `new`'s
 * own value-flags (`--purpose`, `--variant`) must be parsed here, not by the
 * shared parser.
 *
 * @param rawArgs - The raw argument slice following the `new` command token.
 * @returns The parsed name/purpose/variant/dryRun/force values, with
 *   defaults applied for every field except `name`.
 */
function parseNewArgs(rawArgs: readonly string[]): ParsedNewArgs {
  const { values, positionals } = parseArgs({
    args: [...rawArgs],
    options: {
      purpose: { type: "string" },
      variant: { type: "string", default: "cli" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    name: typeof positionals[0] === "string" ? positionals[0] : undefined,
    purpose:
      typeof values["purpose"] === "string"
        ? values["purpose"]
        : DEFAULT_PURPOSE,
    // `generateScript` (via `validateScaffoldInput`) performs its own runtime
    // check and throws `ERR_CLI_SCAFFOLD_INVALID` for an invalid variant
    // string; this cast defers that validation rather than duplicating it.
    variant: (typeof values["variant"] === "string"
      ? values["variant"]
      : "cli") as ScaffoldVariant,
    dryRun: values["dry-run"] === true,
    force: values["force"] === true,
  };
}

/** Renders a single change's action + sanitized path as one output line. */
function renderChange(change: GenerateScriptChange): string {
  return `  ${change.action} ${sanitizeTerminalText(change.path)}`;
}

/** Renders a successful `generateScript` result through `context.output`. */
function renderResult(
  context: M3LCliCommandContext,
  result: GenerateScriptResult,
): void {
  if (context.jsonOutput) {
    context.output.info(JSON.stringify(result));
    return;
  }

  context.output.heading(
    result.dryRun
      ? `Dry run — scripts/${result.scriptName}/ (no files written)`
      : `Scaffolded scripts/${result.scriptName}/`,
  );
  for (const change of result.changes) {
    context.output.info(renderChange(change));
  }
  context.output.info(
    result.dryRun
      ? `${result.changes.length} file(s) would change (dry run).`
      : `${result.changes.length} file(s) changed.`,
  );
}

/**
 * Scaffolds a new `scripts/<name>/` consumer package by parsing `rawArgs`
 * and delegating to {@link generateScript}.
 *
 * This function stays `async` (rather than a plain synchronous return) even
 * though every step — {@link parseNewArgs}, {@link generateScript}, and the
 * `context.output` calls — is synchronous, purely so its call shape matches
 * every sibling command handler (`runInspect`/`runPresets`/etc.), which
 * callers (`main.ts`, and every test here) already `await` uniformly; a
 * synchronous throw from {@link generateScript} then surfaces to an `await`
 * caller as a rejected promise rather than a synchronous throw, matching the
 * "propagates unchanged" contract below.
 *
 * @param context - The command context to run against.
 * @param rawArgs - The raw argument slice following the `new` command token
 *   (parsed independently of `main.ts`'s shared static-command parser).
 * @returns `2` when the `<name>` positional is missing (without ever calling
 *   {@link generateScript}); otherwise `0` on success.
 * @throws Whatever {@link generateScript} throws, unwrapped — an
 *   already-typed `M3LCliError` propagates unchanged.
 *
 * @example
 * ```ts
 * const exitCode = await runNew(context, ["data-sync", "--variant", "lambda"]);
 * // 0 on success; throws M3LCliError on invalid input or a pre-existing target
 * ```
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async only for call-shape uniformity with sibling command handlers (see TSDoc) and to turn generateScript's sync throw into a rejected promise; no await belongs in the body
export async function runNew(
  context: M3LCliCommandContext,
  rawArgs: readonly string[],
): Promise<M3LCliExitCode> {
  const parsed = parseNewArgs(rawArgs);

  if (parsed.name === undefined) {
    context.output.error(
      "new requires a <name> positional — usage: m3l new <name>",
    );
    return USAGE_EXIT_CODE;
  }

  const result = generateScript({
    workspaceRoot: context.workspaceRoot,
    name: parsed.name,
    purpose: parsed.purpose,
    variant: parsed.variant,
    dryRun: parsed.dryRun,
    force: parsed.force,
  });

  renderResult(context, result);
  return 0;
}
