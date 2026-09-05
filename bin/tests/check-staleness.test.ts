import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  staleBranches,
  pendingRemotePrunes,
  orphanedTmpFiles,
  LIVE_TMP_FILES,
  DEFAULT_STALE_DAYS,
} from "../lib/staleness-scan.mjs";
import { runStalenessCheck, listTmpEntries } from "../check-staleness.mjs";
import { createReporter } from "../lib/report.mjs";

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "m3l-check-staleness-"));
}

describe("staleBranches", () => {
  test("a merged branch attached to a worktree is NOT reported (worktree:prune's job)", () => {
    const result = staleBranches({
      mergedSet: new Set(["feat/x"]),
      goneSet: new Set(),
      worktreeBranches: new Set(["feat/x"]),
      currentBranch: "main",
    });
    expect(result).toEqual([]);
  });

  test("a [gone] branch not attached to any worktree IS reported", () => {
    const result = staleBranches({
      mergedSet: new Set(),
      goneSet: new Set(["feat/gone"]),
      worktreeBranches: new Set(),
      currentBranch: "main",
    });
    expect(result).toEqual([
      { branch: "feat/gone", reasons: ["upstream gone"] },
    ]);
  });

  test("a branch both merged and [gone], not attached to a worktree, reports once with both reasons", () => {
    const result = staleBranches({
      mergedSet: new Set(["feat/both"]),
      goneSet: new Set(["feat/both"]),
      worktreeBranches: new Set(),
      currentBranch: "main",
    });
    expect(result).toEqual([
      { branch: "feat/both", reasons: ["merged", "upstream gone"] },
    ]);
  });

  test("main is never reported even if merged and gone", () => {
    const result = staleBranches({
      mergedSet: new Set(["main"]),
      goneSet: new Set(["main"]),
      worktreeBranches: new Set(),
      currentBranch: "feat/other",
    });
    expect(result).toEqual([]);
  });

  test("the current branch is never reported even if merged and gone", () => {
    const result = staleBranches({
      mergedSet: new Set(["feat/here"]),
      goneSet: new Set(["feat/here"]),
      worktreeBranches: new Set(),
      currentBranch: "feat/here",
    });
    expect(result).toEqual([]);
  });

  test("results are sorted by branch name", () => {
    const result = staleBranches({
      mergedSet: new Set(),
      goneSet: new Set(["feat/zeta", "feat/alpha"]),
      worktreeBranches: new Set(),
      currentBranch: "main",
    });
    expect(result.map((r) => r.branch)).toEqual(["feat/alpha", "feat/zeta"]);
  });
});

describe("pendingRemotePrunes", () => {
  test("parses multiple '* [would prune] ...' lines", () => {
    const runGit = () =>
      [
        "Pruning origin",
        "URL: git@example.com:org/repo.git",
        "* [would prune] origin/feat-a",
        "* [would prune] origin/feat-b",
      ].join("\n");
    expect(pendingRemotePrunes(runGit)).toEqual({
      ok: true,
      refs: ["origin/feat-a", "origin/feat-b"],
      error: null,
    });
  });

  test("captures the error message instead of throwing when runGit throws", () => {
    const runGit = () => {
      throw new Error("could not resolve host");
    };
    expect(() => pendingRemotePrunes(runGit)).not.toThrow();
    expect(pendingRemotePrunes(runGit)).toEqual({
      ok: false,
      refs: [],
      error: "could not resolve host",
    });
  });

  test("no matching lines yields an empty, still-ok result", () => {
    const runGit = () => "Pruning origin\nURL: git@example.com:org/repo.git\n";
    expect(pendingRemotePrunes(runGit)).toEqual({
      ok: true,
      refs: [],
      error: null,
    });
  });
});

