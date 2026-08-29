/**
 * `aws/bedrock-runtime/document` — the bounded, validate-and-rebuild
 * recursive document copy ({@link copyDocument}) both `tools.ts` (request-
 * side `inputSchema`) and `shared.ts` (a `json` tool-result payload, a
 * `toolUse` block's `input`) share for the SDK's mutable `DocumentType`
 * boundary, plus the plain-object guard ({@link isPlainObject}), own-property
 * reader ({@link readOwn}), and caller/model-string sanitizer
 * ({@link sanitizeForMessage}) it and `tools.ts`'s toolUse-narrowing
 * machinery both need.
 *
 * Split out of `tools.ts` as its own leaf module (ADR-0072's per-file size
 * ratchet) — the document copier is a self-contained concern with its own
 * invariants (depth bound, node budget, null-prototype rebuild, reserved-key
 * refusal) independent of the tool-vocabulary mapping `tools.ts` keeps.
 * Never imports `tools.ts` (`import-x/no-cycle`, `maxDepth: Infinity`, is a
 * hard repo-wide gate) — `tools.ts` imports from here, never the reverse.
 * Internal module — nothing here is re-exported through
 * `aws/bedrock-runtime/index`.
 *
 * @packageDocumentation
 */

import { M3LBedrockRuntimeOperationError } from "./error.js";

/**
 * Nesting ceiling for {@link copyDocument} — see
 * `docs/reference/aws/bedrock-runtime.md`'s "`input`, `json`, and
 * `inputSchema` are `unknown`" note. No other numeric limit (tool count,
 * name length, byte size) is invented here; adversarial sizing is a later
 * slice's concern.
 */
const MAX_DOCUMENT_DEPTH = 32;

/**
 * Total constructed-node ceiling for one {@link copyDocument} call — a
 * budget threaded through the recursion via {@link copyDocumentImpl}, in
 * addition to (never instead of) {@link MAX_DOCUMENT_DEPTH}. Depth alone
 * does not bound work: a **shared** (not merely deep) DAG of caller input —
 * the same nested sub-document reachable along more than one parent path —
 * revisits that sub-document once per path, so node count grows
 * exponentially in depth while never exceeding the depth ceiling on any
 * single path (proven, 2026-08-29 security pass: a 24-level, 2-way-shared
 * DAG built from ~34 bytes of input expands to ~2^24 copy nodes and OOMs a
 * 2 GB heap; depth 22 alone takes over 2s). Set on the order of 10,000 —
 * generous for any legitimate `inputSchema`/tool-result payload, small
 * enough to bound work to low milliseconds regardless of sharing.
 */
const MAX_DOCUMENT_NODES = 10_000;

/**
 * Per-call node counter threaded through {@link copyDocumentImpl}'s
 * recursion. Never exposed on {@link copyDocument}'s public signature — a
 * fresh budget is constructed for every top-level call, so the ceiling
 * bounds one document copy, not the whole process lifetime.
 *
 * A class (rather than a plain mutable `{ count }` object threaded through
 * every recursive call) so the counter mutates its own instance field
 * instead of a function parameter's property, which this project's
 * `no-param-reassign` lint rule (`props: true`) disallows — mirrors
 * `internal/procedure/evaluate.ts`'s `EvaluationBudget` for the identical
 * shape of problem.
 */
class DocumentCopyBudget {
  private count = 0;

  /** Records one more constructed node; returns `true` once {@link MAX_DOCUMENT_NODES} is exceeded. */
  visit(): boolean {
    this.count += 1;
    return this.count > MAX_DOCUMENT_NODES;
  }
}

/**
 * A JSON-serializable document value, structurally identical to
 * `@smithy/types`' `DocumentType` (verified against installed dist-types,
 * 2026-08-29: `null | boolean | number | string | DocumentType[] | { [key: string]: DocumentType }`)
 * but declared locally rather than imported — this submodule never names an
 * `@smithy` type across its own boundary (ADR-0027), and this alias is
 * purely internal plumbing for building the SDK request literal that
 * `shared.ts`'s `toSdkMessage` and `buildConverseInput` assign into
 * `ConverseCommand`'s constructor argument.
 */
export type M3LBedrockPlainDocument =
  | null
  | boolean
  | number
  | string
  | M3LBedrockPlainDocument[]
  | { [key: string]: M3LBedrockPlainDocument };

