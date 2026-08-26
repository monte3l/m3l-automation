/**
 * `scaffold/generate` — emits a new `scripts/*` consumer package plus its
 * contract page, and wires the root tsconfig project reference (`m3l new`,
 * ADR-0022 fleet conventions).
 *
 * @packageDocumentation
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { M3LCliError } from "../cli/errors.js";
import {
  DOC_PAGE_TEMPLATE,
  TEMPLATE_DIR,
  docPagePath,
  packageTemplateFiles,
  purposeErrors,
  rootTsconfigRef,
  scriptTokens,
  serviceNameErrors,
  substituteTokens,
  SCRIPT_NAME_RE,
} from "./manifest.js";
import type { ScaffoldTokens, ScaffoldVariant } from "./manifest.js";

/** Options controlling a single `generateScript` run. */
export interface GenerateScriptOptions {
  /** The resolved workspace root (see `discovery/discover.ts`). */
  readonly workspaceRoot: string;
  /** The new script's kebab-case name. */
  readonly name: string;
  /** The new script's one-line purpose description. */
  readonly purpose: string;
  /** Which entry-point/README shape to emit. */
  readonly variant: ScaffoldVariant;
  /** Render every file but write nothing. */
  readonly dryRun: boolean;
  /** Overwrite a pre-existing package dir / doc page instead of failing. */
  readonly force: boolean;
}

/** A single file this run created or updated. */
export interface GenerateScriptChange {
  /** Whether the file was newly written or an existing file was amended. */
  readonly action: "created" | "updated";
  /** The file's path, relative to the workspace root. */
  readonly path: string;
}

/** The outcome of a `generateScript` run. */
export interface GenerateScriptResult {
  /** The scaffolded script's name. */
  readonly scriptName: string;
  /** Which variant was emitted. */
  readonly variant: ScaffoldVariant;
  /** Whether this run only rendered (no writes occurred). */
  readonly dryRun: boolean;
  /** Every file created or updated by this run, in emission order. */
  readonly changes: readonly GenerateScriptChange[];
}

/**
 * Validates `name`, `purpose`, and `variant` before any filesystem access.
 *
 * @throws {@link M3LCliError} with code `ERR_CLI_SCAFFOLD_INVALID` on the
 *   first failing check, in order: name shape, service-name/reserved-name
 *   rules, purpose rules, variant.
 */
function validateScaffoldInput(
  name: string,
  purpose: string,
  variant: unknown,
): void {
  if (!SCRIPT_NAME_RE.test(name)) {
    throw new M3LCliError(
      "ERR_CLI_SCAFFOLD_INVALID",
      `script name "${name}" must be kebab-case ([a-z0-9] segments separated by "-").`,
    );
  }
  const nameProblems = serviceNameErrors(name);
  if (nameProblems.length > 0) {
    throw new M3LCliError("ERR_CLI_SCAFFOLD_INVALID", nameProblems.join(" "));
  }
  const purposeProblems = purposeErrors(purpose);
  if (purposeProblems.length > 0) {
    throw new M3LCliError(
      "ERR_CLI_SCAFFOLD_INVALID",
      purposeProblems.join(" "),
    );
  }
  if (variant !== "cli" && variant !== "lambda") {
    throw new M3LCliError(
      "ERR_CLI_SCAFFOLD_INVALID",
      `--variant must be "cli" or "lambda" (got ${JSON.stringify(variant)}).`,
    );
  }
}

/**
 * Checks that neither the package directory nor the doc page pre-exist,
 * unless `force` is set.
 *
 * @throws {@link M3LCliError} with code `ERR_CLI_SCAFFOLD_EXISTS` when a
 *   target pre-exists and `force` is `false`.
 * @returns Whether the package directory / doc page pre-existed, for the
 *   rollback decision in {@link emitPackageFiles}.
 */
function checkExistingTargets(
  packageDir: string,
  docPage: string,
  name: string,
  force: boolean,
): {
  readonly packageDirPreexisted: boolean;
  readonly docPagePreexisted: boolean;
} {
  const packageDirPreexisted = existsSync(packageDir);
  const docPagePreexisted = existsSync(docPage);
  if (packageDirPreexisted && !force) {
    throw new M3LCliError(
      "ERR_CLI_SCAFFOLD_EXISTS",
      `scripts/${name}/ already exists — implement or edit it directly instead of re-scaffolding, or pass --force to overwrite the generated files.`,
    );
  }
  if (docPagePreexisted && !force) {
    throw new M3LCliError(
      "ERR_CLI_SCAFFOLD_EXISTS",
      `${docPagePath(name)} already exists — remove or rename it first, or pass --force to overwrite it.`,
    );
  }
  return { packageDirPreexisted, docPagePreexisted };
}

