// Pure derivation for bin/check-adr-claims.mjs: a table of mechanically-
// probeable factual claims made by the corpus's load-bearing ADRs, each
// bound to a live-state probe and an expected value. Generalizes the
// INTEGRATION_DESCRIPTORS pattern from bin/lib/integration-stance.mjs
// (already extended once, ADR-0030 -> ADR-0093) from "does a skill's own
// text match its own behavior" to "does an ADR's factual claim about the
// repo still hold" — a third instance of the same descriptor-table shape.
//
// Blocking, unlike bin/check-adr-provenance.mjs's advisory drift signal:
// every probe here answers a yes/no question with a single mechanically
// certain source of truth (a file's parsed content), so a mismatch is not a
// judgment call — it is the exact "stale reads, not stale docs" failure
// mode the audit found (ADR-0004 asserted a three-entry exports map while
// the live map had grown a fourth entry, with nothing to catch it).
//
// Each probe takes the absolute repo root and returns a JSON-serializable
// value (never a Promise — every probe here is synchronous file I/O);
// `checkAdrClaims` compares it against `expect` via a structural
// (JSON.stringify) equality, sufficient for the primitives, arrays, and
// small plain objects every current claim returns.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePackageManagerField } from "../check-pnpm-version.mjs";

/**
 * @typedef {{
 *   id: string,
 *   adr: string,
 *   claim: string,
 *   probe: (root: string) => unknown,
 *   expect: unknown,
 * }} AdrClaim
 */

/**
 * Extract the string list items under a top-level YAML key, e.g.
 * `packages:\n  - "packages/*"\n  - "scripts/*"` -> `["packages/*", "scripts/*"]`.
 * Regex-based by house convention (`bin/check-cadence-doc.mjs`: "deliberately
 * regex-based, no YAML dependency") — this repo has no `yaml`/`js-yaml`
 * devDependency, and adding one for a two-line extraction would violate the
 * "minimal runtime dependencies" driver for a single caller.
 *
 * @param {string} yamlText
 * @param {string} key
 * @returns {string[]}
 */
export function extractYamlListKey(yamlText, key) {
  const keyLine = new RegExp(`^${key}:\\s*$`, "m").exec(yamlText);
  if (!keyLine) return [];
  const after = yamlText.slice(keyLine.index + keyLine[0].length);
  /** @type {string[]} */
  const items = [];
  for (const line of after.split("\n")) {
    const itemMatch = /^\s*-\s*"([^"]*)"\s*$/.exec(line);
    if (itemMatch) {
      items.push(itemMatch[1]);
      continue;
    }
    // A non-list-item, non-blank line ends this key's block (the next
    // top-level key, or an unquoted/comment line this extractor doesn't
    // need to understand).
    if (line.trim().length > 0 && !/^\s*-/.test(line)) break;
  }
  return items;
}

/**
 * @param {string} root
 * @returns {unknown}
 */
function probeExportsMapEntryCount(root) {
  const pkg = JSON.parse(
    readFileSync(join(root, "packages/m3l-common/package.json"), "utf8"),
  );
  return Object.keys(pkg.exports ?? {}).length;
}

/**
 * @param {string} root
 * @returns {{ type: string | undefined, hasRequireCondition: boolean }}
 */
function probeEsmOnly(root) {
  const pkg = JSON.parse(
    readFileSync(join(root, "packages/m3l-common/package.json"), "utf8"),
  );
  const exportsValues = Object.values(pkg.exports ?? {});
  const hasRequireCondition = exportsValues.some(
    (entry) =>
      typeof entry === "object" && entry !== null && "require" in entry,
  );
  return { type: pkg.type, hasRequireCondition };
}

/**
 * @param {string} root
 * @returns {string}
 */