/**
 * Module-local plain-object guard, mirroring `core/utils/guards.ts`'s
 * `isPlainObject` exactly (prototype-chain check, not just `typeof`).
 * `aws/**` may import only `core/errors` + `core/prompt` + `core/polling`
 * (ADR-0059's ESLint island, `eslint.config.js:851-870`, asserted by
 * `bin/check-eslint-zones.mjs`) — `core/utils/guards.ts` is out of reach, so
 * this is reimplemented locally rather than imported, matching the existing
 * local-guard precedent in `aws/sqs/attributes.ts` and
 * `aws/athena/template.ts`. Do not "fix" this into a `core/utils` import —
 * it would trip `pnpm check:zones`.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reads an own property of a plain-object-shaped `unknown` value, `Object.hasOwn`-gated
 * so an inherited (prototype-chain) property never impersonates one the model
 * actually sent — the same idiom already used by `aws/sqs/attributes.ts`'s
 * `readRequiredAttribute` and `aws/athena/template.ts`'s
 * `validateOccurrences`.
 */
export function readOwn(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Property names that manipulate an object's own prototype or shape when
 * assigned via plain bracket notation, refused outright rather than merely
 * made structurally inert — see {@link copyDocument}'s null-prototype note.
 */
const DANGEROUS_DOCUMENT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Max length one {@link sanitizeForMessage}-rendered segment is allowed
 * before truncation — a length cap discards an implausibly long
 * caller/model-controlled string in favour of a safe, bounded rendering,
 * mirroring `core/errors/M3LError.ts`'s `SAFE_CAUSE_NAME_PATTERN` length-cap
 * reasoning for the same class of problem (an external string reaching
 * `error.message`, and from there `M3LError.toJSON()`'s log projection).
 */
const MAX_SANITIZED_MESSAGE_SEGMENT_LENGTH = 100;

/** Radix for {@link sanitizeForMessage}'s `\xNN` control-character escape — hex, matching the escape's own name. */
const HEX_RADIX = 16;

/** Zero-padded digit count for {@link sanitizeForMessage}'s `\xNN` escape — exactly two hex digits per byte. */
const HEX_ESCAPE_DIGIT_COUNT = 2;

/**
 * Matches every C0/C1 control character — including `\n`/`\r` (log-line
 * forging) and ESC `\x1B` (the lead byte of every ANSI escape sequence).
 */
// eslint-disable-next-line no-control-regex -- the sanitizer's entire purpose is matching control characters so it can escape them; the rule is inapplicable here.
const UNSAFE_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Renders a caller/model-controlled string safely for interpolation into an
 * `M3LError.message`: length-capped **before** any expansion (so an
 * oversized input is never fully processed), then every control character
 * escaped to `\xNN` so no newline, carriage return, or ANSI escape sequence
 * can pass through. Used by {@link formatDocumentPath} (a document object
 * key), `shared.ts`'s `formatDiscriminant` (a content-block `type`
 * discriminant), and {@link refuseServerToolUse} (a model-supplied
 * `toolUseId`/`name`) — all three interpolate an external string directly
 * into a thrown error's message (M2 finding: an unsanitized, uncapped value
 * here let a 200 KB `type` string produce a 400 KB `toJSON()` and let ANSI
 * injection reach a log sink, 2026-08-29 security pass).
 *
 * `core/errors/M3LError.ts`'s `isSafeCauseName`/`SAFE_CAUSE_NAME_PATTERN` is
 * the right pattern for this problem but is a private, unexported module
 * symbol (not re-exported from `core/errors/index.ts`) — `aws/**`'s ESLint
 * island (ADR-0059) may import only `core/errors`'s PUBLIC surface, so
 * widening that export just for this call site would widen the island;
 * replicated locally instead, deliberately with a wider allowed charset than
 * an identifier pattern — a JSON document key or a model-supplied tool name
 * is not identifier-shaped in general, so rejecting anything outside
 * `[A-Za-z0-9_$]` would discard legitimate diagnostic information for the
 * common case. Do not export this from `core/errors` just to reuse it here.
 */
export function sanitizeForMessage(value: string): string {
  const truncated =
    value.length > MAX_SANITIZED_MESSAGE_SEGMENT_LENGTH
      ? `${value.slice(0, MAX_SANITIZED_MESSAGE_SEGMENT_LENGTH)}…`
      : value;
  return truncated.replace(
    UNSAFE_CONTROL_CHAR_PATTERN,
    (char) =>
      `\\x${char.codePointAt(0)?.toString(HEX_RADIX).padStart(HEX_ESCAPE_DIGIT_COUNT, "0") ?? "00"}`,
  );
}

/**
 * Formats a {@link copyDocument} key/index trail as a JSON-path-like string
 * for an error message — e.g. `$.tools[0].inputSchema.__proto__`. Every
 * string segment here is a caller-supplied object KEY (an array INDEX is a
 * `number`, rendered directly), never a VALUE, so the corresponding value is
 * never included — but a key itself is still external, caller/model-supplied
 * data, so it is rendered through {@link sanitizeForMessage} rather than
 * interpolated raw (a secret used as a document key would otherwise reach
 * `error.message` verbatim, unbounded and unescaped — M2 finding, 2026-08-29
 * security pass).
 */
