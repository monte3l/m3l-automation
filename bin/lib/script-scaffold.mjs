// The single source of truth for the consumer-script scaffold shape
// (ADR-0022 fleet conventions), split across two owners since ADR-0053 U9:
//
//   - Generation-relevant identifiers (name/purpose validation, token
//     substitution, the template manifest, doc-page/tsconfig-ref helpers)
//     are now OWNED by packages/m3l-cli/src/scaffold/manifest.ts — the CLI's
//     `m3l new` command consumes them directly. This file RE-EXPORTS them
//     from the built CLI (`packages/m3l-cli/dist/scaffold/manifest.js`) so
//     `bin/scaffold-script.mjs` (the thin delegate) and
//     `bin/check-script-scaffold.mjs` (the checker) keep consuming ONE
//     source — generator and checker still cannot drift apart, they just
//     both drift-guard against the CLI's copy instead of a local one.
//   - Checker-only identifiers (`packageManifestErrors`, `tsconfigShapeErrors`,
//     `readmeExamplesErrors`, `commandModuleErrors` and their private
//     helpers) stay LOCAL: they're never used by generation, only by
//     `bin/check-script-scaffold.mjs`'s structural validation of
//     already-scaffolded output, so there's exactly one consumer and no
//     drift risk to guard against by relocating them.
//   - `SCRIPT_DOCS_DIR`, `docPagePath` and `scriptPackageDirs` live in
//     ./script-doc-paths.mjs instead, a build-independent sibling module —
//     see that file's header. They're re-exported below unchanged so every
//     existing consumer of this module keeps working; a new bin/*.mjs script
//     that needs only these three should import script-doc-paths.mjs
//     directly rather than pulling in this module's CLI-build requirement.
//
// Requires `packages/m3l-cli` to be built (`pnpm build`) before this module
// is imported — the re-export throws a clear message otherwise rather than
// Node's raw ERR_MODULE_NOT_FOUND.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./reference-index.mjs";

export {
  SCRIPT_DOCS_DIR,
  docPagePath,
  scriptPackageDirs,
} from "./script-doc-paths.mjs";

let cliScaffoldModule;
try {
  cliScaffoldModule =
    await import("../../packages/m3l-cli/dist/scaffold/manifest.js");
} catch (cause) {
  throw new Error(
    "bin/lib/script-scaffold.mjs: packages/m3l-cli is not built — run `pnpm build` first " +
      "(the scaffold manifest moved into the CLI, ADR-0053 U9).",
    { cause },
  );
}

// Only the names an actual bin/*.mjs script or bin/tests/*.test.ts file
// consumes are re-exported here — `RESERVED_CLI_NAMES` and
// `packageTemplateFiles` exist in the CLI's manifest for the CLI's own
// internal use (the `new` command, the doctor.test.ts drift guard reading
// the CLI source directly) but have no bin/-side consumer, so `pnpm knip`
// correctly flags them as unused if re-exported here too.
export const {
  SCRIPT_NAME_RE,
  BANNED_LEADING_SEGMENTS,
  BANNED_EXACT_NAMES,
  serviceNameErrors,
  PURPOSE_MAX_LENGTH,
  purposeErrors,
  TEMPLATE_DIR,
  pascalCase,
  scriptTokens,
  substituteTokens,
  PACKAGE_TEMPLATE_FILES,
  DOC_PAGE_TEMPLATE,
  REQUIRED_EXACT_FILES,
  REQUIRED_GLOBS,
  rootTsconfigRef,
} = cliScaffoldModule;

/**
 * Files the checker treats as **optional but verified**: absent is
 * conformant, present must be correctly shaped.
 *
 * `src/command.ts` is the ADR-0054 command-module seam (U6), emitted for the
 * `cli` scaffold variant only — a Lambda-variant script (ADR-0053 U9) has no
 * `dist/main.js` CLI process for an in-process host to be an alternative to,
 * so `packageTemplateFiles("lambda")` omits it. The generator emits it for
 * every NEW `cli`-variant script, but the pre-U6 fleet scripts have not
 * adopted it yet, and the gate must not fail them. This is deliberately a
 * SEPARATE tier from {@link REQUIRED_EXACT_FILES}: promoting `src/command.ts`
 * into that list is the fleet-catch-up event, and it is a one-line move once
 * every `cli`-variant script has adopted.
 *
 * Each entry pairs the path with its own validator rather than being a bare
 * path list, so the checker cannot apply the wrong one when a second optional
 * file joins the tier — "optional" here means optional-AND-verified, and the
 * verification is per-file by definition.
 */
export const OPTIONAL_EXACT_FILES = [
  { file: "src/command.ts", validate: commandModuleErrors },
];

