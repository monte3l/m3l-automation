#!/usr/bin/env node
/**
 * Makes `.node-version` authoritative for the development and CI runtime.
 *
 * Background (ADR-0003's 2026-08-31 amendment): the repo pinned Node 24 in
 * `.node-version` and declared `engines.node: ">=24"` everywhere, then
 * claimed `engine-strict=true` in `.npmrc` would "fail loudly if the wrong
 * Node version is active". That is false in the direction that actually
 * occurs — `">=24"` is a floor with no ceiling, so a machine running Node 26
 * satisfies it and `engine-strict` can never fire. Meanwhile every workflow
 * hardcoded `node-version: 24` rather than reading the file, so
 * `.node-version` was authoritative for nobody. The concrete cost was a
 * false test failure: `m3l-console-server`'s `readBigInts` case fails on
 * Node 26 and is green in CI on 24.
 *
 * Two responsibilities, deliberately in one gate:
 *
 *   1. STATIC pin-drift (the part with CI value, and the part that exits
 *      non-zero). A Node bump means hand-editing `.node-version`, 22
 *      `engines` fields, 4 workflows and a composite action; nothing
 *      previously detected a straggler. This asserts every `engines.node`
 *      floor agrees with `.node-version`, and that every `actions/setup-node`
 *      step sources its version from `node-version-file: .node-version`
 *      rather than a literal.
 *   2. RUNTIME (the local-developer half, WARN-only). Compares
 *      `process.versions.node`'s major against the pin. Passes trivially in
 *      CI — a runner provisions from the file this gate just validated — so
 *      it is a warning, not an error: a developer mid-session on the wrong
 *      Node should see the advisory (`.claude/hooks/warn-node-version.mjs`
 *      renders it at SessionStart), not have `pnpm verify` refuse to run.
 *
 * DELIBERATE NON-GOAL: narrowing `engines.node`. That field is the
 * *consumer* contract and stays `">=24"` — a consumer running the library on
 * Node 26 is fine and should stay fine. What this gate pins exactly is the
 * development/CI runtime. See ADR-0003's amendment.
 *
 * Why a literal `node-version:` is an ERROR and not a warning: after the PR
 * that introduced this gate there are zero literals left in `.github/`, so
 * erroring is what stops one from creeping back in — a warning would let the
 * five sites silently re-drift, which is the exact failure this gate exists
 * to prevent.
 *
 * Usage:
 *   node bin/check-node-version.mjs          # human-readable report
 *   node bin/check-node-version.mjs --json   # structured report
 *   pnpm check:node-version
 */
import process from "node:process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const NODE_VERSION_FILE = ".node-version";

/**
 * Parse a `.node-version` file's contents into a major version. Tolerates
 * the formats the file family actually uses across version managers — a bare
 * major (`24`), a full version (`24.13.3`), and a `v` prefix (`v24`) — and
 * rejects the aliases (`lts/*`, `node`) that name no concrete major, since a
 * floating alias cannot be compared against an `engines` floor.
 *
 * @param {string} text raw file contents
 * @returns {{ major: number, raw: string } | null} null when unparseable
 */
export function parseNodeVersionFile(text) {
  const raw = (text ?? "").trim();
  const m = /^v?(\d+)(?:\.\d+)*$/.exec(raw);
  if (m === null) return null;
  return { major: Number(m[1]), raw };
}

/**
 * Extract the floor major from an `engines.node` semver range. Only the
 * `>=`-style floor this repo uses is recognised; anything else returns null
 * and is reported as unparseable rather than silently treated as agreeing.
 *
 * @param {string | undefined} range e.g. `">=24"`, `">=24.0.0"`
 * @returns {number | null}
 */
export function parseEnginesFloorMajor(range) {
  const m = /^\s*>=\s*v?(\d+)(?:\.\d+)*\s*$/.exec(range ?? "");
  return m === null ? null : Number(m[1]);
}

