// Pure graph-walking logic backing `bin/check-browser-safe-subpath.mjs`
// (docs/adr/0004-exports-map-contract.md's dated Update, issue #724 / F32).
//
// ADR-0004 bans per-submodule `exports` subpaths as a general policy, but its
// Update carves a narrow, machine-enforced exception: a submodule may gain a
// subpath ONLY when its transitive source-import graph is provably free of
// `node:` builtins and third-party bare specifiers — a browser bundler must
// be able to resolve the whole subpath without externalizing anything.
// Without a gate, that invariant is just a comment someone could invalidate
// by adding one `node:crypto` import to a file three hops deep in the graph.
//
// Walks TypeScript *source* (not built `dist/`) so the gate runs in the
// pre-build CI lane alongside `check:api`, matching how `.js` specifiers in
// NodeNext-style ESM source resolve to sibling `.ts` files at the type level.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Matches the specifier string in any `import`/`export … from "…"` form
// (named, namespace, default, type-only, and bare side-effect imports) plus
// a dynamic `import("…")` call. `[^;]*?` bounds the `import`/`export` branch
// to a single statement (this repo's Prettier formatting always terminates
// one with `;`) rather than `[\s\S]*?`, which would let a lazy match skip
// past an unrelated `from` token years later in the file (e.g. inside a
// large string-literal array like `M3L_ERROR_CODES`) and misattribute it —
// the class still matches newlines within one statement (a multi-line named
// import list), just not across statement boundaries.
const IMPORT_SPECIFIER_RE =
  /(?:import|export)(?:\s+type)?[^;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g;

/**
 * Strips `/* … *\/` block comments and `// …` line comments from TypeScript
 * source text. Required before scanning for imports: this library's TSDoc
 * `@example` blocks routinely show a *published* import path
 * (`@m3l-automation/m3l-common/core`) that would otherwise read as a real
 * bare-specifier violation despite never executing.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Extracts every import/export specifier string from a TypeScript source
 * file's text, in appearance order, ignoring anything inside a comment (see
 * {@link stripComments}). All three capture groups of
 * {@link IMPORT_SPECIFIER_RE} are read: a bare side-effect import
 * (`import "./x.js"`) has no `from` clause, and a dynamic `import(...)` call
 * has neither `from` nor the static keyword form.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
  const specifiers = [];
  for (const match of stripComments(source).matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * Resolves a relative import specifier (as written in NodeNext-style ESM
 * source, e.g. `"./catalog.js"`) against the `.ts` source tree: the `.js`
 * extension the compiled output will carry is swapped for `.ts`, and a
 * directory-style specifier (no extension, or a bare `.`) falls back to its
 * `index.ts`.
 *
 * @param {string} fromFile absolute path of the file containing the import
 * @param {string} specifier a relative specifier (`./…` or `../…`)
 * @returns {string} absolute path to the resolved `.ts` source file
 */
export function resolveRelativeSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  if (base.endsWith(".js")) return `${base.slice(0, -3)}.ts`;
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  return join(base, "index.ts");
}

/**
 * Walks the transitive relative-import graph starting at `entryFile`,
 * collecting every specifier that is NOT a relative path — a `node:`
 * builtin or a bare third-party package name — as a violation. Handles
 * cycles (visited-set) so a two-file cycle like `M3LError.ts ↔ catalog.ts`
 * terminates.
 *
 * @param {string} entryFile absolute path to the entry `.ts` file
 * @param {{ readFile?: (path: string, encoding: "utf8") => string }} [deps]
 *   injectable file reader, narrowed to the one overload this function
 *   actually calls — so a test double only has to implement `(path, "utf8")
 *   => string` rather than the full overloaded `typeof readFileSync` shape
 * @returns {{ visited: string[], violations: { file: string, specifier: string }[] }}
 */
export function walkImportGraph(entryFile, deps = {}) {
  const readFile = deps.readFile ?? readFileSync;
  const visited = new Set();
  const violations = [];
  const queue = [entryFile];

  while (queue.length > 0) {
    // Non-null: guarded by the loop condition (queue.length > 0).
    const file = /** @type {string} */ (queue.shift());
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFile(file, "utf8");
    for (const specifier of extractImportSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeSpecifier(file, specifier);
        if (!visited.has(resolved)) queue.push(resolved);
      } else {
        violations.push({ file, specifier });
      }
    }
  }

  return { visited: [...visited], violations };
}
