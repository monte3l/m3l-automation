import { Core } from "@m3l-automation/m3l-common";

/**
 * How a `runbook`-handled preset's queue is otherwise governed, when it is
 * not (yet) handled through the codified procedure. `resolve-mode` reads this
 * field and stops into the matching codified terminal case for every value
 * other than `"runbook"`.
 */
export type TriageHandling =
  "runbook" | "redrive" | "script" | "ad-hoc" | "under-analysis";

/**
 * The closed verdict vocabulary `sqs-dead-letter-triage` concludes with.
 *
 * Five verdicts are authorable per known-case row in a preset — see
 * {@link AUTHORABLE_VERDICTS}, the runtime list the trust boundary validates
 * against. The remaining six are reached only through the codified terminal
 * cases and are rejected in a preset's `cases[].verdict`, so a row that only
 * matches once the entity was found cannot claim `entity-not-found`.
 */
export type TriageVerdict =
  // authorable on a case row
  | "remove"
  | "reinsert"
  | "hold"
  | "escalate"
  | "known-no-action"
  // reserved for codified terminal cases
  | "not-runbook-managed"
  | "unparseable"
  | "unrouted"
  | "no-key"
  | "entity-not-found"
  | "unrecognised";

/**
 * The subset of {@link TriageVerdict} a preset's own case rows may declare,
 * as a runtime list the trust boundary checks against. The remaining six
 * verdicts are reserved for the codified terminal cases built into the
 * procedure.
 *
 * Deliberately declared with a bare `as const` — NOT
 * `as const satisfies readonly TriageVerdict[]` — because a `satisfies`
 * clause on this literal fails `tsc --isolatedDeclarations` (the mode this
 * script's `tsconfig.build.json` builds under). Membership is still
 * compile-time-checked at the narrowing use site: `preset-validators.ts`'s
 * `parseVerdict` is annotated `: TriageVerdict` and returns the found
 * member, so a typo'd entry here fails to compile there — do not re-add
 * `satisfies` here.
 */
export const AUTHORABLE_VERDICTS = [
  "remove",
  "reinsert",
  "hold",
  "escalate",
  "known-no-action",
] as const;

/**
 * Every value {@link TriageHandling} may take, as a runtime list the trust
 * boundary checks a preset's `handling` field against.
 *
 * Deliberately declared with a bare `as const` — NOT
 * `as const satisfies readonly TriageHandling[]` — because a `satisfies`
 * clause on this literal fails `tsc --isolatedDeclarations` (the mode this
 * script's `tsconfig.build.json` builds under). Membership is still
 * compile-time-checked at the narrowing use site: `preset-validators.ts`'s
 * `parseHandling` is annotated `: TriageHandling` and returns the found
 * member, so a typo'd entry here fails to compile there — do not re-add
 * `satisfies` here.
 */
export const HANDLING_MODES = [
  "runbook",
  "redrive",
  "script",
  "ad-hoc",
  "under-analysis",
] as const;

/**
 * Case-insensitive substring keywords that make a prohibition string
 * effective against a `"reinsert"` verdict. This is the single shared
 * source both `cases.ts`'s `prohibitionBlocks` (the downgrade check) and
 * `load-runbook.ts`'s trust-boundary validation (rejecting a prohibition
 * that matches neither this set nor {@link REMOVE_PROHIBITION_KEYWORDS})
 * read — without one shared source, a prohibition string could pass
 * `validate` and print in `explain` while the two keyword lists silently
 * drifted apart and it blocked nothing at all.
 */
export const REINSERT_PROHIBITION_KEYWORDS = ["redrive", "reinsert"] as const;

/**
 * Case-insensitive substring keywords that make a prohibition string
 * effective against a `"remove"` verdict. See
 * {@link REINSERT_PROHIBITION_KEYWORDS}'s TSDoc for why this lives here
 * rather than duplicated in every consuming module.
 */
export const REMOVE_PROHIBITION_KEYWORDS = ["delete", "remove"] as const;

/**
 * Priorities `1`–`RESERVED_PRIORITY_CEILING` are reserved for the codified
 * terminal cases (`unrouted`, `no-key`, `entity-not-found`, `unrecognised`,
 * …). A preset row claiming one of them is rejected at the trust boundary
 * rather than colliding with the engine's own case table at build time,
 * because the message an operator reads should name the preset field.
 *
 * The terminal cases only occupy priorities 2–6, and the fallback is
 * implicitly 1 — priorities 7–9 are unused. That gap is intentional
 * headroom for a future codified terminal case, not an oversight.
 */