/** `export const commandModule` carrying the `M3LCommandModule` annotation. */
const COMMAND_MODULE_EXPORT_RE =
  /export\s+const\s+commandModule\s*:\s*Core\.M3LCommandModule\b/;

/**
 * `command.ts` must compose the script itself. ADR-0054's parity guarantee is
 * that the in-process path runs the same composition root the spawned child
 * would — config resolution, lifecycle hooks, AWS provisioning and
 * `run-report.json` all still happen "because the entry composes
 * `M3LScript`/`runScript`, not a bypass of them". Nothing in the *types* can
 * prove that (an ADR-0009 layering zone forbids `core/cli-contract` from even
 * naming `core/script`), so it is asserted here instead.
 */
const COMMAND_MODULE_COMPOSES_RE = /Core\.runScript\s*\(/;

/**
 * `command.ts` must source its schema from `config.ts` rather than declaring
 * a second parameter set — one declared schema per script, or the two
 * execution paths can drift apart silently.
 */
const COMMAND_MODULE_CONFIG_IMPORT_RE =
  /import\s*\{[^}]*\bconfigParameters\b[^}]*\}\s*from\s*"\.\/config\.js"/;

/**
 * `commandModule.execute` resolves an outcome and must never call
 * `process.exit` — in-process that takes the host down with it. The ESLint
 * `no-restricted-properties` ban over every script source file is the primary
 * guard; this is its manifest-level backstop, so a script that somehow
 * suppressed the lint rule still fails the scaffold gate. Matched against
 * {@link stripComments}-processed source, so a comment that documents the ban
 * — whether on its own line or trailing real code — is not itself a
 * violation.
 *
 * Property-access shaped, like the ESLint rule it backs up, so
 * `process["exit"]()` and `const { exit } = process; exit(1)` both slip past
 * both layers. Left open deliberately: this is a guardrail against the
 * accident (a copied `process.exit(1)`), not a sandbox against a determined
 * author, and closing it would need a parser rather than a regex.
 *
 * Conversely, {@link stripComments} preserves string CONTENT — it has to,
 * since {@link COMMAND_MODULE_CONFIG_IMPORT_RE} matches a string literal — so
 * the text `process.exit(` inside a string is flagged even though it is data.
 * An accepted false positive: a `command.ts` carrying that text as data is
 * vanishingly unlikely, and the failure direction is safe.
 */
