// Derives which bin/**/*.mjs scripts transitively require
// packages/m3l-cli/dist to be built, then finds every GitHub Actions
// workflow step that invokes one of those scripts with no prior step in the
// same job building @m3l-automation/m3l-cli. This is the gate that would
// have caught the Pages break at authoring time instead of on the next push
// to main: bin/gen-project-hub.mjs reached into an unbuilt CLI dist via
// bin/lib/script-scaffold.mjs's top-level dynamic import (ADR-0053 U9),
// pages.yml never ran a build, and the hand-written comment in ci.yml
// enumerating "the four consumers" that need the CLI built was already
// stale — it never named gen-project-hub.mjs at all. A derived cone,
// re-walked on every run, cannot go stale that way.
//
// Deliberately regex-based (no YAML dependency), matching the style of
// bin/lib/verify-steps.mjs / bin/check-workflows-doc.mjs.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const IMPORT_SPECIFIER_RE = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
const CLI_DIST_MARKER = "packages/m3l-cli/dist";

/**
 * Repo-relative paths of every `bin/**\/*.mjs` script, excluding
 * `bin/tests/**` (test files, never invoked directly by a workflow step).
 *
 * @param {string} root
 * @returns {string[]}
 */
function listBinScripts(root) {
  const binDir = join(root, "bin");
  const results = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (rel === "bin/tests") continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        results.push(rel);
      }
    }
  };
  walk(binDir);
  return results;
}

/**
 * Every module-specifier string a static `import ... from "..."` or a
 * dynamic `import(...)` names in `source`. Deliberately over-approximates: a
 * conditionally-reached dynamic import (e.g. inside a try/catch) is treated
 * the same as an unconditional one, since "this script MIGHT need the CLI
 * built" is always safe workflow-ordering advice — only under-approximating
 * (missing a real dependency) would be a problem.
 *
 * @param {string} source
 * @returns {string[]}
 */
function extractImportSpecifiers(source) {
  return [...source.matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[1]);
}

/**
 * The set of `bin/**\/*.mjs` scripts that, directly or transitively through
 * another `bin/lib/*.mjs` import, reach into `packages/m3l-cli/dist` — i.e.
 * scripts that throw (raw `ERR_MODULE_NOT_FOUND` or a wrapped equivalent)
 * unless `@m3l-automation/m3l-cli` is built first.
 *
 * @param {string} root repo root (absolute path)
 * @returns {Set<string>} repo-relative `bin/**\/*.mjs` paths
 */
export function resolveCliDistCone(root) {
  const files = listBinScripts(root);
  const localImports = new Map();
  const directHit = new Set();

  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const deps = [];
    for (const spec of extractImportSpecifiers(source)) {
      if (spec.includes(CLI_DIST_MARKER)) {
        directHit.add(file);
        continue;
      }
      if (spec.startsWith(".")) {
        const resolved = relative(
          root,
          resolve(dirname(join(root, file)), spec),
        ).replace(/\\/g, "/");
        deps.push(resolved);
      }
    }
    localImports.set(file, deps);
  }

  const inCone = new Set();
  const resolving = new Set();
  function isInCone(file) {
    if (inCone.has(file)) return true;
    if (resolving.has(file)) return false; // cycle guard
    if (directHit.has(file)) {
      inCone.add(file);
      return true;
    }
    resolving.add(file);
    const deps = localImports.get(file) ?? [];
    const hit = deps.some((dep) => isInCone(dep));
    resolving.delete(file);
    if (hit) inCone.add(file);
    return hit;
  }
  for (const file of files) isInCone(file);
  return inCone;
}

/**
 * @typedef {Object} WorkflowStep
 * @property {string} [name]
 * @property {string} run - raw `run:` body (single-line or block scalar);
 *   empty string for a `uses:`-only step (checkout, a composite action).
 */

/**
 * Parse every job's ordered steps (name + `run:` body) from a GitHub
 * Actions workflow YAML. Regex-based, matching `bin/lib/verify-steps.mjs`'s
 * job-boundary technique (2-space job names directly under `jobs:`; every
 * job's own body — `runs-on:`, `steps:`, and everything nested under them —
 * sits at 4-space indent or deeper, so this cannot false-positive on
 * job-body content). Step boundaries are 6-space `- name:`/`- uses:` lines;
 * a `run:` field sits at 8-space indent within a step.
 *
 * @param {string} workflowText
 * @returns {Map<string, WorkflowStep[]>} job id -> ordered steps
 */
