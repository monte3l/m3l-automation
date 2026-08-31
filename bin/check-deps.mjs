#!/usr/bin/env node
/**
 * Dependency hygiene gate — covers the dimensions that pnpm audit misses.
 *
 * `pnpm audit --audit-level=high` (ci.yml) already blocks HIGH/CRITICAL
 * vulnerability advisories. This script covers the remaining un-gated
 * dimensions:
 *
 *   1. Outdated major versions — a dependency is behind its latest major
 *      (majors deliberately deferred in MAJOR_HOLDS are surfaced, not failed).
 *   2. Deprecated packages — npm marks the installed version as deprecated.
 *   3. Peer-dependency mismatches — pnpm reports unmet peers on install.
 *   4. ADR-0017 declaration conformance — the published library's runtime
 *      `dependencies` are exact-pinned and optional peers carry matching
 *      `peerDependenciesMeta`.
 *   5. Root devDependency pinning convention (ADR-0010) — every workspace-root
 *      dev dependency is exact-pinned, independent of ADR-0017's library scope.
 *
 * Exit codes:
 *   0  All checks passed.
 *   1  One or more policy violations found (see report on stderr).
 *
 * Usage:
 *   node bin/check-deps.mjs
 *   pnpm check:deps
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (res.error) {
    throw new Error(`Failed to spawn ${cmd}: ${res.error.message}`, {
      cause: res.error,
    });
  }
  return res;
}

/**
 * Parse the raw stdout from `pnpm outdated --format json` into a normalised
 * entry array.  Handles both the array form (`[{packageName, current, latest}]`)
 * and the object form (`{"name": {current, latest}}`).  Returns an empty array
 * when the input is blank or unparseable (graceful degradation for warning-
 * prefixed output that causes JSON.parse to fail).
 *
 * @param {string} stdout
 * @returns {{ name: string, current: string, latest: string }[]}
 */
export function parseOutdated(stdout) {
  const raw = stdout.trim();
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(data)) {
    return data.map((e) => ({
      name: String(e.packageName ?? e.name ?? ""),
      current: String(e.current ?? ""),
      latest: String(e.latest ?? ""),
    }));
  }
  if (data !== null && typeof data === "object") {
    return Object.entries(data).map(([name, info]) => ({
      name,
      current: String(info.current ?? ""),
      latest: String(info.latest ?? ""),
    }));
  }
  return [];
}

/**
 * Filter an entry list to those where the latest version is a higher major
 * than the installed version.
 *
 * @param {{ name: string, current: string, latest: string }[]} entries
 * @returns {{ name: string, current: string, latest: string }[]}
 */
export function findMajorBumps(entries) {
  return entries.filter((e) => {
    const currentMajor = parseInt((e.current || "0").split(".")[0], 10);
    const latestMajor = parseInt((e.latest || "0").split(".")[0], 10);
    return (
      !isNaN(currentMajor) && !isNaN(latestMajor) && latestMajor > currentMajor
    );
  });
}

/**
 * Deliberately-deferred major upgrades. A package listed here has a newer major
 * available that the project cannot adopt yet for a documented ecosystem or
 * toolchain reason, so `check:deps` must not block every unrelated PR on it.
 * Each hold names the specific major being deferred and why. A major *newer*
 * than the held one re-surfaces as an active violation (see {@link partitionHolds}),
 * so a hold can never silently mask a further major. Remove the entry once the
 * blocker clears and the upgrade lands.
 *
 * @type {Record<string, { major: number, reason: string }>}
 */
