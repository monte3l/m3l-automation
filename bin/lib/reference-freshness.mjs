// Pure derivation for `bin/check-reference-freshness.mjs` (ADR-0093's
// freshness gate for Context7-sourced skill reference snapshots). Nothing
// here reads a filesystem — the CLI wrapper collects
// `.claude/skills/*/references/*.md` file contents and every workspace
// `package.json`, and hands them to `deriveReferenceFreshnessIssues`,
// mirroring `bin/lib/integration-stance.mjs`'s derivation/CLI split so this
// stays exercisable in tests without spawning anything.
//
// What it guards against:
//   1. A Context7-sourced snapshot (its `> **Provenance**` block reads
//      "Source: Context7 …") with no machine-readable freshness stamp — the
//      thing that stops the *next* snapshot from being added unstamped.
//   2. A stamp whose `tracks=` package has drifted past the policy the
//      snapshot itself declares (`refresh=major` fails on a major bump,
//      `refresh=minor` fails on a major or minor bump) — patch-only drift
//      never fails, regardless of policy, matching each block's own
//      "stable across patch/minor" prose.
//   3. The retired `` `ctx7 skills generate` `` instruction (or any other
//      backticked `` `ctx7 <verb>` `` CLI reference) reappearing now that the
//      `ctx7` CLI is uninstalled.
//
// A tracked package absent from every manifest, or drifted below the
// declared policy's fail threshold, is reported as a warning (informational
// drift, not a gate failure) — never a `retiredClaims`/`staleTracked` entry.

const STAMP_PATTERN = /<!--\s*reference-freshness:\s*(.*?)-->/;
const RETIRED_CLI_PATTERN = /`ctx7 [a-z][a-z-]*(?: [a-z][a-z-]*)*`/i;

/**
 * Whether a reference file's content carries a "Source: Context7" provenance
 * line — the same test {@link deriveReferenceFreshnessIssues} uses to decide
 * a file is in scope. Exported so the CLI wrapper can report an accurate
 * Context7-sourced count without duplicating the pattern.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isContext7Sourced(content) {
  return /Source:\s*Context7/i.test(content);
}

/**
 * @typedef {{ path: string, content: string }} ReferenceFile
 * @typedef {{
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>,
 * }} PackageManifest
 * @typedef {{ name: string, version: string }} TrackedPackage
 * @typedef {{
 *   library: string,
 *   tracks: TrackedPackage[],
 *   snapshot: string,
 *   refresh: "major" | "minor",
 * }} FreshnessStamp
 * @typedef {{
 *   missingStamp: string[],
 *   malformedStamp: string[],
 *   staleTracked: string[],
 *   retiredClaims: string[],
 *   unknownTracked: string[],
 *   driftWarnings: string[],
 * }} ReferenceFreshnessIssues
 */

/**
 * Parse one `<!-- reference-freshness: ... -->` stamp's field string into a
 * structured object, or `null` if a required field is missing or a
 * `tracks=` entry doesn't parse as `name@version`.
 *
 * @param {string} fields the text between `reference-freshness:` and `-->`
 * @returns {FreshnessStamp | null}
 */
function parseStamp(fields) {
  const libraryMatch = fields.match(/library=(\S+)/);
  const tracksMatch = fields.match(/tracks=(\S+)/);
  const snapshotMatch = fields.match(/snapshot=(\S+)/);
  const refreshMatch = fields.match(/refresh=(major|minor)/);
  if (
    libraryMatch === null ||
    tracksMatch === null ||
    snapshotMatch === null ||
    refreshMatch === null
  ) {
    return null;
  }

  const tracks = tracksMatch[1].split(",").map((entry) => {
    const at = entry.lastIndexOf("@");
    // at <= 0 means no "@" at all, or a leading "@" with an empty name —
    // either way there's no valid name/version split to make.
    if (at <= 0) return { name: "", version: "" };
    return { name: entry.slice(0, at), version: entry.slice(at + 1) };
  });
  if (tracks.some((t) => t.name === "" || t.version === "")) return null;

  return {
    library: libraryMatch[1],
    tracks,
    snapshot: snapshotMatch[1],
    refresh: refreshMatch[1],
  };
}

/**
 * Resolve a package's installed version from a list of parsed `package.json`
 * manifests, root manifest(s) first — matching the convention that every
 * tracked package today is a root devDependency. Returns `undefined` when
 * the name appears in neither `dependencies` nor `devDependencies` of any
 * manifest.
 *
 * @param {string} name
 * @param {PackageManifest[]} manifests
 * @returns {string | undefined}
 */
function resolveInstalledVersion(name, manifests) {
  for (const manifest of manifests) {
    const version =
      manifest.devDependencies?.[name] ?? manifest.dependencies?.[name];
    if (version !== undefined) return version.replace(/^[\^~]/, "");
  }
  return undefined;
}

/**
 * @param {string} version "major.minor.patch"
 * @returns {[number, number, number]}
 */
function parseSemver(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

/**
 * Whether `installed` has drifted past `stamped` under `refresh`'s policy.
 * Patch-only drift never fails, regardless of policy.
 *
 * @param {string} installed
 * @param {string} stamped
 * @param {"major" | "minor"} refresh
 * @returns {boolean}
 */
function isStaleBeyondPolicy(installed, stamped, refresh) {
  const [iMajor, iMinor] = parseSemver(installed);
  const [sMajor, sMinor] = parseSemver(stamped);
  if (iMajor !== sMajor) return true;
  return refresh === "minor" && iMinor !== sMinor;
}

/**
 * Derive every reference-freshness issue across a set of skill reference
 * files, checked against a set of parsed `package.json` manifests. A file
 * whose content contains no "Source: Context7" provenance line is skipped
 * entirely — this only constrains snapshots actually sourced from Context7.
 *
 * @param {ReferenceFile[]} files
 * @param {PackageManifest[]} manifests
 * @returns {ReferenceFreshnessIssues}
 */
export function deriveReferenceFreshnessIssues(files, manifests) {
  /** @type {ReferenceFreshnessIssues} */
  const issues = {
    missingStamp: [],
    malformedStamp: [],
    staleTracked: [],
    retiredClaims: [],
    unknownTracked: [],
    driftWarnings: [],
  };

  for (const { path, content } of files) {
    if (!isContext7Sourced(content)) continue;

    if (RETIRED_CLI_PATTERN.test(content)) {
      issues.retiredClaims.push(path);
    }

    const stampMatch = content.match(STAMP_PATTERN);
    if (stampMatch === null) {
      issues.missingStamp.push(path);
      continue;
    }

    const stamp = parseStamp(stampMatch[1]);
    if (stamp === null) {
      issues.malformedStamp.push(path);
      continue;
    }

    for (const { name, version: stampedVersion } of stamp.tracks) {
      const installed = resolveInstalledVersion(name, manifests);
      if (installed === undefined) {
        issues.unknownTracked.push(
          `${path}: tracked package "${name}" not found in any manifest`,
        );
        continue;
      }
      if (installed === stampedVersion) continue;
      if (isStaleBeyondPolicy(installed, stampedVersion, stamp.refresh)) {
        issues.staleTracked.push(
          `${path}: "${name}" installed at ${installed} but stamp tracks ${stampedVersion} (refresh=${stamp.refresh} policy exceeded)`,
        );
      } else {
        issues.driftWarnings.push(
          `${path}: "${name}" installed at ${installed}, drifted from stamped ${stampedVersion} (within refresh=${stamp.refresh} policy)`,
        );
      }
    }
  }

  return issues;
}
