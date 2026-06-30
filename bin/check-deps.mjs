#!/usr/bin/env node
/**
 * Dependency hygiene gate — covers the dimensions that pnpm audit misses.
 *
 * `pnpm audit --audit-level=high` (ci.yml) already blocks HIGH/CRITICAL
 * vulnerability advisories. This script covers the remaining un-gated
 * dimensions:
 *
 *   1. Outdated major versions — a dependency is behind its latest major.
 *   2. Deprecated packages — npm marks the installed version as deprecated.
 *   3. Peer-dependency mismatches — pnpm reports unmet peers on install.
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
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sections = [];

  // ── 1. Outdated major versions ───────────────────────────────────────────────

  const outdatedRes = run("pnpm", ["outdated", "--format", "json"]);

  let outdatedEntries;
  try {
    outdatedEntries = parseOutdated(outdatedRes.stdout || "");
  } catch (err) {
    process.stderr.write(
      `check:deps: warning — could not parse pnpm outdated output; skipping outdated-major check. (${/** @type {Error} */ (err).message})\n`,
    );
    outdatedEntries = [];
  }

  const majorBumps = findMajorBumps(outdatedEntries);

  if (majorBumps.length > 0) {
    const rows = majorBumps
      .map((e) => `  ${e.name.padEnd(50)} ${e.current} → ${e.latest}`)
      .join("\n");
    sections.push(
      `MAJOR VERSION UPDATES AVAILABLE (${majorBumps.length}):\n${rows}`,
    );
  }

  // ── 2. Deprecated packages ───────────────────────────────────────────────────

  // `pnpm list --json --depth=0` includes a `deprecated` field on affected entries.
  const listRes = run("pnpm", ["list", "--json", "--depth=0"]);
  let listData;
  try {
    const raw = (listRes.stdout || "").trim();
    listData = raw ? JSON.parse(raw) : [];
  } catch (err) {
    process.stderr.write(
      `check:deps: warning — could not parse pnpm list output; skipping deprecated-package check. (${/** @type {Error} */ (err).message})\n`,
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
    sections.push(`DEPRECATED PACKAGES (${deprecated.length}):\n${rows}`);
  }

  // ── 3. Peer-dependency mismatches ────────────────────────────────────────────

  // A frozen-lockfile install is a no-op on an already-installed tree; pnpm
  // will emit peer warnings to stderr without changing anything on disk.
  const installRes = run("pnpm", ["install", "--frozen-lockfile"]);
  if (installRes.status !== 0) {
    process.stderr.write(
      `check:deps: warning — pnpm install --frozen-lockfile exited with status ${String(installRes.status)}; peer-dependency check may be incomplete.\n`,
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
    sections.push(
      `PEER DEPENDENCY ISSUES (${peerLines.length} warning(s)):\n${peerLines
        .slice(0, 20)
        .map((l) => `  ${l.trim()}`)
        .join("\n")}`,
    );
  }

  // ── Report ───────────────────────────────────────────────────────────────────

  if (sections.length > 0) {
    process.stderr.write(
      `check:deps — policy violations found:\n\n` +
        sections.join("\n\n") +
        `\n\nFix these before merging. Vulnerability advisories are gated ` +
        `separately by \`pnpm audit --audit-level=high\`.\n`,
    );
    process.exit(1);
  }

  console.log(
    "✓  check:deps — no major bumps, deprecated packages, or peer issues found.",
  );
  process.exit(0);
}
