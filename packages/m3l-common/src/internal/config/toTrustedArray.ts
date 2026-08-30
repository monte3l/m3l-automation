/**
 * `internal/config/toTrustedArray` — materializes a foreign array-like value
 * into a genuinely trusted plain `Array`, defending against a hostile
 * `configParameters` export whose own `every`/`map` (or any other iteration
 * method) has been overridden to lie about its elements (X10a security
 * hardening, Fix 1).
 *
 * `Array.isArray(value)` is `true` for a real `Array` instance that also
 * carries an OWN `every`/`map` property shadowing `Array.prototype` for that
 * one instance — a hostile config module can hand back exactly such a value
 * and defeat both `loadScriptConfigDescriptors`'s validation gate
 * (`configParameters.every(isParameterLike)`) and
 * `describeConfigParameters`'s projection (`parameters.map(...)`) wholesale.
 *
 * Private to `core/config`; never re-exported through a public barrel.
 */

/**
 * Copies `source`'s elements into a freshly-constructed array, using only
 * `.length` and integer-indexed property reads.
 *
 * This is deliberately NOT `Array.from(source)` or
 * `Array.prototype.slice.call(source)`: `Array.from` consults
 * `Symbol.iterator`, which is exactly as overridable as `every`/`map` on a
 * hostile array, and `Array.prototype.slice` (like `map`/`concat`) invokes
 * `ArraySpeciesCreate`, which consults the source's OWN `constructor`
 * property to decide what to construct the result with — a hostile module
 * could set `constructor[Symbol.species]` to something that hands back
 * another array with the same lying `every`/`map` overrides. Reading
 * `.length` plus each integer index is the one path that touches neither the
 * iteration protocol nor the species-construction protocol: for a genuine
 * `Array` (already confirmed via `Array.isArray`), `length` is a
 * non-configurable data property (the ECMAScript `[[DefineOwnProperty]]`
 * exotic behavior for `Array` rejects any attempt to redefine it as an
 * accessor), so it cannot itself be turned into a hostile getter, and plain
 * indexed access (`source[index]`) is a direct property read, not a method
 * call a hostile module could shadow. `trusted` is built from a fresh array
 * literal and `Array.prototype.push` called on that same fresh literal, so
 * the result carries no own-property overrides of its own.
 *
 * @param source - The (already `Array.isArray`-confirmed) foreign array to
 *   materialize.
 * @returns A fresh array with the same elements, safe to call `.every`/`.map`
 *   on directly.
 */
export function toTrustedArray<T>(source: readonly T[]): T[] {
  const trusted: T[] = [];
  const { length } = source;
  for (let index = 0; index < length; index += 1) {
    const element = source[index];
    trusted.push(element as T);
  }
  return trusted;
}
