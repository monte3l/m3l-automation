// Pure functions validating the `promoted →` stamp convention
// `/promoting-work-log-lessons` and `/writing-work-logs` share (see
// docs/research/retrospective.md § "Why a ledger and not just the in-log
// marker" and .claude/skills/promoting-work-log-lessons/SKILL.md Step 5).
// Consumed by bin/check-promotion-stamps.mjs and
// bin/tests/check-promotion-stamps.test.ts.
//
// Two arms, per ROADMAP H7 (issue #1000):
//
//   Forward  a `_(promoted → <path>)_` stamp in docs/logs/*.md names a file
//            that must exist — RENAMED_TARGETS below is the one allowed
//            exception (see its own comment).
//   Reverse  a `docs/logs/<name>.md` citation inside .claude/rules/*.md,
//            .claude/agents/*.md, .claude/skills/*/SKILL.md, or CLAUDE.md
//            must resolve to a real log.
//
// Deliberately NOT checked: symmetry (every stamp's target citing its source
// log back). Measured against the live corpus while this gate was designed:
// only 109 of 299 stamp→target pairs are symmetric today, and the other 190
// span either free-form prose targets (a section name, "see Lessons
// learned") that carry no file to cite back into, or a target file that would
// have to grow a citation purely to satisfy the gate — re-inflating exactly
// the rule files ROADMAP H13 (#1040) trimmed under check:context-budget. Logs
// are also immutable history (docs/logs/README.md), so nothing here ever
// edits one; a stale forward stamp is repaired via RENAMED_TARGETS instead.

/** Where work logs live. */
export const LOGS_DIR = "docs/logs";

/**
 * Repo-relative paths this gate's reverse arm scans for `docs/logs/*.md`
 * citations. `evals/evals.json` under any skill directory is deliberately
 * excluded — its docs/logs/… paths are synthetic eval fixtures naming logs
 * that were never written, not real citations.
 */
export const SCAN_GLOBS = [
  ".claude/rules/*.md",
  ".claude/agents/*.md",
  ".claude/skills/*/SKILL.md",
  "CLAUDE.md",
];

/**
 * Resolve {@link SCAN_GLOBS}'s simple shapes — a directory of `.md` files, a
 * subdirectory-per-item file, or a bare literal path — against the real
 * filesystem, via an injected seam. This is the one place this gate's runner
 * and its tests share what "the reverse arm's scan roots" actually means, so
 * the two can never drift apart the way a hardcoded `readdirSync` block in
 * the runner alone would invite. Each wildcard segment matches any single
 * path segment; a literal segment must match exactly. A resolved path that
 * doesn't exist (e.g. `CLAUDE.md` in a fixture that doesn't have one) is
 * silently dropped, matching `existsSync`-guarded lookups elsewhere in this
 * codebase.
 *
 * @param {string[]} globs one of {@link SCAN_GLOBS}'s two shapes per entry
 * @param {{ readdir: (dir: string) => string[], exists: (path: string) => boolean }} fs
 *   injected seam; `readdir` expands each `*` segment in turn, and `exists`
 *   is the terminal check on every fully-resolved leaf path — including one
 *   just enumerated under a wildcard, not only a glob with none at all
 * @returns {string[]} sorted repo-relative paths that exist on disk
 */