/**
 * Renders a template through token substitution and — unless `dryRun` —
 * writes it to `absoluteTarget`. Always renders, even in dry-run, so a
 * genuine unreplaced-token error still surfaces during a preview.
 */
function emitFile(
  workspaceRoot: string,
  template: string,
  absoluteTarget: string,
  tokens: ScaffoldTokens,
  dryRun: boolean,
): void {
  const raw = readFileSync(join(workspaceRoot, TEMPLATE_DIR, template), "utf8");
  const substituted = substituteTokens(raw, tokens);
  if (!dryRun) {
    mkdirSync(dirname(absoluteTarget), { recursive: true });
    writeFileSync(absoluteTarget, substituted);
  }
}

/**
 * Emits every package template file plus the doc page. On any failure, rolls
 * back each target independently — but only when THAT target didn't already
 * exist before this run; under `--force` onto a pre-existing target, deleting
 * it would remove content this run never wrote.
 *
 * @throws {@link M3LCliError} with code `ERR_CLI_SCAFFOLD_FAILED` on any
 *   emission failure.
 */
function emitPackageFiles(
  options: GenerateScriptOptions,
  packageDir: string,
  docPage: string,
  tokens: ScaffoldTokens,
  packageDirPreexisted: boolean,
  docPagePreexisted: boolean,
): GenerateScriptChange[] {
  const changes: GenerateScriptChange[] = [];
  try {
    for (const { template, target } of packageTemplateFiles(options.variant)) {
      const resolvedTarget = substituteTokens(target, tokens);
      emitFile(
        options.workspaceRoot,
        template,
        join(packageDir, resolvedTarget),
        tokens,
        options.dryRun,
      );
      changes.push({
        action: "created",
        path: join("scripts", options.name, resolvedTarget),
      });
    }
    emitFile(
      options.workspaceRoot,
      DOC_PAGE_TEMPLATE,
      docPage,
      tokens,
      options.dryRun,
    );
    changes.push({ action: "created", path: docPagePath(options.name) });
  } catch (cause) {
    if (!packageDirPreexisted) {
      rmSync(packageDir, { recursive: true, force: true });
    }
    if (!docPagePreexisted) {
      rmSync(docPage, { force: true });
    }
    const targetsPreexisted = packageDirPreexisted || docPagePreexisted;
    throw new M3LCliError(
      "ERR_CLI_SCAFFOLD_FAILED",
      targetsPreexisted
        ? `scaffold failed for scripts/${options.name}/ (--force target predates this run — NOT rolled back): ${String(cause)}`
        : `scaffold failed for scripts/${options.name}/ and was rolled back: ${String(cause)}`,
      { cause },
    );
  }
  return changes;
}

/** Indentation width for the fallback root `tsconfig.json` rewrite — matches the committed file's formatting. */
const ROOT_TSCONFIG_INDENT = 2;

/** A minimal parsed shape of the root `tsconfig.json`, for the `references` rewrite. */
interface RootTsconfig {
  references?: { path: string }[];
  [key: string]: unknown;
}

/**
 * Matches the root tsconfig's one-entry-per-line `"references": [ ... ]`
 * block, capturing its inner body and closing-bracket indentation, so a new
 * entry can be inserted textually rather than via a full `JSON.stringify`
 * (which would reformat every existing single-line `{ "path": "..." }`
 * entry into a multi-line object, unlike the committed file's style).
 */
const REFERENCES_BLOCK_RE = /"references":\s*\[\n([\s\S]*?)\n(\s*)\]/;

/** Extracts the `path` value from a single `{ "path": "..." }` reference entry line. */
function extractEntryPath(line: string): string {
  return /"path":\s*"([^"]+)"/.exec(line)?.[1] ?? "";
}

/**
 * Inserts `ref` into the root tsconfig's `references` array as a minimal,
 * line-preserving textual diff: every existing entry line survives
 * byte-for-byte (comma placement aside), and the new entry is inserted in
 * sorted order. Returns `undefined` when `rawText`'s `references` array
 * isn't in the expected one-entry-per-line shape, so the caller can fall
 * back to a full re-serialization.
 */
