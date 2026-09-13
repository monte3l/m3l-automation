/**
 * `lib/triage-presets` — the verification seam that turns an
 * operator-declared `presetAllowlist` into a {@link VerifiedTriagePresets}
 * brand, closing six structural gaps `triage-logs` would otherwise expose.
 *
 * @remarks
 * `cloudwatch-logs-analysis` DECLARES its own `aws.profile` parameter, so
 * slice 3a's `buildEtlTools` class refusal (which excludes any target script
 * that declares one) cannot cover this tool — `triage-logs` needs its own
 * builder, and this module is the check that stands in for it.
 *
 * `M3LScript.loadConfig` resolves an environment variable at precedence
 * level 4 and a preset at level 6, `deriveEnvVarName("aws.profile")` is
 * `AWS_PROFILE`, and `lib/cli-process.ts` spawns the child with no `env`
 * option — so an inherited `AWS_PROFILE` silently outranks any `aws.profile`
 * a preset declares. A preset's own `aws.profile:` key therefore LOOKS like
 * it re-targets the run and does not: it is inert whenever the operator
 * already has the environment variable set, and misleading the rest of the
 * time. The operator's own profile is the single graded target, so an own
 * `aws.profile` key is refused outright rather than compared against it.
 *
 * `AgentCliRunOptions.mode` is `"dry-run" | "mutate"` and nothing ties argv
 * mode to a policy action's `kind` — a mutating-script preset reaching a
 * tool built for read-only triage would execute a real mutation under
 * `read-only-auto-approved`. Closed here structurally: every allowlisted
 * preset's own `operation` key must name one of
 * {@link TRIAGE_READ_ONLY_OPERATIONS}, so `convert` (which writes a preset
 * skeleton to disk) and any script-specific mutating verb can never be named
 * by a triage preset in the first place.
 *
 * All three checks read only OWN keys reported by `rawKeys()` — deliberately
 * shallow. `Core.M3LYAMLConfigProvider` does not follow `extends` (only
 * `M3LScriptPresetLoader` does), so a shallow read is complete only once a
 * triage preset is refused the ability to declare its own `extends` in the
 * first place: without that refusal, a base preset could carry an
 * `aws.profile` or a mutating `operation` invisibly to this module, and the
 * other two checks would be exactly the vacuous guard that never fires.
 * Declaring a triage preset a LEAF is therefore not a stylistic
 * simplification — it is what makes checks 3 and 4 sound.
 *
 * Every own-key check above reads through the injected `readProvider`, which
 * a real caller wires to `Core.M3LYAMLConfigProvider` — a YAML-only parser.
 * But the run this module verifies for does not always load through that
 * parser: `M3LScriptPresetLoader.parsePresetFile` dispatches on the preset
 * file's own EXTENSION, treating `.yaml`/`.yml` as YAML and anything else —
 * `.json` included — as `JSON.parse`. Nothing pinned the allowlist entry's
 * extension, so a `.json` preset could be verified through one parser and
 * executed through another; the divergence that matters is a duplicate key,
 * where the `yaml` package throws and `JSON.parse` silently keeps the last
 * value. Refusing any entry that does not end in `.yaml` or `.yml` closes
 * this by construction: verification and execution are now guaranteed to
 * read the same bytes through the same parser, rather than merely happening
 * to agree on the fixtures anyone thought to try.
 *
 * `join(workspaceRoot, relativePath)` normalises a `..` segment away, so an
 * entry of `../../../etc/passwd` resolves to a real absolute path outside the
 * workspace with no error at all. This module is an EXPORTED function over a
 * bare `ReadonlyMap<string, string>` — nothing stops a second call site from
 * constructing that map directly, bypassing whatever validation
 * `steps/resolve-runtime.ts`'s config parser already applies on the wired
 * path. `lib/cli-surface.ts`'s `resolveAllowedPresetPath` re-checks
 * containment at its own use site for exactly this reason, and this module
 * applies the same shared predicate before its own join for the same reason:
 * an allowlist value is only as trustworthy as the last function that
 * touched it, not the first.
 *
 * @packageDocumentation
 */

import { join } from "node:path";

import { M3LAgentOperatorCliError } from "./errors.js";
import { isDeclarablePresetPath } from "./preset-names.js";

declare const VERIFIED_TRIAGE_PRESETS: unique symbol;

