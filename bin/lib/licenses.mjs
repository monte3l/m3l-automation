// SPDX license-expression parsing and allow-list classification for the
// dependency license gate (check-licenses.mjs, ADR-0036). Pure — no
// fs/child_process/process here, so the parser and classifier are unit-
// testable without spawning `pnpm licenses list` (same shape as
// bin/lib/count-sites.mjs's pure `deriveCounts`).
//
// The grammar handled is the SPDX license-expression subset the reference
// tool this gate was modeled on supports: AND / OR / WITH / parentheses.
// Precedence (loosest to tightest): OR, then AND, then WITH binds a single
// license id to an exception. This is NOT a full SPDX license-id validator —
// it does not check `id` against the SPDX license list, only the expression
// structure — so a bare non-SPDX string like "BSD" parses as a single-id
// expression and is classified purely by allow-list membership.

/**
 * SPDX identifiers this project accepts for a dependency license. Chosen to
 * match the permissive/public-domain set the reference license gate used:
 * no copyleft, no share-alike, nothing requiring downstream disclosure.
 *
 * Kept textually identical (by hand — no machine gate binds the two) to the
 * `allow-licenses` list in `.github/workflows/dependency-review.yml`. See
 * docs/adr/0036-dependency-license-policy.md.
 *
 * @type {Set<string>}
 */
export const ALLOWED_LICENSES = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
]);

/**
 * @param {string} id SPDX license identifier (or non-SPDX bare string)
 * @param {Set<string>} [allowSet]
 * @returns {boolean}
 */
export function isAllowedLicenseId(id, allowSet = ALLOWED_LICENSES) {
  return allowSet.has(id);
}

/**
 * @typedef {
 *   | { type: "license", id: string }
 *   | { type: "and", left: SpdxNode, right: SpdxNode }
 *   | { type: "or", left: SpdxNode, right: SpdxNode }
 *   | { type: "with", license: SpdxNode, exception: string }
 * } SpdxNode
 */

function tokenize(expression) {
  return expression
    .trim()
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Parse an SPDX license expression into an AST. Throws on malformed input
 * (unbalanced parens, dangling operator, empty expression).
 *
 * @param {string} expression
 * @returns {SpdxNode}
 */
export function parseSpdxExpression(expression) {
  const tokens = tokenize(expression);
  if (tokens.length === 0) {
    throw new Error("empty SPDX expression");
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseAtom() {
    const token = peek();
    if (token === "(") {
      next();
      const inner = parseOr();
      if (peek() !== ")") {
        throw new Error(`expected ")" but found "${peek() ?? "<end>"}"`);
      }
      next();
      return inner;
    }
    if (
      token === undefined ||
      token === "AND" ||
      token === "OR" ||
      token === "WITH" ||
      token === ")"
    ) {
      throw new Error(`unexpected token "${token ?? "<end>"}"`);
    }
    next();
    return { type: "license", id: token };
  }

  function parseWith() {
    const atom = parseAtom();
    if (peek() === "WITH") {
      next();
      const exceptionToken = peek();
      if (exceptionToken === undefined) {
        throw new Error('expected an exception id after "WITH"');
      }
      next();
      return { type: "with", license: atom, exception: exceptionToken };
    }
    return atom;
  }

  function parseAnd() {
    let left = parseWith();
    while (peek() === "AND") {
      next();
      left = { type: "and", left, right: parseWith() };
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() === "OR") {
      next();
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  }

  const ast = parseOr();
  if (pos !== tokens.length) {
    throw new Error(`unexpected trailing token "${peek()}"`);
  }
  return ast;
}

/**
 * Evaluate a parsed SPDX expression against an allow predicate. `WITH`
 * exceptions always evaluate to `false` (conservative): an exception changes
 * the license's legal terms in a way a plain allow-list of base license ids
 * does not model, so it never passes — matching the reference gate.
 *
 * @param {SpdxNode} node
 * @param {(id: string) => boolean} isAllowed
 * @returns {boolean}
 */
export function evaluateSpdxAst(node, isAllowed) {
  switch (node.type) {
    case "license":
      return isAllowed(node.id);
    case "and":
      return (
        evaluateSpdxAst(node.left, isAllowed) &&
        evaluateSpdxAst(node.right, isAllowed)
      );
    case "or":
      return (
        evaluateSpdxAst(node.left, isAllowed) ||
        evaluateSpdxAst(node.right, isAllowed)
      );
    case "with":
      return false;
    default:
      return false;
  }
}

/**
 * @typedef {"allowed" | "denied" | "unresolved"} LicenseVerdict
 */

/**
 * Classify a raw license string (as reported by `pnpm licenses list`)
 * against the allow-list. `unresolved` is reserved for a missing/empty
 * license field or an expression that fails to parse (unbalanced parens,
 * dangling operator) — cases where allow-list membership genuinely cannot be
 * determined. A syntactically valid single license id that isn't SPDX-real
 * (e.g. the bare string "BSD") still parses and is classified `denied` by
 * plain allow-list lookup, since that IS a determinable answer.
 *
 * @param {string | null | undefined} licenseString
 * @param {Set<string>} [allowSet]
 * @returns {{ verdict: LicenseVerdict, reason?: string }}
 */
export function classifyLicense(licenseString, allowSet = ALLOWED_LICENSES) {
  if (!licenseString || !licenseString.trim()) {
    return { verdict: "unresolved", reason: "missing license field" };
  }
  let ast;
  try {
    ast = parseSpdxExpression(licenseString);
  } catch (error) {
    return {
      verdict: "unresolved",
      reason: `could not parse SPDX expression "${licenseString}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const allowed = evaluateSpdxAst(ast, (id) =>
    isAllowedLicenseId(id, allowSet),
  );
  return allowed ? { verdict: "allowed" } : { verdict: "denied" };
}
