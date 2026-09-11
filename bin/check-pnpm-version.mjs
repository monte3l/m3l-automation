#!/usr/bin/env node
/**
 * Makes `package.json`'s `packageManager` field authoritative for the pnpm
 * version used in development, CI, and both consumer-image Containerfiles.
 *
 * Background: `packageManager` has never changed since the initial commit
 * (`pnpm@11.9.0`) while upstream pnpm moved on for over a year with nothing
 * noticing — Dependabot has no npm-ecosystem concept of this field
 * (dependabot-core#4830), and `bin/check-deps.mjs` never reads it. Separately,
 * the version is duplicated by hand in two Containerfiles
 * (`packages/m3l-console-web/Containerfile`,
 * `packages/m3l-console-server/Containerfile`, each
 * `RUN npm install --global pnpm@<version>`), with nothing to catch them
 * diverging from `package.json`.
 *
 * This is the deliberate SAME-SHAPE sibling of `bin/check-claude-cli-version.mjs`
 * (one gate per pin subject, not a toolchain mega-gate) rather than an
 * extension of `bin/check-node-version.mjs` — that gate's authority is
 * `.node-version` specifically, and its header already declares "two
 * responsibilities, deliberately in one gate" scoped to Node.
 *
 * Three ways to fail, mirroring the CLI-pin gate's shape:
 *   - `packageManager` itself is missing, names something other than pnpm, or
 *     pins a range/tag instead of an exact version (`pnpm@^12` re-drifts
 *     silently, which is the whole failure this gate exists to prevent);
 *   - a Containerfile's `pnpm@<version>` disagrees with the pin, is itself
 *     unpinned, or derives its version from a shell substitution (which
 *     reads as unpinned to a static scanner even though it resolves
 *     correctly at runtime);
 *   - `pnpm/action-setup` in a workflow or composite action carries an
 *     explicit `version:` input, which would silently override
 *     `packageManager` and give the pin a second, competing authority.
 *
 * A pin nothing reads is also an error (the same rule `check-claude-cli-
 * version.mjs` and ADR-0003's `.node-version` amendment both encode): if
 * every Containerfile stopped installing pnpm by hand and no workflow used
 * `pnpm/action-setup`, `packageManager` would be authoritative for nobody.
 *
 * DELIBERATE NON-GOAL: comparing the pin against pnpm's actual upstream
 * latest. That is a staleness question, not a consistency one, and belongs
 * in `bin/check-deps.mjs` (which already makes network calls and is already
 * wired into `verify-steps`) as a warn-only probe — this gate stays fully
 * offline, like its CLI-pin sibling.
 *
 * Usage:
 *   node bin/check-pnpm-version.mjs          # human-readable report
 *   node bin/check-pnpm-version.mjs --json   # structured report
 *   pnpm check:pnpm-version
 */
import process from "node:process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

export const PACKAGE_MANAGER_NAME = "pnpm";

/**
 * Parse `package.json`'s `packageManager` field into its parts. Deliberately
 * permissive at this layer — it splits the shape without judging it — so
 * callers can report *why* a field is invalid (wrong manager, a range) rather
 * than one generic "unparseable" message.
 *
 * @param {string | undefined} raw the field's raw string value
 * @returns {{ name: string, version: string, integrity: string | null } | null}
 *   null when the value has no `name@version` shape at all
 */
export function parsePackageManagerField(raw) {
  const value = (raw ?? "").trim();
  const m = /^([^\s@]+)@([^\s+]+)(?:\+(\S+))?$/.exec(value);
  if (m === null) return null;
  const [, name, version, integrity] = m;
  return { name, version, integrity: integrity ?? null };
}

/**
 * Judge an already-parsed `packageManager` field, producing the specific
 * failure reason rather than a generic rejection.
 *
 * @param {{ name: string, version: string } | null} field
 * @returns {string[]} error messages; empty when the field pins pnpm exactly
 */
export function findPackageManagerPinErrors(field) {
  if (field === null) {
    return [
      `package.json's "packageManager" field is missing or unparseable — ` +
        `it must be "${PACKAGE_MANAGER_NAME}@<x.y.z>" so pnpm can ` +
        `self-manage its own version (ADR-0001).`,
    ];
  }
  if (field.name !== PACKAGE_MANAGER_NAME) {
    return [
      `package.json's "packageManager" field names "${field.name}", not ` +
        `"${PACKAGE_MANAGER_NAME}" — ADR-0001 pins pnpm as this repo's ` +
        `package manager.`,
    ];
  }
  if (!/^\d+\.\d+\.\d+$/.test(field.version)) {
    return [
      `package.json's packageManager field must pin an exact pnpm version ` +
        `— "${PACKAGE_MANAGER_NAME}@${field.version}" is a range, and a ` +
        `range re-drifts silently.`,
    ];
  }
  return [];
}

