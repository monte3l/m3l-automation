# Configuring a script

This guide shows how to declare and resolve configuration for a script
or Lambda handler with the `config` module. You compose an ordered chain
of providers, declare typed parameters, and let `M3LConfigReader` resolve
each value across the full eight-level resolution order — with alias
support, async fallbacks, presets, and per-value source tracking.

All examples are ESM. Import from the namespace
(`import { Core } from "@m3l-automation/m3l-common";`) or from the
`./core` subpath; relative imports in your own code carry the `.js`
extension.

## The provider chain

`M3LConfigReader` takes an ordered `ReadonlyArray<M3LConfigProvider>` and
resolves values by walking the providers in priority order, returning the
first value found. Each provider adapts one input source (command line,
JSON file, YAML file, environment variables, an in-memory map, a Lambda
event payload, or a preset file) to the common `M3LConfigProvider` shape.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const reader = new Core.M3LConfigReader([
  new Core.M3LCommandLineConfigProvider(),
  new Core.M3LJSONConfigProvider("config.json"),
  new Core.M3LYAMLConfigProvider("config.yaml"),
  new Core.M3LEnvironmentConfigProvider(),
]);
```

The array order _is_ the priority order: providers earlier in the array
win over later ones. The available provider classes are:

- `M3LCommandLineConfigProvider` — CLI arguments
- `M3LJSONConfigProvider` — a JSON config file
- `M3LYAMLConfigProvider` — a YAML config file
- `M3LEnvironmentConfigProvider` — environment variables and `.env`
- `M3LLambdaEventConfigProvider` — the Lambda event payload (Lambda only)
- `M3LPresetConfigProvider` — a named parameter preset
- `M3LInMemoryConfigProvider` — an explicit in-memory map (handy in tests)

## The full eight-level resolution order

For each `M3LConfigParameter`, `getValueAsync()` first consults the
provider chain (via `M3LConfigReader`), then the static default, then the
async fallback. Combined with the standard provider ordering, this is the
complete resolution order applied to every parameter:

```text
1. CLI args                  (M3LCommandLineConfigProvider)
2. JSON config file          (M3LJSONConfigProvider)
3. YAML config file          (M3LYAMLConfigProvider)
4. Environment variables + .env (M3LEnvironmentConfigProvider)
5. Lambda event payload      (M3LLambdaEventConfigProvider, Lambda only)
6. Preset file               (M3LPresetConfigProvider)
7. defaultValue              (static literal)
8. asyncFallback()           (async function, called only when 1–7 are all absent)
```

The first source that supplies a value wins; resolution stops there.
Because step 8 may perform asynchronous I/O, value resolution is async —
which is why you call `getValueAsync()` (and why `M3LScript` loads config
asynchronously).

## Declaring parameters and types

A `M3LConfigParameter` declares a name, a type, and optional
`defaultValue` and `asyncFallback`. The type drives parsing and coercion
of raw provider values. `M3LConfigParameterType` includes:

- `STRING`
- `INT`
- `DOUBLE`
- `BOOL`
- `STRING_ARRAY`
- `INT_ARRAY`
- `DOUBLE_ARRAY`
- `BUFFER`

```typescript
import { Core } from "@m3l-automation/m3l-common";

const region = new Core.M3LConfigParameter({
  name: "region",
  type: Core.M3LConfigParameterType.STRING,
  defaultValue: "eu-south-1",
});

const value = await region.getValueAsync(reader);
```

You can group parameters into a `M3LConfigSchema` to describe a script's
full configuration surface. `M3LUnknownParameterDetector` flags values
that are supplied but not declared in the schema, and
`M3LSecretsSpecifier` marks parameters as secrets so their resolved
values can be handled accordingly (for example, kept out of plain logs).

## Alias resolution

A parameter may be reachable under several keys (for example a CLI
`--alias-name` and a canonical `canonical.name`). Alias support is
applied _per provider_: `getRawValueForKeys(keys)` tries **all** alias
keys within one provider before moving to the next, lower-priority
provider.

This guarantees that a higher-priority provider's alias always wins over
a lower-priority provider's canonical key — a CLI `--alias-name` beats a
JSON file's `canonical.name`, even though both name the same parameter.
The check is exhaustive within a provider before it falls through.

## Lazy I/O defaults with `asyncFallback`

`asyncFallback` is the last resort (step 8). Use it to compute a default
that requires I/O — read a local file, call an API, or fetch from a
secret manager — but only when no provider and no static `defaultValue`
supplied a value. It is invoked as an async function, so the work is
deferred until it is actually needed.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const apiKey = new Core.M3LConfigParameter({
  name: "apiKey",
  type: Core.M3LConfigParameterType.STRING,
  // Only runs if CLI, files, env, Lambda event, preset, and defaultValue
  // all failed to provide a value.
  asyncFallback: async () => loadApiKeyFromSecretManager(),
});

const key = await apiKey.getValueAsync(reader);
```

Prefer a static `defaultValue` for cheap constants and reserve
`asyncFallback` for values that genuinely need to be loaded.

## Presets

Presets let you bundle a named set of parameter values in a YAML or JSON
file and select one by name. Two pieces work together:

- `M3LScriptPresetLoader` loads named presets from YAML/JSON files. It
  bounds nesting depth (max 64, `MAX_PRESET_STRUCTURE_DEPTH`) and uses
  Damerau-Levenshtein distance to suggest corrections for unknown keys,
  throwing `M3LPresetUnknownKeysError` when a preset contains keys that
  are not recognized.
- `M3LPresetConfigProvider` exposes a loaded preset to the config chain.
  As shown above, the preset provider sits at level 6 — below the CLI,
  files, environment, and Lambda event, but above the static
  `defaultValue`.

Placing presets at level 6 means an explicit CLI flag or environment
variable still overrides a preset value, while a preset still overrides
the hard-coded default. This is the usual "named profile, still
overridable" behavior you want for environment- or customer-specific
defaults.

## Source tracking with `sourceOf`

`M3LConfig` records where every resolved value came from.
`M3LConfig.set(name, value, source?)` stores the source label (for
example `'cli'`, `'env'`, `'file'`), and `sourceOf(name)` returns it
later. Use this to print a configuration summary or to audit which layer
won for a given parameter — invaluable when a value is not what you
expect and you need to know whether the CLI, a file, or a default
supplied it.

```typescript
// After resolution, report where each value originated.
const where = config.sourceOf("region"); // e.g. "cli" | "env" | "file"
```

`M3LScript` performs this resolution for you during its config-load
stage, so within a script you typically read already-resolved,
source-tracked values rather than driving `M3LConfigReader` by hand.

## See also

- [config reference](../reference/core/config.md)
- [script reference](../reference/core/script.md)
- [Guide: Environments and paths](./environments-and-paths.md)
- [Guide: Capability index](./capability-index.md)