/**
 * A `preset name -> workspace-relative preset path` map that has already
 * passed every check {@link verifyTriagePresets} performs — minted there and
 * nowhere else. The brand is a **compile-time-only** device (erased by
 * `tsc`, no runtime representation of its own); the actual guarantee is
 * enforced entirely by {@link verifyTriagePresets}, the only function
 * permitted to produce one.
 *
 * A `boolean` "verified" flag was considered and rejected: a caller can
 * forge `true` by simply writing it, but nothing can forge possession of
 * this brand without having gone through the checks that mint it — the same
 * argument `lib/preset-names.ts`'s module remarks make for
 * `AgentOperatorPresetName`.
 *
 * Structurally this brand differs from every `string` brand in this script
 * ({@link "./preset-names.js".AgentOperatorPresetName} and
 * `AgentOperatorPresetPath`): a `string` cannot drift once minted, but a
 * `Map` is a live, mutable object, so the value the brand is layered onto can
 * change out from under it AFTER minting. That is exactly what the defensive
 * copy in {@link verifyTriagePresets} closes — the brand certifies the
 * INSTANCE `verifyTriagePresets` returns, never the caller's own backing
 * `Map`, which the caller is free to keep mutating.
 *
 * A known, DOCUMENTED, and deliberately accepted residual: an intersection
 * with `ReadonlyMap<string, string>` means a value already typed (not just
 * shaped like) `ReadonlyMap<string, string>` can be asserted to this brand
 * with a bare `as` and no error — `someMap as VerifiedTriagePresets` compiles
 * whenever `someMap`'s declared type is `ReadonlyMap<string, string>`, which
 * is exactly `runtime.presetAllowlist`'s declared type on the one real wiring
 * site. `new Map() as VerifiedTriagePresets` is correctly rejected by `tsc`
 * (`TS2352`) because a freshly-constructed `Map` is not ALREADY typed as the
 * read-only interface; only the base-type-annotated case slips through, and
 * it slips through because assertion comparability runs in the OTHER
 * direction (this branded type is assignable to `ReadonlyMap`, which is all
 * `tsc` checks for `as`). Typing the brand property `never` was proposed as
 * a fix and does not work — it was compiled and rejected: both the reported
 * hole and the `never`-typed variant compile identically, because no type
 * given to the brand PROPERTY can change which way the intersection is
 * comparable to its base type. Properly closing this needs an opaque wrapper
 * (a real, unerased runtime container) or a package-wide lint rule banning a
 * bare-`as` cast to a branded type — out of scope here. This brand is still
 * strictly stronger than every OTHER brand in this package: a bare
 * `"raw"` string cast to either `AgentOperatorScriptName` or
 * `AgentOperatorPresetName` compiles with no friction at all, while this
 * one at least rejects a freshly constructed `Map`.
 *
 * @example
 * ```ts
 * import type { VerifiedTriagePresets } from "./triage-presets.js";
 *
 * // A function that requires proof every entry already passed the six
 * // triage-preset refusals, rather than a raw, unchecked allowlist.
 * function useVerifiedPresets(presets: VerifiedTriagePresets): void {
 *   for (const [name] of presets) {
 *     void name;
 *   }
 * }
 * ```
 */
export type VerifiedTriagePresets = ReadonlyMap<string, string> & {
  readonly [VERIFIED_TRIAGE_PRESETS]: unique symbol;
};

/**
 * The closed set of `cloudwatch-logs-analysis` operations a triage preset's
 * own `operation` key may name — exactly one member, `analyze`. Frozen so a
 * caller cannot mutate the array a shared reference points at.
 *
 * Narrower than `cloudwatch-logs-analysis`'s own operation set on purpose:
 * `AgentCliSurface.triageRun` unconditionally pins `--operation=analyze` at
 * config precedence level 1 (CLI), so `validate` and `explain` are never
 * reachable through this seam even though the target script supports them.
 * A preset naming either would pass this module's verification and then die
 * at the CHILD script's own config load — `analyze`'s `requiredParameters`
 * (`aws.profile`, `alarm`, `triggeredAt`) are not what a `validate`/`explain`
 * preset need carry, so the failure would land after authorization, not
 * before it. Naming only the verb the seam can actually run is what keeps
 * verification and execution agreeing; `convert` is excluded for the
 * additional reason that it writes a preset skeleton to disk, so naming it
 * from a triage preset would smuggle a write through a tool built and
 * policy-graded as read-only.
 *
 * @example
 * ```ts
 * import { TRIAGE_READ_ONLY_OPERATIONS } from "./triage-presets.js";
 *
 * TRIAGE_READ_ONLY_OPERATIONS.includes("analyze"); // true
 * TRIAGE_READ_ONLY_OPERATIONS.includes("validate"); // false
 * TRIAGE_READ_ONLY_OPERATIONS.includes("explain"); // false
 * TRIAGE_READ_ONLY_OPERATIONS.includes("convert"); // false
 * ```
 */
