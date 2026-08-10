// The single source of truth for the consumer-script scaffold shape
// (ADR-0022 fleet conventions). Both the generator (bin/scaffold-script.mjs)
// and the conformance checker (bin/check-script-scaffold.mjs) consume this
// manifest, so the two cannot drift apart: a file added here is emitted by
// the generator AND required by the checker in the same change.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./reference-index.mjs";

/** Kebab-case script names only: `data-sync`, `report-builder`, `probe`. */
export const SCRIPT_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * ADR-0028: known-bad abbreviated AWS service tokens. A name whose FIRST
 * hyphen-segment is one of these keys is rejected. This is a denylist, not a
 * service-name allowlist — no canonical vocabulary of "every valid AWS
 * service name" exists yet, nor any structural signal marking a script
 * "AWS-scoped" versus not (see ADR-0028's scope-definition note), so an
 * allowlist can't be built without inventing both. A denylist sidesteps that:
 * it applies uniformly to every name, so a non-AWS name (`json-etl`) is
 * simply never on the list.
 */
export const BANNED_LEADING_SEGMENTS = new Map([
  ["dynamo", "dynamodb"],
  ["cfn", "cloudformation"],
  ["apigw", "api-gateway"],
]);

/**
 * ADR-0028: bare AWS capability names that omit their owning service.
 * Checked as an exact whole-name match (the missing piece is a leading
 * prefix, not a segment substitution, so a leading-segment check can't
 * catch it).
 */
export const BANNED_EXACT_NAMES = new Map([
  ["logs-insights", "cloudwatch-logs-insights"],
]);

/**
 * Validate a script name against the ADR-0028 full-service-name convention.
 * Returns human-readable problem strings (empty array = compliant).
 */
export function serviceNameErrors(name) {
  const problems = [];
  const leadingSegment = name.split("-")[0];
  const abbrevTarget = BANNED_LEADING_SEGMENTS.get(leadingSegment);
  if (abbrevTarget) {
    problems.push(
      `"${name}" abbreviates the AWS service name (uses "${leadingSegment}") — ADR-0028 requires the full official service name ("${abbrevTarget}") as the leading segment.`,
    );
  }
  const exactTarget = BANNED_EXACT_NAMES.get(name);
  if (exactTarget) {
    problems.push(
      `"${name}" names an AWS capability without its owning service — ADR-0028 requires "${exactTarget}".`,
    );
  }
  return problems;
}

/** Longest purpose accepted — one terse sentence, not a paragraph. */
export const PURPOSE_MAX_LENGTH = 200;

/**
 * Validate a --purpose value before substitution. The purpose is injected
 * verbatim into a JSON string (package.json "description"), TS doc comments,
 * and markdown — so characters that terminate or escape those contexts are
 * rejected up front rather than escaped per-context: a double quote or
 * backslash breaks the JSON string, and star/slash can form the two-char
 * comment terminator, which would end the doc comment early and let a
 * "purpose" inject live code into the emitted module (this very comment
 * cannot spell the sequence out — that is the bug).
 * Returns human-readable problem strings (empty array = valid).
 */
export function purposeErrors(purpose) {
  const problems = [];
  if (typeof purpose !== "string" || purpose.trim() === "") {
    return ["purpose must be a non-empty string"];
  }
  if (purpose.length > PURPOSE_MAX_LENGTH) {
    problems.push(
      `purpose must be at most ${PURPOSE_MAX_LENGTH} characters (got ${purpose.length})`,
    );
  }
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\u0000-\u001f\u007f]/u.test(purpose)) {
    problems.push("purpose must not contain newlines or control characters");
  }
  for (const [char, why] of [
    ['"', "it terminates the package.json description string"],
    ["\\", "it escapes inside the package.json description string"],
    ["*", "it can terminate the doc comment the purpose is emitted into"],
    ["/", "it can terminate the doc comment the purpose is emitted into"],
  ]) {
    if (purpose.includes(char)) {
      problems.push(
        `purpose must not contain ${JSON.stringify(char)} — ${why}`,
      );
    }
  }
  return problems;
}

/** Directory (repo-relative) holding the *.tmpl sources. */
export const TEMPLATE_DIR = "templates/script";

/** Directory (repo-relative) holding one contract page per script. */
export const SCRIPT_DOCS_DIR = "docs/reference/scripts";

/** `data-sync` → `DataSync` (for generated identifiers like `runDataSync`). */
export function pascalCase(name) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * The substitution map applied to template content AND target paths.
 * Every `__TOKEN__` used by any file under templates/script/ must be here.
 */
export function scriptTokens(name, purpose) {
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
 * Replace every known token in `text`, then assert none survive. A
 * surviving `__TOKEN__`-shaped span after every known substitution means a
 * template uses a token this manifest's map doesn't know about — a typo, or
 * `scriptTokens()` wasn't updated for a new template. Throwing here (rather
 * than letting it ship into generated source silently) is what makes the
 * scaffolder's atomic rollback (bin/scaffold-script.mjs's try/catch) useful
 * for this failure mode: the half-written package gets removed instead of
 * shipping a literal `__TOKEN__` string a user only discovers later as a
 * `tsc` error in a file they never wrote.
 */
