#!/usr/bin/env node
// Barrel → docs export-coverage gate. Every public symbol surfaced through a
// namespace barrel (src/core|aws/index.ts) must be documented — named in its
// reference page (docs/reference/<ns>/<mod>.md) heading or in the provenance
// sidecar. Fails on any public export that is documented nowhere.
//
// This is the deterministic backstop for the spec-conformance-reviewer and
// docs-consistency-reviewer spokes, which report undocumented exports but do
// not gate CI. It closes the gap from docs/logs/2026-07-01-core-json.md
// divergence 2, where public types added mid-implementation had to be tracked
// into the .md + provenance by hand.
//
// Enumeration is regex-based and intentionally scoped to NAMED value/type
// exports — the same notion of "symbol" the provenance sidecars already use.
// Submodule index.ts files are pure `export * from "./file.js"` re-exports, so
// the enumerator resolves one level into each referenced sibling file. It does
// NOT reach into internal/ (never re-exported through a public barrel per the
// library rules), so anything it finds is genuinely public.
//
// Usage:
//   pnpm check:doc-exports   # verify (fails on any undocumented export)
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  root,
  NAMESPACES,
  barrelWiredModules,
  provenanceSymbols,
} from "./lib/reference-index.mjs";

const srcRoot = join(root, "packages/m3l-common/src");

// Strip generic parameters so `M3LResult<T, E>` and `M3LResult` compare equal.
function baseName(symbol) {
  return symbol.replace(/<.*$/s, "").trim();
}

// Collect the named exports declared or re-exported by one .ts file, resolving
// `export * from "./sibling.js"` transitively. `visited` guards against cycles.
function fileExports(absTsPath, visited) {
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

// A symbol is "documented" when it is named on its reference page — either
// listed in the provenance sidecar or written anywhere in the .md as a
// whole-word token (Public-API list, a heading, or a usage example). This
// matches the project's convention where one section documents a cluster (e.g.
// the whole `M3LResult<T, E>` family, with its combinators shown in examples)
// rather than one heading per export. It still fails on a genuinely absent
// export — a new public symbol never written into the page at all.
function documentedMatcher(namespace, name) {
  const documentedSymbols = new Set(
    provenanceSymbols(namespace, name).map(({ symbol }) => baseName(symbol)),
  );
  const mdPath = join(root, `docs/reference/${namespace}/${name}.md`);
  const mdText = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  return {
    has(symbol) {
      const base = baseName(symbol);
      if (documentedSymbols.has(base)) return true;
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`).test(mdText);
    },
  };
}

let errors = 0;
let checked = 0;

for (const namespace of NAMESPACES) {
  for (const name of barrelWiredModules(namespace)) {
    const indexPath = join(srcRoot, namespace, name, "index.ts");
    const publicExports = fileExports(indexPath, new Set());
    if (publicExports.size === 0) continue; // placeholder / empty — nothing to check
    checked++;

    const documented = documentedMatcher(namespace, name);
    const undocumented = [...publicExports]
      .filter((sym) => !documented.has(sym))
      .sort();

    if (undocumented.length > 0) {
      console.error(
        `✗  ${namespace}/${name}: ${undocumented.length} public export(s) not ` +
          `documented in docs/reference/${namespace}/${name}.md ` +
          `(heading) or its provenance sidecar:\n` +
          undocumented.map((s) => `     • ${s}`).join("\n"),
      );
      errors += undocumented.length;
    }
  }
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} undocumented public export(s). Document each in its ` +
      `reference page and provenance sidecar (same change set), or move it to ` +
      `internal/ if it should not be public.`,
  );
  process.exit(1);
}

console.log(
  `✓  All public exports documented across ${checked} implemented submodule(s).`,
);