export const TRIAGE_READ_ONLY_OPERATIONS: readonly string[] = Object.freeze([
  "analyze",
]);

/**
 * The provider surface {@link verifyTriagePresets} needs from a resolved
 * preset file — exactly `Core.M3LYAMLConfigProvider`'s public shape.
 * Exported (the sibling `BuildTriageToolsDeps` is exported too) so a caller
 * can annotate its own `readProvider` implementation, including a test
 * double, by name rather than restating the shape structurally.
 *
 * @example
 * ```ts
 * import type { TriagePresetReader } from "./triage-presets.js";
 *
 * const reader: TriagePresetReader = {
 *   rawKeys: () => ["operation"],
 *   getRawValue: (key) => (key === "operation" ? "analyze" : undefined),
 * };
 * ```
 */
export interface TriagePresetReader {
  rawKeys(): readonly string[];
  getRawValue(key: string): unknown;
}

/**
 * Dependencies {@link verifyTriagePresets} needs to check every allowlist
 * entry. Exported for the same reason as {@link TriagePresetReader}: a
 * caller building its own `deps` object — in a test or in a real wiring
 * site — can annotate it by name.
 *
 * @example
 * ```ts
 * import type { VerifyTriagePresetsDeps } from "./triage-presets.js";
 *
 * const deps: VerifyTriagePresetsDeps = {
 *   presetAllowlist: new Map([
 *     ["checkout-5xx", "data/config/presets/triage-checkout-5xx.yaml"],
 *   ]),
 *   workspaceRoot: "/workspace/m3l-automation",
 *   readProvider: () => ({
 *     rawKeys: () => ["operation"],
 *     getRawValue: () => "analyze",
 *   }),
 * };
 * ```
 */
export interface VerifyTriagePresetsDeps {
  /** The `preset name -> workspace-relative preset path` map an operator declared in config. */
  readonly presetAllowlist: ReadonlyMap<string, string>;
  /** The absolute directory every declared preset path is resolved against. */
  readonly workspaceRoot: string;
  /**
   * Builds the reader for one resolved absolute preset path. Injected so
   * tests need no filesystem; a real caller passes a function constructing
   * `Core.M3LYAMLConfigProvider`.
   */
  readonly readProvider: (absolutePath: string) => TriagePresetReader;
}

/**
 * Throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_PRESET`
 * naming `presetName` (an operator-authored config key, never model input,
 * so it is safe to echo) with a fixed, value-free reason.
 */
function rejectPreset(presetName: string, reason: string): never {
  throw new M3LAgentOperatorCliError(
    `triage preset "${presetName}" ${reason}`,
    "ERR_AGENT_OPERATOR_PRESET",
    { context: { presetName } },
  );
}

/**
 * Applies the three own-key refusals (`extends`, `aws.profile`, `operation`)
 * to a single resolved preset. Never echoes a preset VALUE — every thrown
 * message and context is built from fixed strings and the preset NAME alone.
 */
function checkTriagePreset(
  presetName: string,
  reader: TriagePresetReader,
): void {
  const ownKeys = reader.rawKeys();

  if (ownKeys.includes("extends")) {
    rejectPreset(
      presetName,
      "declares its own extends key; a triage preset must be a leaf",
    );
  }

  if (ownKeys.includes("aws.profile")) {
    rejectPreset(
      presetName,
      "declares its own aws.profile key, which is inert or misleading under the operator's own profile",
    );
  }

  if (!ownKeys.includes("operation")) {
    rejectPreset(presetName, "declares no own operation key");
  }

  const operation: unknown = reader.getRawValue("operation");
  if (typeof operation !== "string") {
    rejectPreset(presetName, "declares a non-string operation key");
  }
  if (!TRIAGE_READ_ONLY_OPERATIONS.includes(operation)) {
    rejectPreset(
      presetName,
      "declares an operation outside the read-only triage set",
    );
  }
}

/**
 * Whether `relativePath` ends in `.yaml` or `.yml` — the two extensions
 * `M3LScriptPresetLoader.parsePresetFile` parses as YAML. Every other
 * extension, `.json` included, is parsed as `JSON.parse` by that loader, so
 * an allowlist entry that fails this check would be verified through
 * `Core.M3LYAMLConfigProvider` here and executed through a different parser
 * at run time — the exact divergence {@link verifyTriagePresets}'s module
 * remarks describe.
 */
function hasYamlOrYmlPresetExtension(relativePath: string): boolean {
  return relativePath.endsWith(".yaml") || relativePath.endsWith(".yml");
}

