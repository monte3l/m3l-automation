#!/usr/bin/env node
// Verifies that every templates/script/*.tmpl file, after simple __TOKEN__
// substitution, is ALREADY prettier-conformant — for every token set tested,
// with no reformatting pass. This is a load-bearing invariant, not a nicety:
// packages/m3l-cli/src/scaffold/generate.ts (ADR-0053 U9) emits scaffolded
// files directly from these templates without ever calling `prettier`,
// because packages/m3l-cli carries a zero-third-party-runtime-dependency
// contract (bin/check-cli-scaffold.mjs) that forbids importing it. Verified
// by hand at U9's authoring time across every template and several token
// sets (short name, typical, a name/purpose pair near the 200-char
// purposeErrors ceiling) — this gate makes that fact permanent: a future
// template edit that breaks it fails loud here, instead of silently shipping
// unformatted scaffolds that only surface as a `pnpm format:check` failure
// in someone else's PR.
//
// Deliberately does NOT import packages/m3l-cli's scaffold module (which
// would require the CLI already built): __TOKEN__ substitution is pure
// string replacement, simple and stable enough to duplicate here rather than
// impose a build-order dependency on this gate. `templates/script/**` is
// otherwise ungated by `format:check` — prettier infers no parser for
// `.tmpl`, so `prettier --check .` silently skips every file under it; this
// gate closes that hole by resolving each template's TARGET parser
// (extension after substitution/stripping `.tmpl`) explicitly.
//
// Usage:
//   node bin/check-template-format.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { format, resolveConfig } from "prettier";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

/** Repo-relative directory holding the `*.tmpl` sources. */
export const TEMPLATE_DIR = "templates/script";

/**
 * Token sets exercised against every template — chosen to bracket the real
 * input space: a minimal name, a realistic name+purpose, and a pairing near
 * `purposeErrors`' 200-character ceiling (the longest legal purpose plus a
 * multi-segment name), which is the shape most likely to push a line past
 * prettier's `printWidth` if a template ever grew a token inside a
 * width-sensitive context (a table cell, a single-line comment).
 *
 * @returns {{ label: string, tokens: Record<string, string> }[]}
 */
export function tokenSets() {
  return [
    {
      label: "short-name",
      tokens: {
        __SCRIPT_NAME__: "x",
        __SCRIPT_NAME_PASCAL__: "X",
        __PURPOSE__: "Do a thing.",
      },
    },
    {
      label: "typical",
      tokens: {
        __SCRIPT_NAME__: "data-sync",
        __SCRIPT_NAME_PASCAL__: "DataSync",
        __PURPOSE__: "Sync S3 exports to Dynamo.",
      },
    },
    {
      label: "long-name-and-purpose",
      tokens: {
        __SCRIPT_NAME__: "cloudwatch-logs-analysis-extended-variant",
        __SCRIPT_NAME_PASCAL__: "CloudwatchLogsAnalysisExtendedVariant",
        __PURPOSE__: `${"A".repeat(180)} end.`,
      },
    },
  ];
}

/**
 * Replaces every `tokens` key in `text` with its value. Deliberately NOT
 * the scaffolder's `substituteTokens` (which throws on a leftover token) —
 * this gate's job is to check formatting of what substitution actually
 * produces for a fixed set of KNOWN templates, not to re-validate the
 * token contract itself (that is `bin/tests/script-scaffold.test.ts`'s job).
 *
 * @param {string} text
 * @param {Record<string, string>} tokens
 * @returns {string}
 */
export function substitute(text, tokens) {
  let result = text;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.replaceAll(token, value);
  }
  return result;
}

/**
 * Recursively lists every `.tmpl` file under `dir`, repo-relative to `root`.
 *
 * @param {string} root
 * @param {string} dir absolute directory to walk
 * @returns {string[]} repo-relative paths, sorted
 */
export function listTemplates(root, dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTemplates(root, full));
    } else if (full.endsWith(".tmpl")) {
      out.push(relative(root, full));
    }
  }
  return out.sort();
}

/**
 * The prettier-resolvable target path for a template: strip the trailing
 * `.tmpl` and substitute tokens in the path itself (mirrors the scaffolder,
 * which substitutes tokens in `target` paths too — e.g.
 * `src/steps/run-__SCRIPT_NAME__.ts.tmpl`) so prettier infers the parser
 * from the REAL extension (`.md`/`.json`/`.ts`), not `.tmpl`.
 *
 * @param {string} templateRel repo-relative template path
 * @param {Record<string, string>} tokens
 * @returns {string}
 */
export function targetPathFor(templateRel, tokens) {
  return substitute(templateRel.replace(/\.tmpl$/, ""), tokens);
}

/**
 * Checks one template against one token set. Returns a problem string, or
 * `undefined` when the substituted output is already prettier-conformant.
 *
 * @param {string} root
 * @param {string} templateRel
 * @param {{ label: string, tokens: Record<string, string> }} tokenSet
 * @returns {Promise<string | undefined>}
 */
async function checkOne(root, templateRel, tokenSet) {
  const raw = readFileSync(join(root, templateRel), "utf8");
  const substituted = substitute(raw, tokenSet.tokens);
  const targetPath = targetPathFor(templateRel, tokenSet.tokens);
  let formatted;
  try {
    const prettierOptions = await resolveConfig(join(root, targetPath));
    formatted = await format(substituted, {
      ...prettierOptions,
      filepath: targetPath,
    });
  } catch (cause) {
    return `${templateRel} [${tokenSet.label}]: prettier could not format the substituted output (target "${targetPath}"): ${cause}`;
  }
  if (formatted !== substituted) {
    return `${templateRel} [${tokenSet.label}]: substituted output is NOT prettier-conformant — a template edit introduced formatting that needs a reformatting pass, which packages/m3l-cli/src/scaffold/generate.ts cannot perform (no prettier runtime dependency, ADR-0053 U9). Fix the template's committed text so substitution alone stays clean.`;
  }
  return undefined;
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const root = repoRoot(import.meta.url);

  let errors = 0;
  const templates = listTemplates(root, join(root, TEMPLATE_DIR));
  if (templates.length === 0) {
    reporter.error(`${TEMPLATE_DIR}/ has no .tmpl files — nothing to check.`);
    errors++;
  }

  for (const templateRel of templates) {
    for (const tokenSet of tokenSets()) {
      const problem = await checkOne(root, templateRel, tokenSet);
      if (problem) {
        reporter.error(problem, { file: templateRel });
        errors++;
      }
    }
  }

  if (errors > 0) {
    if (!json) {
      console.error(
        `\n✗  ${errors} template-format mismatch(es) across ${templates.length} template(s).`,
      );
    }
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    `${templates.length} template(s) stay prettier-conformant after substitution across ${tokenSets().length} token set(s).`,
  );
  reporter.finish();
}
