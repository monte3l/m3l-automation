# `config` — Multi-source configuration

The `config` module resolves configuration values from an ordered chain of providers (CLI, files, environment, Lambda event, presets) plus static defaults and async fallbacks. It supports parameter typing, key aliases, and per-value source tracking.

## Overview

`M3LConfigReader` takes an ordered `ReadonlyArray<M3LConfigProvider>` and resolves values by walking the providers in priority order. Each `M3LConfigParameter` declares its type and optional default/fallback, and `M3LConfig` records where every resolved value came from. Provider classes adapt different input sources (command line, JSON, YAML, environment variables, in-memory, Lambda event, presets) to the common `M3LConfigProvider` shape.

## Public API

Exported from `@m3l-automation/m3l-common/core` (the `config` sub-module):

- `M3LConfig`
- `M3LConfigReader`
- `M3LConfigProvider`
- `M3LConfigParameter`
- `M3LConfigParameterType`
- `M3LCoercedValue` (type-level map from a `M3LConfigParameterType` member to its coerced result type)
- `M3LConfigSchema`
- Provider classes: `M3LCommandLineConfigProvider`, `M3LJSONConfigProvider`, `M3LYAMLConfigProvider`, `M3LEnvironmentConfigProvider`, `M3LInMemoryConfigProvider`, `M3LLambdaEventConfigProvider`, `M3LPresetConfigProvider`
- `coerceConfigValue` (the value parser: coerces a raw provider value to its declared `M3LConfigParameterType`, throwing on a type mismatch; generic over the target type so its return is `M3LCoercedValue<T>`, not `unknown`)
- `M3LSecretsSpecifier`
- `M3LUnknownParameterDetector`
- `M3LConfigValidator` (type: a `(value) => true | string` schema-time validator)
- `M3LConfigValidators` (stock validators: `range`, `regex`, `oneOf`, `nonEmpty`, `minLength`)
- Errors: `M3LConfigCoercionError`, `M3LConfigParseError`, `M3LUnsafeConfigKeyError`, `M3LConfigValidationError`, `M3LConfigMissingError`

## Provider priority chain

`M3LConfigReader` walks the provided array in declared priority order, returning the first value found. The standard ordering for a parameter is:

1. CLI args (`M3LCommandLineConfigProvider`)
2. JSON config file (`M3LJSONConfigProvider`)
3. YAML config file (`M3LYAMLConfigProvider`)
4. Environment variables and `.env` (`M3LEnvironmentConfigProvider`)
5. Lambda event payload (`M3LLambdaEventConfigProvider`, Lambda only)
6. Preset file (`M3LPresetConfigProvider`)

When no provider supplies a value, resolution continues to the static default, then the async fallback (see below).

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
> validate it). The error `context` never carries the value, but a **custom**
> validator's returned reason string is author-controlled — do not embed the
> value in the reason for a secret parameter (e.g. a `secretNames` entry), or it
> will surface in the thrown error's message. The stock validators above are
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

## `asyncFallback`

`asyncFallback` enables lazy I/O defaults: load a local file, call an API, or read from a secret manager — but only when no provider and no static default supply a value. It is invoked as an async function, which is why `getValueAsync()` (and parameter resolution generally) is asynchronous.

## Source tracking

`M3LConfig.set(name, value, source?)` records the source of each resolved value (for example, `'cli'`, `'env'`, `'file'`). Query it later with `sourceOf(name)` to report or audit where a value originated.

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
- `M3LUnknownParameterDetector` flags parameters that are supplied but not declared in the schema.
- Alias resolution is exhaustive within a provider before falling through to lower-priority providers.

## See also

- [script](./script.md)
- [environment](./environment.md)
- [security](./security.md)
- [Guide: Configuration](../../guides/configuration.md)
- [Architecture overview](../../m3l-common-architecture.md)