/**
 * Find every site in a Containerfile that installs pnpm globally via npm.
 *
 * @param {string} text Containerfile source
 * @returns {Array<{ line: number, version: string | null }>} version is null
 *   when the install carries no `@<version>` at all
 */
export function scanContainerfilePnpmInstalls(text) {
  const found = [];
  (text ?? "").split("\n").forEach((line, index) => {
    const m = /npm\s+(?:install|i)\s+(?:--global|-g)\s+pnpm(?:@(\S+))?/.exec(
      line,
    );
    if (m === null) return;
    found.push({ line: index + 1, version: m[1] ?? null });
  });
  return found;
}

/**
 * Assert every Containerfile pnpm-install site agrees exactly with the pin.
 *
 * Pure over already-read Containerfile text so it is testable without a
 * filesystem.
 *
 * @param {string} pinVersion exact version from {@link parsePackageManagerField}
 * @param {Array<{ file: string, text: string }>} files
 * @returns {{ errors: string[], siteCount: number }}
 */
export function findContainerfileDrift(pinVersion, files) {
  const errors = [];
  let siteCount = 0;

  for (const { file, text } of files) {
    for (const { line, version } of scanContainerfilePnpmInstalls(text)) {
      siteCount += 1;

      if (version === null) {
        errors.push(
          `${file}:${line} installs pnpm globally without a version — pin ` +
            `it to "pnpm@${pinVersion}" to match package.json's ` +
            `packageManager.`,
        );
        continue;
      }

      // A shell substitution resolves correctly at runtime but reads as
      // unpinned to a static scanner, defeating the point of the pin — the
      // same rule check-claude-cli-version.mjs applies to its own sites.
      if (/[$`]/.test(version)) {
        errors.push(
          `${file}:${line} derives pnpm's version from a shell substitution ` +
            `(${version}) — write the literal "pnpm@${pinVersion}" so this ` +
            `gate can verify it.`,
        );
        continue;
      }

      if (version !== pinVersion) {
        errors.push(
          `${file}:${line} installs pnpm@${version} but package.json pins ` +
            `pnpm@${pinVersion} — the container would resolve the lockfile ` +
            `with a different resolver than CI. Update both together.`,
        );
      }
    }
  }

  return { errors, siteCount };
}

/**
 * Scan one workflow / composite-action file for how it uses
 * `pnpm/action-setup`: how many sites read the pin implicitly, and whether
 * any of them overrides it with an explicit `version:` input.
 *
 * Heuristic, matching `scanWorkflowNodeSetup`'s approach: walks lines after
 * a `uses: pnpm/action-setup@` step looking for a `version:` key at deeper
 * indentation, stopping at the first line that returns to the step's own
 * indentation or shallower (i.e. leaves the step's block).
 *
 * @param {string} text YAML source
 * @returns {{
 *   actionSetupCount: number,
 *   versionOverrides: Array<{ line: number, value: string }>,
 * }}
 */
