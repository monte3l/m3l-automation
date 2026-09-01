#!/usr/bin/env node
// Warns (non-blocking) when the retrospective loop's two inputs have drifted:
// the auto-memory store's own health, and how far the work-log sweep has
// fallen behind. ADR-0084's self-polling half, modelled on
// bin/check-harness-freshness.mjs (ADR-0082) — same reporter, same
// always-exit-0 shape, same "target missing -> warn and move on" behaviour.
//
// Why a gate reaches OUTSIDE the repo. The auto-memory store lives at
// ~/.claude/projects/<slug>/memory/, not in git, so no PR can review it and
// no existing gate can see it. That blind spot is not hypothetical: on
// 2026-09-01 the store held a memory file (write-tool-control-byte-trap.md)
// carrying literal 0x00 and 0x1f bytes — the memory documenting the
// Write-tool control-byte trap, corrupted by that exact trap.
// check:control-chars structurally cannot catch it, because
// bin/check-control-chars.mjs scans git-TRACKED files by design. Same defect
// class, different filesystem; this gate covers the other side.
//
// Everything here is offline and cheap (a directory read of ~50 small files).
// It NEVER blocks: every finding is a warning and the process always exits 0,
// exactly like check:harness-freshness and check:context-budget. On CI the
// memory store is absent entirely and the gate is a clean no-op.
//
// Usage:
//   node bin/check-retrospective.mjs
//   node bin/check-retrospective.mjs --json        # ADR-0030 structured report
//   node bin/check-retrospective.mjs --dir <path>  # point at a fixture store
//   pnpm check:retrospective
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveClaudeProjectDir } from "./lib/claude-home.mjs";
import { scanControlChars } from "./lib/control-char-scan.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The tracker PR 4 writes; section B reads only its header comment. */
export const TRACKER_PATH = "docs/research/retrospective.md";

/** Where work logs live — the denominator for the sweep-backlog count. */
export const LOGS_DIR = "docs/logs";

/**
 * The four memory types Anthropic's auto-memory frontmatter documents. A
 * `metadata.type` outside this set is a typo, not a fifth category — the
 * recall step filters on it, so a misspelled type makes the memory
 * effectively unreachable.
 */
export const MEMORY_TYPES = new Set([
  "user",
  "feedback",
  "project",
  "reference",
]);

/**
 * MEMORY.md is loaded into context in full at every session start, so it is
 * charged against the same budget CLAUDE.md is. Anthropic's documented cap is
 * 200 lines / 25 KB; warn at 80% of each so the ceiling is visible while
 * there is still room to act on it, rather than at the moment it is breached.
 */
export const INDEX_LINE_CAP = 200;
export const INDEX_BYTE_CAP = 25 * 1024;
export const INDEX_WARN_RATIO = 0.8;

/**
 * How many un-swept work logs may accumulate before the sweep is considered
 * overdue. Matches the "every ~5 logs" cadence /writing-work-logs documents —
 * which, before this gate, nothing polled.
 */
export const SWEEP_BACKLOG_THRESHOLD = 5;

/** Backstop for a sweep that stalls without new logs arriving. */
export const SWEEP_STALENESS_THRESHOLD_DAYS = 90;

const HEADER_PATTERN =
  /<!--\s*retrospective:\s*last-swept=(\S+)\s+logs-considered=(\S+)\s*-->/;

/**
 * A `[[wikilink]]` as the memory convention actually spells one: a lowercase
 * kebab-case slug matching a memory's `name:` field. Deliberately NOT a
 * permissive `[[...]]` — memories quote shell in prose, and zsh's `[[ -o
 * login ]]` test is a real string in this store. A permissive pattern reports
 * it as a broken link on every run, which is how an advisory gate teaches a
 * maintainer to ignore it.
 */
const WIKILINK_PATTERN = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;

/**
 * The auto-memory store for THIS repo — `memory/` inside Claude Code's
 * per-project directory. See bin/lib/claude-home.mjs for why the slug is
 * derived from the git COMMON dir.
 *
 * @param {(args: string[]) => string} runGitFn injected git seam
 * @param {string} home the user's home directory
 * @returns {string} absolute path to the memory directory
 */
export function resolveMemoryDir(runGitFn, home) {
  return join(resolveClaudeProjectDir(runGitFn, home), "memory");
}

/**
 * Filenames linked from MEMORY.md, which is the index actually loaded into
 * context. A memory file absent from here is written but never recalled.
 *
 * @param {string} contents MEMORY.md's text
 * @returns {string[]} link targets, in document order
 */
