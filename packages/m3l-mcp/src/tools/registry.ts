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
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The brand key that marks a {@link GatedToolRegistration} as having been
 * produced through the (slice V10c) policy gate, rather than assembled as a
 * plain object literal. Deliberately **not exported**: a `unique symbol`
 * that leaves this module can be imported and used to hand-build a fake
 * branded value, which defeats the whole point of the brand.
 *
 * Given a real, module-local `Symbol()` value (not an ambient `declare const`)
 * so that this module's own future producer — `gateTool`, slice V10c — can
 * mint a branded value with a plain object literal
 * (`{ [gatedBrand]: true, ... }`) and no `as` cast. An ambient `declare const`
 * has no runtime identity: it type-checks as a computed property key but
 * emits that same unresolved identifier to JS, so constructing one throws a
 * `ReferenceError` at the moment anything tries — which would force
 * `gateTool` into a cast, permanently reopening the hole this brand exists to
 * close. The explicit `: unique symbol` annotation (not the `declare`
 * keyword) is what keeps `isolatedDeclarations` happy: the emitted `.d.ts` is
 * still `declare const gatedBrand: unique symbol;`, unexported, so outside
 * forgeries are rejected exactly as before.
 *
 * Slice V10c's `gateTool` mints real branded entries from *inside* this
 * module's own boundary (i.e. it lives in this file, or is added to it) —
 * that is legitimate precisely because only code inside this module can name
 * `gatedBrand`. A producer outside this file still cannot forge one.
 */
const gatedBrand: unique symbol = Symbol("m3l.mcp.gated");

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
  /**
   * The tool's call handler, typed as the SDK's own default `ToolCallback`
   * (no generic argument) so `main.ts` can pass it straight to
   * `McpServer#registerTool` with no cast: that overload's `cb` parameter is
   * exactly this shape, a callback taking only the request's `extra` and
   * returning a `CallToolResult`, precisely because `config` above carries
   * no `inputSchema`. This is the no-argument-schema case only; slice V10c
   * widens `config` to add `inputSchema` for the tools that take arguments
   * (`fleet_run`, `fleet_flow`, `fleet_describe`), and `handler`'s type
   * parameterizes on that schema at the same time, taking the parsed
   * arguments as well as `extra`.
   */
  readonly handler: ToolCallback;
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