export function scanWorkflowPnpmSetup(text) {
  const lines = (text ?? "").split("\n");
  let actionSetupCount = 0;
  const versionOverrides = [];

  lines.forEach((line, index) => {
    const usesMatch = /^(\s*)-\s*uses:\s*pnpm\/action-setup@/.exec(line);
    if (usesMatch === null) return;
    actionSetupCount += 1;
    const baseIndent = usesMatch[1].length;

    for (let i = index + 1; i < lines.length; i++) {
      const next = lines[i];
      if (next.trim() === "") continue;
      const indent = /^(\s*)/.exec(next)[1].length;
      if (indent <= baseIndent) break; // left this step's own block

      const versionMatch = /^\s*version:\s*(\S.*?)\s*$/.exec(next);
      if (versionMatch !== null) {
        versionOverrides.push({
          line: i + 1,
          value: versionMatch[1].replace(/^["']|["']$/g, ""),
        });
        break;
      }
    }
  });

  return { actionSetupCount, versionOverrides };
}

/**
 * Assert no `pnpm/action-setup` step overrides `packageManager` with an
 * explicit `version:` input, which would silently give the pin a second,
 * competing authority.
 *
 * @param {Array<{ file: string, text: string }>} files
 * @returns {{ errors: string[], actionSetupCount: number }}
 */
export function findWorkflowPnpmVersionDrift(files) {
  const errors = [];
  let actionSetupCount = 0;

  for (const { file, text } of files) {
    const scan = scanWorkflowPnpmSetup(text);
    actionSetupCount += scan.actionSetupCount;
    for (const { line, value } of scan.versionOverrides) {
      errors.push(
        `${file}:${line} passes an explicit version: input (${value}) to ` +
          `pnpm/action-setup, which overrides packageManager. Drop the ` +
          `input so package.json stays the single authority.`,
      );
    }
  }

  return { errors, actionSetupCount };
}

/**
 * A pin nothing reads is authoritative for nobody — the same rule
 * `check-claude-cli-version.mjs` applies and ADR-0003's `.node-version`
 * amendment caught. Counts both kinds of reader: a Containerfile's explicit
 * `pnpm@<version>` install, and any `pnpm/action-setup` step (which reads
 * `packageManager` implicitly whenever it carries no `version:` override).
 *
 * @param {string} pinVersion
 * @param {number} containerfileSiteCount
 * @param {number} actionSetupCount
 * @returns {string[]} error messages
 */
export function findUnreadPin(
  pinVersion,
  containerfileSiteCount,
  actionSetupCount,
) {
  if (containerfileSiteCount + actionSetupCount > 0) return [];
  return [
    `package.json pins pnpm@${pinVersion} but no Containerfile or workflow ` +
      `reads it — a pin nothing reads is authoritative for nobody.`,
  ];
}

/**
 * Every Containerfile this gate compares against the pin: one per immediate
 * `packages/*` directory that has one. Derived from disk rather than a
 * hardcoded two-file list — `collectWorkspaceManifests`'s same rationale
 * applies here (a plan authored against today's count drifts the moment a
 * third package adds one).
 *
 * @param {string} root repo root
 * @returns {string[]} repo-relative, POSIX-separated paths
 */
export function collectContainerfiles(root) {
  const found = [];
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return found;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = posix.join("packages", entry.name, "Containerfile");
    if (existsSync(join(root, rel))) found.push(rel);
  }
  return found.sort();
}

/**
 * Every `.github/` file that can carry a `pnpm/action-setup` step: the
 * workflow files plus each composite action's `action.yml`. Same shape as
 * `collectGithubNodeSetupFiles`.
 *
 * @param {string} root repo root
 * @returns {string[]} repo-relative, POSIX-separated paths
 */
export function collectGithubPnpmSetupFiles(root) {
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

  const rootManifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const field = parsePackageManagerField(rootManifest.packageManager);
  const pinErrors = findPackageManagerPinErrors(field);

  if (pinErrors.length > 0) {
    for (const error of pinErrors)
      reporter.error(error, { file: "package.json" });
    reporter.finish({ pinnedVersion: null });
    process.exit(1);
  }

  const pinVersion = /** @type {{ name: string, version: string }} */ (field)
    .version;

  const containerfilePaths = collectContainerfiles(root);
  const containerfiles = containerfilePaths.map((file) => ({
    file,
    text: readFileSync(join(root, file), "utf8"),
  }));
  const { errors: containerfileErrors, siteCount: containerfileSiteCount } =
    findContainerfileDrift(pinVersion, containerfiles);

  const githubPaths = collectGithubPnpmSetupFiles(root);
  const githubFiles = githubPaths.map((file) => ({
    file,
    text: readFileSync(join(root, file), "utf8"),
  }));
  const { errors: workflowErrors, actionSetupCount } =
    findWorkflowPnpmVersionDrift(githubFiles);

  const unreadErrors = findUnreadPin(
    pinVersion,
    containerfileSiteCount,
    actionSetupCount,
  );

  const errors = [...containerfileErrors, ...workflowErrors, ...unreadErrors];
  for (const error of errors) reporter.error(error);

  const extras = {
    pinnedVersion: pinVersion,
    containerfileCount: containerfiles.length,
    containerfileSiteCount,
    actionSetupCount,
  };

  if (errors.length > 0) {
    if (!json) {
      console.error(`\n✗  ${errors.length} pnpm version pin violation(s).`);
    }
    reporter.finish(extras);
    process.exit(1);
  }

  reporter.succeed(
    `package.json's packageManager (pnpm@${pinVersion}) is authoritative: ` +
      `${containerfiles.length} Containerfile(s) agree and ` +
      `${actionSetupCount} pnpm/action-setup site(s) read it with no ` +
      `override.`,
  );
  reporter.finish(extras);
}
