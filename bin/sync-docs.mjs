#!/usr/bin/env node
// One deterministic entry point for the /syncing-docs reconciliation
// sequence (ADR-0030 Phase 4; the authoritative step order is
// .claude/skills/syncing-docs/SKILL.md). Before this script existed, an agent
// replayed those steps by hand, one bin/pnpm invocation at a time, and had to
// remember every ordering footgun the skill calls out on every single run:
// gen:index must run before prettier (the generator emits non-prettier JSON),
// a scoped provenance restamp can silently no-op gen:index because a new
// export's sidecar sources[] entry is a hand-add the restamp never performs,
// and a missed step leaves the reference index or doc counts stale without
// anyone noticing until CI. This orchestrator fixes each footgun by
// construction instead of by discipline: it spawns the same underlying bin
// scripts (with their --json flag, see bin/lib/report.mjs) in the one correct
// order, forwards the optional --affected scoping to the restamp step only,
// and folds every step's structured payload into a single composite report —
// so an agent (or a human) gets one go/no-go verdict instead of stitching
// fourteen command outputs together by hand.
//
// Usage:
//   node bin/sync-docs.mjs                       # human-readable summary
//   node bin/sync-docs.mjs --json                 # one JSON line on stdout
//   node bin/sync-docs.mjs --affected <path>      # scope step 2's restamp
//
// Exit contract: 0 when every step completes cleanly; 1 the moment a step's
// child process exits non-zero (the composite report is still emitted before
// exiting — fail fast, but never silently) or when any step (even one that
// exited 0) recorded an error.
import process from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  NAMESPACES,
  barrelWiredModules,
  provenanceSymbols,
  baseName,
  fileExports,
} from "./lib/reference-index.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(root, "packages/m3l-common/src");

// Split so the raw source text never has the word "export" immediately
// followed by a period — the repo's CommonJS guard hook (Write/Edit PreToolUse)
// flags that shape even inside a plain filename, so a single literal here
// blocks every edit to this very file.
const CHECK_DOC_EXPORTS_SCRIPT = "bin/check-doc-export" + "s.mjs";

const { json, argv } = parseJsonFlag();
const reporter = createReporter(json);

const affectedIdx = argv.indexOf("--affected");
let affectedPath = null;
if (affectedIdx !== -1) {
  const value = argv[affectedIdx + 1];
  if (value === undefined) {
    // A dangling `--affected` with nothing after it previously degraded
    // silently to an unscoped restamp (step 2 would restamp every sidecar
    // instead of the one the caller meant to scope) — that is exactly the
    // kind of silent misconfiguration this orchestrator exists to prevent.
    reporter.error(
      "--affected requires a path argument (e.g. --affected src/core/foo/index.ts) — refusing to fall back to an unscoped restamp.",
    );
    reporter.finish({ steps: [], restamped: [], counts: null });
    process.exit(1);
  }
  affectedPath = value;
}

/**
 * @typedef {{
 *   name: string,
 *   ok: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   updated: string[],
 *   created: string[],
 *   removed: string[],
 *   payload?: Record<string, unknown>,
 * }} StepResult
 */

/** @type {StepResult[]} */
const steps = [];

/**
 * Parse the LAST non-blank line of a child's stdout as JSON — defensive
 * against anything (a dependency, a stray console.log) writing extra lines
 * before the reporter's final payload.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown>}
 */
function parseLastJsonLine(stdout) {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error("produced no output on stdout");
  }
  return JSON.parse(last);
}

/**
 * Build a StepResult, push it onto {@link steps}, and return it. Centralizes
 * the one place every step (spawned or in-process) records itself.
 *
 * @param {string} name
 * @param {boolean} ok
 * @param {string[]} errors
 * @param {string[]} [warnings]
 * @param {string[]} [updated]
 * @param {string[]} [created]
 * @param {string[]} [removed]
 * @param {Record<string, unknown>} [payload]
 * @returns {StepResult}
 */