export function resolveScanGlobs(globs, fs) {
  /** @type {string[]} */
  const resolved = [];

  /**
   * @param {string[]} segments remaining glob segments to consume
   * @param {string} prefix the repo-relative path built so far (no trailing slash)
   */
  const expand = (segments, prefix) => {
    if (segments.length === 0) {
      if (fs.exists(prefix)) resolved.push(prefix);
      return;
    }

    const [segment, ...rest] = segments;
    const path = prefix ? `${prefix}/${segment}` : segment;

    if (!segment.includes("*")) {
      expand(rest, path);
      return;
    }

    const pattern = new RegExp(
      `^${segment
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    for (const name of fs.readdir(prefix || ".")) {
      if (pattern.test(name)) {
        expand(rest, prefix ? `${prefix}/${name}` : name);
      }
    }
  };

  for (const glob of globs) expand(glob.split("/"), "");

  return resolved.sort();
}

/**
 * A wildcard-free {@link SCAN_GLOBS} entry (e.g. `CLAUDE.md`) that doesn't
 * exist. {@link resolveScanGlobs} silently drops any path that fails
 * `exists()`, which is correct for a wildcard glob matching zero files (an
 * empty directory is not an error) but wrong for a bare literal: if that
 * file is ever renamed, the reverse arm would silently stop scanning it —
 * the gate would still exit 0 despite losing coverage of exactly the
 * rename-induced rot it exists to catch. A glob containing `*` is never
 * flagged here; only a fully literal entry is.
 *
 * @param {string[]} globs one of {@link SCAN_GLOBS}'s two shapes per entry
 * @param {(path: string) => boolean} exists
 * @returns {{ message: string, file: string }[]}
 */
export function checkMissingLiteralGlobs(globs, exists) {
  return globs
    .filter((glob) => !glob.includes("*") && !exists(glob))
    .map((glob) => ({
      message:
        `SCAN_GLOBS lists "${glob}" as a reverse-arm scan root, but it does ` +
        `not exist — the reverse arm has silently stopped scanning it. If it ` +
        `was renamed, update the entry in bin/lib/promotion-stamps.mjs.`,
      file: "bin/lib/promotion-stamps.mjs",
    }));
}

/**
 * Historical `promoted →` targets that no longer exist because the file was
 * renamed after the stamp landed, mapped to where the content lives now.
 * Landed work logs are immutable (docs/logs/README.md), so a rename is
 * repaired here instead of by editing the log. Add a row here — never edit a
 * log — the next time a stamped file is renamed.
 */
export const RENAMED_TARGETS = new Map([
  // .claude/agents/submodule-implementer.md -> code-implementer.md, commit 9db7c3bb
  [
    ".claude/agents/submodule-implementer.md",
    ".claude/agents/code-implementer.md",
  ],
  // .claude/skills/sync-docs -> syncing-docs, commit fa60919e
  [".claude/skills/sync-docs/SKILL.md", ".claude/skills/syncing-docs/SKILL.md"],
  // .claude/skills/vitest-coverage-types-mocks -> vitest-testing, commit 2cdbd165 (#1077)
  [
    ".claude/skills/vitest-coverage-types-mocks/SKILL.md",
    ".claude/skills/vitest-testing/SKILL.md",
  ],
]);

/**
 * The stamp itself — `[\s\S]` (not `.`) because prettier wraps ~8 of these
 * across two lines. The non-greedy terminator matches the first literal
 * `)_` substring, not balanced parens — correct for every stamp in the live
 * corpus (verified: 0 false positives across 305 stamps), but it assumes a
 * well-formed corpus, not arbitrary input: a stamp body containing a nested
 * parenthetical whose close happens to be immediately followed by `_`
 * (another markdown-italic close) would truncate the capture early.
 */
const STAMP_RE = /_\(promoted →([\s\S]*?)\)_/g;

/** A `docs/logs/<name>.md` citation anywhere in a scanned harness file. */
const LOG_CITATION_RE = /docs\/logs\/([A-Za-z0-9._-]+\.md)/g;

/**
 * Is `token` shaped like a repo-relative file path? Deliberately permissive
 * about what a stamp target's trailing prose may contain (an em-dash
 * explanation, a `§ Section` pointer) — this only judges the leading token
 * {@link parseLogStamps} isolates, never the free text after it.
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksPathShaped(token) {
  if (token.includes("/")) return true; // has a directory separator
  if (/^\.[A-Za-z0-9_-]+$/.test(token)) return true; // dotfile, e.g. .gitignore
  // Bare filename.ext, e.g. CLAUDE.md, eslint.config.js, tsconfig.build.json —
  // one or more dot-separated segments, so a multi-dot filename isn't missed.
  if (/^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)+$/.test(token)) return true;
  return false;
}

/**
 * Parse every `_(promoted → …)_` stamp in one log's text into its target
 * path(s). A stamp body is split on `,` and `;` (both separate multiple
 * targets in the corpus); only each part's *leading whitespace-delimited
 * token* is treated as a path, so a target followed by explanatory prose
 * (`docs/contributing/foo.md — the new "Recover" subsection…`) or a
 * `§ Section` pointer yields exactly one target, and a part that is prose
 * throughout (`see Lessons learned`, `filed → IMPLEMENTATION.md F14`'s own
 * `filed` half) yields none — it is skipped, not flagged, since a stamp names
 * a target file, not every judgment call a check like this could invent.
 *
 * @param {string} text a docs/logs/*.md file's contents
 * @returns {{ target: string, line: number }[]} in document order; `line` is
 *   the 1-indexed line the stamp's opening `_(promoted →` appears on
 */
export function parseLogStamps(text) {
  /** @type {{ target: string, line: number }[]} */
  const stamps = [];

  for (const match of text.matchAll(STAMP_RE)) {
    const line = text.slice(0, match.index).split("\n").length;
    const body = match[1].replace(/\s+/g, " ").trim();

    for (const part of body.split(/[,;]/)) {
      const token = part.trim().split(/\s+/)[0]?.replaceAll("`", "");
      if (token && looksPathShaped(token)) {
        stamps.push({ target: token, line });
      }
    }
  }

  return stamps;
}

/**
 * {@link parseLogStamps} applied across every log, tagging each stamp with
 * its source log filename.
 *
 * @param {{ file: string, text: string }[]} logs
 * @returns {{ log: string, target: string, line: number }[]}
 */
