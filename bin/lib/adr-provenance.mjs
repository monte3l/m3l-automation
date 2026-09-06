// Pure derivation for docs/adr/'s provenance sidecar — a single aggregate
// docs/adr/provenance.json, not one file per ADR (docs/reference's per-page
// sidecar granularity tracks named sections/symbols; an ADR's file citations
// have no equivalent section structure, so one shared file scales to all 94
// ADRs without 94 near-empty JSON files).
//
// Coverage is systematic, not hand-curated: every backtick-quoted,
// repo-relative-looking path across all of docs/adr/*.md is a candidate,
// filtered to paths that actually exist on disk. This is deliberately the
// generator's whole job — a hand-picked subset would silently stop covering
// an ADR the moment someone added a new file citation to it, exactly the
// "no freshness machinery" gap the audit found
// (docs/logs/2026-09-06-adr-corpus-audit.md).
//
// What this catches that the ADR-claims descriptor table (bin/lib/adr-claims.mjs)
// does not: a citation going stale — the cited file changed since the ADR
// last confirmed accuracy — for ANY ADR that names a concrete path, not just
// the ~15 with a mechanically-probeable assertion. What it does NOT catch:
// whether the ADR's prose about that file is still true (only that the file
// changed at all) — a human re-read decides that; this only flags "go look."

/**
 * A backtick-quoted span whose content looks like a repo-relative path:
 * contains a "/" (a directory-qualified path) and no whitespace. Deliberately
 * broad — over-matching is cheap here, since every candidate is filtered
 * against the real filesystem next; under-matching would silently narrow
 * coverage.
 */
const BACKTICK_PATH_RE = /`([^`\s]+\/[^`\s]+)`/g;

/** Root-level files worth tracking that a path regex (requires "/") would miss. */
const ROOT_FILE_ALLOWLIST = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "lefthook.yml",
  ".node-version",
  "CLAUDE.md",
  "tsconfig.base.json",
  "tsconfig.json",
  "turbo.json",
  ".mcp.json",
  ".gitattributes",
]);

/**
 * Strip trailing punctuation a sentence commonly leaves attached to a
 * backtick-closed path (`./0057-…md).` — the period is prose, not the path)
 * and a `#section`/`?query` suffix, which never appears in a real repo path.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripTrailingNoise(raw) {
  return raw.replace(/[.,;:)!?]+$/, "").split(/[#?]/)[0];
}

/**
 * Extract every plausible repo-relative path citation from one ADR's text.
 * Pure string matching — existence (and the file-vs-directory distinction:
 * a citation like `packages/m3l-console-web` matches the path pattern and
 * exists, but names a directory, which `git hash-object` cannot hash —
 * confirmed live, the gate crashed on exactly this before the caller was
 * given an `isFile()` filter) is checked separately by the caller (this
 * module never touches the filesystem), so this can run identically in a
 * test as in the live gate.
 *
 * @param {string} content
 * @returns {string[]} deduplicated candidates, in first-seen order
 */
export function extractPathCandidates(content) {
  /** @type {string[]} */
  const seen = [];
  const add = (raw) => {
    const path = stripTrailingNoise(raw);
    // Reject a glob (nothing to hash), a bare ADR cross-reference rendered
    // in backticks (`ADR-0057`), and a package specifier that merely
    // contains "/" (`@m3l-automation/m3l-common`) — none names a real file.
    if (
      path.length === 0 ||
      path.includes("*") ||
      /^ADR-\d{4}/.test(path) ||
      path.startsWith("@") ||
      path.startsWith("http")
    ) {
      return;
    }
    if (!seen.includes(path)) seen.push(path);
  };

  for (const match of content.matchAll(BACKTICK_PATH_RE)) add(match[1]);
  for (const root of ROOT_FILE_ALLOWLIST) {
    if (content.includes(`\`${root}\``)) add(root);
  }

  return seen;
}

/**
 * @typedef {{ path: string, blob: string }} ProvenanceSource
 * @typedef {{ sourceFiles: ProvenanceSource[], verifiedAt: string }} AdrProvenanceEntry
 * @typedef {Record<string, AdrProvenanceEntry>} AdrProvenanceData
 */