export function parseWorkflowJobSteps(workflowText) {
  const jobsMatch = /\njobs:\n([\s\S]*)$/.exec(`\n${workflowText}`);
  if (!jobsMatch) return new Map();
  const jobsSection = jobsMatch[1];

  const jobBoundaries = [...jobsSection.matchAll(/^ {2}([\w-]+):\n/gm)];
  const result = new Map();

  for (const [index, boundary] of jobBoundaries.entries()) {
    const jobName = boundary[1];
    const start = boundary.index + boundary[0].length;
    const end = jobBoundaries[index + 1]?.index ?? jobsSection.length;
    const jobBody = jobsSection.slice(start, end);

    const stepBoundaries = [
      ...jobBody.matchAll(/^ {6}- (?:name:\s*(.+?)\s*$|uses:)/gm),
    ];
    const steps = [];
    for (const [sIndex, sBoundary] of stepBoundaries.entries()) {
      const sStart = sBoundary.index;
      const sEnd = stepBoundaries[sIndex + 1]?.index ?? jobBody.length;
      const stepText = jobBody.slice(sStart, sEnd);
      const name = sBoundary[1];

      const blockRunMatch = /^ {8}run:\s*[|>][+-]?\s*\n((?: {8,}.*\n?)*)/m.exec(
        stepText,
      );
      const singleLineRunMatch = /^ {8}run:\s*(.+?)\s*$/m.exec(stepText);
      const run = blockRunMatch?.[1] ?? singleLineRunMatch?.[1] ?? "";

      steps.push({ name, run });
    }
    result.set(jobName, steps);
  }
  return result;
}

const CLI_PACKAGE_NAME = "@m3l-automation/m3l-cli";

/** Does this step's `run:` body build `@m3l-automation/m3l-cli`? */
function stepBuildsCli(runText) {
  if (/\bpnpm\s+build\b/.test(runText)) return true; // unscoped: builds every package

  const turboMatch = /\bturbo\s+run\s+build\b(.*)$/m.exec(runText);
  if (turboMatch) {
    const filterMatch = /--filter[= ]([^\s]+)/.exec(turboMatch[1]);
    if (!filterMatch) return true; // unscoped turbo build: builds everything
    if (filterMatch[1] === CLI_PACKAGE_NAME) return true;
  }

  // `pnpm --filter <pkg> build` / `pnpm --filter=<pkg> build`: pnpm's own
  // workspace-filter syntax, distinct from turbo's `--filter`.
  const pnpmFilterMatch = /\bpnpm\s+--filter[= ]([^\s]+)\s+build\b/.exec(
    runText,
  );
  if (pnpmFilterMatch && pnpmFilterMatch[1] === CLI_PACKAGE_NAME) return true;

  return false;
}

/**
 * Does this step's `run:` body invoke a script in `cliDistCone`, either
 * directly (`node bin/<x>.mjs`) or via a `pnpm <script>` alias that
 * `package.json`'s `scripts` map resolves to one?
 *
 * @param {string} runText
 * @param {Set<string>} cliDistCone
 * @param {Record<string, string>} packageScripts
 * @returns {string | undefined} the in-cone `bin/**\/*.mjs` path, if any
 */
function stepInvokesConeScript(runText, cliDistCone, packageScripts) {
  const nodeMatch = /\bnode\s+(bin\/[\w./-]+\.mjs)\b/.exec(runText);
  if (nodeMatch && cliDistCone.has(nodeMatch[1])) return nodeMatch[1];

  const pnpmMatch = /\bpnpm\s+([\w:.-]+)\b/.exec(runText);
  if (pnpmMatch) {
    const scriptCmd = packageScripts[pnpmMatch[1]];
    const scriptNodeMatch =
      scriptCmd && /^node\s+(bin\/[\w./-]+\.mjs)\b/.exec(scriptCmd);
    if (scriptNodeMatch && cliDistCone.has(scriptNodeMatch[1])) {
      return scriptNodeMatch[1];
    }
  }
  return undefined;
}

/**
 * @typedef {Object} BuildOrderViolation
 * @property {string} workflow - repo-relative workflow file path
 * @property {string} job - the job id
 * @property {string} step - the step's `name:`, or "(unnamed step)"
 * @property {string} script - the in-cone `bin/**\/*.mjs` path invoked
 */

/**
 * Every step, across one workflow's jobs, that invokes an in-cone script
 * with no earlier step in the SAME job building `@m3l-automation/m3l-cli`.
 *
 * KNOWN LIMITATION: ordering is checked between steps, not within one. A
 * single `run:` block that both builds the CLI and invokes an in-cone
 * script (e.g. a multi-line shell script that invokes the script first,
 * then builds) is treated as "this step builds the CLI" and never checked
 * for that same-step ordering mistake — `stepBuildsCli` matches anywhere in
 * the step's text regardless of position. Not a concern for any workflow in
 * this repo today (every build step and every cone-script-invoking step is
 * its own separate step), but a future workflow that combines both into one
 * shell block would not be caught here.
 *
 * @param {string} workflowPath repo-relative path (for error messages)
 * @param {string} workflowText
 * @param {Set<string>} cliDistCone
 * @param {Record<string, string>} packageScripts
 * @returns {BuildOrderViolation[]}
 */
export function findBuildOrderViolations(
  workflowPath,
  workflowText,
  cliDistCone,
  packageScripts,
) {
  const jobs = parseWorkflowJobSteps(workflowText);
  const violations = [];

  for (const [jobName, steps] of jobs) {
    let builtCli = false;
    for (const step of steps) {
      if (!step.run) continue;
      if (stepBuildsCli(step.run)) {
        builtCli = true;
        continue;
      }
      const conflictingScript = stepInvokesConeScript(
        step.run,
        cliDistCone,
        packageScripts,
      );
      if (conflictingScript && !builtCli) {
        violations.push({
          workflow: workflowPath,
          job: jobName,
          step: step.name ?? "(unnamed step)",
          script: conflictingScript,
        });
      }
    }
  }
  return violations;
}