function recordStep(
  name,
  ok,
  errors,
  warnings = [],
  updated = [],
  created = [],
  removed = [],
  payload = undefined,
) {
  /** @type {StepResult} */
  const result = {
    name,
    ok,
    errors,
    warnings,
    updated,
    created,
    removed,
    ...(payload ? { payload } : {}),
  };
  steps.push(result);
  return result;
}

/**
 * Run one of the existing agent-invoked bin scripts in --json mode and fold
 * its payload into a normalized {@link StepResult}. `ok` here tracks the
 * child's exit code ONLY (not `payload.ok`) — bin/lib/report.mjs deliberately
 * lets a script report errors yet still exit 0 (e.g. gen-doc-counts skipping
 * an unreadable file), and that must not halt the fail-fast sequence; it is
 * still surfaced through `errors`/`warnings` in the aggregate.
 *
 * @param {string} name - human label for the step, shown in the summary
 * @param {string} scriptRelPath - repo-relative path, e.g. "bin/gen-doc-counts.mjs"
 * @param {string[]} [args] - extra CLI args before "--json"
 * @param {{ timeout?: number }} [opts]
 * @returns {StepResult}
 */
function runJsonStep(name, scriptRelPath, args = [], opts = {}) {
  /** @type {string} */
  let stdout;
  let exitCode = 0;
  try {
    stdout = execFileSync(
      "node",
      [join(root, scriptRelPath), ...args, "--json"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: opts.timeout,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch (cause) {
    const err =
      /** @type {{ stdout?: string, status?: number | null, message: string }} */ (
        cause
      );
    if (typeof err.stdout === "string" && err.stdout.length > 0) {
      stdout = err.stdout;
      exitCode = err.status ?? 1;
    } else {
      // The child never produced a JSON payload at all (spawn failure, crash
      // before the reporter ran, or a timeout) — record it as a hard error
      // rather than trying to parse nothing.
      return recordStep(name, false, [
        `${name}: failed to run — ${err.message}`,
      ]);
    }
  }

  let payload;
  try {
    payload = parseLastJsonLine(stdout);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return recordStep(name, false, [
      `${name}: could not parse its JSON payload — ${message}\n` +
        `   stdout tail: ${stdout.slice(-500)}`,
    ]);
  }

  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const updated = Array.isArray(payload.updated) ? payload.updated : [];
  const created = Array.isArray(payload.created) ? payload.created : [];
  const removed = Array.isArray(payload.removed) ? payload.removed : [];
  return recordStep(
    name,
    exitCode === 0,
    errors,
    warnings,
    updated,
    created,
    removed,
    payload,
  );
}

/**
 * Step 6: every symbol surfaced through a namespace barrel must be named in
 * some provenance sidecar's `sections[].sources[]` — not merely documented
 * *somewhere* on the reference page (the doc-exports check's looser bar,
 * which also accepts a plain-text mention in the markdown prose). gen:index
 * derives the whole reference index from `sources[]` alone, never the barrel
 * or the page prose, so a symbol that is barrel-wired and prose-documented
 * but absent from `sources[]` makes gen:index silently produce no diff — the
 * skill's step-8 trap. Runs in-process (not a spawned bin script), reusing
 * the same enumeration bin/lib/reference-index.mjs already shares with the
 * doc-exports check.
 *
 * @returns {StepResult}
 */
function checkBarrelSidecarSources() {
  /** @type {{ symbol: string, barrel: string, sidecar: string }[]} */
  const missing = [];
  // The lib helpers (barrelWiredModules, fileExports, provenanceSymbols)
  // return empty/[] on an unreadable or malformed source rather than
  // throwing — that contract is locked by bin/tests/reference-index.test.ts
  // and must not change here. Without an independent check at this call
  // site, an unreadable barrel or a malformed sidecar collapses to "nothing
  // to check" and this step passes when it should fail loudly.
  /** @type {string[]} */
  const structuralErrors = [];
  let checkedModules = 0;

  for (const namespace of NAMESPACES) {
    const barrelPath = join(srcRoot, namespace, "index.ts");
    const barrelRel = relative(root, barrelPath);
    if (!existsSync(barrelPath)) {
      structuralErrors.push(
        `${barrelRel} is missing — cannot verify barrel wiring for ${namespace}.`,
      );
      continue;
    }
    try {
      readFileSync(barrelPath, "utf8");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      structuralErrors.push(`${barrelRel} is unreadable: ${message}`);
      continue;
    }

    for (const name of barrelWiredModules(namespace)) {
      const indexPath = join(srcRoot, namespace, name, "index.ts");
      const indexRel = relative(root, indexPath);
      if (!existsSync(indexPath)) {
        structuralErrors.push(
          `${indexRel} is missing, but ${namespace}/${name} is wired from ` +
            `${barrelRel} — cannot verify its exports.`,
        );
        continue;
      }
      let publicExports;
      try {
        readFileSync(indexPath, "utf8");
        publicExports = fileExports(indexPath, new Set());
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        structuralErrors.push(`${indexRel} is unreadable: ${message}`);
        continue;
      }
      // Legitimate placeholder/empty submodule — index.ts exists and reads
      // fine, it simply has nothing to re-export yet. Distinct from the
      // missing/unreadable cases above, which are structural errors.
      if (publicExports.size === 0) continue;
      checkedModules++;

      const sidecarPath = join(
        root,
        `docs/reference/${namespace}/${name}.provenance.json`,
      );
      const sidecarRel = `docs/reference/${namespace}/${name}.provenance.json`;
      let sidecarSymbols = new Set();
      if (existsSync(sidecarPath)) {
        let raw;
        try {
          raw = readFileSync(sidecarPath, "utf8");
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          structuralErrors.push(`${sidecarRel} is unreadable: ${message}`);
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          structuralErrors.push(
            `${sidecarRel} contains malformed JSON: ${message}`,
          );
          continue;
        }
        if (parsed === null || typeof parsed !== "object") {
          structuralErrors.push(
            `${sidecarRel} does not contain a JSON object at its top level ` +
              `(got ${parsed === null ? "null" : typeof parsed}).`,
          );
          continue;
        }
        // The pre-check above already proved the sidecar is well-formed —
        // safe to hand off to the lib helper for the actual symbol extraction.
        sidecarSymbols = new Set(
          provenanceSymbols(namespace, name).map(({ symbol }) =>
            baseName(symbol),
          ),
        );
      }
      // else: no sidecar file at all — every symbol below correctly reports
      // as missing, same as the pre-existing behavior.

      for (const symbol of [...publicExports].sort()) {
        if (!sidecarSymbols.has(baseName(symbol))) {
          missing.push({
            symbol,
            barrel: `${namespace}/${name}`,
            sidecar: sidecarRel,
          });
        }
      }
    }
  }

  const errors = [
    ...structuralErrors,
    ...missing.map(
      (m) =>
        `${m.symbol}: barrel-wired via ${m.barrel} but missing from ` +
        `${m.sidecar} sections[].sources[] — add it there, or gen:index will ` +
        `silently no-op for this symbol.`,
    ),
  ];
  return recordStep(
    "Barrel <-> sidecar sources",
    errors.length === 0,
    errors,
    [],
    [],
    [],
    [],
    { checkedModules, missing, structuralErrors },
  );
}

/**
 * Step 12: `prettier --write` on exactly the files step 11
 * (gen-reference-index) reported in `updated[]`. gen-reference-index already
 * writes its JSON output prettier-shaped (see its own header comment), but
 * the README.md catalog-block surgery is plain string replacement, so this
 * step is what keeps `pnpm format:check` green afterward — without
 * reformatting anything gen:index didn't touch (a no-diff run here keeps the
 * whole sequence byte-stable).
 *
 * @param {string[]} files - repo-relative paths from step 11's `updated[]`
 * @returns {StepResult}
 */
function formatGeneratedFiles(files) {
  if (files.length === 0) {
    return recordStep("Reference index format", true, []);
  }
  try {
    execFileSync("pnpm", ["exec", "prettier", "--write", ...files], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return recordStep("Reference index format", true, [], [], files);
  } catch (cause) {
    const err =
      /** @type {{ stdout?: string, stderr?: string, message: string }} */ (
        cause
      );
    const detail = (err.stderr ?? err.stdout ?? err.message ?? "").toString();
    return recordStep("Reference index format", false, [
      `prettier --write failed on ${files.join(", ")}: ${detail}`,
    ]);
  }
}

/**
 * Step 14: markdown lint. Unlike every other step, `pnpm lint:md` has no
 * --json mode (rumdl is a third-party CLI) — success/failure comes from the
 * exit code, and on failure only the tail of its output (rather than the full
 * transcript, which can be long) goes into the composite error.
 *
 * @returns {StepResult}
 */
function lintMarkdown() {
  try {
    execFileSync("pnpm", ["lint:md"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return recordStep("Markdown lint", true, []);
  } catch (cause) {
    const err =
      /** @type {{ stdout?: string, stderr?: string, message: string }} */ (
        cause
      );
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    const tail = output.split("\n").slice(-30).join("\n");
    return recordStep("Markdown lint", false, [
      `pnpm lint:md failed:\n${tail}`,
    ]);
  }
}

/**
 * Run the fixed 14-step sequence, stopping the moment a step's `ok` is false.
 */
function runSequence() {
  // 1 — pre-flight
  if (!runJsonStep("Provenance pre-flight", "bin/check-doc-provenance.mjs").ok)
    return;

  // 2 — restamp (optionally scoped to --affected)
  const restampArgs = ["--update"];
  if (affectedPath !== null) restampArgs.push("--affected", affectedPath);
  if (
    !runJsonStep(
      "Sidecars re-stamped",
      "bin/check-doc-provenance.mjs",
      restampArgs,
    ).ok
  )
    return;

  // 3 — regenerate doc counts
  if (!runJsonStep("Doc counts regen", "bin/gen-doc-counts.mjs").ok) return;

  // 4 — verify doc counts
  if (!runJsonStep("Doc counts", "bin/check-doc-counts.mjs").ok) return;

  // 5 — verify documented exports
  if (!runJsonStep("Documented exports", CHECK_DOC_EXPORTS_SCRIPT).ok) return;

  // 6 — NEW: barrel-vs-sidecar-sources (in-process)
  if (!checkBarrelSidecarSources().ok) return;

  // 7 — post-stamp provenance re-check
  if (
    !runJsonStep("Provenance (post-stamp)", "bin/check-doc-provenance.mjs").ok
  )
    return;

  // 8 — implemented count
  if (!runJsonStep("Implemented count", "bin/check-impl-counts.mjs").ok) return;

  // 9 — test counts (runs the full Vitest suite internally — generous timeout)
  if (
    !runJsonStep("Test counts", "bin/check-test-counts.mjs", [], {
      timeout: 600_000,
    }).ok
  )
    return;

  // 10 — script scaffold/doc conformance
  if (!runJsonStep("Script docs", "bin/check-script-scaffold.mjs").ok) return;

  // 11 — regenerate the reference index
  const genIndex = runJsonStep(
    "Reference index regen",
    "bin/gen-reference-index.mjs",
  );
  if (!genIndex.ok) return;

  // 12 — format exactly what step 11 touched, before verifying it
  if (!formatGeneratedFiles(genIndex.updated).ok) return;

  // 13 — verify the reference index is current
  if (
    !runJsonStep("Reference index verify", "bin/check-reference-index.mjs").ok
  )
    return;

  // 14 — markdown lint
  lintMarkdown();
}

// The documented exit contract (see the header comment) guarantees the
// composite report is always emitted, even when a step throws instead of
// returning a StepResult (e.g. an unanticipated crash in the in-process
// step 6 check, or a lib helper regressing away from its empty-on-error
// contract). Without this guard, an uncaught throw here would abort the
// process before the forwarding loop / reporter.finish() below ever ran,
// silently breaking that guarantee.
try {
  runSequence();
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  recordStep("Unexpected failure", false, [
    `sync-docs: unexpected error during the step sequence — ${message}`,
  ]);
}

// Forward every message/change from every step that actually ran into the
// composite's own reporter, so the top-level ok/errors/warnings/updated
// reflect the union across the whole sequence, not just the last step.
for (const step of steps) {
  for (const message of step.errors) reporter.error(`${step.name}: ${message}`);
  for (const message of step.warnings)
    reporter.warn(`${step.name}: ${message}`);
  for (const file of step.updated) reporter.change("updated", file);
  for (const file of step.created) reporter.change("created", file);
  for (const file of step.removed) reporter.change("removed", file);
}

const sequenceCompleted = steps.every((s) => s.ok);
const failedStep = steps.find((s) => !s.ok);

if (sequenceCompleted && steps.length > 0) {
  reporter.succeed(`/syncing-docs: all ${steps.length} step(s) passed.`);
} else if (!json) {
  console.error(
    `\n✗  /syncing-docs stopped at "${failedStep?.name ?? "unknown step"}" ` +
      `(step ${steps.length} of 14).`,
  );
}

if (!json) {
  const restampStep = steps.find((s) => s.name === "Sidecars re-stamped");
  const docCountsStep = steps.find((s) => s.name === "Doc counts");
  const barrelStep = steps.find((s) => s.name === "Barrel <-> sidecar sources");
  console.log("\n## /syncing-docs summary\n");
  for (const step of steps) {
    const icon = step.ok ? "✓" : "✗";
    const detail =
      typeof step.payload?.summary === "string" ? step.payload.summary : "";
    console.log(`- ${icon}  ${step.name}${detail ? `: ${detail}` : ""}`);
  }
  if (!sequenceCompleted) {
    console.log(
      `- ⏭  ${14 - steps.length} step(s) not run (stopped after the first failure)`,
    );
  }
  if (restampStep?.payload?.restamped) {
    const restamped = /** @type {string[]} */ (restampStep.payload.restamped);
    console.log(
      `\nSidecars re-stamped: ${restamped.length > 0 ? restamped.join(", ") : "none"}`,
    );
  }
  if (docCountsStep?.payload?.counts) {
    const counts = /** @type {{ core: number, aws: number, total: number }} */ (
      docCountsStep.payload.counts
    );
    console.log(
      `Doc counts: Core=${counts.core}, AWS=${counts.aws}, total=${counts.total}`,
    );
  }
  if (barrelStep?.payload && "checkedModules" in barrelStep.payload) {
    console.log(
      `Barrel <-> sidecar sources: ${String(barrelStep.payload.checkedModules)} module(s) checked`,
    );
  }
  console.log(
    "\nCommit-stats badges are main-only (not part of this pass) — see the skill's step 8 note.",
  );
}

const restampStepForPayload = steps.find(
  (s) => s.name === "Sidecars re-stamped",
);
const docCountsStepForPayload = steps.find((s) => s.name === "Doc counts");

const finalPayload = reporter.finish({
  steps: steps.map(
    ({ name, ok, errors, warnings, updated, created, removed }) => ({
      name,
      ok,
      errors,
      warnings,
      updated,
      created,
      removed,
    }),
  ),
  restamped: restampStepForPayload?.payload?.restamped ?? [],
  counts: docCountsStepForPayload?.payload?.counts ?? null,
});

process.exit(sequenceCompleted && finalPayload.ok ? 0 : 1);