/**
 * Verifies every entry of an operator-declared `presetAllowlist` against the
 * six triage-preset refusals, in the order the code below checks them: an
 * empty allowlist, a containment escape, a non-`.yaml`/`.yml` extension, an
 * own `extends` key, an own `aws.profile` key, and an
 * absent/non-string/non-read-only `operation` key — and returns a defensive
 * copy of the entries re-typed as
 * {@link VerifiedTriagePresets} once every entry has passed. This is the
 * **only** minting site of that brand.
 *
 * Every entry is checked; the loop never stops at the first failure or the
 * first success, so a bad SECOND entry is refused exactly as a bad first one
 * would be. The extension and containment refusals run BEFORE `join` and
 * BEFORE `readProvider` is ever called for that entry — a check that reads
 * the file first and rejects after is not a containment check, and this
 * module accepts an exported, injectable `readProvider` precisely because a
 * caller-supplied stub can prove that ordering.
 *
 * `async` is not decorative here: every refusal below is a `throw`, and
 * declaring this function `async` is what turns each one into a REJECTION of
 * the returned promise rather than a synchronous throw out of the call
 * itself. A caller that writes `verifyTriagePresets(x).catch(handler)` —
 * exactly the shape the declared `Promise` return type invites — needs the
 * call to `verifyTriagePresets` to always succeed in producing a promise, so
 * `.catch` has something to attach to; a non-`async` function returning
 * `Promise<T>` from a `throw` breaks that invitation for every early-exit
 * path, and every path here is an early exit.
 *
 * @param deps - See {@link VerifyTriagePresetsDeps}.
 * @returns A NEW `Map` holding every allowlist entry, branded as verified.
 *   Deliberately not the caller's own `Map` re-branded: the brand certifies a
 *   verified INSTANCE, and returning the caller's live handle would let a
 *   `set` call made after minting silently extend what the brand claims to
 *   cover.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_PRESET`
 *   when `presetAllowlist` is empty, or when any entry fails one of the six
 *   refusals.
 *
 * @example
 * ```ts
 * import { Core } from "@monte3l/m3l-common/core";
 * import { verifyTriagePresets } from "./triage-presets.js";
 *
 * const verified = await verifyTriagePresets({
 *   presetAllowlist: new Map([
 *     ["checkout-5xx", "data/config/presets/triage-checkout-5xx.yaml"],
 *   ]),
 *   workspaceRoot: "/workspace/m3l-automation",
 *   readProvider: (absolutePath) => new Core.M3LYAMLConfigProvider(absolutePath),
 * });
 * ```
 */
/* eslint-disable-next-line @typescript-eslint/require-await -- `async` is not for awaiting `readProvider` (synchronous by contract); it exists so every refusal below rejects the returned promise rather than throwing synchronously — see the TSDoc above. */
export async function verifyTriagePresets(
  deps: VerifyTriagePresetsDeps,
): Promise<VerifiedTriagePresets> {
  if (deps.presetAllowlist.size === 0) {
    throw new M3LAgentOperatorCliError(
      "triage preset allowlist has no entries",
      "ERR_AGENT_OPERATOR_PRESET",
    );
  }

  for (const [presetName, relativePath] of deps.presetAllowlist) {
    // Containment first: an entry that escapes the presets directory is
    // refused before this module ever forms a path from it, let alone reads
    // one — screened here even though `steps/resolve-runtime.ts`'s config
    // parser already validates the wired path, because this is an EXPORTED
    // function over a bare `ReadonlyMap<string, string>` and a second call
    // site would otherwise make it an arbitrary-file-read primitive.
    if (!isDeclarablePresetPath(relativePath)) {
      rejectPreset(
        presetName,
        "declares an allowlist path outside the presets directory, or containing a disallowed segment",
      );
    }
    if (!hasYamlOrYmlPresetExtension(relativePath)) {
      rejectPreset(
        presetName,
        "declares an allowlist path that does not end in .yaml or .yml",
      );
    }

    const absolutePath = join(deps.workspaceRoot, relativePath);
    const reader = deps.readProvider(absolutePath);
    checkTriagePreset(presetName, reader);
  }

  // The one minting site for this brand. A `Map` is deliberately NOT
  // comparable to `VerifiedTriagePresets` by a single `as` — only the base
  // `ReadonlyMap<string, string>` type is (the documented residual on the
  // brand's own TSDoc) — so the defensive copy needs an explicit `unknown`
  // hop here rather than a weaker `ReadonlyMap`-typed intermediate, which
  // would route this one honest mint through the very hole that residual
  // describes.
  return new Map(deps.presetAllowlist) as unknown as VerifiedTriagePresets;
}