export function substituteTokens(text, tokens) {
  let result = text;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.replaceAll(token, value);
  }
  const leftover = UNREPLACED_TOKEN_RE.exec(result);
  if (leftover) {
    throw new Error(
      `substituteTokens: unreplaced token "${leftover[0]}" survived substitution — add it to scriptTokens() in bin/lib/script-scaffold.mjs.`,
    );
  }
  return result;
}

/**
 * Template → target pairs emitted inside `scripts/<name>/`. Targets may carry
 * tokens (resolved with the same map as the content).
 */
export const PACKAGE_TEMPLATE_FILES = [
  { template: "package.json.tmpl", target: "package.json" },
  { template: "tsconfig.json.tmpl", target: "tsconfig.json" },
  { template: "tsconfig.build.json.tmpl", target: "tsconfig.build.json" },
  { template: "src/main.ts.tmpl", target: "src/main.ts" },
  { template: "src/config.ts.tmpl", target: "src/config.ts" },
  { template: "src/hooks.ts.tmpl", target: "src/hooks.ts" },
  {
    template: "src/steps/run-__SCRIPT_NAME__.ts.tmpl",
    target: "src/steps/run-__SCRIPT_NAME__.ts",
  },
  { template: "tests/config.test.ts.tmpl", target: "tests/config.test.ts" },
  { template: "README.md.tmpl", target: "README.md" },
];

/** The contract page emitted outside the package dir. */
export const DOC_PAGE_TEMPLATE = "docs-page.md.tmpl";

/** Repo-relative path of a script's contract page. */
export function docPagePath(name) {
  return `${SCRIPT_DOCS_DIR}/${name}.md`;
}

/**
 * Files the checker requires by exact path inside `scripts/<name>/`.
 * (The starter step and smoke test are required via REQUIRED_GLOBS instead,
 * so a script may rename/extend them without a false positive.)
 */
export const REQUIRED_EXACT_FILES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "src/main.ts",
  "src/config.ts",
  "src/hooks.ts",
  "README.md",
];

/**
 * Directory/suffix pairs of which at least one match must exist:
 * business logic lives in steps modules, and ADR-0022 §8 mandates at least a
 * config-declaration smoke test.
 *
 * The scan is deliberately SHALLOW (one level): flat `src/steps/` and
 * `tests/` directories are part of the ratified fleet shape — the ESLint
 * design rules already cap module size, so growth means more flat step
 * modules, not nesting. A conformant file one level deeper does not count;
 * to allow nesting, change this manifest (and the ADR) — not the checker.
 */
export const REQUIRED_GLOBS = [
  { dir: "src/steps", suffix: ".ts", what: "a steps/ module" },
  { dir: "tests", suffix: ".test.ts", what: "the config smoke test" },
];

/** The root tsconfig `references` entry a script package must have. */
export function rootTsconfigRef(name) {
  return `./scripts/${name}/tsconfig.build.json`;
}

/**
 * Validate a script's package.json against the ADR-0022 package contract.
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
 * discipline the rest of this module already follows (one source, generator
 * and checker both read it), applied to a field this manifest previously
 * only checked for presence. Reads lazily (per call, not at module load) so
 * this module carries no import-time fs side effect.
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
 * Read tsconfig.json.tmpl / tsconfig.build.json.tmpl's `extends` and
 * `references` shape directly from the template — neither template
 * substitutes any token, so their committed text IS every scaffolded
 * script's expected value verbatim. Reads lazily, matching
 * {@link expectedPackageScripts}.
 *
 * @param {"tsconfig.json.tmpl" | "tsconfig.build.json.tmpl"} templateName
 * @returns {{ extends: unknown, references: { path?: unknown }[] }}
 */
function expectedTsconfigShape(templateName) {
  const parsed = JSON.parse(
    readFileSync(join(root, TEMPLATE_DIR, templateName), "utf8"),
  );
  return { extends: parsed.extends, references: parsed.references ?? [] };
}

/**
 * Validate a scaffolded script's tsconfig.json or tsconfig.build.json against
 * the invariants the matching template encodes: `extends` the base config,
 * and a project `references` entry back to m3l-common (so `tsc -b` and
 * editor tooling resolve `@m3l-automation/m3l-common`'s types). Previously
 * only file EXISTENCE was checked (`REQUIRED_EXACT_FILES`), so a script whose
 * tsconfig lost `extends` or its m3l-common reference passed silently.
 * Returns human-readable problem strings (empty array = conformant).
 *
 * @param {{ extends?: unknown, references?: { path?: unknown }[] }} tsconfig parsed tsconfig.json or tsconfig.build.json
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
 * `node dist/main.js` invocation somewhere after that heading. "Somewhere
 * after" (not "immediately inside") is deliberate: the fleet shape puts the
 * fence directly under the heading, but `json-etl`'s teaching-oriented layout
 * puts its worked examples under numbered sibling headings instead — both
 * satisfy this check without an allowlist. Content only, not example count or
 * the Minimal/Common/Production/Edge-case labels — those stay reviewer-judged.
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

/**
 * Directory names under `scripts/` that contain a package.json — the set of
 * script packages the checker validates. Artifact-only ghosts (a leftover
 * dist/ with no manifest) are ignored.
 */
export function scriptPackageDirs(repoRoot) {
  const scriptsDir = join(repoRoot, "scripts");
  if (!existsSync(scriptsDir)) {
    return [];
  }
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(scriptsDir, name, "package.json")));
}
