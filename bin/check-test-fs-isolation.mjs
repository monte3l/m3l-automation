#!/usr/bin/env node
// Closes the one part of the test-I/O sandbox policy (style-guide.md §
// Runner, layout & the test-I/O policy; docs/adr/0100-test-fs-sandbox-isolation.md)
// that a per-node ESLint `no-restricted-syntax` selector structurally cannot
// express: "this file created a mkdtemp() sandbox but never tore it down
// anywhere." ESLint's selector model visits one AST node at a time; it has no
// "this file lacks pattern X" primitive, so the seven no-restricted-syntax
// selectors in eslint.config.js (literal path, symlink/link's arg-1 literal
// path, the member-call form, a process.cwd()-rooted path, an
// import.meta.dirname-rooted path, a mkdtemp() root not under os.tmpdir())
// cover every rule EXCEPT this one.
//
// Deliberately weak on purpose, not a placeholder for a stronger version
// later: proving the `rm`/`rmSync` call actually reaches THAT SPECIFIC
// mkdtemp() root needs dataflow analysis this gate does not attempt (a
// variable could be reassigned, the root could be threaded through a helper,
// cleanup could run in a different file's shared afterEach). A plain
// substring presence check — "the file contains an mkdtemp/mkdtempSync call;
// does it also contain an rm/rmSync call anywhere?" — catches the blatant
// omission (a sandbox created and never torn down at all) at negligible cost,
// which is the failure mode worth guarding against. Both a false positive and
// a false negative remain possible in the same lexical-vs-semantic direction:
// a comment mentioning `mkdtemp(x)` with no real cleanup call reports a
// violation that isn't one, and an `rm(...)` appearing only in a comment or
// string masks a real one. Neither is worth guarding against here — a file
// passing this check is not proven leak-free; it is proven to at least
// mention cleanup. Do not read more into a green result than that.
//
// `**/tests/integration/**` is excluded, matching eslint.config.js's ignores
// for the same reason: that layer runs under its own
// vitest.integration.config.ts and the sandbox policy was never written for
// it.
//
// Usage:
//   node bin/check-test-fs-isolation.mjs
//   node bin/check-test-fs-isolation.mjs --json   # ADR-0030 structured report
//   pnpm check:test-fs-isolation
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";
import { findMissingCleanup } from "./lib/test-fs-isolation.mjs";

const root = repoRoot(import.meta.url);

/**
 * The single injected git execution seam, mirroring `runGit` in
 * check-control-chars.mjs so nothing here shells out directly in
 * `bin/tests/**`.
 *
 * @param {string[]} args
 * @returns {string}
 */
function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Every git-tracked test file this policy governs: `**\/*.test.ts`,
 * `**\/*.test.tsx`, `**\/tests/**\/*.ts`, `**\/tests/**\/*.tsx` — the same
 * glob eslint.config.js's sandbox block matches — with
 * `**\/tests/integration/**` excluded, matching that block's `ignores`.
 *
 * @param {(args: string[]) => string} runGitFn
 * @returns {string[]}
 */
export function listCandidateTestFiles(runGitFn) {
  const tracked = runGitFn(["ls-files", "-z"]).split("\0").filter(Boolean);
  return tracked.filter((path) => {
    // `(^|\/)` anchors both patterns so a repo-root tests/ directory (no
    // leading slash in a git-relative path) matches exactly like a nested
    // one — mirroring bin/lib/protected-paths.mjs's isProtectedPath anchor
    // for the same reason. A plain `/tests/integration/` substring check
    // would silently miss `tests/integration/foo.ts` at the repo root.
    if (/(^|\/)tests\/integration\//.test(path)) return false;
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return true;
    return /(^|\/)tests\/.*\.tsx?$/.test(path);
  });
}

/**
 * Run the gate against injected seams. Returns the outcome rather than
 * calling `process.exit`, so every branch is assertable.
 *
 * @param {{
 *   runGit: typeof runGit,
 *   readFile: (path: string) => string,
 *   reporter: ReturnType<typeof createReporter>,
 * }} deps
 * @returns {{ ok: boolean, findings: string[], scanned: number }}
 */
export function runTestFsIsolationCheck({
  runGit: runGitFn,
  readFile: readFileFn,
  reporter,
}) {
  try {
    const candidates = listCandidateTestFiles(runGitFn);
    if (candidates.length === 0) {
      reporter.error(
        "`git ls-files` returned no candidate test files — refusing to " +
          "report a clean scan of nothing.",
      );
      reporter.finish({ findings: [], scanned: 0 });
      return { ok: false, findings: [], scanned: 0 };
    }

    /** @type {string[]} */
    const findings = [];

    for (const path of candidates) {
      let source;
      try {
        source = readFileFn(path);
      } catch (cause) {
        findings.push(
          `Could not read tracked file ${path} ` +
            `(${cause instanceof Error ? cause.message : String(cause)}). ` +
            `Not skipping silently — resolve it or the file goes unscanned.`,
        );
        continue;
      }
      if (findMissingCleanup(source)) {
        findings.push(
          `${path}: creates an mkdtemp()/mkdtempSync() sandbox but the file ` +
            `contains no rm()/rmSync() call anywhere — the sandbox is never ` +
            `torn down (style-guide.md § Runner, layout & the test-I/O policy).`,
        );
      }
    }

    for (const message of findings) reporter.error(message);

    if (findings.length > 0) {
      reporter.finish({ findings, scanned: candidates.length });
      return { ok: false, findings, scanned: candidates.length };
    }

    reporter.succeed(
      `${candidates.length} test file(s) checked for a torn-down mkdtemp() ` +
        `sandbox — none missing cleanup.`,
    );
    reporter.finish({ findings, scanned: candidates.length });
    return { ok: true, findings, scanned: candidates.length };
  } catch (cause) {
    reporter.error(
      `Test-fs-isolation scan failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish({ findings: [], scanned: 0 });
    return { ok: false, findings: [], scanned: 0 };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const outcome = runTestFsIsolationCheck({
    runGit,
    readFile: (path) => readFileSync(join(root, path), "utf8"),
    reporter,
  });
  if (!outcome.ok) process.exit(1);
}