function formatDocumentPath(path: readonly (string | number)[]): string {
  let rendered = "$";
  for (const segment of path) {
    rendered +=
      typeof segment === "number"
        ? `[${segment}]`
        : `.${sanitizeForMessage(segment)}`;
  }
  return rendered;
}

/**
 * Recursively copies `value` into fresh mutable structures for the SDK's
 * mutable `DocumentType` boundary (`@smithy/types`' array arm is
 * `DocumentType[]`, not `readonly`, so a `readonly` library value is not
 * assignable to it — spreading or casting does not produce a structurally
 * mutable copy at every depth). Used for
 * {@link M3LBedrockToolDefinition.inputSchema}, a `json` tool-result
 * content block, and (per `shared.ts`'s `mapContentBlockToSdk`) a `toolUse`
 * block's `input`.
 *
 * This is a **validate-and-rebuild against a JSON grammar**: every output
 * container ({@link copyDocumentImpl}'s array/object arms) is constructed
 * from a literal this module controls (`[]`, `Object.create(null)`), never
 * derived from the input's own `constructor`/`prototype`/`Symbol.species` —
 * see {@link copyDocumentImpl}'s array-arm comment for why the previous
 * `.map()`-based implementation was unsafe even with the reserved-key
 * refusal in place (M1, 2026-08-29 security pass: a caller-controlled
 * `constructor`/`Symbol.species`, including via a Proxy `get` trap with no
 * own property, made `.map()` return an attacker-prototyped object merely
 * TYPED as an array).
 *
 * Bounded at {@link MAX_DOCUMENT_DEPTH} levels AND {@link MAX_DOCUMENT_NODES}
 * total constructed nodes — depth alone does not bound work (see
 * {@link MAX_DOCUMENT_NODES}'s doc comment). The depth bound also catches a
 * cyclic object by construction, since a cycle can never terminate and so
 * always reaches the ceiling. A value that cannot round-trip JSON at all (a
 * `bigint`, a function, a `symbol`, `undefined`) is likewise a caller error,
 * not a silent mis-serialization at send time.
 *
 * The whole recursive descent runs under one `try`/`catch`: a hostile Proxy
 * trap or throwing getter on caller input can raise an arbitrary raw error
 * (e.g. a `getOwnPropertyDescriptor`/`ownKeys`/`get` trap throwing directly),
 * and this catch re-wraps anything that isn't already this module's typed
 * error so no raw `TypeError`/`RangeError` crosses the public boundary (M2
 * finding). An already-typed error thrown deeper in the recursion is
 * rethrown unchanged, never double-wrapped.
 *
 * @param value - The value to copy; typically an `inputSchema`, a `json`
 *   tool-result payload, or a `toolUse.input`, all typed `unknown` at the
 *   public boundary.
 * @param depth - The current nesting depth; callers pass `0`.
 * @param path - The key/index trail from the root call, for error messages
 *   only; callers omit it (defaults to `[]`, meaning the root).
 * @throws {@link M3LBedrockRuntimeOperationError} (`origin: caller`,
 *   `retryable: false`) when nesting exceeds {@link MAX_DOCUMENT_DEPTH}, the
 *   total constructed-node count exceeds {@link MAX_DOCUMENT_NODES}, `value`
 *   (at any depth) is not one of `null`/a plain object/an array/a
 *   string/a number/a boolean, a plain object carries an own
 *   `__proto__`/`constructor`/`prototype` key, or reading the input raised
 *   any other error — this is caller/handler data, not model output, so a
 *   key the caller thinks they sent is refused outright rather than silently
 *   dropped.
 */
export function copyDocument(
  value: unknown,
  depth = 0,
  path: readonly (string | number)[] = [],
): M3LBedrockPlainDocument {
  try {
    return copyDocumentImpl(value, depth, path, new DocumentCopyBudget());
  } catch (cause) {
    if (cause instanceof M3LBedrockRuntimeOperationError) {
      throw cause;
    }
    throw new M3LBedrockRuntimeOperationError(
      `failed to copy an inputSchema/tool-result value at ${formatDocumentPath(path)} — reading the input raised an unexpected error`,
      { cause, origin: "caller", retryable: false },
    );
  }
}

/**
 * {@link copyDocument}'s actual recursive implementation, taking the mutable
 * {@link DocumentCopyBudget} threaded through every call — split out so the
 * public {@link copyDocument} entry point can wrap the ENTIRE recursive
 * descent (not just its own frame) in one `try`/`catch`, since a raw throw
 * from deep in the recursion propagates up through every un-caught frame to
 * that single catch.
 */
