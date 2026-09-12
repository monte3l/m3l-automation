#!/usr/bin/env node
// Refuses to let the release workflow attempt `pnpm publish` against a
// version already present on the registry. GitHub Packages treats a
// published version as immutable — republishing the same version number is
// rejected outright, and a version deleted from a private package cannot be
// reliably reused (docs.github.com/en/packages/learn-github-packages/
// deleting-and-restoring-a-package) — so this check turns that rejection
// into a clear, early failure message instead of a raw registry 4xx buried
// in `pnpm publish`'s own output.
//
// Needs network and a token with at least `read:packages` — the release
// workflow's own ephemeral GITHUB_TOKEN suffices (ADR-0103). Deliberately
// NOT part of `pnpm verify` / `pre-push`: every other check:* gate here is
// local and network-free, and this one only means anything in the
// release-dispatch context. See
// docs/plans/2026-09-12-u13-registry-publish.md's P3 slice.
//
// This could not be live-verified against the real npm.pkg.github.com
// endpoint from the authoring session (no outbound curl, and WebFetch
// refuses authenticated endpoints) — it follows the documented npm registry
// protocol shape (a scoped package's metadata document has a `versions` map
// keyed by version string; a never-published package 404s). The release
// workflow's first real dispatch is this script's actual live exercise,
// same as any other GitHub-Actions-only step in this repo.
//
// Usage:
//   NODE_AUTH_TOKEN=<token> node bin/check-publish-version.mjs
//   node bin/check-publish-version.mjs --json
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

/** Repo-relative directory of the package this gate guards. */
export const PACKAGE_DIR = "packages/m3l-common";

/** The registry `packages/m3l-common/package.json`'s `publishConfig` points at. */
export const REGISTRY = "https://npm.pkg.github.com";

/**
 * Read the `{ name, version }` this release would publish.
 *
 * @param {string} repoRootDir
 * @returns {{ name: string, version: string }}
 */
export function readPublishTarget(repoRootDir) {
  const pkg = JSON.parse(
    readFileSync(join(repoRootDir, PACKAGE_DIR, "package.json"), "utf8"),
  );
  return { name: pkg.name, version: pkg.version };
}

/**
 * A scoped package name's path segment in an npm-registry-protocol request —
 * only `/` is percent-encoded (`%2F`); the leading `@` stays literal. Not
 * `encodeURIComponent(name)`: that would also encode `@` to `%40`, which the
 * registry does not expect (mirrors how npm's own registry client escapes a
 * scoped name).
 *
 * @param {string} name e.g. "@monte3l/m3l-common"
 * @returns {string}
 */
export function registryPathSegment(name) {
  return name.replace("/", "%2F");
}

/**
 * True if `version` already exists in `name`'s published version set on
 * `registry`. A 404 means the package has never been published at all —
 * that is "no versions exist yet", not an error.
 *
 * @param {string} name
 * @param {string} version
 * @param {{ registry: string, token: string, fetchImpl?: typeof fetch }} opts
 *   `fetchImpl` defaults to global `fetch`; tests inject a stub instead of
 *   mocking global fetch (the `countTokensExact` pattern in
 *   bin/check-context-budget.mjs).
 * @returns {Promise<boolean>}
 */
export async function versionExists(
  name,
  version,
  { registry, token, fetchImpl = fetch },
) {
  const response = await fetchImpl(`${registry}/${registryPathSegment(name)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `registry lookup for ${name} failed: ${response.status} ${response.statusText}`,
    );
  }
  /** @type {{ versions?: Record<string, unknown> }} */
  const body = await response.json();
  return Object.hasOwn(body.versions ?? {}, version);
}

/**
 * Bound an unknown catch value to its message, never the raw value — a
 * fetch failure's `cause` chain can carry request internals, so this keeps
 * whatever ends up in a reporter line to text a human wrote.
 *
 * @param {unknown} cause
 * @returns {string}
 */
function causeMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const token = process.env.NODE_AUTH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    reporter.error(
      "no registry token found — set NODE_AUTH_TOKEN (or GITHUB_TOKEN) before running this check.",
    );
    reporter.finish();
    process.exit(1);
  }

  let name, version;
  try {
    ({ name, version } = readPublishTarget(root));
  } catch (cause) {
    reporter.error(
      `could not read ${PACKAGE_DIR}/package.json: ${causeMessage(cause)}`,
    );
    reporter.finish();
    process.exit(1);
  }

  try {
    const exists = await versionExists(name, version, {
      registry: REGISTRY,
      token,
    });
    if (exists) {
      reporter.error(
        `${name}@${version} is already published to ${REGISTRY} — GitHub Packages versions are immutable; bump the version before releasing again.`,
      );
      reporter.finish();
      process.exit(1);
    }
  } catch (cause) {
    reporter.error(
      `could not check ${name}@${version} against ${REGISTRY}: ${causeMessage(cause)}`,
    );
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    `${name}@${version} is not yet published to ${REGISTRY} — clear to publish.`,
  );
  reporter.finish();
}
