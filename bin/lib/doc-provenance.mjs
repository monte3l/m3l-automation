// Core engine for docs/reference/*.provenance.json verification and
// content-hash (git blob) staleness detection. Extracted from
// bin/check-doc-provenance.mjs so the logic is unit-testable
// (bin/tests/doc-provenance.test.ts); the CLI stays a thin wrapper with the
// same flags and exit contract. Kept pattern-parallel with
// bin/lib/signed-range.mjs and bin/lib/worktree-include.mjs: pure/injectable
// functions, no module-level side effects.
//
// Staleness is content-addressed (git blob SHA of the source file), not
// commit-addressed: a rebase that leaves a source file byte-identical never
// marks its sidecar stale, even though the commit SHA changes. This is what
// makes `--update` safe to run bare — only sections whose source content
// actually changed get re-stamped.
import { spawnSync } from "node:child_process";

/**
 * Parse markdown headings (levels 1-6) into their trimmed text.
 *
 * @param {string} mdText
 * @returns {string[]}
 */
export function parseHeadings(mdText) {
  return mdText
    .split("\n")
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => l.replace(/^#{1,6} /, "").trim());
}

/**
 * Whether `symbol` is exported (directly or via a named-export block) from
 * TypeScript source text.
 *
 * @param {string} src
 * @param {string} symbol
 * @returns {boolean}
 */
export function isSymbolExported(src, symbol) {
  // Escape regex metacharacters in the symbol name (e.g. < > in generics).
  const ident = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directRe = new RegExp(
    `\\bexport\\b(?:\\s+(?:abstract|declare|async))*\\s+` +
      `(?:class|function|type|interface|const|let|var|enum)\\s+${ident}\\b`,
  );
  const namedRe = new RegExp(
    `\\bexport\\b(?:\\s+type)?\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}`,
  );
  return directRe.test(src) || namedRe.test(src);
}

/**
 * Default git runner: batched `git hash-object`. Injectable for tests.
 *
 * @param {string[]} args
 * @param {{ cwd: string }} opts
 * @returns {{ status: number | null, stdout: string }}
 */
function defaultRunGit(args, opts) {
  return spawnSync("git", args, { ...opts, encoding: "utf8" });
}

/**
 * Batch git blob SHAs for a set of repo-relative file paths in one spawn
 * (rather than one `git hash-object` per source, per run). Callers must only
 * pass paths already known to exist on disk — `git hash-object` fails the
 * whole batch if any path is missing.
 *
 * @param {string} root - absolute repo root, used as the git cwd
 * @param {string[]} files - repo-relative paths
 * @param {(args: string[], opts: { cwd: string }) => { status: number | null, stdout: string }} [runGit]
 * @returns {Map<string, string>} file -> 40-hex blob SHA (empty if the batch failed)
 */
export function hashBlobs(root, files, runGit = defaultRunGit) {
  const map = new Map();
  const unique = [...new Set(files)];
  if (unique.length === 0) return map;
  const res = runGit(["hash-object", "--", ...unique], { cwd: root });
  if (res.status !== 0) return map;
  const lines = res.stdout.split("\n").filter((l) => l.length > 0);
  unique.forEach((file, i) => {
    if (lines[i]) map.set(file, lines[i].trim());
  });
  return map;
}

/**
 * Verify one sidecar section-list against its sibling markdown doc's
 * headings and each source's on-disk existence/export/blob state. Pure:
 * takes pre-computed inputs rather than touching fs or git itself.
 *
 * @param {{ sections: object[] }} data - parsed sidecar JSON
 * @param {string[]} mdHeadings
 * @param {{
 *   fileExists: (file: string) => boolean,
 *   symbolCheck: (file: string, symbol: string) => boolean,
 *   blobOf: (file: string) => string | undefined,
 * }} deps
 * @returns {{
 *   errors: string[],
 *   warnings: string[],
 *   staleSources: { sectionIndex: number, sourceIndex: number, file: string, blob: string }[],
 * }}
 */
export function verifySidecarSections(data, mdHeadings, deps) {
  const { fileExists, symbolCheck, blobOf } = deps;
  const errors = [];
  const warnings = [];
  const staleSources = [];

  data.sections.forEach((section, sectionIndex) => {
    const tag = `"${section.heading}"`;

    if (!mdHeadings.includes(section.heading)) {
      errors.push(
        `heading ${tag} not found\n` +
          `   Known headings: ${mdHeadings.map((h) => `"${h}"`).join(", ")}`,
      );
    }

    (section.sources ?? []).forEach((source, sourceIndex) => {
      if (!fileExists(source.file)) {
        errors.push(`source file not found: ${source.file} (section ${tag})`);
        return;
      }
      if (!symbolCheck(source.file, source.symbol)) {
        errors.push(
          `"${source.symbol}" not exported from ${source.file} (section ${tag})`,
        );
      }
      const currentBlob = blobOf(source.file);
      if (currentBlob && source.blob !== currentBlob) {
        warnings.push(
          `stale — re-verify. ${source.file} changed since last verification (section ${tag}).`,
        );
        staleSources.push({
          sectionIndex,
          sourceIndex,
          file: source.file,
          blob: currentBlob,
        });
      }
    });
  });

  return { errors, warnings, staleSources };
}

/**
 * Given a validated sidecar and its stale sources (from
 * {@link verifySidecarSections}), return updated JSON data with blobs
 * stamped and `retrieved` bumped only for touched sections — or `null` if
 * nothing changed, so the caller can skip the write entirely. This is what
 * makes a bare `--update` safe: a rebase with byte-identical sources touches
 * zero sidecars. Also strips the legacy section-level `commit` field (dead
 * once blob-addressing lands) from every section it rewrites.
 *
 * @param {object} data
 * @param {{ sectionIndex: number, sourceIndex: number, blob: string }[]} staleSources
 * @param {string} today - YYYY-MM-DD
 * @returns {object | null}
 */
export function applyBlobUpdates(data, staleSources, today) {
  if (staleSources.length === 0) return null;
  const next = structuredClone(data);
  const touchedSections = new Set();
  for (const { sectionIndex, sourceIndex, blob } of staleSources) {
    next.sections[sectionIndex].sources[sourceIndex].blob = blob;
    touchedSections.add(sectionIndex);
  }
  for (const section of next.sections) {
    delete section.commit;
  }
  for (const sectionIndex of touchedSections) {
    next.sections[sectionIndex].retrieved = today;
  }
  return next;
}
