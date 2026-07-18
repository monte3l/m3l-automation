#!/usr/bin/env node
// Pure builder for the reference index. Returns { catalog, symbolMap } from
// the filesystem without writing anything. Shared by gen-reference-index.mjs
// and check-reference-index.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SCRIPT_DOCS_DIR,
  docPagePath,
  scriptPackageDirs,
} from "./script-scaffold.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const NAMESPACES = ["core", "aws"];
const IMPORT_PATH = {
  core: "@m3l-automation/m3l-common/core",
  aws: "@m3l-automation/m3l-common/aws",
};

const BEGIN_MARKER = "<!-- BEGIN GENERATED CATALOG -->";
const END_MARKER = "<!-- END GENERATED CATALOG -->";
const SCRIPTS_BEGIN_MARKER = "<!-- BEGIN GENERATED SCRIPTS CATALOG -->";
const SCRIPTS_END_MARKER = "<!-- END GENERATED SCRIPTS CATALOG -->";

/**
 * Strip generic parameters so `M3LResult<T, E>` and `M3LResult` compare equal.
 * Shared by check-doc-exports and sync-docs's barrel-vs-sidecar-sources check —
 * both need the same "public symbol" identity notion.
 *
 * @param {string} symbol
 * @returns {string}
 */
export function baseName(symbol) {
  return symbol.replace(/<.*$/s, "").trim();
}

/**
 * Collect the named exports declared or re-exported by one .ts file, resolving
 * `export * from "./sibling.js"` transitively. `visited` guards against
 * cycles. Submodule index.ts files are pure `export * from "./file.js"`
 * re-exports, so this resolves one level into each referenced sibling file. It
 * does NOT reach into internal/ (never re-exported through a public barrel per
 * the library rules), so anything it finds is genuinely public.
 *
 * Shared by check-doc-exports (barrel vs docs coverage) and sync-docs's
 * barrel-vs-sidecar-sources check.
 *
 * @param {string} absTsPath
 * @param {Set<string>} visited
 * @returns {Set<string>}
 */
export function fileExports(absTsPath, visited) {
  if (visited.has(absTsPath)) return new Set();
  visited.add(absTsPath);

  let src;
  try {
    src = readFileSync(absTsPath, "utf8");
  } catch {
    return new Set();
  }

  const names = new Set();

  // 1. Direct declarations: export (class|function|const|type|interface|enum) X
  const declRe =
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of src.matchAll(declRe)) names.add(m[1]);

  // 2. Named export lists: export { A, B as C, type D } [from "..."]
  const listRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
  for (const m of src.matchAll(listRe)) {
    for (const rawItem of m[1].split(",")) {
      const item = rawItem.trim().replace(/^type\s+/, "");
      if (!item || item === "default") continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/.exec(item);
      const exported = asMatch ? asMatch[1] : item;
      if (exported !== "default") names.add(exported);
    }
  }

  // 3. export * as ns from "..."
  const starAsRe = /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g;
  for (const m of src.matchAll(starAsRe)) names.add(m[1]);

  // 4. export * from "./sibling.js" — resolve and recurse.
  const starRe = /\bexport\s+\*\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(starRe)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue; // never follow package specifiers
    const resolved = join(dirname(absTsPath), spec.replace(/\.js$/, ".ts"));
    for (const n of fileExports(resolved, visited)) names.add(n);
  }

  return names;
}

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