/**
 * Compare every workspace manifest's `engines.node` floor against the
 * `.node-version` pin. A floor that names a different major than the pin is
 * the "half-finished Node bump" this gate exists to catch.
 *
 * Pure over already-read manifests so it is testable without a filesystem.
 *
 * @param {number} pinMajor major from {@link parseNodeVersionFile}
 * @param {Array<{ file: string, engines: { node?: string } | undefined }>} manifests
 * @returns {string[]} error messages
 */
export function findEnginesDrift(pinMajor, manifests) {
  const errors = [];
  for (const { file, engines } of manifests) {
    const range = engines?.node;
    if (range === undefined) {
      errors.push(
        `${file} declares no "engines.node" — every workspace manifest must ` +
          `declare the consumer floor (">=${pinMajor}").`,
      );
      continue;
    }
    const floor = parseEnginesFloorMajor(range);
    if (floor === null) {
      errors.push(
        `${file}'s "engines.node" is ${JSON.stringify(range)}, which this ` +
          `gate cannot compare against ${NODE_VERSION_FILE} — use a ` +
          `">=<major>" floor.`,
      );
      continue;
    }
    if (floor !== pinMajor) {
      errors.push(
        `${file}'s "engines.node" floor is Node ${floor} but ` +
          `${NODE_VERSION_FILE} pins ${pinMajor} — a Node bump left this ` +
          `manifest behind. Update both together.`,
      );
    }
  }
  return errors;
}

/**
 * Scan one workflow / composite-action file for how it provisions Node.
 *
 * @param {string} text YAML source
 * @returns {{
 *   setupNodeCount: number,
 *   literals: Array<{ line: number, value: string }>,
 *   versionFiles: Array<{ line: number, value: string }>,
 * }}
 */
