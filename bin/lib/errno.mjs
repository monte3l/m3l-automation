// Shared errno-code reader for `bin/` tooling (X8e, issue #1251 slice 2).
//
// `.mjs` scripts cannot import `packages/m3l-common/src/core/utils/guards.ts`
// directly (that tree is TypeScript source, not a built artifact bin/ can
// depend on), so this mirrors the same algorithm the library's
// `errnoCodeOf` uses: an errno `code` counts only when it is an **own**
// property (`Object.hasOwn`) of a real `Error`, read **exactly once** into a
// local. Honouring an inherited `code` means one
// `Error.prototype.code = "ENOENT"` anywhere in the process makes every
// caught failure present as the tolerated one — the same forgeability
// argument that drove the library-side hardening (X8d, PR #1245).
//
// Every `bin/` site that decides tolerate-vs-rethrow from an errno code
// must read it through this function, not a hand-rolled `"code" in cause`
// presence check or a direct `.code` cast — see
// `docs/contributing/style-guide.md`'s "a mirrored constant's drift guard
// must enumerate every copy" rule for why this covers all four call sites,
// not just the one issue #1251 named directly.

/**
 * Returns the own, string-typed `code` property of an `Error`, or
 * `undefined` when `value` is not an `Error`, or has no own `code`, or that
 * `code` is not a string.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function errnoCodeOf(value) {
  if (!(value instanceof Error) || !Object.hasOwn(value, "code")) {
    return undefined;
  }
  const code = /** @type {{ code?: unknown }} */ (value).code;
  return typeof code === "string" ? code : undefined;
}
