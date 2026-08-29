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
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from "typescript";

/**
 * Extracts every static and dynamic import/export specifier string from a
 * TypeScript source file's text, in appearance order, via a real AST parse
 * (`ts.createSourceFile`) rather than regex text-scanning. This is
 * deliberate, not incidental: a regex-based extractor (the first
 * implementation of this function) has two failure modes a parser
 * structurally cannot —
 *
 * 1. **False negative**: a comment-stripping pre-pass driven by
 *    `/\/\*…\*\//`/`//` regexes silently deletes everything between two
 *    ordinary string literals that happen to contain `/*`/`*\/` sequences,
 *    which can delete a real import sitting between them — the gate reports
 *    zero violations for a file that actually has one.
 * 2. **False positive**: text inside a string or template literal that
 *    merely *looks* like an import statement (e.g. a fixture string in a
 *    future browser-safe subpath's source) reads as a real specifier.
 *
 * A parser sees neither problem: `ts.forEachChild` only visits real
 * `ImportDeclaration`/`ExportDeclaration` nodes and real dynamic-`import`
 * `CallExpression` nodes, so comment and string-literal content is never
 * inspected at all — including this library's TSDoc `@example` blocks that
 * routinely show the *published* import path
 * (`@m3l-automation/m3l-common/core`), which would otherwise read as a real
 * bare-specifier violation despite never executing.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
  const sourceFile = createSourceFile(
    "source.ts",
    source,
    ScriptTarget.Latest,
    false,
    ScriptKind.TS,
  );
  const specifiers = [];

  /** @param {import("typescript").Node} node */
  function visit(node) {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    forEachChild(node, visit);
  }
  visit(sourceFile);

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

    let source;
    try {
      source = readFile(file, "utf8");
    } catch (cause) {
      throw new Error(
        `check:browser-safe-subpath could not read "${file}" while walking ` +
          `its import graph — check for a broken relative import in this ` +
          `browser-safe subpath.`,
        { cause },
      );
    }
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
