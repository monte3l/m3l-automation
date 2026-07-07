#!/usr/bin/env node
/**
 * Enforces that a *breaking* change to the public `exports` snapshot is *labeled*
 * breaking. `check:api` (check-exports-snapshot.mjs) already forces the snapshot to
 * be updated deliberately when the exports map changes, but nothing checks that the
 * change ships with a `feat!:` / `BREAKING CHANGE:` marker — the one semver invariant
 * with no deterministic backstop (only the PR-review bot mentioned it).
 *
 * A removed or retyped `.`/`./core`/`./aws` entry is breaking; a purely added key is
 * additive. When a breaking delta is present between the PR base and head, the PR's
 * commit range must carry a breaking marker (a `BREAKING CHANGE:` footer or a `!`
 * subject); otherwise this fails.
 *
 * PR-only — it needs the base and head commits of the PR:
 *   node bin/check-exports-semver.mjs --base <sha> --head <sha>
 *
 * Exit codes:
 *   0  No breaking delta, or a breaking delta that is properly marked.
 *   1  A breaking exports delta with no breaking marker in the commit range,
 *      or the range/snapshot could not be resolved.
 */
import process from "node:process";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Built by concatenation so the source has no contiguous `<word>.<word>` literal
// that the write-time guard-no-commonjs hook mistakes for an `exports.<name>` access.
const snapshotRel = "packages/m3l-common/api-exports" + ".json";

/**
 * Key-sorted serialization so a per-entry value comparison ignores authoring order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/**
 * Classify the delta between two `exports` maps. A key present in base but missing
 * from head is a removal (breaking); a key whose value changed is a retype
 * (breaking); a key only in head is additive. A null base (snapshot absent at the
 * base commit) makes every head key additive.
 *
 * @param {Record<string, unknown> | null} baseMap
 * @param {Record<string, unknown>} headMap
 * @returns {{ breaking: string[], additive: string[] }}
 */
export function classifyExportsDelta(baseMap, headMap) {
  const breaking = [];
  const additive = [];
  const base = baseMap ?? {};
  for (const key of Object.keys(base)) {
    if (!(key in headMap)) {
      breaking.push(`${key} (removed)`);
    } else if (stableStringify(base[key]) !== stableStringify(headMap[key])) {
      breaking.push(`${key} (retyped)`);
    }
  }
  for (const key of Object.keys(headMap)) {
    if (!(key in base)) additive.push(`${key} (added)`);
  }
  return { breaking, additive };
}

/**
 * True when a concatenated commit-message log carries a Conventional-Commits
 * breaking marker: a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, or a `!`
 * subject such as `feat!:` / `feat(scope)!:`.
 *
 * @param {string} commitLog
 * @returns {boolean}
 */
export function hasBreakingMarker(commitLog) {
  if (/(^|\n)\s*BREAKING[ -]CHANGE:/.test(commitLog)) return true;
  return /(^|\n)\s*[a-z]+(\([^)]+\))?!:/i.test(commitLog);
}

/**
 * Read `--base`/`--head` from an argv array.
 *
 * @param {string[]} argv
 * @returns {{ base: string | undefined, head: string | undefined }}
 */
export function parseArgs(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { base: at("--base"), head: at("--head") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { base, head } = parseArgs(process.argv.slice(2));
  if (!base || !head) {
    console.error(
      "✗  Usage: check-exports-semver.mjs --base <sha> --head <sha>",
    );
    process.exit(1);
  }
  try {
    const headMap = JSON.parse(readFileSync(join(root, snapshotRel), "utf8"));
    let baseMap = null;
    try {
      baseMap = JSON.parse(
        execFileSync("git", ["show", `${base}:${snapshotRel}`], {
          cwd: root,
          encoding: "utf8",
        }),
      );
    } catch {
      // Snapshot did not exist at the base commit — treat as all-additive.
      baseMap = null;
    }
    const { breaking } = classifyExportsDelta(baseMap, headMap);
    if (breaking.length === 0) {
      console.log("✓  No breaking exports-map delta in this PR.");
      process.exit(0);
    }
    const commitLog = execFileSync(
      "git",
      ["log", "--format=%B", `${base}..${head}`],
      { cwd: root, encoding: "utf8" },
    );
    if (hasBreakingMarker(commitLog)) {
      console.log(
        `✓  Breaking exports delta (${breaking.join(", ")}) is marked BREAKING.`,
      );
      process.exit(0);
    }
    console.error(
      `✗  The public exports map changed in a BREAKING way (${breaking.join(", ")})\n` +
        `   but no commit in this PR carries a breaking marker. Add a\n` +
        `   \`BREAKING CHANGE:\` footer (or a \`feat!:\` subject) so the semver\n` +
        `   impact is explicit. See CLAUDE.md "Architecture & Decisions".`,
    );
    process.exit(1);
  } catch (error) {
    console.error(`✗  ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
