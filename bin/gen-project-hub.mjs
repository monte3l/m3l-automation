#!/usr/bin/env node
// Renders the ADR-0032 visibility-hub dashboard to dist/index.html: the
// current Roadmap/Implementation-backlog/Implementation-status trackers plus
// an index over the ADR/work-log/plan-archive/reference-doc corpus, all in
// one self-contained, styled HTML page. Run by .github/workflows/pages.yml on
// every push to `main` (published to GitHub Pages alongside
// dist/commit-stats/, see gen-commit-stats-endpoint.mjs); also runnable
// locally via `pnpm gen:project-hub`.
//
// This file is Node-builtin I/O only — every parse/extract/render step comes
// from bin/lib/project-hub.mjs, which stays pure and unit-tested.
//
// Usage:
//   node bin/gen-project-hub.mjs           # writes dist/index.html
//   node bin/gen-project-hub.mjs --json    # same, plus a JSON report on stdout
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildCorpusSections,
  extractImplementation,
  extractImplementationStatus,
  extractRoadmap,
  renderHubPage,
} from "./lib/project-hub.mjs";
import { SCRIPT_DOCS_DIR, scriptPackageDirs } from "./lib/script-scaffold.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read one repo-relative markdown file's contents as UTF-8 text. */
function readDoc(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

/** List a directory's `.md` filenames (basenames only), excluding `skip`. */
function listMarkdownFiles(dir, skip = []) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .filter((name) => !skip.includes(name));
}

/** Read every file in `names` (basenames under `dir`) into `{ name, content }`. */
function readFileSet(dir, names) {
  return names.map((name) => ({
    name,
    content: readDoc(`${dir}/${name}`),
  }));
}

/** Every `scripts/<name>/README.md` that actually exists, repo-relative. */
function scriptReadmePaths() {
  return scriptPackageDirs(root)
    .map((name) => `scripts/${name}/README.md`)
    .filter((relativePath) => existsSync(join(root, relativePath)));
}

/** Short commit SHA for the header; "unknown" (with a warning) if git fails. */
function resolveCommitSha(reporter) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch (cause) {
    reporter.warn(
      `Could not resolve the current commit SHA (${cause instanceof Error ? cause.message : String(cause)}); using "unknown".`,
    );
    return "unknown";
  }
}

/** Total data rows across every rendered tracker table, for the summary line. */
function countTrackerRows(...tables) {
  return tables.reduce((sum, table) => sum + (table?.rows.length ?? 0), 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const roadmap = extractRoadmap(readDoc("docs/ROADMAP.md"));
  const backlog = extractImplementation(
    readDoc("docs/plans/IMPLEMENTATION.md"),
  );
  const ledger = extractImplementationStatus(
    readDoc("docs/implementation-status.md"),
  );

  const extractionErrors = [
    ...roadmap.errors,
    ...backlog.errors,
    ...ledger.errors,
  ];
  if (extractionErrors.length > 0) {
    for (const message of extractionErrors) reporter.error(message);
    reporter.finish();
    process.exit(1);
  }

  const adrFiles = readFileSet(
    "docs/adr",
    listMarkdownFiles("docs/adr", ["README.md", "template.md"]),
  );
  const logFiles = readFileSet(
    "docs/logs",
    listMarkdownFiles("docs/logs", ["README.md"]),
  );
  const archiveFiles = readFileSet(
    "docs/plans/archive",
    listMarkdownFiles("docs/plans/archive"),
  );
  const planFiles = readFileSet("docs/plans", listMarkdownFiles("docs/plans"));

  const catalog = JSON.parse(readDoc("docs/reference/catalog.json"));
  const scriptPages = listMarkdownFiles(SCRIPT_DOCS_DIR, ["README.md"]).map(
    (name) => `${SCRIPT_DOCS_DIR}/${name}`,
  );
  const readmePaths = [
    "README.md",
    "packages/m3l-common/README.md",
    "docs/README.md",
    ...scriptReadmePaths(),
  ];

  const corpus = buildCorpusSections({
    adrFiles,
    logFiles,
    archiveFiles,
    planFiles,
    catalog,
    scriptPages,
    readmePaths,
  });

  const model = {
    generatedAt: new Date().toISOString(),
    commitSha: resolveCommitSha(reporter),
    summary: { implemented: ledger.implemented, total: ledger.total },
    roadmap,
    backlog,
    ledger,
    corpus,
  };

  const html = renderHubPage(model);
  const content = html.endsWith("\n") ? html : `${html}\n`;

  const distDir = join(root, "dist");
  mkdirSync(distDir, { recursive: true });
  const outPath = join(distDir, "index.html");
  writeFileSync(outPath, content, "utf8");
  reporter.change("updated", "dist/index.html");

  const trackerRows = countTrackerRows(
    roadmap.priority0,
    roadmap.priority1,
    roadmap.priority2,
    roadmap.governance,
    backlog.friction,
    backlog.getterReality,
    backlog.gated,
    ledger.barrels,
    ledger.core,
    ledger.aws,
  );

  reporter.succeed(
    `Project hub rendered: ${corpus.adrs.length} ADR(s), ${corpus.logs.length} log(s), ${corpus.archive.length} archived plan(s), ${trackerRows} tracker row(s).`,
  );
  reporter.finish({
    counts: {
      adrs: corpus.adrs.length,
      logs: corpus.logs.length,
      archived: corpus.archive.length,
      trackerRows,
    },
  });
}
