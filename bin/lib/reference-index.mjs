#!/usr/bin/env node
// Pure builder for the reference index. Returns { catalog, symbolMap } from
// the filesystem without writing anything. Shared by gen-reference-index.mjs
// and check-reference-index.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const NAMESPACES = ["core", "aws"];
const IMPORT_PATH = {
  core: "@m3l-automation/m3l-common/core",
  aws: "@m3l-automation/m3l-common/aws",
};

const BEGIN_MARKER = "<!-- BEGIN GENERATED CATALOG -->";
const END_MARKER = "<!-- END GENERATED CATALOG -->";

function barrelWiredModules(namespace) {
  const barrelPath = join(
    root,
    `packages/m3l-common/src/${namespace}/index.ts`,
  );
  let content;
  try {
    content = readFileSync(barrelPath, "utf8");
  } catch {
    return new Set();
  }
  const re = /^export \* from "\.\/([^/]+)\/index\.js";/gm;
  const names = new Set();
  let m;
  while ((m = re.exec(content)) !== null) names.add(m[1]);
  return names;
}

function parseImplementationStatus() {
  const filePath = join(root, "docs/implementation-status.md");
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  const statusMap = {};
  for (const line of content.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    if (cells.length < 6) continue;
    const name = cells[1].trim();
    // Only simple lowercase submodule names (not headers, separators, or infra rows)
    if (!/^[a-z][a-z]+$/.test(name)) continue;
    const statusCell = cells[5].trim();
    // First code point is the status emoji
    const emoji = [...statusCell][0] ?? "❌";
    statusMap[name] = emoji;
  }
  return statusMap;
}

function provenanceSymbols(namespace, name) {
  const sidecarPath = join(
    root,
    `docs/reference/${namespace}/${name}.provenance.json`,
  );
  if (!existsSync(sidecarPath)) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch {
    return [];
  }
  // First-occurrence deduplication: first section that names a symbol wins.
  const seen = new Map();
  for (const section of data.sections ?? []) {
    for (const source of section.sources ?? []) {
      if (!seen.has(source.symbol)) {
        seen.set(source.symbol, {
          file: source.file,
          ...(source.lines ? { lines: source.lines } : {}),
        });
      }
    }
  }
  return [...seen.entries()].map(([symbol, info]) => ({ symbol, ...info }));
}

function submoduleNames(namespace) {
  const refDir = join(root, `docs/reference/${namespace}`);
  let files;
  try {
    files = readdirSync(refDir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function buildIndex() {
  const statusMap = parseImplementationStatus();
  const catalog = [];
  const symbolMap = {};

  for (const namespace of NAMESPACES) {
    const wired = barrelWiredModules(namespace);
    const names = submoduleNames(namespace);

    for (const name of names) {
      const symbolSources = provenanceSymbols(namespace, name);
      const symbols = symbolSources.map((s) => s.symbol);

      catalog.push({
        namespace,
        name,
        importPath: IMPORT_PATH[namespace],
        status: statusMap[name] ?? "❌",
        wired: wired.has(name),
        docPath: `docs/reference/${namespace}/${name}.md`,
        symbols,
      });

      for (const { symbol, file, lines } of symbolSources) {
        if (!(symbol in symbolMap)) {
          symbolMap[symbol] = {
            submodule: name,
            namespace,
            file,
            ...(lines ? { lines } : {}),
          };
        }
      }
    }
  }

  return { catalog, symbolMap };
}

export function buildReadmeBlock(catalog) {
  const rows = catalog.map(
    (e) =>
      `| ${e.namespace} | [${e.name}](${e.namespace}/${e.name}.md) | ${e.status} | \`${e.importPath}\` |`,
  );
  return [
    BEGIN_MARKER,
    "",
    "| Namespace | Module | Status | Import path |",
    "| --------- | ------ | ------ | ----------- |",
    ...rows,
    "",
    END_MARKER,
  ].join("\n");
}

export { BEGIN_MARKER, END_MARKER };