function probeNodeFloor(root) {
  return readFileSync(join(root, ".node-version"), "utf8").trim();
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function probeWorkspacePackageGlobs(root) {
  const yamlText = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  return extractYamlListKey(yamlText, "packages").sort();
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function probeConsoleContainerfilesExist(root) {
  return (
    existsSync(join(root, "packages/m3l-console-server/Containerfile")) &&
    existsSync(join(root, "packages/m3l-console-web/Containerfile"))
  );
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function probeContext7Registered(root) {
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  return "context7" in (mcp.mcpServers ?? {});
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function probeReviewSizeCeilingDefined(root) {
  const workflow = readFileSync(
    join(root, ".github/workflows/claude-pr-review.yml"),
    "utf8",
  );
  return workflow.includes("MAX_REVIEWABLE_BYTES");
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function probeWorktreeToolingExists(root) {
  return (
    existsSync(join(root, "bin/worktree-new.mjs")) &&
    existsSync(join(root, "bin/worktree-remove.mjs"))
  );
}

/**
 * Asserts shape, not the literal version — an `expect: "12.4.1"` would rot on
 * every patch bump and force an ADR Update each time, rebuilding the drift
 * problem `check:pnpm-version`/`check:deps`'s staleness probe already close.
 * The major version is included deliberately: stable across patch and minor
 * bumps, and a future pnpm 13 bump *should* fail this claim, since at that
 * point ADR-0001's pnpm-12 prose genuinely is stale.
 *
 * @param {string} root
 * @returns {{ manager: string | undefined, exact: boolean, major: number | null }}
 */
function probePackageManagerPin(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const field = parsePackageManagerField(pkg.packageManager);
  const exact = field !== null && /^\d+\.\d+\.\d+$/.test(field.version);
  return {
    manager: field?.name,
    exact,
    major: exact ? Number(field.version.split(".")[0]) : null,
  };
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function probeHostResourceGateExists(root) {
  return existsSync(join(root, "bin/check-host-resources.mjs"));
}

/**
 * The load-bearing ADRs' probeable claims. Not exported directly — tests
 * exercise `checkAdrClaims` with their own small override array via its
 * `claims` parameter, the same pattern `deriveIntegrationStanceIssues` uses
 * for `INTEGRATION_DESCRIPTORS`.
 *
 * @type {AdrClaim[]}
 */
const ADR_CLAIMS = [
  {
    id: "exports-map-entry-count",
    adr: "0004",
    claim:
      "the exports map has exactly the entries ADR-0004's Decision and its 2026-08-29 Update together describe",
    probe: probeExportsMapEntryCount,
    expect: 4,
  },
  {
    id: "esm-only-no-require",
    adr: "0002",
    claim:
      '`packages/m3l-common/package.json` is `"type": "module"` with no `require` condition in any exports entry',
    probe: probeEsmOnly,
    expect: { type: "module", hasRequireCondition: false },
  },
  {
    id: "node-floor",
    adr: "0003",
    claim: ".node-version pins the Node 24 floor",
    probe: probeNodeFloor,
    expect: "24",
  },
  {
    id: "workspace-package-globs",
    adr: "0022",
    claim: "pnpm-workspace.yaml's packages key lists packages/* and scripts/*",
    probe: probeWorkspacePackageGlobs,
    expect: ["packages/*", "scripts/*"],
  },
  {
    id: "console-containerfiles-exist",
    adr: "0091",
    claim:
      "the console's app containers build from a Containerfile, not a Dockerfile",
    probe: probeConsoleContainerfilesExist,
    expect: true,
  },
  {
    id: "context7-mcp-registered",
    adr: "0093",
    claim: ".mcp.json declares the context7 server",
    probe: probeContext7Registered,
    expect: true,
  },
  {
    id: "review-size-ceiling-defined",
    adr: "0072",
    claim:
      "claude-pr-review.yml still defines the MAX_REVIEWABLE_BYTES ceiling check:review-size mirrors",
    probe: probeReviewSizeCeilingDefined,
    expect: true,
  },
  {
    id: "worktree-tooling-exists",
    adr: "0013",
    claim: "bin/worktree-new.mjs and bin/worktree-remove.mjs both exist",
    probe: probeWorktreeToolingExists,
    expect: true,
  },
  {
    id: "host-resource-gate-exists",
    adr: "0080",
    claim: "bin/check-host-resources.mjs exists",
    probe: probeHostResourceGateExists,
    expect: true,
  },
  {
    id: "package-manager-pin",
    adr: "0001",
    claim:
      "package.json's packageManager field pins an exact pnpm 12.x version",
    probe: probePackageManagerPin,
    expect: { manager: "pnpm", exact: true, major: 12 },
  },
];

export { ADR_CLAIMS };

/**
 * Run every claim's probe against `root` and report every one whose live
 * value no longer matches `expect`. A probe that throws (a missing file, a
 * parse failure) is reported as its own finding rather than crashing the
 * gate — the underlying file having moved or become unparseable is exactly
 * the kind of drift this gate exists to surface.
 *
 * @param {string} root - absolute repo root
 * @param {AdrClaim[]} [claims]
 * @returns {{ id: string, adr: string, message: string }[]}
 */
export function checkAdrClaims(root, claims = ADR_CLAIMS) {
  /** @type {{ id: string, adr: string, message: string }[]} */
  const findings = [];

  for (const claim of claims) {
    let actual;
    try {
      actual = claim.probe(root);
    } catch (err) {
      findings.push({
        id: claim.id,
        adr: claim.adr,
        message: `ADR-${claim.adr}'s claim ("${claim.claim}") could not be verified — the probe itself failed: ${err instanceof Error ? err.message : String(err)}.`,
      });
      continue;
    }

    if (JSON.stringify(actual) !== JSON.stringify(claim.expect)) {
      findings.push({
        id: claim.id,
        adr: claim.adr,
        message: `ADR-${claim.adr}'s claim ("${claim.claim}") no longer holds — expected ${JSON.stringify(claim.expect)}, live state is ${JSON.stringify(actual)}. Re-read and update the ADR.`,
      });
    }
  }

  return findings;
}
