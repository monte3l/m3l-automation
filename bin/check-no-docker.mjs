#!/usr/bin/env node
// Fails when a tracked file is a banned Docker artifact (Dockerfile,
// *.dockerfile, .dockerignore, docker-compose.y*ml), or when a workflow,
// package.json scripts block, bin/ script, or lefthook.yml lane invokes
// `docker`/`docker compose`/`docker-compose`. See bin/lib/docker-ban-scan.mjs
// for the full rationale (ADR-0091: Podman replaces Docker project-wide).
//
// Needs no network and no `gh` auth — reads only the git index and the
// working tree — so it runs on pre-push and in CI unconditionally.
//
// Usage:
//   node bin/check-no-docker.mjs
//   node bin/check-no-docker.mjs --json     # ADR-0030 structured report
//   pnpm check:no-docker
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INVOCATION_SCAN_EXACT,
  INVOCATION_SCAN_PREFIXES,
  scanFilenames,
  scanPackageJsonScripts,
  scanRawInvocations,
} from "./lib/docker-ban-scan.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The single injected git execution seam, mirroring `runGit` in
 * check-control-chars.mjs so nothing here shells out directly in
 * `bin/tests/**`. Always an argv array — never a shell string.
 *
 * @param {string[]} args
 * @returns {string} the child process's captured stdout
 */
function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Every git-TRACKED path, NUL-delimited so a filename containing a newline
 * cannot split one entry into two.
 *
 * @param {(args: string[]) => string} runGitFn
 * @returns {string[]}
 */
export function listTrackedFiles(runGitFn) {
  return runGitFn(["ls-files", "-z"]).split("\0").filter(Boolean);
}

/**
 * True when `path` is a candidate for the raw-content invocation scan
 * (workflows, `bin/**`, `lefthook.yml`) — everything else in the repo may
 * mention "docker" freely; only files that execute commands are scanned.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isInvocationScanCandidate(path) {
  if (INVOCATION_SCAN_EXACT.has(path)) return true;
  return INVOCATION_SCAN_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Read each candidate path as UTF-8 text. A path that cannot be read is
 * reported, never skipped silently.
 *
 * @param {string[]} paths
 * @param {(path: string) => string} readFileFn
 * @returns {{ files: { path: string, content: string }[], errors: string[] }}
 */
function readTextFiles(paths, readFileFn) {
  /** @type {{ path: string, content: string }[]} */
  const files = [];
  /** @type {string[]} */
  const errors = [];

  for (const path of paths) {
    try {
      files.push({ path, content: readFileFn(path) });
    } catch (cause) {
      errors.push(
        `Could not read tracked file ${path} ` +
          `(${cause instanceof Error ? cause.message : String(cause)}). ` +
          `Not skipping silently — resolve it or the file goes unscanned.`,
      );
    }
  }

  return { files, errors };
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
export function runDockerBanCheck({
  runGit: runGitFn,
  readFile: readFileFn,
  reporter,
}) {
  try {
    const tracked = listTrackedFiles(runGitFn);
    if (tracked.length === 0) {
      reporter.error(
        "`git ls-files` returned no tracked files — refusing to report a " +
          "clean scan of nothing.",
      );
      reporter.finish({ findings: [], scanned: 0 });
      return { ok: false, findings: [], scanned: 0 };
    }

    const filenameFindings = scanFilenames(tracked);

    const invocationPaths = tracked.filter(isInvocationScanCandidate);
    const { files: invocationFiles, errors: invocationErrors } = readTextFiles(
      invocationPaths,
      readFileFn,
    );
    const invocationFindings = scanRawInvocations(invocationFiles);

    const packageJsonPaths = tracked.filter((p) => p.endsWith("package.json"));
    const { files: packageJsonFiles, errors: packageJsonErrors } =
      readTextFiles(packageJsonPaths, readFileFn);
    const packageJsonFindings = scanPackageJsonScripts(packageJsonFiles);

    const findings = [
      ...filenameFindings,
      ...invocationErrors,
      ...invocationFindings,
      ...packageJsonErrors,
      ...packageJsonFindings,
    ];

    for (const message of findings) reporter.error(message);

    const scanned = tracked.length;
    if (findings.length > 0) {
      reporter.finish({ findings, scanned });
      return { ok: false, findings, scanned };
    }

    reporter.succeed(
      `No banned Docker artifacts or invocations found across ${scanned} ` +
        `tracked file(s) (${invocationFiles.length} scanned for command ` +
        `invocations, ${packageJsonFiles.length} package.json scripts block(s) ` +
        `checked).`,
    );
    reporter.finish({ findings, scanned });
    return { ok: true, findings, scanned };
  } catch (cause) {
    reporter.error(
      `Docker-ban scan failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish({ findings: [], scanned: 0 });
    return { ok: false, findings: [], scanned: 0 };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const outcome = runDockerBanCheck({
    runGit,
    readFile: (path) => readFileSync(join(root, path), "utf8"),
    reporter,
  });
  if (!outcome.ok) process.exit(1);
}
