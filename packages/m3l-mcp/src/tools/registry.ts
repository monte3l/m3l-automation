/**
 * `tools/registry` — the fleet's tool table (ADR-0062). `TOOL_REGISTRY` is
 * the single list `main.ts` registers with the SDK's `McpServer`; every
 * entry in it must be a {@link GatedToolRegistration}, a type only
 * `gateTool` (slice V10c) can produce. That is a structural guarantee, not
 * a convention: an object literal built by hand, no matter how closely it
 * mimics the shape, is missing the brand and is rejected by the type
 * checker before it ever reaches this array — a tool cannot skip the
 * ADR-0060 policy/ADR-0061 audit wrapper by accident.
 *
 * @packageDocumentation
 */

/**
 * The brand key that marks a {@link GatedToolRegistration} as having been
 * produced through the (slice V10c) policy gate, rather than assembled as a
 * plain object literal. Deliberately **not exported**: a `unique symbol`
 * that leaves this module can be imported and used to hand-build a fake
 * branded value, which defeats the whole point of the brand. Kept as an
 * ambient `declare const` rather than a `Symbol()` value — it needs no
 * runtime identity, only a type-level name only this module can write, and
 * that form still satisfies `isolatedDeclarations` (the emitted `.d.ts`
 * carries the same `declare const` unexported).
 *
 * Slice V10c's `gateTool` mints real branded entries from *inside* this
 * module's own boundary (i.e. it lives in this file, or is added to it) —
 * that is legitimate precisely because only code inside this module can name
 * `gatedBrand`. A producer outside this file still cannot forge one.
 */
declare const gatedBrand: unique symbol;

/**
 * A tool registration that has passed through the ADR-0060 policy gate.
 * The `[gatedBrand]` member has no runtime producer in this slice (that is
 * `gateTool`, slice V10c) — its only purpose here is to make an unbranded
 * object literal with the same `name`/`config`/`handler` shape fail
 * structural assignability against this type. Because the brand key itself
 * is never exported (see {@link gatedBrand}), no caller outside this module
 * can construct a value that satisfies this interface, even with the exact
 * same field shape and no type assertions.
 *
 * @example
 * ```ts
 * import type { GatedToolRegistration } from "./tools/registry.js";
 *
 * function describe(entry: GatedToolRegistration): string {
 *   return `${entry.name}: ${entry.config.title}`;
 * }
 * ```
 */
export interface GatedToolRegistration {
  /** Brand-only member; see {@link gatedBrand}. */
  readonly [gatedBrand]: true;
  /** The tool's registered name (surfaced to the MCP client verbatim). */
  readonly name: string;
  /** The SDK tool config: title, description, and behavioral annotations. */
  readonly config: {
    readonly title: string;
    readonly description: string;
    readonly annotations: { readonly readOnlyHint: boolean };
  };
  /** The tool's call handler. */
  readonly handler: (args: unknown) => Promise<unknown>;
}

/**
 * The fleet's registered tools. Empty in this slice — populating it is
 * slice V10c's job, once `gateTool` exists to produce entries. Frozen so a
 * caller cannot push an unbranded entry onto it at runtime even by
 * bypassing the type checker (e.g. from plain JavaScript).
 *
 * @example
 * ```ts
 * import { TOOL_REGISTRY } from "./tools/registry.js";
 *
 * for (const entry of TOOL_REGISTRY) {
 *   // register entry with an MCP server
 * }
 * ```
 */
export const TOOL_REGISTRY: readonly GatedToolRegistration[] = Object.freeze(
  [],
);