export function parseIndexEntries(contents) {
  return [...contents.matchAll(/^-\s*\[[^\]]*\]\(([^)]+)\)/gm)].map(
    (match) => match[1],
  );
}

/**
 * Pull the three frontmatter fields the memory contract requires. Returns
 * nulls rather than throwing so one malformed file yields a finding instead
 * of aborting the whole scan.
 *
 * @param {string} contents a memory file's text
 * @returns {{ name: string | null, description: string | null, type: string | null }}
 */
export function parseMemoryFrontmatter(contents) {
  const match = /^---\n([\s\S]*?)\n---/.exec(contents);
  const block = match ? match[1] : "";
  const field = (pattern) => {
    const hit = pattern.exec(block);
    return hit ? hit[1].trim().replace(/^["']|["']$/g, "") : null;
  };
  return {
    name: field(/^name:\s*(.+)$/m),
    description: field(/^description:\s*(.+)$/m),
    type: field(/^\s+type:\s*(.+)$/m),
  };
}

/**
 * Both directions of the index/file reconciliation. An orphan (on disk, not
 * indexed) is silently unreachable; a dangling entry (indexed, not on disk)
 * points recall at nothing.
 *
 * @param {string[]} indexEntries link targets from MEMORY.md
 * @param {string[]} fileNames memory filenames on disk, excluding MEMORY.md
 * @returns {string[]} one finding per direction that has drifted
 */
export function checkIndexReconciliation(indexEntries, fileNames) {
  const indexed = new Set(indexEntries.map((entry) => basename(entry)));
  const onDisk = new Set(fileNames);

  /** @type {string[]} */
  const findings = [];

  const orphans = fileNames.filter((name) => !indexed.has(name)).sort();
  if (orphans.length > 0) {
    findings.push(
      `${orphans.length} memory file(s) are on disk but absent from ` +
        `MEMORY.md, so they are written but never recalled: ` +
        `${orphans.join(", ")}. Add a one-line pointer for each.`,
    );
  }

  const dangling = [...indexed].filter((name) => !onDisk.has(name)).sort();
  if (dangling.length > 0) {
    findings.push(
      `${dangling.length} MEMORY.md entr(ies) point at a file that does not ` +
        `exist: ${dangling.join(", ")}. Remove the pointer or restore the ` +
        `memory.`,
    );
  }

  return findings;
}

/**
 * Every memory needs a `name`, a `description` (the field recall ranks on),
 * and a `metadata.type` drawn from the four documented values.
 *
 * @param {{ path: string, contents: string }[]} files
 * @returns {string[]} one finding per non-conforming file
 */
export function checkFrontmatter(files) {
  /** @type {string[]} */
  const findings = [];

  for (const { path, contents } of files) {
    const { name, description, type } = parseMemoryFrontmatter(contents);
    /** @type {string[]} */
    const problems = [];

    if (!name) problems.push("no `name:`");
    if (!description) problems.push("no `description:`");
    if (!type) {
      problems.push("no `metadata.type:`");
    } else if (!MEMORY_TYPES.has(type)) {
      problems.push(
        `\`metadata.type: ${type}\` is not one of ` +
          `${[...MEMORY_TYPES].join(", ")}`,
      );
    }

    if (problems.length > 0) {
      findings.push(
        `${path} has malformed frontmatter (${problems.join("; ")}) — ` +
          `recall filters on these fields, so the memory is effectively ` +
          `unreachable.`,
      );
    }
  }

  return findings;
}

/**
 * Every `[[wikilink]]` must resolve to some memory's `name:`. A link that
 * does not is usually a near-miss for a real memory rather than a
 * placeholder, and it silently breaks the graph the links exist to build.
 *
 * @param {{ path: string, contents: string }[]} files
 * @param {Set<string>} names every memory's `name:` value
 * @returns {string[]} one finding per file carrying broken links
 */
export function checkWikilinks(files, names) {
  /** @type {string[]} */
  const findings = [];

  for (const { path, contents } of files) {
    const broken = [
      ...new Set(
        [...contents.matchAll(WIKILINK_PATTERN)]
          .map((match) => match[1])
          .filter((slug) => !names.has(slug)),
      ),
    ].sort();

    if (broken.length > 0) {
      findings.push(
        `${path} links to ${broken.length} memor(ies) that do not exist: ` +
          `${broken.map((slug) => `[[${slug}]]`).join(", ")}. Fix the slug ` +
          `or write the memory.`,
      );
    }
  }

  return findings;
}

/**
 * MEMORY.md against the context-load cap. Warns at 80% so the ceiling is
 * actionable before it is breached, and reports a breach separately.
 *
 * @param {string} contents MEMORY.md's text
 * @returns {string[]}
 */
export function checkIndexBudget(contents) {
  const lines = contents.split("\n").length;
  const bytes = Buffer.byteLength(contents, "utf8");
  /** @type {string[]} */
  const findings = [];

  /**
   * @param {number} value
   * @param {number} cap
   * @param {string} unit
   */
  const measure = (value, cap, unit) => {
    if (value > cap) {
      findings.push(
        `MEMORY.md is ${value} ${unit} — over the ${cap}-${unit} load cap. ` +
          `Consolidate or delete memories; it is injected in full at every ` +
          `session start.`,
      );
    } else if (value >= Math.floor(cap * INDEX_WARN_RATIO)) {
      findings.push(
        `MEMORY.md is ${value} ${unit}, at ` +
          `${Math.round((value / cap) * 100)}% of the ${cap}-${unit} load cap.`,
      );
    }
  };

  measure(lines, INDEX_LINE_CAP, "lines");
  measure(bytes, INDEX_BYTE_CAP, "bytes");

  return findings;
}

/**
 * Section B's header parse. `unset` is the never-swept state and is treated
 * as stale rather than as fresh — the same choice check-harness-freshness
 * makes, and for the same reason: a scaffolded-but-empty tracker read as
 * "fresh" is how a gate goes quiet forever.
 *
 * @param {string} contents the tracker's text
 * @returns {{ lastSwept: string, logsConsidered: number | null } | null}
 */
export function parseSweepHeader(contents) {
  const match = HEADER_PATTERN.exec(contents);
  if (!match) return null;
  const logsConsidered = Number.parseInt(match[2], 10);
  return {
    lastSwept: match[1],
    logsConsidered: Number.isNaN(logsConsidered) ? null : logsConsidered,
  };
}

/**
 * Turn a parsed header plus the live log count into findings.
 *
 * @param {{ lastSwept: string, logsConsidered: number | null } | null} header
 * @param {number} totalLogs work logs currently in docs/logs/
 * @param {Date} now injected clock, so staleness is assertable
 * @returns {string[]}
 */
export function evaluateSweepFreshness(header, totalLogs, now) {
  /** @type {string[]} */
  const findings = [];

  if (header === null) {
    findings.push(
      `${TRACKER_PATH} has no parseable ` +
        `"retrospective: last-swept=... logs-considered=..." header comment.`,
    );
    return findings;
  }

  const { lastSwept, logsConsidered } = header;

  if (logsConsidered === null) {
    findings.push(
      `${TRACKER_PATH}'s logs-considered value is not a number — the sweep ` +
        `backlog cannot be computed.`,
    );
  } else {
    const backlog = totalLogs - logsConsidered;
    if (backlog >= SWEEP_BACKLOG_THRESHOLD) {
      findings.push(
        `${backlog} work log(s) have not been swept (${totalLogs} in ` +
          `${LOGS_DIR}, ${logsConsidered} considered) — at or over the ` +
          `${SWEEP_BACKLOG_THRESHOLD}-log cadence. Run ` +
          `/promoting-work-log-lessons.`,
      );
    }
  }

  if (lastSwept === "unset") {
    findings.push(
      `${TRACKER_PATH} has never been swept (last-swept=unset) — run ` +
        `/promoting-work-log-lessons.`,
    );
    return findings;
  }

  const sweptDate = new Date(`${lastSwept}T00:00:00Z`);
  if (Number.isNaN(sweptDate.getTime())) {
    findings.push(
      `${TRACKER_PATH}'s last-swept value "${lastSwept}" is not a parseable ` +
        `YYYY-MM-DD date.`,
    );
    return findings;
  }

  const staleDays = Math.floor(
    (now.getTime() - sweptDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (staleDays > SWEEP_STALENESS_THRESHOLD_DAYS) {
    findings.push(
      `${TRACKER_PATH} was last swept ${staleDays} day(s) ago ` +
        `(${lastSwept}) — over the ${SWEEP_STALENESS_THRESHOLD_DAYS}-day ` +
        `threshold. Run /promoting-work-log-lessons.`,
    );
  }

  return findings;
}

/**
 * Section A end to end, over an already-read set of memory files.
 *
 * @param {{ indexContents: string, files: { path: string, contents: string, bytes: Uint8Array }[] }} store
 * @returns {string[]}
 */
export function checkMemoryStore({ indexContents, files }) {
  const names = new Set(
    files
      .map(({ contents }) => parseMemoryFrontmatter(contents).name)
      .filter((name) => name !== null),
  );

  return [
    ...checkIndexReconciliation(
      parseIndexEntries(indexContents),
      files.map(({ path }) => basename(path)),
    ),
    ...scanControlChars(files.map(({ path, bytes }) => ({ path, bytes }))),
    ...checkFrontmatter(files),
    ...checkWikilinks(files, names),
    ...checkIndexBudget(indexContents),
  ];
}

/**
 * Read a memory store off disk. Separated from {@link checkMemoryStore} so
 * every check is unit-testable without a fixture directory, while `--dir`
 * still exercises the real read path.
 *
 * @param {string} dir absolute path to the memory directory
 * @param {{ readdir: typeof readdirSync, readFile: typeof readFileSync }} fs
 * @returns {{ indexContents: string, files: { path: string, contents: string, bytes: Uint8Array }[] }}
 */
export function readMemoryStore(dir, fs) {
  const entries = fs
    .readdir(dir)
    .filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
    .sort();

  const files = entries.map((name) => {
    const bytes = fs.readFile(join(dir, name));
    return { path: name, contents: bytes.toString("utf8"), bytes };
  });

  return {
    indexContents: fs.readFile(join(dir, "MEMORY.md")).toString("utf8"),
    files,
  };
}

/**
 * Run both sections against injected seams. Returns the outcome rather than
 * exiting, so every branch is assertable — and note that `ok: false` here
 * does NOT mean a non-zero exit: the CLI below always exits 0. The two are
 * deliberately separate so tests can assert a real failure on a seeded defect
 * while `pre-push` and CI stay unblocked.
 *
 * @param {{
 *   memoryDir: string,
 *   readMemory: (dir: string) => ReturnType<typeof readMemoryStore>,
 *   readTracker: () => string,
 *   countLogs: () => number,
 *   now: Date,
 *   reporter: ReturnType<typeof createReporter>,
 * }} deps
 * @returns {{ ok: boolean, findings: string[], scanned: number }}
 */
export function runRetrospectiveCheck({
  memoryDir,
  readMemory,
  readTracker,
  countLogs,
  now,
  reporter,
}) {
  /** @type {string[]} */
  const findings = [];
  let scanned = 0;

  // Section A — memory-store health.
  try {
    const store = readMemory(memoryDir);
    scanned = store.files.length;
    findings.push(...checkMemoryStore(store));
  } catch (cause) {
    // The CI condition: no memory store on the runner at all. Warn and move
    // on, exactly as check-harness-freshness does for a missing tracker.
    reporter.warn(
      `No auto-memory store readable at ${memoryDir} — skipping the ` +
        `memory-health section. (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      { file: TRACKER_PATH },
    );
  }

  // Section B — sweep freshness.
  try {
    findings.push(
      ...evaluateSweepFreshness(
        parseSweepHeader(readTracker()),
        countLogs(),
        now,
      ),
    );
  } catch (cause) {
    reporter.warn(
      `${TRACKER_PATH} not found — run /promoting-work-log-lessons to ` +
        `create it. (${cause instanceof Error ? cause.message : String(cause)})`,
      { file: TRACKER_PATH },
    );
  }

  for (const finding of findings) reporter.warn(finding);

  if (findings.length === 0) {
    reporter.succeed(
      `Retrospective loop healthy: ${scanned} memor(ies) indexed, ` +
        `well-formed and link-clean; work-log sweep within cadence.`,
    );
  }

  reporter.finish({ findings, scanned, memoryDir });
  return { ok: findings.length === 0, findings, scanned };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);

  const dirFlag = argv.indexOf("--dir");
  const memoryDir =
    dirFlag !== -1 && argv[dirFlag + 1]
      ? argv[dirFlag + 1]
      : resolveMemoryDir(
          (args) => execFileSync("git", args, { encoding: "utf8", cwd: root }),
          homedir(),
        );

  runRetrospectiveCheck({
    memoryDir,
    readMemory: (dir) =>
      readMemoryStore(dir, { readdir: readdirSync, readFile: readFileSync }),
    readTracker: () => readFileSync(join(root, TRACKER_PATH), "utf8"),
    countLogs: () =>
      readdirSync(join(root, LOGS_DIR)).filter(
        (name) => name.endsWith(".md") && name !== "README.md",
      ).length,
    now: new Date(),
    reporter,
  });

  // Advisory only — never blocks a push. See runRetrospectiveCheck's note.
  process.exit(0);
}
