#!/usr/bin/env node
/**
 * Dependency license-policy gate (ADR-0036) — the inbound counterpart to
 * ADR-0006's outbound (Apache-2.0) license choice. `pnpm audit` and
 * `dependency-review.yml` gate vulnerabilities; nothing gates the license
 * terms a dependency ships under.
 *
 * Two severities, split by whether the package is actually shipped:
 *
 *   - PROD scope (error, fails the build): `packages/m3l-common`'s runtime
 *     `dependencies`, plus its optional `peerDependencies` — a consumer who
 *     installs a peer is still exposed to its license terms, so a peer is
 *     gated exactly like a hard dependency, not skipped.
 *   - DEV scope (warn, does not fail): everything else — build/lint/test
 *     tooling never linked into a shipped artifact. ADR-0006's procurement
 *     concern does not reach these.
 *
 * `pnpm licenses list --prod` (run at the workspace root, covering
 * m3l-common + every `scripts/*` package) reports `dependencies` and
 * `optionalDependencies` only — it does NOT surface `peerDependencies`, even
 * with `--filter`, because a peer is supplied by the consumer, not resolved
 * into this repo's own tree. m3l-common's optional peers happen to be
 * installed here too (as devDependencies, for tests), so they resolve via
 * the unfiltered `pnpm licenses list --json` call and are unioned into the
 * PROD scope by name below.
 *
 * Exit codes:
 *   0  No PROD-scope violations (DEV-scope violations still warn to stderr).
 *   1  One or more PROD-scope violations found.
 *
 * Usage:
 *   node bin/check-licenses.mjs
 *   node bin/check-licenses.mjs --json
 *   pnpm check:licenses
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";
import { ALLOWED_LICENSES, classifyLicense } from "./lib/licenses.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { json } = parseJsonFlag();
const reporter = createReporter(json);

// dependency-review.yml's `allow-licenses:` input is a hand-maintained,
// textually-identical copy of ALLOWED_LICENSES (ADR-0036 — the two gate the
// same policy at two different points: PR-diff time there, resolved-tree
// time here). Nothing else binds them together, so a change to one that
// forgets the other drifts silently until a PR happens to exercise the gap.
// Parse the workflow's own `allow-licenses:` line and assert set equality
// before doing any of the (slower) `pnpm licenses list` work below.
const dependencyReviewPath = join(
  root,
  ".github",
  "workflows",
  "dependency-review.yml",
);
/**
 * @param {string} filePath
 * @returns {Set<string>}
 */
function parseAllowLicenses(filePath) {
  const text = readFileSync(filePath, "utf8");
  const match = /^\s*allow-licenses:\s*(.+)$/m.exec(text);
  if (!match) {
    reporter.error(
      `Could not find an "allow-licenses:" line in ${filePath} — has the ` +
        "dependency-review-action config moved or been renamed?",
    );
    reporter.finish();
    process.exit(1);
  }
  return new Set(
    match[1]
      .split(",")
      .map((license) => license.trim())
      .filter((license) => license.length > 0),
  );
}