function insertSortedReferenceLine(
  rawText: string,
  ref: string,
): string | undefined {
  const match = REFERENCES_BLOCK_RE.exec(rawText);
  if (!match) {
    return undefined;
  }
  const [whole, body, closingIndent] = match;
  const existingLines = (body ?? "").split("\n");
  const entryIndent = /^(\s*)/.exec(existingLines[0] ?? "")?.[1] ?? "    ";
  const newLine = `${entryIndent}{ "path": ${JSON.stringify(ref)} }`;
  const sortedLines = [
    ...existingLines.map((line) => line.replace(/,\s*$/, "")),
    newLine,
  ].sort((a, b) => extractEntryPath(a).localeCompare(extractEntryPath(b)));
  const rendered = sortedLines
    .map((line, index) => (index < sortedLines.length - 1 ? `${line},` : line))
    .join("\n");
  const replacement = `"references": [\n${rendered}\n${closingIndent}]`;
  return (
    rawText.slice(0, match.index) +
    replacement +
    rawText.slice(match.index + whole.length)
  );
}

/**
 * Rebuilds the entire root tsconfig as pretty-printed JSON. Used only when
 * {@link insertSortedReferenceLine} can't find the expected textual shape
 * (e.g. a compact single-line `references` array) — its exact formatting is
 * not load-bearing, only its structural content.
 */
function rewriteRootTsconfig(rootTsconfig: RootTsconfig, ref: string): string {
  const references = [...(rootTsconfig.references ?? []), { path: ref }].sort(
    (a, b) => a.path.localeCompare(b.path),
  );
  return `${JSON.stringify({ ...rootTsconfig, references }, null, ROOT_TSCONFIG_INDENT)}\n`;
}

/**
 * Adds this script's project reference to the root `tsconfig.json` if it
 * isn't already present, keeping `references` sorted by `path`.
 *
 * @returns The `updated` change, or `undefined` when the reference already
 *   existed.
 */
function updateRootTsconfig(
  workspaceRoot: string,
  name: string,
  dryRun: boolean,
): GenerateScriptChange | undefined {
  const rootTsconfigPath = join(workspaceRoot, "tsconfig.json");
  const rawText = readFileSync(rootTsconfigPath, "utf8");
  const rootTsconfig = JSON.parse(rawText) as RootTsconfig;
  const ref = rootTsconfigRef(name);
  const references = rootTsconfig.references ?? [];
  if (references.some((entry) => entry.path === ref)) {
    return undefined;
  }
  if (!dryRun) {
    const updatedText =
      insertSortedReferenceLine(rawText, ref) ??
      rewriteRootTsconfig(rootTsconfig, ref);
    writeFileSync(rootTsconfigPath, updatedText);
  }
  return { action: "updated", path: "tsconfig.json" };
}

/**
 * Scaffolds a new `scripts/<name>/` consumer package plus its contract page,
 * and wires the root tsconfig project reference.
 *
 * @param options - The scaffold options.
 * @returns The scaffolded script's name, variant, dry-run flag, and every
 *   file this run created or updated.
 * @throws {@link M3LCliError} with code `ERR_CLI_SCAFFOLD_INVALID` for a
 *   malformed `name`/`purpose`/`variant`, `ERR_CLI_SCAFFOLD_EXISTS` when the
 *   target pre-exists without `--force`, or `ERR_CLI_SCAFFOLD_FAILED` on an
 *   emission failure.
 *
 * @example
 * ```ts
 * const result = generateScript({
 *   workspaceRoot: "/repo",
 *   name: "data-sync",
 *   purpose: "Sync S3 exports to Dynamo",
 *   variant: "cli",
 *   dryRun: false,
 *   force: false,
 * });
 * // result.changes lists every created/updated file
 * ```
 */
export function generateScript(
  options: GenerateScriptOptions,
): GenerateScriptResult {
  validateScaffoldInput(options.name, options.purpose, options.variant);

  const packageDir = join(options.workspaceRoot, "scripts", options.name);
  const docPage = join(options.workspaceRoot, docPagePath(options.name));
  const { packageDirPreexisted, docPagePreexisted } = checkExistingTargets(
    packageDir,
    docPage,
    options.name,
    options.force,
  );
  const tokens = scriptTokens(options.name, options.purpose);
  const changes = emitPackageFiles(
    options,
    packageDir,
    docPage,
    tokens,
    packageDirPreexisted,
    docPagePreexisted,
  );

  const tsconfigChange = updateRootTsconfig(
    options.workspaceRoot,
    options.name,
    options.dryRun,
  );
  if (tsconfigChange) {
    changes.push(tsconfigChange);
  }

  return {
    scriptName: options.name,
    variant: options.variant,
    dryRun: options.dryRun,
    changes,
  };
}