describe("orphanedTmpFiles", () => {
  test("an allowlisted LIVE_TMP_FILES entry is never orphaned, even far in the past", () => {
    const [liveRelPath] = [...LIVE_TMP_FILES];
    const now = new Date("2026-09-05T00:00:00Z");
    const result = orphanedTmpFiles({
      entries: [
        {
          relPath: liveRelPath as string,
          mtimeMs: new Date("2020-01-01T00:00:00Z").getTime(),
        },
      ],
      now,
      staleDays: 7,
    });
    expect(result).toEqual([]);
  });

  test("a non-allowlisted entry older than staleDays IS orphaned, with the exact ageDays", () => {
    const now = new Date("2026-01-08T00:00:00Z");
    const mtimeMs = new Date("2026-01-01T00:00:00Z").getTime();
    const result = orphanedTmpFiles({
      entries: [{ relPath: "tmp/some-journal.md", mtimeMs }],
      now,
      staleDays: 7,
    });
    expect(result).toEqual([{ relPath: "tmp/some-journal.md", ageDays: 7 }]);
  });

  test("a non-allowlisted entry younger than staleDays is NOT orphaned", () => {
    const now = new Date("2026-01-08T00:00:00Z");
    const mtimeMs = new Date("2026-01-03T00:00:00Z").getTime(); // 5 days old
    const result = orphanedTmpFiles({
      entries: [{ relPath: "tmp/some-journal.md", mtimeMs }],
      now,
      staleDays: 7,
    });
    expect(result).toEqual([]);
  });

  test("the default staleDays equals DEFAULT_STALE_DAYS when omitted", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    now.setUTCDate(now.getUTCDate() + DEFAULT_STALE_DAYS);
    const mtimeMs = new Date("2026-01-01T00:00:00Z").getTime();
    const result = orphanedTmpFiles({
      entries: [{ relPath: "tmp/some-journal.md", mtimeMs }],
      now,
    });
    expect(result).toEqual([
      { relPath: "tmp/some-journal.md", ageDays: DEFAULT_STALE_DAYS },
    ]);
  });

  test("results are sorted by relPath", () => {
    const now = new Date("2026-01-08T00:00:00Z");
    const mtimeMs = new Date("2026-01-01T00:00:00Z").getTime();
    const result = orphanedTmpFiles({
      entries: [
        { relPath: "tmp/zeta.md", mtimeMs },
        { relPath: "tmp/alpha.md", mtimeMs },
      ],
      now,
      staleDays: 7,
    });
    expect(result.map((r) => r.relPath)).toEqual([
      "tmp/alpha.md",
      "tmp/zeta.md",
    ]);
  });
});

describe("LIVE_TMP_FILES", () => {
  test("is a Set containing exactly the 3 documented live tmp/ files", () => {
    expect(LIVE_TMP_FILES).toBeInstanceOf(Set);
    expect(LIVE_TMP_FILES).toEqual(
      new Set([
        "tmp/slice-progress.json",
        "tmp/compact-handoff.json",
        "tmp/session-incidents.jsonl",
      ]),
    );
  });
});

/**
 * Fabricates a `runGit` that dispatches on the joined argv, mirroring
 * `bin/tests/worktree-prune.test.ts`'s fake-runGit style. Throws for any
 * unmapped call so a test's assumptions about which git calls happen are
 * self-checking rather than silently returning `undefined`.
 */
function makeGit(
  responses: Record<string, string | (() => string)>,
): (args: string[]) => string {
  return (args: string[]) => {
    const key = args.join(" ");
    const entry = responses[key];
    if (entry === undefined) {
      throw new Error(`unexpected git call in test fixture: ${key}`);
    }
    return typeof entry === "function" ? entry() : entry;
  };
}

/** A single-worktree (main only), nothing merged/gone, git fixture. */
const CLEAN_GIT_RESPONSES: Record<string, string> = {
  "worktree list --porcelain": [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
  ].join("\n"),
  "rev-parse --abbrev-ref HEAD": "main",
  "branch --merged main --format=%(refname:short)": "main",
  "for-each-ref refs/heads --format=%(refname:short)%09%(upstream:track)":
    "main\t",
};