// Injectable for tests: pass `content` to parse a fixture instead of the
// real `docs/implementation-status.md` (mirrors count-sites.mjs's
// `getStatus` fixture pattern).
function parseImplementationStatus(content) {
  if (content === undefined) {
    const filePath = join(root, "docs/implementation-status.md");
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return {};
    }
  }
  const statusMap = {};
  for (const line of content.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    if (cells.length < 6) continue;
    const name = cells[1].trim();
    // Lowercase submodule names: hyphens allowed for multi-word names beyond
    // the original bootstrap catalog (e.g. "logs-insights", ADR-0027), and
    // digits allowed for full official AWS service names (ADR-0028) that
    // contain one (e.g. "s3", "ec2") — not headers, separators, or infra
    // rows.
    if (!/^[a-z][a-z0-9-]+$/.test(name)) continue;
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
  // Valid JSON that isn't an object (e.g. a literal `null`, array, or scalar)
  // has no `.sections` to iterate — treat it the same as unreadable/malformed.
  if (data === null || typeof data !== "object") return [];
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

// Prettier uses display width (not JS string length) when aligning table columns.
// Wide characters (CJK, emoji) occupy 2 terminal columns but have JS length 1.
// This helper matches prettier's character-width logic for the values that appear
// in the generated table (emoji status values in particular).
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp) {
  // Simplified Unicode East Asian Width = W or F ranges, plus emoji blocks.
  // Covers the status emoji (❌ U+274C, ✅ U+2705, 🟢 U+1F7E2, 🧪 U+1F9EA, …).
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x2600 && cp <= 0x27bf) || // Misc Symbols + Dingbats (❌ ✅ …)
    (cp >= 0x1f000 && cp <= 0x1ffff) || // Emoji block (🟢 🧪 …)
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

function padToDisplay(str, width) {
  const spaces = width - displayWidth(str);
  return spaces > 0 ? str + " ".repeat(spaces) : str;
}

export function buildReadmeBlock(catalog) {
  const header = ["Namespace", "Module", "Status", "Import path"];
  const dataRows = catalog.map((e) => [
    e.namespace,
    `[${e.name}](${e.namespace}/${e.name}.md)`,
    e.status,
    `\`${e.importPath}\``,
  ]);
  const colWidths = header.map((h, col) =>
    Math.max(displayWidth(h), ...dataRows.map((r) => displayWidth(r[col]))),
  );
  const fmtRow = (cells) =>
    "| " +
    cells.map((c, i) => padToDisplay(c, colWidths[i])).join(" | ") +
    " |";
  const separator =
    "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  return [
    BEGIN_MARKER,
    "",
    fmtRow(header),
    separator,
    ...dataRows.map(fmtRow),
    "",
    END_MARKER,
  ].join("\n");
}

/**
 * The consumer-scripts catalog: the union of contract pages under
 * docs/reference/scripts/ and script packages under scripts/, sorted by name.
 * A conformant script has both (check-script-scaffold enforces it); the index
 * still renders one-sided entries so drift is visible here too.
 */
export function buildScriptsCatalog() {
  const packages = new Set(scriptPackageDirs(root));
  const pages = new Set();
  try {
    for (const file of readdirSync(join(root, SCRIPT_DOCS_DIR))) {
      if (file.endsWith(".md") && file !== "README.md") {
        pages.add(file.slice(0, -3));
      }
    }
  } catch {
    // No scripts docs dir yet — the catalog below may still list packages.
  }
  return [...new Set([...packages, ...pages])].sort().map((name) => ({
    name,
    docPath: docPagePath(name),
    docExists: pages.has(name),
    packageExists: packages.has(name),
  }));
}

export function buildScriptsReadmeBlock(scriptsCatalog) {
  const lines = [SCRIPTS_BEGIN_MARKER, ""];
  if (scriptsCatalog.length === 0) {
    lines.push(
      "_No consumer scripts yet — scaffold one with `pnpm scaffold:script <name>`._",
    );
  } else {
    const header = ["Script", "Contract page", "Package"];
    const dataRows = scriptsCatalog.map((e) => [
      e.name,
      e.docExists ? `[${e.name}.md](scripts/${e.name}.md)` : "❌ missing",
      e.packageExists ? `\`scripts/${e.name}/\`` : "❌ missing",
    ]);
    const colWidths = header.map((h, col) =>
      Math.max(displayWidth(h), ...dataRows.map((r) => displayWidth(r[col]))),
    );
    const fmtRow = (cells) =>
      "| " +
      cells.map((c, i) => padToDisplay(c, colWidths[i])).join(" | ") +
      " |";
    lines.push(
      fmtRow(header),
      "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |",
      ...dataRows.map(fmtRow),
    );
  }
  lines.push("", SCRIPTS_END_MARKER);
  return lines.join("\n");
}

export {
  BEGIN_MARKER,
  END_MARKER,
  SCRIPTS_BEGIN_MARKER,
  SCRIPTS_END_MARKER,
  NAMESPACES,
  parseImplementationStatus,
  barrelWiredModules,
  provenanceSymbols,
};