export const MAJOR_HOLDS = {
  typescript: {
    major: 7,
    reason:
      "TS 7 deferred. Two independent blockers, both verified against PR #780's " +
      "failed run: (1) typescript-eslint still peer-caps typescript at <6.1.0 " +
      "(checked at 8.68.0), so the type-aware lint toolchain cannot run on TS 7; " +
      "(2) bin/lib/browser-safe-subpath.mjs is this repo's only consumer of the " +
      "TypeScript compiler API, and TS 7's native port reshapes it — its " +
      "createSourceFile call broke 16 of 20 tests in " +
      "bin/tests/check-browser-safe-subpath.test.ts. Blocker (2) is the larger " +
      "one and is NOT mentioned in ADR-0001 decision 4, which defers the native " +
      "port on declaration-emit grounds alone: adopting TS 7 means porting " +
      "extractImportSpecifiers, not just relaxing a peer range. Revisit as its " +
      "own ADR-gated PR. Mirrored as a version-anchored ignore in " +
      ".github/dependabot.yml — keep the two in sync.",
  },
  "@types/node": {
    major: 26,
    reason:
      "Held at the 24.x line on purpose, not lagging: .node-version pins the " +
      "dev/CI runtime to Node 24, and @types/node is what decides which API " +
      "surface `pnpm typecheck` validates against. At 26 a green typecheck " +
      "proved the code runs on Node 26 while the declared floor was 24 — it " +
      "could use a Node-26-only API unchallenged, and did (a setInterval " +
      "overload in packages/m3l-console-server/tests/stream-writer.test.ts). " +
      "Enforced positively by check:node-version's findTypesNodeDrift, which " +
      "asserts major(@types/node) === .node-version and runs in ci.yml's " +
      "un-path-gated gates lane; this hold only keeps check:deps quiet about " +
      "the deliberate gap. Raise both together whenever .node-version moves.",
  },
};

/**
 * Splits detected major bumps into deliberately-held and active violations. A
 * bump is held only when its package appears in `holds` AND the available major
 * **equals** the specific held major — a hold defers exactly the one major it
 * names. Any other major (older or newer than the held one) falls through to
 * `active`, forcing a fresh decision rather than being silently masked. Pure.
 *
 * @param {{ name: string, current: string, latest: string }[]} majorBumps
 * @param {Record<string, { major: number, reason: string }>} [holds]
 * @returns {{ held: { name: string, current: string, latest: string, reason: string }[], active: { name: string, current: string, latest: string }[] }}
 */
export function partitionHolds(majorBumps, holds = MAJOR_HOLDS) {
  const held = [];
  const active = [];
  for (const e of majorBumps) {
    const hold = holds[e.name];
    const latestMajor = parseInt((e.latest || "0").split(".")[0], 10);
    if (hold && !isNaN(latestMajor) && latestMajor === hold.major) {
      held.push({ ...e, reason: hold.reason });
    } else {
      active.push(e);
    }
  }
  return { held, active };
}

/**
 * Semver exact-version matcher: `MAJOR.MINOR.PATCH` with optional prerelease
 * and build metadata, and nothing else — no range operators (`^`/`~`/`>`/`<`),
 * no wildcards (`*`/`x`), no dist-tags. ADR-0017 requires every `dependencies`
 * entry to be exact-pinned.
 */
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Returns the `dependencies` entries whose version specifier is not an exact
 * pin. Enforces the ADR-0017 rule that required runtime dependencies are
 * exact-pinned (ranges belong to `peerDependencies`, which the consumer
 * resolves). Pure — operates on a parsed `package.json` object.
 *
 * @param {{ dependencies?: Record<string, string> }} pkg
 * @returns {{ name: string, range: string }[]}
 */
export function findRangedDependencies(pkg) {
  const deps = pkg.dependencies ?? {};
  return Object.entries(deps)
    .filter(([, range]) => !EXACT_VERSION.test(range))
    .map(([name, range]) => ({ name, range }));
}

/**
 * Returns the `devDependencies` entries whose version specifier is not an
 * exact pin. Every dev dependency repo-wide is exact-pinned by convention
 * (ADR-0010's rumdl entry: "matching every other dev dependency") — unlike
 * {@link findRangedDependencies}, this is not an ADR-0017 rule scoped to the
 * published library; it applies to the workspace root's own `devDependencies`.
 * Pure — operates on a parsed `package.json` object.
 *
 * @param {{ devDependencies?: Record<string, string> }} pkg
 * @returns {{ name: string, range: string }[]}
 */
export function findRangedDevDependencies(pkg) {
  const deps = pkg.devDependencies ?? {};
  return Object.entries(deps)
    .filter(([, range]) => !EXACT_VERSION.test(range))
    .map(([name, range]) => ({ name, range }));
}