export const RESERVED_PRIORITY_CEILING = 9;

/**
 * Mirrors `Core.M3L_PROCEDURE_MAX_PATTERN_LENGTH`, checked here so an
 * oversized pattern is reported as a preset problem rather than a build-time
 * one.
 */
export const MAX_PATTERN_LENGTH = 512;

/**
 * The allow-list an extracted lookup key must satisfy before it is used
 * against a lookup tier. The key never reaches a query string — the lookup is
 * a typed key read — but it is still allow-listed at the trust boundary so an
 * unsafe extraction is rejected as a preset/message problem rather than
 * silently reaching the entity-lookup seam.
 *
 * @example
 * ```typescript
 * import { SAFE_KEY_VALUE } from "./preset.js";
 *
 * SAFE_KEY_VALUE.test("order-42"); // true
 * SAFE_KEY_VALUE.test("order 42!"); // false
 * ```
 */
export const SAFE_KEY_VALUE: RegExp = /^[\w.:@#=+-]{1,256}$/u;

/**
 * What happens when every lookup tier is exhausted without finding the
 * correlated entity.
 */
export type TriageOnMissing = "entity-not-found" | "escalate" | "hold";

/** How the SQS message body is parsed before any path is read from it. */
export interface TriageEnvelope {
  /** When true the SQS body is JSON-parsed before any path read. */
  readonly bodyIsJson: boolean;
  /** Dot path to the payload inside the parsed body; undefined = the body itself. */
  readonly payloadPath: string | undefined;
}

/** How the correlated entity's lookup key is extracted from the payload. */
export interface TriageKeyRule {
  readonly path: string;
  readonly stripPrefix: string | undefined;
  readonly addSuffix: string | undefined;
  /** Regex with exactly one capture group; the group becomes the key. */
  readonly capture: string | undefined;
}

/** One fallback tier of the lookup, tried in declaration order. */
export interface TriageLookupTier {
  readonly label: string;
  readonly table: string;
  readonly keyField: string;
}

/** How the entity's and message's state fields feed `derive-state`. */
export interface TriageStateMap {
  /** Dot path, read off the looked-up entity. */
  readonly fromState: string;
  /** Dot path, read off the message payload. */
  readonly nextState: string;
  /** Dot path to an ordered list of states; undefined disables the progression predicate. */
  readonly progression: string | undefined;
}

/** One row of an arm's known-cases table. */
export interface TriageCase {
  /** Unique within the preset; becomes the procedure's `caseId`. */
  readonly id: string;
  /** What this row means, for a maintainer. */
  readonly description: string;
  /** Operator-facing prose — what a human reads when this row wins. */
  readonly prose: string;
  /**
   * Unique within the preset and above {@link RESERVED_PRIORITY_CEILING};
   * higher wins.
   */
  readonly priority: number;
  // predicates — ALL declared ones must hold
  readonly fromState: string | undefined;
  readonly nextState: string | undefined;
  readonly eventType: string | undefined;
  /** Regex matched against the raw message body. */
  readonly signature: string | undefined;
  /** Every listed state must appear in the entity's normalised progression. */
  readonly requiredProgression: readonly string[] | undefined;
  /** The verdict this row concludes; one of {@link AUTHORABLE_VERDICTS}. */
  readonly verdict: TriageVerdict;
  readonly ticket: string | undefined;
  readonly resolution: string | undefined;
  readonly escalateTo: string | undefined;
  readonly followUps: readonly string[];
}

/** One event-type branch of a preset: how to key, look up, and judge it. */
export interface TriageArm {
  /** Discriminator value; undefined marks the single default arm. */
  readonly match: string | undefined;
  readonly label: string;
  readonly key: TriageKeyRule;
  readonly lookup: readonly TriageLookupTier[];
  readonly onMissing: TriageOnMissing;
  readonly state: TriageStateMap;
  readonly cases: readonly TriageCase[];
}

/**
 * One queue's triage preset: everything that varies between dead-letter
 * queues, as data. The step graph itself is codified and identical for every
 * preset (ADR-0077) — only which arm and which case rows a preset declares
 * changes.
 */
export interface TriagePreset {
  /** The dead-letter queue this preset governs. */
  readonly queue: string;
  /** Human-readable label for reports. */
  readonly title: string;
  /** `"runbook"` runs the codified procedure; anything else stops at `resolve-mode`. */
  readonly handling: TriageHandling;
  /** Overrides that downgrade an executable verdict to a follow-up. Always win. */
  readonly prohibitions: readonly string[];
  /** Whether the queue is FIFO; drives ordered, single-entry sends. */
  readonly fifo: boolean;
  /** Envelope path the FIFO path sorts on. */
  readonly orderBy: string | undefined;
  /** Where a `reinsert` verdict sends. */
  readonly sourceQueue: string | undefined;
  /**
   * Dot path to the FIFO message group id inside the resolved payload.
   * Required when {@link TriagePreset.fifo} is `true` (an un-sendable FIFO
   * preset must fail `validate` offline, not mid-remediation) and rejected
   * when `fifo` is `false` — a declared `groupIdPath` on a standard queue
   * would silently do nothing, which is worse than an absent field. See
   * `load-runbook.ts`'s two-way validation of this pair.
   */
  readonly groupIdPath: string | undefined;
  readonly envelope: TriageEnvelope;
  /** Envelope path holding the event-type discriminator. */
  readonly routeOn: string;
  /** One per event type; an arm with no `match` is the default arm. */
  readonly arms: readonly TriageArm[];
  /** The owning team. */
  readonly escalateTo: string;
  /** Steps the script deliberately does not automate. */
  readonly followUps: readonly string[];
  /** Conversion gaps. A non-empty `todos` fails `validate` (not enforced here). */
  readonly todos: readonly string[];
}

/** What `sqs-dead-letter-triage` concludes, for one message, in one run. */
export interface TriageConclusion {
  readonly verdict: TriageVerdict;
  /** The winning case's id, or `undefined` when a terminal case concluded. */
  readonly caseId: string | undefined;
  readonly description: string;
  readonly prose: string;
  readonly ticket: string | undefined;
  readonly resolution: string | undefined;
  readonly escalateTo: string;
  readonly followUps: readonly string[];
  /** Set when a prohibition downgraded an executable verdict. */
  readonly prohibited: string | undefined;
}

/** One SQS dead-letter message the procedure is run against. */
export interface TriageMessage {
  readonly messageId: string;
  readonly body: string;
}

/**
 * The entity-lookup seam a triage run reads through. Narrow by design: a
 * unit test supplies a fake implementation and exercises the whole step
 * graph with no DynamoDB client and no network.
 */
export interface TriageEntityLookup {
  get(
    tier: TriageLookupTier,
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<Readonly<Record<string, unknown>> | undefined>;
}

/**
 * The mutable, per-run seams the step graph writes through and later steps
 * read back — the entity-lookup counterpart to `values` for data too large
 * or non-scalar to live in the procedure engine's own value map (a resolved
 * payload, the selected arm, the looked-up entity record).
 *
 * Deliberately plain and synchronous: a unit test constructs one directly
 * with `createTriageRunState()` and drives a single step's `execute` against
 * it, with no procedure run and no lifecycle required.
 *
 * @example
 * ```typescript
 * import { createTriageRunState } from "./preset.js";
 *
 * const state = createTriageRunState();
 * state.setPayload({ orderId: "42" });
 * console.log(state.payload); // { orderId: "42" }
 * ```
 */
export interface TriageRunState {
  /** Records the payload `parse-envelope` resolved from the message body. */
  setPayload(payload: unknown): void;
  /** Records the arm `route-event` selected for this message. */
  selectArm(arm: TriageArm): void;
  /** Records the entity `lookup-entity` found, or `undefined` on a miss. */
  setEntity(entity: Readonly<Record<string, unknown>> | undefined): void;
  /** The payload most recently set by `setPayload`; `undefined` until then. */
  readonly payload: unknown;
  /** The arm most recently set by `selectArm`; `undefined` until then. */
  readonly arm: TriageArm | undefined;
  /** The entity most recently set by `setEntity`; `undefined` until then. */
  readonly entity: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Builds a fresh, empty {@link TriageRunState}. One instance is constructed
 * per run and threaded through `TriageDeps.state` — every step reads and
 * writes the same instance across the whole procedure execution.
 *
 * @returns A new run-state instance with no payload, arm, or entity set.
 *
 * @example
 * ```typescript
 * import { createTriageRunState } from "./preset.js";
 *
 * const state = createTriageRunState();
 * console.log(state.arm); // undefined
 * ```
 */
export function createTriageRunState(): TriageRunState {
  let payload: unknown;
  let arm: TriageArm | undefined;
  let entity: Readonly<Record<string, unknown>> | undefined;
  return {
    setPayload(nextPayload: unknown): void {
      payload = nextPayload;
    },
    selectArm(nextArm: TriageArm): void {
      arm = nextArm;
    },
    setEntity(nextEntity: Readonly<Record<string, unknown>> | undefined): void {
      entity = nextEntity;
    },
    get payload(): unknown {
      return payload;
    },
    get arm(): TriageArm | undefined {
      return arm;
    },
    get entity(): Readonly<Record<string, unknown>> | undefined {
      return entity;
    },
  };
}

/** The dependency bag the procedure's steps read. Opaque to the engine. */
export interface TriageDeps {
  readonly preset: TriagePreset;
  readonly message: TriageMessage;
  readonly lookup: TriageEntityLookup;
  /** The per-run mutable seams the step graph reads and writes through. */
  readonly state: TriageRunState;
}

/**
 * The declared shape of the dead-letter-triage procedure. `stepId` is a
 * closed literal union so the step graph, every `jumpsTo` target, and
 * build-time cycle detection stay compile-checked; `caseId` is deliberately
 * `string` so `.case()` can be called in a loop over an arm's known-case
 * rows.
 */
export interface TriageShape extends Core.M3LProcedureShape {
  deps: TriageDeps;
  values: {
    handling: string;
    eventType: string;
    armLabel: string;
    messageKey: string;
    lookupTier: number;
    entityFound: boolean;
    fromState: string;
    nextState: string;
    progression: string;
  };
  parameters: { queue: string; messageId: string };
  conclusion: TriageConclusion;
  stepId:
    | "resolve-mode"
    | "parse-envelope"
    | "route-event"
    | "extract-key"
    | "widen-lookup"
    | "lookup-entity"
    | "check-entity-present"
    | "derive-state"
    | "match-known-cases";
  caseId: string;
}

/**
 * Normalises an ordered progression to a single lowercased, comma-delimited
 * string with a leading and trailing comma, since the procedure engine's
 * value map is scalar-only and cannot carry an array.
 *
 * The leading/trailing commas let a `contains`-style predicate test
 * `",paid,"` without a prefix collision — `"unpaid"` would otherwise
 * wrongly match a bare `"paid"` substring search.
 *
 * @param states - The ordered progression, e.g. `["created", "paid", "shipped"]`.
 * @returns The delimited string, e.g. `",created,paid,shipped,"`.
 *
 * @example
 * ```typescript
 * import { normaliseProgression } from "./preset.js";
 *
 * normaliseProgression(["Created", "Paid"]); // ",created,paid,"
 * ```
 */
export function normaliseProgression(states: readonly string[]): string {
  return `,${states.map((state) => state.toLowerCase()).join(",")},`;
}

/**
 * Reads a simple dot-path (`"a.b.c"`) off untrusted, arbitrary message data —
 * the shared reader every path field in a preset (`envelope.payloadPath`,
 * `key.path`, `state.fromState`/`nextState`/`progression`) is walked through.
 *
 * Only own, enumerable properties of a **plain object** resolve at each hop
 * — an array is never indexed (numeric segments are out of scope here), and
 * `Object.hasOwn` is checked at every hop so an *inherited* property can
 * never resolve, even when the source is hostile JSON. That does **not**
 * mean a literal `"__proto__"` path segment always misses: `JSON.parse`
 * turns a `"__proto__"` key in its input into an ordinary **own** data
 * property — it never touches the real prototype — so `Object.hasOwn`
 * legitimately sees it and this function reads it like any other field (see
 * the example below). The guarantee that actually holds, and the one that
 * matters here, is narrower: no *inherited* value ever resolves, and this
 * function never writes anything, so no preset field can be used to pollute
 * `Object.prototype`. Total: a missing segment, a non-object intermediate
 * value, or an empty path all yield `undefined` rather than throwing.
 *
 * @param source - The value to walk into. Never mutated.
 * @param path - The dot-delimited path, e.g. `"detail.orderId"`.
 * @returns The resolved value, or `undefined` when any hop misses.
 *
 * @example
 * ```typescript
 * import { readPath } from "./preset.js";
 *
 * readPath({ detail: { orderId: "42" } }, "detail.orderId"); // "42"
 * readPath({ detail: { orderId: "42" } }, "detail.missing"); // undefined
 * // JSON.parse makes "__proto__" an own data property here (never the real
 * // prototype), so this legitimately resolves — Object.hasOwn(...) is
 * // `true` — rather than returning `undefined`. No pollution occurs:
 * // ({}).polluted stays `undefined` after this call.
 * readPath(JSON.parse('{"__proto__":{"polluted":true}}'), "__proto__.polluted"); // true
 * ```
 */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (!Core.isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}
