/**
 * `scaffold/manifest` — pure validation rules, token substitution, and the
 * template-file manifest for scaffolding a new `scripts/*` consumer package
 * (`m3l new`, ADR-0022 fleet conventions). No filesystem access: every export
 * here is a pure function or a static table, so `scaffold/generate` is the
 * only module in this pair that touches `node:fs`.
 *
 * @packageDocumentation
 */

import { M3LCliError } from "../cli/errors.js";

/**
 * The two shapes `m3l new` can scaffold: a plain CLI-invoked script, or one
 * whose `src/main.ts` is a Lambda handler.
 *
 * @example
 * ```ts
 * function describeVariant(variant: ScaffoldVariant): string {
 *   return variant === "lambda" ? "AWS Lambda handler" : "CLI entry point";
 * }
 * ```
 */
export type ScaffoldVariant = "cli" | "lambda";

/**
 * Kebab-case script names only: `data-sync`, `report-builder`, `probe`.
 *
 * @example
 * ```ts
 * SCRIPT_NAME_RE.test("data-sync"); // true
 * SCRIPT_NAME_RE.test("Data_Sync"); // false
 * ```
 */
export const SCRIPT_NAME_RE: RegExp = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * ADR-0028: known-bad abbreviated AWS service tokens. A name whose FIRST
 * hyphen-segment is one of these keys is rejected. This is a denylist, not a
 * service-name allowlist — no canonical vocabulary of "every valid AWS
 * service name" exists yet, nor any structural signal marking a script
 * "AWS-scoped" versus not, so an allowlist can't be built without inventing
 * both. A denylist sidesteps that: it applies uniformly to every name, so a
 * non-AWS name (`json-etl`) is simply never on the list.
 *
 * @example
 * ```ts
 * BANNED_LEADING_SEGMENTS.get("dynamo"); // "dynamodb"
 * ```
 */
export const BANNED_LEADING_SEGMENTS: ReadonlyMap<string, string> = new Map([
  ["dynamo", "dynamodb"],
  ["cfn", "cloudformation"],
  ["apigw", "api-gateway"],
]);

/**
 * ADR-0028: bare AWS capability names that omit their owning service.
 * Checked as an exact whole-name match (the missing piece is a leading
 * prefix, not a segment substitution, so a leading-segment check can't catch
 * it).
 *
 * @example
 * ```ts
 * BANNED_EXACT_NAMES.get("logs-insights"); // "cloudwatch-logs-insights"
 * ```
 */
export const BANNED_EXACT_NAMES: ReadonlyMap<string, string> = new Map([
  ["logs-insights", "cloudwatch-logs-insights"],
]);

/**
 * ADR-0042: static command names of the m3l CLI. A script whose name equals
 * one of these would shadow the CLI's own subcommand routing (`m3l <script>`
 * dynamic dispatch), so scaffolding rejects it. `run <script>` stays the
 * always-unambiguous canonical form either way; this list just keeps the
 * short form collision-free.
 *
 * Kept as its own literal (not imported from `commands/doctor.ts` or
 * `commands/dynamic.ts`, which independently declare the same 9 names) — a
 * drift guard elsewhere reads this literal by text and compares it against
 * `doctor.ts`'s.
 *
 * @example
 * ```ts
 * RESERVED_CLI_NAMES.has("new"); // true
 * ```
 */
export const RESERVED_CLI_NAMES: ReadonlySet<string> = new Set([
  "list",
  "inspect",
  "run",
  "doctor",
  "presets",
  "history",
  "wizard",
  "new",
  "help",
]);

/**
 * Validates a script name against the ADR-0028 full-service-name convention
 * and the ADR-0042 reserved-CLI-name list.
 *
 * @param name - The candidate script name.
 * @returns Human-readable problem strings; `[]` when `name` is compliant.
 *
 * @example
 * ```ts
 * serviceNameErrors("dynamo-backup");
 * // ['"dynamo-backup" abbreviates the AWS service name ... "dynamodb" ...']
 * ```
 */