/**
 * Returns optional-peer declaration inconsistencies. ADR-0017 requires every
 * optional dependency to appear in BOTH `peerDependencies` and
 * `peerDependenciesMeta` with `optional: true`. Reports a peer that is missing
 * its `optional: true` meta, and an orphaned meta entry with no matching peer.
 * Pure — operates on a parsed `package.json` object.
 *
 * @param {{ peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, { optional?: boolean }> }} pkg
 * @returns {{ name: string, issue: string }[]}
 */
export function findPeerMetaInconsistencies(pkg) {
  const peers = pkg.peerDependencies ?? {};
  const meta = pkg.peerDependenciesMeta ?? {};
  const issues = [];

  for (const name of Object.keys(peers)) {
    if (meta[name]?.optional !== true) {
      issues.push({
        name,
        issue:
          "in peerDependencies but not marked optional in peerDependenciesMeta",
      });
    }
  }
  for (const name of Object.keys(meta)) {
    if (!(name in peers)) {
      issues.push({
        name,
        issue:
          "in peerDependenciesMeta but has no matching peerDependencies entry",
      });
    }
  }
  return issues;
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const libPkgRel = "packages/m3l-common/package.json";
  const rootPkgRel = "package.json";
  let violationCount = 0;

  // ── 1. Outdated major versions ───────────────────────────────────────────────

  const outdatedRes = run("pnpm", ["outdated", "--format", "json"]);

  let outdatedEntries;
  try {
    outdatedEntries = parseOutdated(outdatedRes.stdout || "");
  } catch (err) {
    reporter.warn(
      `check:deps: could not parse pnpm outdated output; skipping outdated-major check. (${/** @type {Error} */ (err).message})`,
    );
    outdatedEntries = [];
  }

  const { held, active } = partitionHolds(findMajorBumps(outdatedEntries));

  // Deliberately-deferred majors are surfaced but do not fail the gate — they
  // are un-adoptable today for a documented reason (see MAJOR_HOLDS).
  if (held.length > 0) {
    const rows = held
      .map(
        (e) =>
          `  ${e.name.padEnd(50)} ${e.current} → ${e.latest}\n      hold: ${e.reason}`,
      )
      .join("\n");
    reporter.warn(
      `check:deps — ${held.length} major update(s) on deliberate hold (not blocking):\n${rows}`,
    );
  }

  if (active.length > 0) {
    const rows = active
      .map((e) => `  ${e.name.padEnd(50)} ${e.current} → ${e.latest}`)
      .join("\n");
    reporter.error(
      `MAJOR VERSION UPDATES AVAILABLE (${active.length}):\n${rows}`,
    );
    violationCount++;
  }

  // ── 2. Deprecated packages ───────────────────────────────────────────────────

  // `pnpm list --json --depth=0` includes a `deprecated` field on affected entries.
  const listRes = run("pnpm", ["list", "--json", "--depth=0"]);
  let listData;
  try {
    const raw = (listRes.stdout || "").trim();
    listData = raw ? JSON.parse(raw) : [];
  } catch (err) {
    reporter.warn(
      `check:deps: could not parse pnpm list output; skipping deprecated-package check. (${/** @type {Error} */ (err).message})`,
    );
    listData = [];
  }

  const allDeps = {};
  for (const pkg of Array.isArray(listData) ? listData : [listData]) {
    for (const [name, info] of Object.entries({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    })) {
      allDeps[name] = info;
    }
  }

  const deprecated = Object.entries(allDeps).filter(
    ([, info]) =>
      typeof info.deprecated === "string" && info.deprecated.length > 0,
  );

  if (deprecated.length > 0) {
    const rows = deprecated
      .map(([name, info]) => `  ${name.padEnd(50)} ${info.deprecated}`)
      .join("\n");
    reporter.error(`DEPRECATED PACKAGES (${deprecated.length}):\n${rows}`);
    violationCount++;
  }

  // ── 3. Peer-dependency mismatches ────────────────────────────────────────────

  // A frozen-lockfile install is a no-op on an already-installed tree; pnpm
  // will emit peer warnings to stderr without changing anything on disk.
  const installRes = run("pnpm", ["install", "--frozen-lockfile"]);
  if (installRes.status !== 0) {
    reporter.warn(
      `check:deps: pnpm install --frozen-lockfile exited with status ${String(installRes.status)}; peer-dependency check may be incomplete.`,
    );
  }
  const peerLines = (installRes.stderr || "")
    .split("\n")
    .filter(
      (l) =>
        /peer/i.test(l) &&
        (/warn/i.test(l) ||
          /error/i.test(l) ||
          /missing/i.test(l) ||
          /unmet/i.test(l)),
    );

  if (peerLines.length > 0) {
    reporter.error(
      `PEER DEPENDENCY ISSUES (${peerLines.length} warning(s)):\n${peerLines
        .slice(0, 20)
        .map((l) => `  ${l.trim()}`)
        .join("\n")}`,
    );
    violationCount++;
  }

  // ── 4. Dependency-declaration conformance (ADR-0017) ─────────────────────────

  // The published library is the only package this rule governs — the workspace
  // root and the automation scripts legitimately use ranges and workspace:*.
  const libPkgPath = join(root, "packages", "m3l-common", "package.json");
  let libPkg = {};
  try {
    libPkg = JSON.parse(readFileSync(libPkgPath, "utf8"));
  } catch (err) {
    reporter.warn(
      `check:deps: could not read/parse ${libPkgRel}; skipping declaration-conformance checks. (${/** @type {Error} */ (err).message})`,
      { file: libPkgRel },
    );
  }

  const rangedDeps = findRangedDependencies(libPkg);
  if (rangedDeps.length > 0) {
    const rows = rangedDeps
      .map((e) => `  ${e.name.padEnd(50)} ${e.range}`)
      .join("\n");
    reporter.error(
      `NON-EXACT RUNTIME DEPENDENCIES (${rangedDeps.length}) — ADR-0017 requires exact pins in \`dependencies\`:\n${rows}`,
      { file: libPkgRel },
    );
    violationCount++;
  }

  const peerIssues = findPeerMetaInconsistencies(libPkg);
  if (peerIssues.length > 0) {
    const rows = peerIssues
      .map((e) => `  ${e.name.padEnd(40)} ${e.issue}`)
      .join("\n");
    reporter.error(
      `OPTIONAL-PEER DECLARATION ISSUES (${peerIssues.length}) — ADR-0017 requires every optional peer in both peerDependencies and peerDependenciesMeta.optional:\n${rows}`,
      { file: libPkgRel },
    );
    violationCount++;
  }

  // ── 5. Root devDependency pinning convention ─────────────────────────────────

  // Every dev dependency repo-wide is exact-pinned by convention (ADR-0010's
  // rumdl entry) — distinct from ADR-0017, which governs only the published
  // library's runtime `dependencies`/`peerDependencies` above.
  const rootPkgPath = join(root, "package.json");
  let rootPkg = {};
  try {
    rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
  } catch (err) {
    reporter.warn(
      `check:deps: could not read/parse ${rootPkgRel}; skipping root devDependency pinning check. (${/** @type {Error} */ (err).message})`,
      { file: rootPkgRel },
    );
  }

  const rangedDevDeps = findRangedDevDependencies(rootPkg);
  if (rangedDevDeps.length > 0) {
    const rows = rangedDevDeps
      .map((e) => `  ${e.name.padEnd(50)} ${e.range}`)
      .join("\n");
    reporter.error(
      `NON-EXACT ROOT DEV DEPENDENCIES (${rangedDevDeps.length}) — every dev dependency is exact-pinned by convention (ADR-0010):\n${rows}`,
      { file: rootPkgRel },
    );
    violationCount++;
  }

  // ── Report ───────────────────────────────────────────────────────────────────

  if (violationCount > 0) {
    if (!json) {
      console.error(
        `\ncheck:deps — ${violationCount} polic${violationCount === 1 ? "y" : "ies"} violation section(s) above. ` +
          `Fix these before merging. Vulnerability advisories are gated ` +
          `separately by \`pnpm audit --audit-level=high\`.`,
      );
    }
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    "check:deps — no blocking major bumps, deprecated packages, or peer issues found.",
  );
  reporter.finish();
  process.exit(0);
}