function copyDocumentImpl(
  value: unknown,
  depth: number,
  path: readonly (string | number)[],
  budget: DocumentCopyBudget,
): M3LBedrockPlainDocument {
  if (budget.visit()) {
    throw new M3LBedrockRuntimeOperationError(
      `document copy exceeded ${MAX_DOCUMENT_NODES} constructed nodes while copying an inputSchema/tool-result value at ${formatDocumentPath(path)} — a shared (not merely deep) structure can expand exponentially even within the depth ceiling`,
      { origin: "caller", retryable: false },
    );
  }
  if (depth > MAX_DOCUMENT_DEPTH) {
    throw new M3LBedrockRuntimeOperationError(
      `document nesting exceeded ${MAX_DOCUMENT_DEPTH} levels while copying an inputSchema/tool-result value at ${formatDocumentPath(path)}`,
      { origin: "caller", retryable: false },
    );
  }
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    // Never `.map()`, `.filter()`, spread, or any other method call on
    // caller input here: `.map()` performs `ArraySpeciesCreate` —
    // `Get(value, "constructor")`, then reads `[Symbol.species]` off the
    // result, then `Construct`s it — so a caller-controlled
    // `constructor`/`Symbol.species` (including one supplied by a Proxy
    // `get` trap with no own property, which an own-key check cannot see)
    // makes `.map()` return an attacker-prototyped object merely TYPED as
    // `M3LBedrockPlainDocument[]` (M1). An index loop over `value.length`,
    // accumulating into a literal `[]` this module constructs, never
    // reaches `ArraySpeciesCreate`. Do not "simplify" this back to `.map()`.
    const copy: M3LBedrockPlainDocument[] = [];
    for (let index = 0; index < value.length; index += 1) {
      copy.push(
        copyDocumentImpl(value[index], depth + 1, [...path, index], budget),
      );
    }
    return copy;
  }
  if (isPlainObject(value)) {
    return copyPlainObjectDocument(value, depth, path, budget);
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value as string | number | boolean;
  }
  throw new M3LBedrockRuntimeOperationError(
    `an inputSchema/tool-result value contained a non-JSON-serializable ${kind} at ${formatDocumentPath(path)} — bigint, function, symbol, and undefined cannot round-trip through the Converse API's document type`,
    { origin: "caller", retryable: false },
  );
}

/**
 * {@link copyDocumentImpl}'s plain-object arm, split out to keep the parent
 * function's cyclomatic complexity within the repo's lint ceiling.
 *
 * Builds `copy` on a **null prototype** (`Object.create(null)`), never a
 * `{}` literal, and refuses {@link DANGEROUS_DOCUMENT_KEYS} outright. This
 * is not decorative: the AWS SDK's request serializer (`@aws-sdk/core`'s
 * protocol layer, `JsonShapeSerializer._write`) walks a `DocumentType` with
 * `for...in`, which traverses the **prototype chain**. `JSON.parse` can
 * produce `__proto__` as a real own property (unlike an object literal), so
 * a `{}`-based `copy[key] = ...` assignment for `key === "__proto__"` would
 * fire `Object.prototype`'s `__proto__` ACCESSOR instead of creating an own
 * data property — silently dropping the key from `Object.keys(copy)` while
 * splicing the caller's nested data onto `copy`'s own prototype, which the
 * SDK's `for...in` walk would then re-surface as sibling top-level members
 * on the wire (proven end-to-end: an `inputSchema`/`json` payload's
 * `__proto__` value reaches Bedrock as extra top-level document keys). A
 * null-prototype `copy` has no such accessor, so bracket assignment always
 * creates a plain own property; the explicit key refusal below is defense
 * in depth on top of that structural fix. Do not "simplify" this back to a
 * `{}` literal.
 */
function copyPlainObjectDocument(
  value: Record<string, unknown>,
  depth: number,
  path: readonly (string | number)[],
  budget: DocumentCopyBudget,
): M3LBedrockPlainDocument {
  const copy: Record<string, M3LBedrockPlainDocument> = Object.create(
    null,
  ) as Record<string, M3LBedrockPlainDocument>;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_DOCUMENT_KEYS.has(key)) {
      throw new M3LBedrockRuntimeOperationError(
        `an inputSchema/tool-result value used the reserved key "${key}" at ${formatDocumentPath([...path, key])} — this cannot round-trip safely through the Converse API's document type`,
        { origin: "caller", retryable: false },
      );
    }
    copy[key] = copyDocumentImpl(value[key], depth + 1, [...path, key], budget);
  }
  return copy;
}
