# `config` — Multi-source configuration

The `config` module resolves configuration values from an ordered chain of providers (CLI, files, environment, Lambda event, presets) plus static defaults and async fallbacks. It supports parameter typing, key aliases, and per-value source tracking.

## Overview

`M3LConfigReader` takes an ordered `ReadonlyArray<M3LConfigProvider>` and resolves values by walking the providers in priority order. Each `M3LConfigParameter` declares its type and optional default/fallback, and `M3LConfig` records where every resolved value came from. Provider classes adapt different input sources (command line, JSON, YAML, environment variables, in-memory, Lambda event, presets) to the common `M3LConfigProvider` shape.

## Public API

Exported from `@m3l-automation/m3l-common/core` (the `config` sub-module):

- `M3LConfig`
- `M3LConfigReader`
- `M3LConfigResolution` (a resolved value paired with the source label that supplied it — returned by `M3LConfigReader.resolveForKeys` and `M3LConfigParameter.resolveAsync`)
- `M3LConfigProvider`
- `M3LConfigParameter`
- `M3LConfigParameterType`
- `M3LCoercedValue` (type-level map from a `M3LConfigParameterType` member to its coerced result type)
- `M3LConfigSchema`
- `M3LConfigHelpFormatter` (renders a `--help`-style usage listing from a declared `M3LConfigSchema`)
- Provider classes: `M3LCommandLineConfigProvider`, `M3LJSONConfigProvider`, `M3LYAMLConfigProvider`, `M3LEnvironmentConfigProvider`, `M3LInMemoryConfigProvider`, `M3LLambdaEventConfigProvider`, `M3LPresetConfigProvider`
- `coerceConfigValue` (the value parser: coerces a raw provider value to its declared `M3LConfigParameterType`, throwing on a type mismatch; generic over the target type so its return is `M3LCoercedValue<T>`, not `unknown`)
- `M3LSecretsSpecifier`
- `deriveSecretsSpecifier`, `M3LDeriveSecretsSpecifierOptions` (derives an `M3LSecretsSpecifier` from a schema's declared `secret` parameters — see [Secret parameters](#secret-parameters))
- `M3LUnknownParameterDetector`
- `M3LUnknownParameterSuggestion`, `M3LUnknownParameterSuggestOptions` (the typed result/options pair for `M3LUnknownParameterDetector.detectWithSuggestions`)
- `M3LConfigValidator` (type: a `(value) => true | string` schema-time validator)
- `M3LConfigValidators` (stock validators: `range`, `regex`, `oneOf`, `nonEmpty`, `minLength`)
- `M3LConfigSchemaValidator` (type: a `(config) => true | string` cross-parameter, schema-level validator)
- `M3LConfigSchemaValidators` (stock schema-level validators: `requires`)
- `M3LConfigAccessor` (defensive typed re-reads of an already-resolved `M3LConfig` value, plus `M3LConfigAccessorOptions`)
- Errors: `M3LConfigCoercionError`, `M3LConfigParseError`, `M3LUnsafeConfigKeyError`, `M3LConfigValidationError`, `M3LConfigMissingError`

## Provider priority chain

`M3LConfigReader` walks the provided array in declared priority order, returning the first value found. The standard ordering for a parameter is:

1. CLI args (`M3LCommandLineConfigProvider`) — source label `"cli"`
2. JSON config file (`M3LJSONConfigProvider`) — source label `"json-file"` — under `M3LScript`, wired via [`options.configFiles`](./script.md#config-files-optionsconfigfiles)
3. YAML config file (`M3LYAMLConfigProvider`) — source label `"yaml-file"` — same seam as level 2
4. Environment variables and `.env` (`M3LEnvironmentConfigProvider`) — source label `"environment-variable"`
5. Lambda event payload (`M3LLambdaEventConfigProvider`, Lambda only) — source label `"lambda-event"` — under `M3LScript`, wired automatically by [`createLambdaHandler()`](./script.md#configuration-from-the-lambda-event); no caller wiring required
6. Preset file (`M3LPresetConfigProvider`) — source label `"preset"`

Levels 2 and 3 are not fixed to JSON-before-YAML: under `M3LScript`, both are
wired via a single `options.configFiles` array, and array order — not file
type — decides which of a JSON or YAML entry outranks the other.

When no provider supplies a value, resolution continues to the static default, then the async fallback (see below).

Every provider declares its label via `getSourceLabel()`, an overridable method on the `M3LConfigProvider` base class (default `"other"`). `M3LConfigReader.resolveForKeys(keys)` returns the winning provider's value paired with that label as an `M3LConfigResolution`; `getRawValueForKeys(keys)` delegates to it and returns just the value, unchanged from before. `M3LInMemoryConfigProvider` reports `"in-memory"`.

## Alias resolution

`getRawValueForKeys(keys)` implements alias support: for each provider, all alias keys are tried before moving to the next lower-priority provider. This guarantees that a higher-priority provider's alias always wins over a lower-priority provider's canonical key — for example, a CLI `--alias-name` wins over a JSON file's canonical `canonical.name`, even though both refer to the same parameter.

## Resolution order

For each `M3LConfigParameter`, `getValueAsync()` resolves the value in this order:

1. Provider value (via `M3LConfigReader`)
2. `defaultValue` (static, if defined)
3. `asyncFallback()` (called as an async function only if both above are absent)

Combined with the provider chain above, this yields the full 8-level resolution order:

```text
1. CLI args
2. JSON config file
3. YAML config file
4. Environment variables + .env
5. Lambda event payload (Lambda only)
6. Preset file
7. defaultValue (static literal)
8. asyncFallback() (async function, called only when all above are absent)
```

Because step 8 may perform asynchronous I/O, value resolution is async.

When a parameter declares `required: true`, reaching the end of this chain with
no value supplied (no provider value, no `defaultValue`, no `asyncFallback`)
throws `M3LConfigMissingError` (`code: "ERR_CONFIG_MISSING"`) instead of
resolving to `undefined`. See [Required parameters](#required-parameters).

## Parameter types

`M3LConfigParameterType` declares the coercion target. Each member maps to a
specific coerced result type, expressed by the `M3LCoercedValue<T>` conditional
type. `coerceConfigValue` and `M3LConfigParameter` are both typed by this map,
so a `defaultValue` (or the resolved value) whose type disagrees with the
declared `type` is a **compile error** — the parameter's value type is inferred
from its `type`, not declared independently:

| `M3LConfigParameterType` member | `M3LCoercedValue<T>` (coerced result) |
| ------------------------------- | ------------------------------------- |
| `STRING`                        | `string`                              |
| `INT`                           | `number`                              |
| `DOUBLE`                        | `number`                              |
| `BOOL`                          | `boolean`                             |
| `STRING_ARRAY`                  | `readonly string[]`                   |
| `INT_ARRAY`                     | `readonly number[]`                   |
| `DOUBLE_ARRAY`                  | `readonly number[]`                   |
| `BUFFER`                        | `Buffer`                              |

`coerceConfigValue(raw, type)` returns `M3LCoercedValue<typeof type>`;
`new M3LConfigParameter({ type, defaultValue })` requires `defaultValue` (and
`asyncFallback`'s resolved value) to be `M3LCoercedValue<typeof type>`, and
`getValueAsync()` resolves to `M3LCoercedValue<typeof type> | undefined`. For
example, `new M3LConfigParameter({ type: M3LConfigParameterType.INT, defaultValue: "3000" })`
does not compile — `defaultValue` must be a `number`.

## Descriptions and `--help` rendering

A parameter may declare a human-readable `description`:

```typescript
const region = new Core.M3LConfigParameter({
  name: "region",
  type: Core.M3LConfigParameterType.STRING,
  aliases: ["aws-region"],
  defaultValue: "eu-south-1",
  description: "AWS region to operate in",
});
```

`description` is purely presentational — it is never consulted by resolution.
`M3LConfigParameter` exposes it, alongside the other declared fields, via
getters mirroring the existing `getName()`/`getAliases()` style:
`getType()`, `isRequired()`, `isSecret()`, `getDefaultValue()`, and
`getDescription()`.

`M3LConfigHelpFormatter` renders a plain-text usage listing from a declared
`M3LConfigSchema`, one block per parameter in declaration order, separated by
a blank line:

```typescript
const formatter = new Core.M3LConfigHelpFormatter();
console.log(formatter.format(schema));
// --region, --aws-region <STRING>
//     AWS region to operate in
//     default: eu-south-1
```

Each block's header line lists the canonical name and every alias as
`--name`-style flags, then the declared type in angle brackets, then a
trailing `(required)` marker when the parameter declares `required: true`.
A description line and a `default: <value>` line follow when declared —
either, both, or neither, in that order. An array-typed default renders
comma-joined (`default: a, b, c`); every other declared type renders via
`String(value)`. `format()` never throws and never resolves a value; an empty
schema renders `""`.

## Secret parameters

A parameter may declare itself secret:

```typescript
const apiKey = new Core.M3LConfigParameter({
  name: "apiKey",
  type: Core.M3LConfigParameterType.STRING,
  required: true,
  secret: true,
  description: "API key for the target service",
});
```

`secret` (default `false`) is exposed via an `isSecret(): boolean` getter in
the same declared-fields getter family as `isRequired()`. Like
`description`, it is **purely declarative — never consulted by resolution,
coercion, or validation**. It exists as a machine-readable marker for
consumers that handle parameter _values_ outside the resolution path, which
must uphold this contract:

- **Never persist** a secret parameter's value (a preset/history writer
  skips it, with an explicit notice rather than a silent drop).
- **Never display** a secret parameter's resolved or default value
  unmasked — route any rendering through
  `redactSensitiveLogValue` (`core/logging`) or equivalent masking.
- A secret parameter's **name, type, and description are not secret** —
  listings and `--help` render its block normally, **except the
  `default:` line, which `M3LConfigHelpFormatter` masks** (`default: ********`)
  when `isSecret()` is true. A source-literal secret default is already
  visible in source, but nothing constrains `defaultValue` to a literal —
  an env- or runtime-sourced default (`defaultValue: process.env.API_TOKEN`)
  would otherwise leak into help output and any consumer that persists
  rendered descriptors.
- **History surfaces store names and outcomes only, never values** — the
  same never-persist rule as presets, stated here so both 8f surfaces
  inherit it from the spec rather than each other.

### `deriveSecretsSpecifier`

```typescript
interface M3LDeriveSecretsSpecifierOptions {
  readonly includeAliases?: boolean; // default true
}

function deriveSecretsSpecifier(
  schema: M3LConfigSchema,
  options?: M3LDeriveSecretsSpecifierOptions,
): M3LSecretsSpecifier;
```

A standalone function — not a `M3LConfigSchema` method, matching the
free-function convention `coerceConfigValue` already establishes for
per-schema derivations — that derives an `M3LSecretsSpecifier` from a
schema's declared parameters: every parameter where `isSecret()` is `true` is
marked. A non-secret parameter contributes nothing.

**`includeAliases` defaults to `true`.** A secret is reachable under any of
its declared aliases — the m3l CLI's dynamic per-script subcommands accept a
secret parameter's alias as a flag exactly like its canonical name
(`docs/reference/cli.md`, phase 8d) — so a _lookup_ consumer (redaction,
below) that only marked the canonical name would under-redact a value logged
by its alias. This means `secretNames` on the returned specifier is, by
default, a set of _reachable flag names_, not a 1:1 set of declared parameter
names — a parameter with two aliases contributes three entries. Pass
`{ includeAliases: false }` when the consumer instead _iterates_ the
specifier as a parameter-name set (e.g. a listing that prints "these
parameters are secret") and needs a clean 1:1 mapping.

**Known gap — the marked set does not cover every reachable spelling.**
`M3LSecretsSpecifier.isSecret` is an exact, case-sensitive name match. A
declared name or alias is also reachable through
`M3LEnvironmentConfigProvider`'s derived SCREAMING_SNAKE env-var key (e.g. a
declared `tenantRef` is readable as `TENANT_REF`), which `deriveSecretsSpecifier`
does not additionally mark — unlike the built-in redaction heuristic
(`core/logging`), which is case- and separator-insensitive by design. A value
logged under the env-derived spelling is therefore not redacted by the
derived specifier alone. This is a known limitation, not a bug; widen the
options bag if this ever needs closing.

A schema with no secret parameters returns an empty (but non-`undefined`)
specifier. Each call returns a fresh instance; mutating it via `markSecret`
never affects the schema or any other returned specifier.

This is the schema-side half of the `secret`-flag contract: `isSecret()`
above is the per-parameter declaration, `deriveSecretsSpecifier` is what
turns a whole schema's declarations into the name-set `redactSensitiveLogValue`
/ `redactSensitiveLogText` (`core/logging`) consult to redact a value the
built-in heuristic key-list wouldn't otherwise catch — see
[`core/logging`'s redaction section](./logging.md#redacting-with-a-declared-secrets-specifier).
A consumer such as the m3l CLI's preset layer (ADR-0042 phase 8f) may still
choose to carry its own serializable secret flag instead of a live
`M3LSecretsSpecifier` instance when the specifier can't survive a persistence
boundary (e.g. a JSON-serialized discovery cache) — `deriveSecretsSpecifier`
is for in-process consumers that hold a live `M3LConfigSchema`, such as a
script's own logging setup.

## Typo suggestions

`M3LUnknownParameterDetector.detectWithSuggestions(suppliedKeys, options?)` is
an additive alternative to `detect()` — `detect()` itself is unchanged — that
pairs each undeclared key with its nearest declared name/alias candidates:

```typescript
const detector = new Core.M3LUnknownParameterDetector(schema);
detector.detectWithSuggestions(["regoin"]);
// [{ key: "regoin", suggestions: ["region"] }]
```

Candidates are ranked by ascending restricted Damerau–Levenshtein distance —
insertions, deletions, substitutions, and adjacent transpositions each cost
one edit — against every name in `schema.declaredNames()`, filtered to
`options.maxDistance` (default `2`), capped at `options.maxSuggestions`
(default `3`), with ties broken by `declaredNames()` order. A key with no
candidate within `maxDistance` still appears in the result, with an empty
`suggestions` array — the returned array covers exactly the same keys
`detect()` would flag, in the same `suppliedKeys` order.

## Schema-time validation

A parameter may declare an optional `validate` function that rejects a coerced
value failing an application constraint — a port out of range, a string that
must match a pattern, a value that must be one of a fixed set.

```typescript
export type M3LConfigValidator<T> = (value: T) => true | string;
```

- **`true`** is the only passing result — the value is accepted.
- **Any string** is the human-readable failure reason; resolution throws
  `M3LConfigValidationError` carrying that reason. (A string result — not a
  boolean — means a truthy non-`true` value can never be mistaken for "valid".)

The validator is attached through `M3LConfigParameterOptions`:

```typescript
readonly validate?: M3LConfigValidator<M3LCoercedValue<TType>>;
```

Its input type follows the parameter's declared `type` through
`M3LCoercedValue<TType>`, so a validator on an `INT` parameter receives a
`number`, one on a `STRING_ARRAY` receives `readonly string[]`, and a validator
typed for the wrong shape is a **compile error**.

### When it runs

Validation runs on the **coerced** value (never the raw provider string), at
three points:

1. **Eagerly in the constructor** — a declared `defaultValue` is validated when
   the parameter is constructed. A default that violates its own validator is a
   programming error, so it fails fast at declaration, not lazily at resolution.
2. **After provider coercion** — a value supplied by a provider is coerced, then
   validated, before `getValueAsync()` returns it.
3. **After `asyncFallback`** — a value produced by the async fallback is
   validated before it is returned.

A failing validation at any point throws `M3LConfigValidationError`
(`code: "ERR_CONFIG_VALIDATION"`).

### `M3LConfigValidationError`

Thrown when a coerced value (provider, default, or fallback) fails its
validator. Its `context` carries `{ parameter, reason }` and a redaction-safe
`valueType` (the `typeof` the value) — **never the value itself**, so a
validation failure is safe to log for any parameter, secret or not. Catch it to
distinguish a validation failure from a coercion failure
(`M3LConfigCoercionError`), which is a caller-actionable difference (the value
parsed to the right type but broke a constraint).

### Required parameters

A parameter may declare `required: true`. When set, `getValueAsync()` throws
`M3LConfigMissingError` at the true fall-through of the [resolution
order](#resolution-order) — i.e. only after a provider value, `defaultValue`,
and `asyncFallback` have all been tried and none supplied a value — instead of
returning `undefined`. A `required` parameter that also declares a
`defaultValue` never throws (the default always supplies a value). Required-ness
is a presence guard; it composes with `validate` (e.g. `nonEmpty`), which
constrains a value that _is_ present.

```typescript
const input = new M3LConfigParameter({
  name: "input",
  type: M3LConfigParameterType.STRING,
  required: true,
  validate: M3LConfigValidators.nonEmpty,
});
// getValueAsync(reader) throws M3LConfigMissingError if nothing supplies "input"
```

### `M3LConfigMissingError`

Thrown by `getValueAsync()` when a parameter declared `required: true` resolves
through its whole chain without a value. `code` is `"ERR_CONFIG_MISSING"` and
`context` carries `{ parameter }` (the parameter name) — there is no resolved
value to include, so nothing is leaked. Catch it to distinguish a _missing_
required value from a _validation_ failure (`M3LConfigValidationError`, a value
that was present but broke a constraint) or a _coercion_ failure
(`M3LConfigCoercionError`).

### Stock validators (`M3LConfigValidators`)

```typescript
export const M3LConfigValidators: {
  range(min: number, max: number): M3LConfigValidator<number>;
  regex(pattern: RegExp): M3LConfigValidator<string>;
  oneOf<T>(allowed: readonly T[]): M3LConfigValidator<T>;
  nonEmpty: M3LConfigValidator<{ readonly length: number }>;
  minLength(min: number): M3LConfigValidator<{ readonly length: number }>;
};
```

| Helper            | Passes when                     | Failure reason describes                      |
| ----------------- | ------------------------------- | --------------------------------------------- |
| `range(min, max)` | `min <= value <= max`           | the bound, e.g. `must be between 1 and 65535` |
| `regex(pattern)`  | `pattern.test(value)` is `true` | the pattern                                   |
| `oneOf(allowed)`  | `allowed` includes `value`      | the allowed set                               |
| `nonEmpty`        | `value.length !== 0`            | `must not be empty`                           |
| `minLength(min)`  | `value.length >= min`           | the bound, e.g. `must be minimum 3 in length` |

`nonEmpty` and `minLength` are typed against the structural shape
`{ readonly length: number }`, so they apply to any parameter whose coerced
type has a `length` — `STRING`, the `*_ARRAY` types, and `BUFFER` — and are a
**compile error** on a `number`/`boolean` parameter (no `length`). Unlike the
other four, `nonEmpty` is a validator **value**, used directly without a call
(`validate: M3LConfigValidators.nonEmpty`); `minLength(min)` is a factory.

Each stock validator's failure reason describes the **constraint**, never the
received value — so a stock validator applied to a secret parameter cannot leak
the value through the reason.

> **Secret values.** A validator receives the real coerced value (it must, to
> validate it). The library itself never places that value into `context` —
> but a **custom** validator's returned reason string is author-controlled and
> becomes both the thrown error's `message` and its `context.reason`. Neither
> is redacted downstream (name-based redaction only matches `key=value`-shaped
> text, not an arbitrary reason string), so do not embed the value in the
> reason for a secret parameter (e.g. a `secretNames` entry) — it will survive
> verbatim into a persisted `run-report.json`. The stock validators above are
> already safe.

### Example

```typescript
import {
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LConfigValidators,
  M3LConfigValidationError,
} from "@m3l-automation/m3l-common/core";

const port = new M3LConfigParameter({
  name: "PORT",
  type: M3LConfigParameterType.INT,
  defaultValue: 3000,
  validate: M3LConfigValidators.range(1, 65535),
});

try {
  const value = await port.getValueAsync(reader);
} catch (error) {
  if (error instanceof M3LConfigValidationError) {
    console.error(error.context.parameter, error.context.reason);
  }
  throw error;
}
```

### Cross-parameter validation

A `validate` function attached to an individual `M3LConfigParameter` only ever
sees that one parameter's own coerced value — it has no way to express a
constraint spanning two or more parameters (e.g. "`sort` requires `limit` to
also be set", or "`start` must be strictly before `end`"). `M3LConfigSchema`
carries a second, optional layer for exactly that: a list of schema-level
validators that run once, after every declared parameter has resolved.

```typescript
export type M3LConfigSchemaValidator = (config: M3LConfig) => true | string;
```

The `true | string` return follows the same reasoning as `M3LConfigValidator<T>`
above: `true` is the only passing result, so a `boolean`-returning predicate is
not assignable and can never be mistaken for "valid" through a stray truthy
`false`. A schema-level validator receives the fully-resolved `M3LConfig` store
so it can read any combination of parameters via `get`/`has`/`sourceOf` — most
usefully through `M3LConfigAccessor` for typed reads. **A validator must not
call `M3LConfig.set()`** — it is handed the live store for reading, not for
mutation; this is a documented contract, not a type-enforced one.

`M3LConfigSchema`'s constructor takes the validator list as an optional second
positional parameter:

```typescript
const schema = new M3LConfigSchema(
  [sortParam, limitParam],
  [
    (config) =>
      config.get("sort") === undefined || config.get("limit") !== undefined
        ? true
        : "'sort' requires 'limit' to be set",
  ],
);
```

### Stock schema validators (`M3LConfigSchemaValidators`)

The commonest cross-parameter shape — "flag A is only meaningful alongside flag
B" — is available as a factory rather than hand-written per script:

```typescript
export const M3LConfigSchemaValidators: {
  readonly requires: (
    dependent: string,
    required: string,
  ) => M3LConfigSchemaValidator;
};
```

`requires(dependent, required)` passes when `dependent` is unset, or when both
are set; it fails with the reason `'<dependent>' requires '<required>' to be
set`, naming the supported alternative rather than echoing either value.
"**Set**" means `config.get(name) !== undefined` — any stored value counts,
including a falsy one (`false`, `0`, `""`) and a parameter not declared in the
schema. So an explicitly-supplied `--flag=false` is _set_, and the constraint
still fires. It
follows the same curried shape as the per-parameter `M3LConfigValidators`
factories, and the same secret-safety discipline: the reason string describes
the constraint, never a value.

Its motivating use is the destructive gate's sensitive-target opt-in
(`M3LConfigSchemaValidators.requires("yesSensitive", "yes")`), where an
opt-in passed without the plain bypass must be rejected **when flags are
parsed** rather than after a run has begun doing work — see
[ADR-0048](../../adr/0048-target-graded-destructive-confirmation.md) and
[Core / prompt](./prompt.md#confirmdestructive). Because it is a plain
`M3LConfigSchemaValidator`, it composes with hand-written validators in the
same `validate` array.

### When schema-level validation runs

Schema-level validation runs **once**, after every declared parameter has been
resolved by `M3LScriptConfigLoader.load()` — so any per-parameter `required` or
`validate` failure always surfaces first, before a cross-parameter constraint
is ever evaluated. Validators run in declaration order; the first one to return
a string reason throws immediately (fail-fast), and no later validator runs.

A script declares its schema-level validators alongside its parameters:

```typescript
new M3LScript({
  metadata,
  config: {
    params: [sortParam, limitParam],
    validate: [
      (config) =>
        config.get("sort") === undefined || config.get("limit") !== undefined
          ? true
          : "'sort' requires 'limit' to be set",
    ],
  },
});
```

A failing schema-level validator throws the same `M3LConfigValidationError`
(`code: "ERR_CONFIG_VALIDATION"`) documented above, discriminated by its
`context` shape: `{ validatorIndex, reason }` rather than the per-parameter
`{ parameter, reason, valueType }`. As with the per-parameter path, the library
itself never places a config value into `context` — but `reason` is entirely
author-controlled free text, and it reaches both `message` and `context.reason`
with no redaction applied downstream. A schema-level validator's blast radius
is wider than a per-parameter one, too: it can read the **whole** resolved
store rather than one already-typed value, and only the commonest shape has a
stock factory (`M3LConfigSchemaValidators.requires`) to fall back on — every
other schema-level validator is hand-written. The same secret-values caveat
above applies with equal force
here: don't embed a value in the reason string, for any parameter the
validator reads, not only the ones it is nominally checking.

## Defensive typed reads (`M3LConfigAccessor`)

`M3LConfig.get(name)` returns `unknown` — by design, since `M3LConfig` stores
values from any provider without re-asserting the declaring parameter's type.
A caller reading it back (most commonly a consumer script's operation
dispatcher, re-checking a value that was already coerced and validated at
`getValueAsync()` time, or defending against a directly-constructed
`M3LConfig` — as tests do — that bypassed that coercion) otherwise re-writes
the same defensive `typeof` check and thrown error at every call site.
`M3LConfigAccessor` centralizes that pattern: it binds one `M3LConfig` and one
caller-supplied `M3LError` `code` so every read only needs a parameter name.

```typescript
export interface M3LConfigAccessorOptions {
  readonly config: M3LConfig;
  readonly code: string;
}

export class M3LConfigAccessor {
  constructor(options: M3LConfigAccessorOptions);
  optionalString(name: string): string | undefined;
  optionalNumber(name: string): number | undefined;
  optionalBoolean(name: string): boolean | undefined;
  optionalStringArray(name: string): readonly string[] | undefined;
  optionalNonEmptyString(name: string): string | undefined;
  numberWithDefault(name: string, defaultValue: number): number;
  booleanWithDefault(name: string, defaultValue: boolean): boolean;
  oneOf<T extends string>(name: string, allowed: readonly T[]): T;
  requiredFor<T>(
    value: T | undefined,
    name: string,
    operation: string,
  ): Exclude<T, undefined>;
  requiredString(name: string, operation: string): string;
  requiredNumber(name: string, operation: string): number;
  requiredBoolean(name: string, operation: string): boolean;
  requiredStringArray(name: string, operation: string): readonly string[];
}
```

- **`optionalString` / `optionalNumber` / `optionalBoolean`** — return
  `undefined` when `name` is unset; throw `M3LError` (`options.code`, message
  `'${name}' must be a ${typeName}`) when set to a value of the wrong type.
- **`optionalStringArray`** — tolerates both an already-coerced
  `readonly string[]` (the shape `get()` returns once
  `M3LScript.getConfiguration()` has coerced a declared `STRING_ARRAY`
  parameter — every element must itself be a `string`, or this falls through
  to the throw below) and a raw comma-separated `string` (the shape a
  directly-constructed `M3LConfig` stores verbatim, bypassing that
  coercion): a string value is split on `,`, each segment trimmed, and empty
  segments dropped (so `""`/`","` resolve to `[]`, not `undefined` — only an
  unset key returns `undefined`). Any other type — including an array with a
  non-string element — throws `M3LError` (message
  `'${name}' must be a string array`).
- **`numberWithDefault` / `booleanWithDefault`** — read like the `optional*`
  counterpart (same wrong-type throw), falling back to `defaultValue` via
  `??` — not `||` — when unset, so a stored `0`/`false` is returned as-is
  and never replaced by `defaultValue` (reproducing the parameter's declared
  default at the read site, since a directly-constructed `M3LConfig` never
  applies it).
- **`oneOf(name, allowed)`** — validates an already-resolved string value
  against a declared literal-union set, narrowing the return type to `T`.
  Throws `M3LError` (message
  `'${name}' must be one of: ${allowed.join(", ")}`) on an unset,
  non-string, or out-of-set value. This is a defensive re-check: the
  declaring `M3LConfigParameter`'s `oneOf` validator (see [Stock
  validators](#stock-validators-m3lconfigvalidators) above) already enforces
  this at config-load time in a script driven through
  `M3LScript.getConfiguration()`; `oneOf` here protects a caller that builds
  an `M3LConfig` directly, bypassing that validation.
- **`optionalNonEmptyString(name)`** — like `optionalString`, but also folds
  an empty string to `undefined` (an empty string is treated the same as
  unset). Still throws `M3LError` on a wrong-typed value — it never silently
  drops a non-string the way a hand-written local helper might.
- **`requiredFor(value, name, operation)`** — the per-operation
  cross-parameter guard: returns `value` unchanged, narrowed to
  `Exclude<T, undefined>` (so `null`/`false`/`0`/`""` all pass through and
  narrow correctly — only `undefined` is excluded, `NonNullable` would wrongly
  also strip `null`), or throws `M3LError` (message
  `'${name}' is required for operation '${operation}'`) when `value` is
  `undefined`. Generic over `value`'s type, so it composes after any of the
  readers above (a required string, a required already-parsed record, etc.).
- **`requiredString` / `requiredNumber` / `requiredBoolean` /
  `requiredStringArray`** — the required-variant family, each composing its
  corresponding `optional*` reader with `requiredFor` so a single call covers
  absent, wrong-typed, and (for the string and array variants) empty values:
  - `requiredString(name, operation)` — `requiredFor(optionalNonEmptyString(name), name, operation)`.
    Throws on unset, empty, or non-string.
  - `requiredNumber(name, operation)` — `requiredFor(optionalNumber(name), name, operation)`.
    Throws on unset or non-number.
  - `requiredBoolean(name, operation)` — `requiredFor(optionalBoolean(name), name, operation)`.
    Throws on unset or non-boolean.
  - `requiredStringArray(name, operation)` — reads via `optionalStringArray`,
    folding an empty array to `undefined` before a single `requiredFor` call
    (mirroring `requiredString`'s empty-folding shape) — an empty array is
    treated the same as unset, throwing the same
    `'${name}' is required for operation '${operation}'` message. Throws on
    unset, empty, or a value that is not a string array.

  These replace the `readRequiredString`/`readBool`/`readNumber`-shaped
  per-script helpers the W5 promotion pass found duplicated across
  `dynamodb-crud`/`api-gateway-client`/`sqs-etl`/`s3-objects`/`json-etl` and
  the `athena-query`/`cloudwatch-logs-insights` `as*(value, name)` narrowers.

Every method throws the base `M3LError` class with `options.code` — there is
no dedicated `M3LConfigAccessor`-specific error subclass, since the caller
already owns the `code` its consumers expect (mirrors
[`Core.confirmDestructive`](./prompt.md)'s caller-supplied `code`).

### Example

```typescript
import { Core } from "@m3l-automation/m3l-common";

const read = new Core.M3LConfigAccessor({
  config,
  code: "ERR_ECS_OPS_CONFIG",
});

const operation = read.oneOf("operation", [
  "list-services",
  "describe-service",
] as const);
const cluster = read.requiredFor(
  read.optionalString("cluster"),
  "cluster",
  operation,
);
```

## `asyncFallback`

`asyncFallback` enables lazy I/O defaults: load a local file, call an API, or read from a secret manager — but only when no provider and no static default supply a value. It is invoked as an async function, which is why `getValueAsync()` (and parameter resolution generally) is asynchronous.

## Source tracking

`M3LConfig.set(name, value, source?)` records the source of each resolved value. Query it later with `sourceOf(name)` to report or audit where a value originated.

`M3LScriptConfigLoader.load()` populates a real label for every resolved parameter, via `M3LConfigParameter.resolveAsync(reader)` — the same 4-branch chain `getValueAsync` uses, but returning an `M3LConfigResolution` (`{ value, source }`) instead of just the value. The label is one of the provider labels above, or:

- `"default"` — the parameter's static `defaultValue` supplied it.
- `"async-fallback"` — the parameter's `asyncFallback()` resolved it.

A parameter that resolves to `undefined` (no provider value, no `defaultValue`, no `asyncFallback`, and not `required`) gets no `M3LConfig` entry at all, so `sourceOf(name)` returns `undefined` for it — same as before this label vocabulary existed.

These are also the exact labels `core/diagnostics`' config fingerprint accepts (see [diagnostics → structural ports](./diagnostics.md#structural-ports-and-why-they-are-not-m3lscript)); a `sourceOf` return outside this set is replaced with the fixed `"other"` marker at that boundary, never stored verbatim.

## Usage example

```typescript
import { Core } from "@m3l-automation/m3l-common";

const reader = new Core.M3LConfigReader([
  new Core.M3LCommandLineConfigProvider(),
  new Core.M3LJSONConfigProvider("config.json"),
  new Core.M3LEnvironmentConfigProvider(),
]);

const region = new Core.M3LConfigParameter({
  name: "region",
  type: Core.M3LConfigParameterType.STRING,
  defaultValue: "eu-south-1",
  asyncFallback: async () => loadRegionFromSecret(),
});

const value = await region.getValueAsync(reader);
```

The example is illustrative of the documented resolution behavior; exact constructor option names beyond those listed above are not specified by the overview.

## Notes and behavior

- `M3LSecretsSpecifier` marks parameters as secrets so resolved values can be handled accordingly.
- `M3LUnknownParameterDetector` flags parameters that are supplied but not declared in the schema; `detectWithSuggestions` is an additive alternative that also ranks nearest-name typo candidates (see [Typo suggestions](#typo-suggestions)) — `detect()` itself is unchanged.
- `M3LConfigHelpFormatter` is presentation-only: it never resolves a value and never throws (see [Descriptions and `--help` rendering](#descriptions-and---help-rendering)).
- Alias resolution is exhaustive within a provider before falling through to lower-priority providers.

## See also

- [script](./script.md)
- [environment](./environment.md)
- [security](./security.md)
- [files](./files.md) — `M3LInputFileReader` pairs with `M3LConfigAccessor` for
  input-file `name` parameters resolved through config
- [Guide: Configuration](../../guides/configuration.md)
- [Architecture overview](../../m3l-common-architecture.md)