describe("runStalenessCheck", () => {
  test("a fully clean scenario returns ok:true with no findings", () => {
    const reporter = createReporter(true);
    const outcome = runStalenessCheck({
      runGit: makeGit(CLEAN_GIT_RESPONSES),
      listTmp: () => [],
      now: new Date("2026-09-05T00:00:00Z"),
      staleDays: DEFAULT_STALE_DAYS,
      fetchRemote: false,
      reporter,
    });
    expect(outcome).toEqual({ ok: true, findings: [] });
  });

  test("a [gone]-upstream worktree produces a worktree:prune finding and ok:false", () => {
    const responses: Record<string, string> = {
      "worktree list --porcelain": [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /repo-feat",
        "HEAD def456",
        "branch refs/heads/feat/x",
        "",
      ].join("\n"),
      "rev-parse --abbrev-ref HEAD": "main",
      "branch --merged main --format=%(refname:short)": "main",
      "for-each-ref refs/heads --format=%(refname:short)%09%(upstream:track)":
        "main\t\nfeat/x\t[gone]",
    };
    const reporter = createReporter(true);
    const outcome = runStalenessCheck({
      runGit: makeGit(responses),
      listTmp: () => [],
      now: new Date("2026-09-05T00:00:00Z"),
      staleDays: DEFAULT_STALE_DAYS,
      fetchRemote: false,
      reporter,
    });
    expect(outcome.ok).toBe(false);
    expect(
      outcome.findings.some(
        (f: string) =>
          f.includes("pnpm worktree:prune") && f.includes("feat/x"),
      ),
    ).toBe(true);
  });

  test("a throwing remote-prune dry-run warns but adds no finding, and does not throw", () => {
    const responses: Record<string, string | (() => string)> = {
      ...CLEAN_GIT_RESPONSES,
      "remote prune origin --dry-run": () => {
        throw new Error("could not resolve host");
      },
    };
    const reporter = createReporter(true);
    let outcome: { ok: boolean; findings: string[] } | undefined;
    expect(() => {
      outcome = runStalenessCheck({
        runGit: makeGit(responses),
        listTmp: () => [],
        now: new Date("2026-09-05T00:00:00Z"),
        staleDays: DEFAULT_STALE_DAYS,
        fetchRemote: true,
        reporter,
      });
    }).not.toThrow();
    expect(outcome).toEqual({ ok: true, findings: [] });
    const payload = reporter.finish();
    expect(
      (payload["warnings"] as string[]).some((w) =>
        w.includes("remote-tracking-ref staleness could not be checked"),
      ),
    ).toBe(true);
    expect(payload["errors"]).toEqual([]);
  });

  test("one orphaned tmp/ entry produces a finding mentioning its relPath", () => {
    const reporter = createReporter(true);
    const now = new Date("2026-09-05T00:00:00Z");
    const old = new Date(now);
    old.setUTCDate(old.getUTCDate() - (DEFAULT_STALE_DAYS + 1));
    const outcome = runStalenessCheck({
      runGit: makeGit(CLEAN_GIT_RESPONSES),
      listTmp: () => [
        { relPath: "tmp/orphaned-journal.md", mtimeMs: old.getTime() },
      ],
      now,
      staleDays: DEFAULT_STALE_DAYS,
      fetchRemote: false,
      reporter,
    });
    expect(outcome.ok).toBe(false);
    expect(
      outcome.findings.some((f: string) =>
        f.includes("tmp/orphaned-journal.md"),
      ),
    ).toBe(true);
  });
});

describe("listTmpEntries", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns one entry with the correct relPath and a numeric mtimeMs for a real file", () => {
    dir = mktemp();
    writeFileSync(join(dir, "some-file.txt"), "hello\n");

    const entries = listTmpEntries(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.relPath).toBe("tmp/some-file.txt");
    expect(typeof entries[0]?.mtimeMs).toBe("number");
  });

  test("a nonexistent directory returns [] without throwing", () => {
    const missing = join(tmpdir(), "m3l-check-staleness-does-not-exist");
    expect(() => listTmpEntries(missing)).not.toThrow();
    expect(listTmpEntries(missing)).toEqual([]);
  });

  test("a subdirectory inside the tmp dir is excluded (only files count)", () => {
    dir = mktemp();
    writeFileSync(join(dir, "kept.txt"), "hi\n");
    mkdirSync(join(dir, "a-subdir"));
    writeFileSync(join(dir, "a-subdir", "nested.txt"), "nested\n");

    const entries = listTmpEntries(dir);
    expect(entries.map((e) => e.relPath)).toEqual(["tmp/kept.txt"]);
  });
});