/**
 * Derive the provenance entry a fresh generation would produce for one ADR,
 * given its already-filtered, already-hashed source list (existence and
 * hashing are I/O the CLI performs; this only shapes the result and decides
 * whether today's date is needed).
 *
 * @param {{ path: string, blob: string | undefined }[]} resolved -
 *   candidates that passed an existence check, with `blob` set for those
 *   `git hash-object` could hash (a symlink or non-regular file resolves to
 *   `undefined` and is dropped)
 * @param {string} today - YYYY-MM-DD
 * @param {AdrProvenanceEntry | undefined} previous - the committed entry, if any
 * @returns {AdrProvenanceEntry | undefined} `undefined` when there are no
 *   hashable sources at all (an ADR that cites no concrete repo path, or
 *   whose citations are all now stale filesystem paths — the entry is
 *   omitted rather than written empty)
 */
export function deriveProvenanceEntry(resolved, today, previous) {
  const sourceFiles = resolved
    .filter((r) => r.blob !== undefined)
    .map((r) => ({ path: r.path, blob: /** @type {string} */ (r.blob) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (sourceFiles.length === 0) return undefined;

  // Re-stamp verifiedAt only when the source list or any blob actually
  // changed — an unrelated ADR's re-generation must not bump every other
  // ADR's date, the same "stamp blob + date for changed sources only"
  // contract bin/check-doc-provenance.mjs's --update documents.
  const unchanged =
    previous !== undefined &&
    previous.sourceFiles.length === sourceFiles.length &&
    previous.sourceFiles.every(
      (p, i) =>
        p.path === sourceFiles[i].path && p.blob === sourceFiles[i].blob,
    );

  return {
    sourceFiles,
    verifiedAt: unchanged ? previous.verifiedAt : today,
  };
}

/**
 * Compare the committed provenance data against what a fresh derivation
 * produces (both keyed by 4-digit ADR number) and report every ADR whose
 * cited source(s) drifted since `verifiedAt` — the file's live blob no
 * longer matches the stamped one, or the ADR now cites a source it didn't
 * before (an added citation not yet verified), or a source it did before is
 * now gone from the filesystem entirely.
 *
 * @param {AdrProvenanceData} committed
 * @param {AdrProvenanceData} fresh - re-derived from live disk state (see
 *   {@link deriveProvenanceEntry}), but with every entry's `verifiedAt`
 *   forced to match `committed`'s so only genuine blob/path drift surfaces —
 *   a bare re-run must never itself look like drift
 * @returns {string[]} one human-readable finding per drifted ADR
 */
export function checkAdrProvenance(committed, fresh) {
  /** @type {string[]} */
  const findings = [];

  for (const [adr, committedEntry] of Object.entries(committed)) {
    const freshEntry = fresh[adr];
    if (freshEntry === undefined) {
      findings.push(
        `ADR-${adr}: every previously-tracked source is gone or no longer ` +
          `cited — re-run gen:adr-provenance to confirm and re-stamp.`,
      );
      continue;
    }

    const committedByPath = new Map(
      committedEntry.sourceFiles.map((s) => [s.path, s.blob]),
    );
    const freshByPath = new Map(
      freshEntry.sourceFiles.map((s) => [s.path, s.blob]),
    );

    /** @type {string[]} */
    const drifted = [];
    for (const [path, blob] of freshByPath) {
      const committedBlob = committedByPath.get(path);
      if (committedBlob === undefined) {
        drifted.push(`${path} (newly cited, unverified)`);
      } else if (committedBlob !== blob) {
        drifted.push(`${path} (changed since ${committedEntry.verifiedAt})`);
      }
    }
    for (const path of committedByPath.keys()) {
      if (!freshByPath.has(path)) drifted.push(`${path} (no longer exists)`);
    }

    if (drifted.length > 0) {
      findings.push(
        `ADR-${adr}: re-derive its claim before relying on it — ${drifted.join(", ")}.`,
      );
    }
  }

  return findings;
}
