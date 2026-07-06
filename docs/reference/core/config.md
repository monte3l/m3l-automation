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
- Errors: `M3LConfigCoercionError`, `M3LConfigParseError`, `M3LUnsafeConfigKeyError`

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