export function serviceNameErrors(name: string): string[] {
  const problems: string[] = [];
  const leadingSegment = name.split("-")[0] ?? "";
  const abbrevTarget = BANNED_LEADING_SEGMENTS.get(leadingSegment);
  if (abbrevTarget !== undefined) {
    problems.push(
      `"${name}" abbreviates the AWS service name (uses "${leadingSegment}") — ADR-0028 requires the full official service name ("${abbrevTarget}") as the leading segment.`,
    );
  }
  const exactTarget = BANNED_EXACT_NAMES.get(name);
  if (exactTarget !== undefined) {
    problems.push(
      `"${name}" names an AWS capability without its owning service — ADR-0028 requires "${exactTarget}".`,
    );
  }
  if (RESERVED_CLI_NAMES.has(name)) {
    problems.push(
      `"${name}" is a reserved m3l CLI command name (${[...RESERVED_CLI_NAMES].join(", ")}) — ADR-0042 forbids script names that shadow a static CLI command.`,
    );
  }
  return problems;
}

/** Longest `--purpose` value accepted — one terse sentence, not a paragraph. */
export const PURPOSE_MAX_LENGTH = 200;

/** Characters that would terminate or escape the contexts a purpose is emitted into, paired with why. */
const UNSAFE_PURPOSE_CHARS: readonly (readonly [string, string])[] = [
  ['"', "it terminates the package.json description string"],
  ["\\", "it escapes inside the package.json description string"],
  ["*", "it can terminate the doc comment the purpose is emitted into"],
  ["/", "it can terminate the doc comment the purpose is emitted into"],
];

/**
 * Validates a `--purpose` value before token substitution. The purpose is
 * injected verbatim into a JSON string (package.json `description`), TS doc
 * comments, and markdown — so characters that terminate or escape those
 * contexts are rejected up front rather than escaped per-context.
 *
 * @param purpose - The candidate purpose value. Typed `unknown` (rather than
 *   `string`) because this validator is also reachable from an untyped JS
 *   caller across the `bin/` boundary — the `typeof` check below is what
 *   makes that safe, not the type system.
 * @returns Human-readable problem strings; `[]` when `purpose` is valid.
 *
 * @example
 * ```ts
 * purposeErrors(""); // ["purpose must be a non-empty string"]
 * purposeErrors("Sync S3 exports to Dynamo"); // []
 * ```
 */
export function purposeErrors(purpose: unknown): string[] {
  if (typeof purpose !== "string" || purpose.trim() === "") {
    return ["purpose must be a non-empty string"];
  }
  const problems: string[] = [];
  if (purpose.length > PURPOSE_MAX_LENGTH) {
    problems.push(
      `purpose must be at most ${PURPOSE_MAX_LENGTH} characters (got ${purpose.length})`,
    );
  }
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\u0000-\u001f\u007f]/u.test(purpose)) {
    problems.push("purpose must not contain newlines or control characters");
  }
  for (const [char, why] of UNSAFE_PURPOSE_CHARS) {
    if (purpose.includes(char)) {
      problems.push(
        `purpose must not contain ${JSON.stringify(char)} — ${why}`,
      );
    }
  }
  return problems;
}

/** Directory (repo-relative) holding the `*.tmpl` sources. */
export const TEMPLATE_DIR = "templates/script";

/** Directory (repo-relative) holding one contract page per script. */
export const SCRIPT_DOCS_DIR = "docs/reference/scripts";

/**
 * Converts a kebab-case script name to PascalCase, for generated identifiers
 * like `runDataSync`.
 *
 * @param name - A kebab-case script name.
 * @returns The PascalCase form.
 *
 * @example
 * ```ts
 * pascalCase("data-sync"); // "DataSync"
 * ```
 */