const workflowAllowList = parseAllowLicenses(dependencyReviewPath);
const workflowOnly = [...workflowAllowList].filter(
  (license) => !ALLOWED_LICENSES.has(license),
);
const localOnly = [...ALLOWED_LICENSES].filter(
  (license) => !workflowAllowList.has(license),
);
if (workflowOnly.length > 0 || localOnly.length > 0) {
  reporter.error(
    "dependency-review.yml's allow-licenses list has drifted from " +
      "bin/lib/licenses.mjs's ALLOWED_LICENSES (ADR-0036 — keep them " +
      "textually identical): " +
      [
        workflowOnly.length > 0
          ? `only in dependency-review.yml: ${workflowOnly.sort().join(", ")}`
          : null,
        localOnly.length > 0
          ? `only in ALLOWED_LICENSES: ${localOnly.sort().join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("; "),
  );
  reporter.finish();
  process.exit(1);
}

/**
 * @param {string[]} args
 * @returns {Record<string, { name: string, versions: string[], license: string }[]>}
 */
function runLicensesList(args) {
  const res = spawnSync("pnpm", ["licenses", "list", "--json", ...args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (res.error) {
    throw new Error(
      `Failed to spawn "pnpm licenses list": ${res.error.message}`,
      {
        cause: res.error,
      },
    );
  }
  if (res.status !== 0) {
    reporter.error(
      `"pnpm licenses list ${args.join(" ")} --json" exited ${res.status}: ${(res.stderr || "").trim()}`,
    );
    reporter.finish();
    process.exit(1);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (error) {
    reporter.error(
      `Could not parse "pnpm licenses list" output as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    reporter.finish();
    process.exit(1);
  }
}

/**
 * Flatten the `{ license: entry[] }` shape into one array. A package name
 * can appear under more than one license group when two versions of it are
 * resolved in the tree with different declared licenses (e.g. `argparse`
 * resolves both a `1.0.10` (MIT) and a `2.0.1` (Python-2.0) here) — every
 * entry is classified independently, so a violation on one version is never
 * hidden behind an earlier, cleaner version of the same name.
 *
 * @param {Record<string, { name: string, versions: string[], license: string }[]>} licenseMap
 * @returns {{ name: string, versions: string[], license: string }[]}
 */
function flattenEntries(licenseMap) {
  return Object.values(licenseMap).flat();
}

/**
 * @param {{ name: string, versions: string[], license: string }[]} entries
 * @returns {Set<string>}
 */
function namesOf(entries) {
  return new Set(entries.map((entry) => entry.name));
}

const fullEntries = flattenEntries(runLicensesList([]));
const fullNames = namesOf(fullEntries);
const prodNames = namesOf(flattenEntries(runLicensesList(["--prod"])));

let libPkg;
try {
  libPkg = JSON.parse(
    readFileSync(join(root, "packages", "m3l-common", "package.json"), "utf8"),
  );
} catch (error) {
  reporter.error(
    `Could not read packages/m3l-common/package.json: ${error instanceof Error ? error.message : String(error)}`,
  );
  reporter.finish();
  process.exit(1);
}
const peerNames = Object.keys(libPkg.peerDependencies ?? {});

for (const peerName of peerNames) {
  if (!fullNames.has(peerName)) {
    reporter.warn(
      `Optional peer dependency "${peerName}" (packages/m3l-common) is not present in the ` +
        `resolved dependency tree — its license could not be checked. It is normally installed ` +
        `here as a devDependency for tests; if that changes, this check loses coverage of it.`,
    );
  }
}

const prodScope = new Set([...prodNames, ...peerNames]);
/** @type {Record<string, number>} */
const licenseCounts = {};
let errorCount = 0;

for (const entry of fullEntries) {
  licenseCounts[entry.license] = (licenseCounts[entry.license] ?? 0) + 1;

  const { verdict, reason } = classifyLicense(entry.license, ALLOWED_LICENSES);
  if (verdict === "allowed") continue;

  const inProdScope = prodScope.has(entry.name);
  const versions = entry.versions.join(", ");
  const detail =
    verdict === "denied"
      ? `license "${entry.license}" is not on the allow-list`
      : (reason ?? "license could not be determined");
  const message = `${entry.name}@${versions}: ${detail} (${inProdScope ? "prod" : "dev-only"} scope)`;

  if (inProdScope) {
    reporter.error(message);
    errorCount++;
  } else {
    reporter.warn(message);
  }
}

const summaryExtra = {
  allowedLicenses: [...ALLOWED_LICENSES].sort(),
  scope: { prod: prodScope.size, total: fullNames.size },
  licenseCounts,
};

if (errorCount > 0) {
  if (!json) {
    console.error(
      `\n✗  ${errorCount} prod-scope license violation(s). Allow-listed licenses: ` +
        `${[...ALLOWED_LICENSES].sort().join(", ")}. See docs/adr/0036-dependency-license-policy.md.`,
    );
  }
  reporter.finish(summaryExtra);
  process.exit(1);
}

reporter.succeed(
  `No prod-scope license violations (${prodScope.size} prod-scope package(s), ${fullNames.size} total).`,
);
for (const [license, count] of Object.entries(licenseCounts).sort(
  (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
)) {
  reporter.info(`  ${license}: ${count}`);
}
reporter.finish(summaryExtra);