export function collectStamps(logs) {
  return logs.flatMap(({ file, text }) =>
    parseLogStamps(text).map((stamp) => ({ log: file, ...stamp })),
  );
}

/**
 * A stamp target that resolves neither directly nor through
 * {@link RENAMED_TARGETS} — a promoted lesson pointing at a file that was
 * deleted or renamed with no ledger entry added.
 *
 * @param {{ log: string, target: string, line: number }[]} stamps
 * @param {(path: string) => boolean} exists
 * @returns {{ message: string, file: string, line: number }[]}
 */
export function checkDeadTargets(stamps, exists) {
  return stamps
    .filter(
      (stamp) => !exists(stamp.target) && !RENAMED_TARGETS.has(stamp.target),
    )
    .map((stamp) => ({
      message:
        `${LOGS_DIR}/${stamp.log}:${stamp.line} stamps ` +
        `"promoted → ${stamp.target}", but that file does not exist. If it ` +
        `was renamed, add it to RENAMED_TARGETS in bin/lib/promotion-stamps.mjs ` +
        `rather than editing the log (docs/logs/ is immutable history).`,
      file: `${LOGS_DIR}/${stamp.log}`,
      line: stamp.line,
    }));
}

/**
 * A {@link RENAMED_TARGETS} entry whose *current* path no longer exists
 * either — the map itself has rotted, most likely a second rename that never
 * updated the ledger.
 *
 * @param {(path: string) => boolean} exists
 * @returns {{ message: string, file: string }[]}
 */
export function checkStaleAliases(exists) {
  /** @type {{ message: string, file: string }[]} */
  const findings = [];

  for (const [oldPath, newPath] of RENAMED_TARGETS) {
    if (!exists(newPath)) {
      findings.push({
        message:
          `RENAMED_TARGETS maps "${oldPath}" → "${newPath}", but ${newPath} ` +
          `does not exist either — update the alias to wherever the content ` +
          `now lives.`,
        file: "bin/lib/promotion-stamps.mjs",
      });
    }
  }

  return findings;
}

/**
 * Every `docs/logs/<name>.md` citation inside one scanned harness file.
 *
 * @param {string} text a rule/agent/skill/CLAUDE.md file's contents
 * @returns {{ logFile: string, line: number }[]}
 */
export function parseLogCitations(text) {
  /** @type {{ logFile: string, line: number }[]} */
  const citations = [];

  for (const match of text.matchAll(LOG_CITATION_RE)) {
    const line = text.slice(0, match.index).split("\n").length;
    citations.push({ logFile: match[1], line });
  }

  return citations;
}

/**
 * {@link parseLogCitations} applied across every scanned harness file,
 * tagging each citation with the file it was found in.
 *
 * @param {{ path: string, text: string }[]} scannedFiles
 * @returns {{ path: string, logFile: string, line: number }[]}
 */
export function collectCitations(scannedFiles) {
  return scannedFiles.flatMap(({ path, text }) =>
    parseLogCitations(text).map((citation) => ({ path, ...citation })),
  );
}

/**
 * A `docs/logs/<name>.md` citation naming a log that does not exist on disk
 * — the reverse-arm counterpart to {@link checkDeadTargets}: a rule/agent/
 * skill citing a log that was renamed or never existed.
 *
 * @param {{ path: string, logFile: string, line: number }[]} citations
 * @param {Set<string>} existingLogFiles filenames present in docs/logs/
 * @returns {{ message: string, file: string, line: number }[]}
 */
export function checkDanglingCitations(citations, existingLogFiles) {
  return citations
    .filter((citation) => !existingLogFiles.has(citation.logFile))
    .map((citation) => ({
      message:
        `${citation.path}:${citation.line} cites ${LOGS_DIR}/${citation.logFile}, ` +
        `which does not exist in ${LOGS_DIR}/.`,
      file: citation.path,
      line: citation.line,
    }));
}

/**
 * All four checks composed, over already-parsed stamps and citations.
 *
 * @param {{
 *   stamps: { log: string, target: string, line: number }[],
 *   citations: { path: string, logFile: string, line: number }[],
 *   exists: (path: string) => boolean,
 *   existingLogFiles: Set<string>,
 *   scanGlobs?: string[],
 * }} input `scanGlobs` defaults to {@link SCAN_GLOBS} — override only in tests
 * @returns {{ message: string, file: string, line?: number }[]}
 */
export function checkPromotionStamps({
  stamps,
  citations,
  exists,
  existingLogFiles,
  scanGlobs = SCAN_GLOBS,
}) {
  return [
    ...checkDeadTargets(stamps, exists),
    ...checkStaleAliases(exists),
    ...checkDanglingCitations(citations, existingLogFiles),
    ...checkMissingLiteralGlobs(scanGlobs, exists),
  ];
}