export function scanWorkflowNodeSetup(text) {
  const lines = (text ?? "").split("\n");
  let setupNodeCount = 0;
  const literals = [];
  const versionFiles = [];

  lines.forEach((line, index) => {
    if (/^\s*(?:-\s*)?uses:\s*actions\/setup-node@/.test(line)) {
      setupNodeCount += 1;
      return;
    }
    const literal = /^\s*node-version:\s*(\S.*?)\s*$/.exec(line);
    if (literal !== null) {
      literals.push({ line: index + 1, value: literal[1] });
      return;
    }
    const versionFile = /^\s*node-version-file:\s*(\S.*?)\s*$/.exec(line);
    if (versionFile !== null) {
      versionFiles.push({
        line: index + 1,
        value: versionFile[1].replace(/^["']|["']$/g, ""),
      });
    }
  });

  return { setupNodeCount, literals, versionFiles };
}

/**
 * Assert every Node-provisioning site in `.github/` reads `.node-version`.
 *
 * Three ways to fail, each a real regression path:
 *   - a literal `node-version:` (the pre-amendment state — five sites of it),
 *   - a `node-version-file:` aimed at some other file,
 *   - an `actions/setup-node` step with neither, which silently inherits the
 *     runner's default Node instead of the pin.
 *
 * @param {Array<{ file: string, text: string }>} files
 * @returns {string[]} error messages
 */
export function findWorkflowNodeVersionDrift(files) {
  const errors = [];
  for (const { file, text } of files) {
    const { setupNodeCount, literals, versionFiles } =
      scanWorkflowNodeSetup(text);

    for (const { line, value } of literals) {
      errors.push(
        `${file}:${line} hardcodes "node-version: ${value}" — use ` +
          `"node-version-file: ${NODE_VERSION_FILE}" so the pin has exactly ` +
          `one authority.`,
      );
    }
    for (const { line, value } of versionFiles) {
      if (value !== NODE_VERSION_FILE) {
        errors.push(
          `${file}:${line} reads "node-version-file: ${value}" — it must be ` +
            `${NODE_VERSION_FILE}.`,
        );
      }
    }
    if (setupNodeCount > 0 && literals.length + versionFiles.length === 0) {
      errors.push(
        `${file} uses actions/setup-node but declares neither ` +
          `"node-version" nor "node-version-file" — it silently inherits the ` +
          `runner's default Node instead of ${NODE_VERSION_FILE}.`,
      );
    }
  }
  return errors;
}

/**
 * The third authority `.node-version` has to hold: `@types/node`'s major.
 *
 * Why this belongs in this gate rather than only in `.github/dependabot.yml`:
 * a Dependabot `ignore` rule suppresses a *proposal*, it does not enforce a
 * *state*. A `pnpm up`, a hand edit, or a mis-scoped ignore condition can all
 * drift `@types/node` off the pinned line with nothing failing. This assertion
 * runs in `ci.yml`'s `gates` lane, which deliberately carries no step-level
 * path gating, so it fires on every PR — including Dependabot's own.
 *
 * What it protects: `typecheck` is only evidence that the code compiles
 * against the Node API surface `@types/node` describes. With the pin at 24 and
 * the types at 26, a green `typecheck` proved the code runs on Node 26 while
 * claiming a floor of 24 — it could use a Node-26-only API and nothing would
 * object. (It did: a `setInterval` overload in a console-server test.)
 *
 * Deliberately compares the MAJOR only. DefinitelyTyped ships frequent 24.x
 * releases as it backports Node 24 additions, and `.node-version` names a bare
 * major, so pinning the minor here would fight both.
 *
 * @param {number} pinMajor major from {@link parseNodeVersionFile}
 * @param {string | undefined} typesNodeRange the declared `@types/node` version
 * @param {string} [manifestRel] repo-relative manifest path, for the message
 * @returns {string[]} error messages
 */
export function findTypesNodeDrift(
  pinMajor,
  typesNodeRange,
  manifestRel = "package.json",
) {
  if (typesNodeRange === undefined) return [];
  const m = /^\s*[\^~]?v?(\d+)(?:\.\d+)*\s*$/.exec(typesNodeRange);
  if (m === null) {
    return [
      `${manifestRel}'s "@types/node" is ${JSON.stringify(typesNodeRange)}, ` +
        `which this gate cannot compare against ${NODE_VERSION_FILE} — use a ` +
        `concrete version so the typed API surface is pinned to the floor.`,
    ];
  }
  const typesMajor = Number(m[1]);
  if (typesMajor === pinMajor) return [];
  return [
    `${manifestRel} declares "@types/node": ${JSON.stringify(typesNodeRange)} ` +
      `(major ${typesMajor}) but ${NODE_VERSION_FILE} pins ${pinMajor} — ` +
      `typecheck would run against Node ${typesMajor}'s API surface while the ` +
      `declared floor is ${pinMajor}, so a green typecheck would not prove the ` +
      `code runs on the floor. Pin @types/node to the ${pinMajor}.x line.`,
  ];
}

/**
 * The local-developer half: is the Node actually executing this process the
 * pinned major? Warn-only by design (see the file header).
 *
 * @param {number} pinMajor
 * @param {string} runtimeVersion `process.versions.node`, e.g. "26.8.1"
 * @returns {string[]} warning messages
 */
export function evaluateRuntimeVersion(pinMajor, runtimeVersion) {
  const runtimeMajor = Number.parseInt(runtimeVersion, 10);
  if (!Number.isFinite(runtimeMajor) || runtimeMajor === pinMajor) return [];
  return [
    `Running Node ${runtimeVersion} but ${NODE_VERSION_FILE} pins ` +
      `${pinMajor}. CI runs ${pinMajor}, so a local-only failure here may be ` +
      `a version artifact rather than a real regression (the ` +
      `m3l-console-server readBigInts case is exactly that). Fix with ` +
      `\`fnm use ${pinMajor}\` — or \`fnm install ${pinMajor}\` plus ` +
      `\`eval "$(fnm env --use-on-cd --shell zsh)"\` in your shell rc for ` +
      `per-directory switching. See ADR-0003.`,
  ];
}

/**
 * Every workspace manifest whose `engines.node` this gate compares: the root
 * plus each immediate `packages/*` and `scripts/*` directory that has a
 * `package.json`. Derived from disk rather than a hardcoded list or count —
 * the plan behind this gate was authored against "16 scripts" when there
 * were already 17, which is precisely the drift a derived list avoids.
 *
 * @param {string} root repo root
 * @returns {string[]} repo-relative, POSIX-separated manifest paths
 */
export function collectWorkspaceManifests(root) {
  const found = ["package.json"];
  for (const group of ["packages", "scripts"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = posix.join(group, entry.name, "package.json");
      if (existsSync(join(root, rel))) found.push(rel);
    }
  }
  return found.sort();
}

/**
 * Every `.github/` file that can provision Node: the workflow files plus each
 * composite action's `action.yml`.
 *
 * @param {string} root repo root
 * @returns {string[]} repo-relative, POSIX-separated paths
 */
export function collectGithubNodeSetupFiles(root) {
  const found = [];

  const workflowsDir = join(root, ".github/workflows");
  if (existsSync(workflowsDir)) {
    for (const name of readdirSync(workflowsDir)) {
      if (/\.ya?ml$/.test(name)) {
        found.push(posix.join(".github/workflows", name));
      }
    }
  }

  const actionsDir = join(root, ".github/actions");
  if (existsSync(actionsDir)) {
    for (const entry of readdirSync(actionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const candidate of ["action.yml", "action.yaml"]) {
        const rel = posix.join(".github/actions", entry.name, candidate);
        if (existsSync(join(root, rel))) found.push(rel);
      }
    }
  }

  return found.sort();
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = repoRoot(import.meta.url);
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const pinPath = join(root, NODE_VERSION_FILE);
  const pin = existsSync(pinPath)
    ? parseNodeVersionFile(readFileSync(pinPath, "utf8"))
    : null;

  if (pin === null) {
    reporter.error(
      existsSync(pinPath)
        ? `${NODE_VERSION_FILE} does not name a concrete version — it must be ` +
            `a major (\`24\`) or a full version (\`24.13.3\`), not a floating ` +
            `alias like \`lts/*\`.`
        : `${NODE_VERSION_FILE} is missing — it is the single authority for ` +
            `the development and CI Node runtime (ADR-0003).`,
      { file: NODE_VERSION_FILE },
    );
    reporter.finish({ pinMajor: null, runtimeMajor: null });
    process.exit(1);
  }

  const manifestPaths = collectWorkspaceManifests(root);
  const manifests = manifestPaths.map((file) => ({
    file,
    engines: JSON.parse(readFileSync(join(root, file), "utf8")).engines,
  }));

  const workflowPaths = collectGithubNodeSetupFiles(root);
  const workflows = workflowPaths.map((file) => ({
    file,
    text: readFileSync(join(root, file), "utf8"),
  }));

  const rootManifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const typesNodeRange =
    rootManifest.devDependencies?.["@types/node"] ??
    rootManifest.dependencies?.["@types/node"];

  const errors = [
    ...findEnginesDrift(pin.major, manifests),
    ...findWorkflowNodeVersionDrift(workflows),
    ...findTypesNodeDrift(pin.major, typesNodeRange),
  ];
  const warnings = evaluateRuntimeVersion(pin.major, process.versions.node);

  for (const warning of warnings) reporter.warn(warning);
  for (const error of errors) reporter.error(error);

  const extras = {
    pinMajor: pin.major,
    pinRaw: pin.raw,
    runtimeVersion: process.versions.node,
    runtimeMajor: Number.parseInt(process.versions.node, 10),
    manifestCount: manifests.length,
    workflowCount: workflows.length,
    typesNodeRange: typesNodeRange ?? null,
  };

  if (errors.length > 0) {
    if (!json) {
      console.error(`\n✗  ${errors.length} Node version pin violation(s).`);
    }
    reporter.finish(extras);
    process.exit(1);
  }

  reporter.succeed(
    `${NODE_VERSION_FILE} (Node ${pin.raw}) is authoritative: ` +
      `${manifests.length} manifest floor(s) agree, ` +
      `${workflows.length} .github file(s) source the version from it, and ` +
      `@types/node (${typesNodeRange ?? "undeclared"}) tracks the pinned major.`,
  );
  reporter.finish(extras);
  // Runtime mismatch is warn-only: exit 0. See file header.
}