const COMMAND_MODULE_PROCESS_EXIT_RE = /process\s*\.\s*exit\s*\(/;

/**
 * Remove comments from TypeScript source so the command-module checks below
 * match code only.
 *
 * It matters in BOTH directions: a `process.exit(1)` written inside a comment
 * that DOCUMENTS the ban must not fail the gate, and an
 * `export const commandModule: ...` inside a TSDoc `@example` fence must not
 * satisfy it.
 *
 * `fileExports()` in bin/lib/reference-index.mjs strips line comments with
 * `/^\s*\/\/.*$/gm` — anchored to the line start, so a `//` inside a string
 * literal (a URL) cannot truncate a real declaration. That anchor also means a
 * TRAILING comment survives, which for this gate is a false positive:
 * `await flush(); // never call process.exit(1)` is conformant code. So this
 * scans the source for each `//` that is not inside a string and drops to the
 * end of that line — handling both cases the anchored regex cannot.
 *
 * Quote state is carried ACROSS lines, so a multi-line template literal whose
 * continuation line contains `//` (a URL, a path) is treated as string content
 * rather than truncated there. A newline still closes a single- or
 * double-quoted string, since those cannot legally span lines — that way one
 * stray apostrophe cannot swallow the rest of the file.
 *
 * Deliberately a small scanner, not a parser: it tracks quote state and
 * backslash escapes, which is all TypeScript source needs for this decision.
 * A regex literal containing an unbalanced quote is the known blind spot, and
 * carrying state across lines widened it: an unbalanced `'` or `"` (`/'/`)
 * still closes at the newline, but an unbalanced BACKTICK (`` /`/ ``) opens
 * template state for the rest of the FILE, suppressing comment stripping from
 * that point on. Both directions stay fail-safe — a comment left unstripped
 * can only produce a false failure, never a false pass — so the gate never
 * lets a bad `command.ts` through; it would just complain about a good one.
 * Closing it properly needs a tokenizer, which this gate does not justify.
 *
 * @param source - Raw TypeScript source.
 * @returns The source with comments removed.
 */
function stripComments(source) {
  // Block comments first: they can span lines and can contain quote
  // characters, which would otherwise open quote state in the scan below.
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let quote = "";
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (quote !== "") {
      if (char === "\\") {
        // Consume the escaped character so an escaped quote cannot close the
        // string.
        out += char + (src[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (char === quote) quote = "";
      else if (char === "\n" && quote !== "`") quote = "";
      out += char;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Validate an adopted command module. Only called when
 * `src/command.ts` exists — a script without it passes vacuously.
 * Returns human-readable problem strings (empty array = conformant).
 *
 * @param {string} commandSrc - contents of `src/command.ts`
 * @returns {string[]}
 */
export function commandModuleErrors(commandSrc) {
  const problems = [];
  const scannable = stripComments(commandSrc);
  if (!COMMAND_MODULE_EXPORT_RE.test(scannable)) {
    problems.push(
      "must declare `export const commandModule: Core.M3LCommandModule` — the ADR-0054 descriptor a host discovers. The explicit annotation (not `satisfies`) is required by `isolatedDeclarations`.",
    );
  }
  if (!COMMAND_MODULE_COMPOSES_RE.test(scannable)) {
    problems.push(
      "must compose the script itself via `Core.runScript(...)` — ADR-0054's parity guarantee is that the in-process path runs the same composition root the spawned child would, not a bypass of it.",
    );
  }
  if (!COMMAND_MODULE_CONFIG_IMPORT_RE.test(scannable)) {
    problems.push(
      'must import `configParameters` from "./config.js" — one declared schema per script, or the spawn and in-process paths drift apart silently.',
    );
  }
  if (COMMAND_MODULE_PROCESS_EXIT_RE.test(scannable)) {
    problems.push(
      "must never call `process.exit` — a hosted command resolves an M3LCommandOutcome; exiting takes the in-process host down with it (ADR-0054).",
    );
  }
  return problems;
}

/**
 * Validate a script's package.json against the ADR-0022 package contract.
 * Checker-only — never consumed by generation, so it stays local rather than
 * moving into the CLI.
 * Returns human-readable problem strings (empty array = conformant).
 */
export function packageManifestErrors(pkg, name) {
  const problems = [];
  if (pkg.name !== `@m3l-automation/${name}`) {
    problems.push(
      `"name" must be "@m3l-automation/${name}" (got ${JSON.stringify(pkg.name)})`,
    );
  }
  if (pkg.private !== true) {
    problems.push(`"private" must be true (scripts are never published)`);
  }
  if (pkg.type !== "module") {
    problems.push(`"type" must be "module" (ESM only)`);
  }
  if (!/>=\s*24/.test(pkg.engines?.node ?? "")) {
    problems.push(`"engines.node" must declare ">=24"`);
  }
  if (pkg.dependencies?.["@m3l-automation/m3l-common"] !== "workspace:*") {
    problems.push(
      `dependencies must include "@m3l-automation/m3l-common": "workspace:*"`,
    );
  }
  const expectedScripts = expectedPackageScripts();
  for (const script of Object.keys(expectedScripts)) {
    const actual = pkg.scripts?.[script];
    if (typeof actual !== "string" || !actual) {
      problems.push(`"scripts.${script}" must be declared`);
    } else if (actual !== expectedScripts[script]) {
      // Value, not just presence — previously a script could declare
      // `"typecheck": "echo nope"` and this loop would pass, since it only
      // checked the key was a non-empty string.
      problems.push(
        `"scripts.${script}" must be ${JSON.stringify(expectedScripts[script])} (got ${JSON.stringify(actual)})`,
      );
    }
  }
  return problems;
}

/**
 * The `scripts.{build,typecheck,start}` command values every scaffolded
 * script's package.json must carry — read from package.json.tmpl rather than
 * hand-duplicated as string literals. Its `scripts` values carry no
 * `__TOKEN__`s (unlike `name`/`description`), so its committed text IS every
 * script's expected value verbatim; this is the same shared-manifest
 * discipline this module already follows (one source, generator and checker
 * both read it), applied to a field this manifest previously only checked
 * for presence. Reads lazily (per call, not at module load) so this module
 * carries no import-time fs side effect.
 *
 * @returns {Record<string, string>}
 */
function expectedPackageScripts() {
  const parsed = JSON.parse(
    readFileSync(join(root, TEMPLATE_DIR, "package.json.tmpl"), "utf8"),
  );
  return parsed.scripts ?? {};
}

/**
 * Read tsconfig.json.tmpl / tsconfig.build.json.tmpl's `extends`,
 * `compilerOptions` and `references` shape directly from the template —
 * neither template substitutes any token, so their committed text IS every
 * scaffolded script's expected value verbatim. Reads lazily, matching
 * {@link expectedPackageScripts}.
 *
 * @param {"tsconfig.json.tmpl" | "tsconfig.build.json.tmpl"} templateName
 * @returns {{ extends: unknown, compilerOptions: Record<string, unknown>, references: { path?: unknown }[] }}
 */
function expectedTsconfigShape(templateName) {
  const parsed = JSON.parse(
    readFileSync(join(root, TEMPLATE_DIR, templateName), "utf8"),
  );
  return {
    extends: parsed.extends,
    compilerOptions: parsed.compilerOptions ?? {},
    references: parsed.references ?? [],
  };
}

/**
 * Validate a scaffolded script's tsconfig.json or tsconfig.build.json against
 * the invariants the matching template encodes: `extends` the base config,
 * every `compilerOptions` entry the template sets, and a project `references`
 * entry back to m3l-common (so `tsc -b` and editor tooling resolve
 * `@m3l-automation/m3l-common`'s types). Checker-only. Returns human-readable
 * problem strings (empty array = conformant).
 *
 * The `compilerOptions` check is full parity with the template rather than a
 * named-flag allow-list, so the next flag added to a template cannot silently
 * skip the already-scaffolded fleet — how `isolatedDeclarations` came to be
 * missing from three scripts (#773). It matters most for
 * tsconfig.build.json's `isolatedDeclarations`, which is deliberately kept
 * out of tsconfig.base.json: without it `pnpm typecheck` passes while
 * `pnpm build` would fail `TS9010`, so a script missing it loses that gate
 * entirely. Extra keys a script sets beyond the template are not flagged —
 * only drift from a value the template pins.
 *
 * @param {{ extends?: unknown, compilerOptions?: Record<string, unknown>, references?: { path?: unknown }[] }} tsconfig parsed tsconfig.json or tsconfig.build.json
 * @param {"tsconfig.json.tmpl" | "tsconfig.build.json.tmpl"} templateName which template's shape to check against
 * @returns {string[]}
 */
export function tsconfigShapeErrors(tsconfig, templateName) {
  const expected = expectedTsconfigShape(templateName);
  const problems = [];
  if (tsconfig.extends !== expected.extends) {
    problems.push(
      `"extends" must be ${JSON.stringify(expected.extends)} (got ${JSON.stringify(tsconfig.extends)})`,
    );
  }
  const actualOptions = tsconfig.compilerOptions ?? {};
  for (const [key, value] of Object.entries(expected.compilerOptions)) {
    const actual = actualOptions[key];
    if (JSON.stringify(actual) !== JSON.stringify(value)) {
      problems.push(
        `"compilerOptions.${key}" must be ${JSON.stringify(value)} (from ${templateName}, got ${JSON.stringify(actual)})`,
      );
    }
  }
  const actualRefPaths = (
    Array.isArray(tsconfig.references) ? tsconfig.references : []
  ).map((entry) => entry?.path);
  for (const entry of expected.references) {
    if (!actualRefPaths.includes(entry.path)) {
      problems.push(
        `"references" must include { "path": ${JSON.stringify(entry.path)} } (from ${templateName}) so tsc -b resolves the library`,
      );
    }
  }
  return problems;
}

/** The scaffold placeholder left behind when a README's Examples section is never filled in — see `templates/script/README.md.tmpl`. */
const EXAMPLES_PLACEHOLDER_RE = /<!--\s*Add[^>]*-->/;

/** An "### Examples" heading — always H3 in the fleet shape. */
const EXAMPLES_HEADING_RE = /^### Examples\s*$/m;

/** A fenced bash block invoking the script — evidence of a real, runnable example, not just prose. */
const RUNNABLE_EXAMPLE_RE = /```bash\n[^`]*node dist\/main\.js[^`]*```/;

/**
 * Validate a script README's Examples section against the fleet convention
 * (`templates/script/README.md.tmpl`): a populated `### Examples` heading, no
 * leftover scaffold placeholder, and at least one runnable
 * `node dist/main.js` invocation somewhere after that heading. Checker-only.
 * Returns human-readable problem strings (empty array = conformant).
 */
export function readmeExamplesErrors(readmeText) {
  const problems = [];
  const headingMatch = EXAMPLES_HEADING_RE.exec(readmeText);
  if (!headingMatch) {
    problems.push(
      'must have an "### Examples" heading with 2-4 runnable examples (ADR-0022 fleet convention).',
    );
    return problems;
  }
  if (EXAMPLES_PLACEHOLDER_RE.test(readmeText)) {
    problems.push(
      'still carries the scaffold placeholder comment under "### Examples" — fill in 2-4 real examples.',
    );
  }
  const afterHeading = readmeText.slice(
    headingMatch.index + headingMatch[0].length,
  );
  if (!RUNNABLE_EXAMPLE_RE.test(afterHeading)) {
    problems.push(
      '"### Examples" section has no runnable ```bash fence invoking `node dist/main.js`.',
    );
  }
  return problems;
}