export function pascalCase(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** The substitution map applied to template content AND target paths. */
export interface ScaffoldTokens {
  /** The kebab-case script name. */
  readonly __SCRIPT_NAME__: string;
  /** The PascalCase form of the script name. */
  readonly __SCRIPT_NAME_PASCAL__: string;
  /** The one-line purpose description. */
  readonly __PURPOSE__: string;
}

/**
 * Builds the token map every scaffold template is substituted against.
 *
 * @param name - The kebab-case script name.
 * @param purpose - The one-line purpose description.
 * @returns The three documented tokens.
 *
 * @example
 * ```ts
 * scriptTokens("data-sync", "Sync it");
 * // { __SCRIPT_NAME__: "data-sync", __SCRIPT_NAME_PASCAL__: "DataSync", __PURPOSE__: "Sync it" }
 * ```
 */
export function scriptTokens(name: string, purpose: string): ScaffoldTokens {
  return {
    __SCRIPT_NAME__: name,
    __SCRIPT_NAME_PASCAL__: pascalCase(name),
    __PURPOSE__: purpose,
  };
}

/**
 * A `__TOKEN__`-shaped span: two leading underscores, one or more
 * uppercase/digit/underscore characters, two trailing underscores.
 */
const UNREPLACED_TOKEN_RE = /__[A-Z][A-Z0-9_]*__/;

/**
 * Replaces every known token in `text`, then asserts none survive. A
 * surviving `__TOKEN__`-shaped span after every known substitution means a
 * template uses a token {@link scriptTokens} doesn't know about — a typo, or
 * `scriptTokens` wasn't updated for a new template.
 *
 * @param text - The template content (or target path) to substitute into.
 * @param tokens - The token map, typically {@link scriptTokens}'s output.
 *   Accepts either {@link ScaffoldTokens} or an arbitrary string-keyed
 *   record — the latter admits an ad hoc token set (e.g. from an untyped
 *   caller across the `bin/` boundary) without widening
 *   {@link ScaffoldTokens} itself into carrying an index signature.
 * @returns `text` with every token replaced.
 * @throws {@link M3LCliError} with code `ERR_CLI_SCAFFOLD_FAILED` when a
 *   `__TOKEN__`-shaped span survives substitution.
 *
 * @example
 * ```ts
 * substituteTokens("Hello __SCRIPT_NAME__", { __SCRIPT_NAME__: "data-sync", __SCRIPT_NAME_PASCAL__: "DataSync", __PURPOSE__: "" });
 * // "Hello data-sync"
 * ```
 */
export function substituteTokens(
  text: string,
  tokens: ScaffoldTokens | Record<string, string>,
): string {
  let result = text;
  const entries = Object.entries(tokens) as [string, string][];
  for (const [token, value] of entries) {
    result = result.replaceAll(token, value);
  }
  const leftover = UNREPLACED_TOKEN_RE.exec(result);
  if (leftover) {
    throw new M3LCliError(
      "ERR_CLI_SCAFFOLD_FAILED",
      `substituteTokens: unreplaced token "${leftover[0]}" survived substitution — add it to scriptTokens() in packages/m3l-cli/src/scaffold/manifest.ts.`,
    );
  }
  return result;
}

/** A template → target pair emitted inside `scripts/<name>/`. */
export interface ScaffoldTemplateFile {
  /** The template's path relative to {@link TEMPLATE_DIR}. */
  readonly template: string;
  /** The target's path relative to the script package directory; may carry tokens. */
  readonly target: string;
}

/**
 * The template → target pairs emitted inside `scripts/<name>/` for a given
 * variant. Targets may carry tokens (resolved with the same map as content).
 *
 * ADR-0054's in-process command-module seam (U6, `src/command.ts` +
 * `tests/command.test.ts`) is emitted for the `"cli"` variant only. It is an
 * alternative host for invoking a script's declared operations in-process
 * against the CLI's own `dist/main.js` process — a Lambda-variant script (U9)
 * has no such CLI process at all, so there is nothing for the seam to be an
 * alternative to. This is a deliberate scoping, not an oversight: don't "fix"
 * it by making the two variants symmetric.
 *
 * @param variant - Which entry-point/README pair to emit.
 * @returns The 11-entry manifest for `"cli"`, or the 9-entry manifest for
 *   `"lambda"`.
 *
 * @example
 * ```ts
 * packageTemplateFiles("cli")[0];
 * // { template: "package.json.tmpl", target: "package.json" }
 * ```
 */
export function packageTemplateFiles(
  variant: ScaffoldVariant,
): readonly ScaffoldTemplateFile[] {
  return [
    { template: "package.json.tmpl", target: "package.json" },
    { template: "tsconfig.json.tmpl", target: "tsconfig.json" },
    { template: "tsconfig.build.json.tmpl", target: "tsconfig.build.json" },
    {
      template:
        variant === "lambda" ? "src/main.lambda.ts.tmpl" : "src/main.ts.tmpl",
      target: "src/main.ts",
    },
    { template: "src/config.ts.tmpl", target: "src/config.ts" },
    { template: "src/hooks.ts.tmpl", target: "src/hooks.ts" },
    ...(variant === "cli"
      ? [{ template: "src/command.ts.tmpl", target: "src/command.ts" }]
      : []),
    {
      template: "src/steps/run-__SCRIPT_NAME__.ts.tmpl",
      target: "src/steps/run-__SCRIPT_NAME__.ts",
    },
    { template: "tests/config.test.ts.tmpl", target: "tests/config.test.ts" },
    ...(variant === "cli"
      ? [
          {
            template: "tests/command.test.ts.tmpl",
            target: "tests/command.test.ts",
          },
        ]
      : []),
    {
      template:
        variant === "lambda" ? "README.lambda.md.tmpl" : "README.md.tmpl",
      target: "README.md",
    },
  ];
}

/** The `variant: "cli"` template manifest — the default shape most scripts use. */
export const PACKAGE_TEMPLATE_FILES: readonly ScaffoldTemplateFile[] =
  packageTemplateFiles("cli");

/** The contract page template emitted outside the package dir. */
export const DOC_PAGE_TEMPLATE = "docs-page.md.tmpl";

/**
 * Builds a script's contract-page path.
 *
 * @param name - The kebab-case script name.
 * @returns The repo-relative doc page path.
 *
 * @example
 * ```ts
 * docPagePath("data-sync"); // "docs/reference/scripts/data-sync.md"
 * ```
 */
export function docPagePath(name: string): string {
  return `${SCRIPT_DOCS_DIR}/${name}.md`;
}

/** Files a conformant scaffolded script always carries by exact path. */
export const REQUIRED_EXACT_FILES: readonly string[] = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "src/main.ts",
  "src/config.ts",
  "src/hooks.ts",
  "README.md",
];

/** A directory/suffix pair of which at least one match must exist. */
export interface ScaffoldRequiredGlob {
  /** The directory (relative to the script package root) to scan. */
  readonly dir: string;
  /** The filename suffix a conformant match must carry. */
  readonly suffix: string;
  /** Human-readable description of what the match represents. */
  readonly what: string;
}

/**
 * Directory/suffix pairs of which at least one match must exist: business
 * logic lives in steps modules, and the fleet convention mandates at least a
 * config-declaration smoke test.
 */
export const REQUIRED_GLOBS: readonly ScaffoldRequiredGlob[] = [
  { dir: "src/steps", suffix: ".ts", what: "a steps/ module" },
  { dir: "tests", suffix: ".test.ts", what: "the config smoke test" },
];

/**
 * Builds the root tsconfig `references` entry a script package must have.
 *
 * @param name - The kebab-case script name.
 * @returns The project-reference path.
 *
 * @example
 * ```ts
 * rootTsconfigRef("data-sync"); // "./scripts/data-sync/tsconfig.build.json"
 * ```
 */
export function rootTsconfigRef(name: string): string {
  return `./scripts/${name}/tsconfig.build.json`;
}
