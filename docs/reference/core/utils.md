# Core: `utils`

General-purpose utilities used across the library: deployment-aware path resolution, a bounded concurrency pool, safe serialization, string/value formatting helpers, and a complete set of runtime type guards.

## Overview

The `utils` module gathers the cross-cutting helpers that other Core modules depend on. It provides `M3LPaths` for resolving data, config, input, output, and cache directories based on the detected deployment mode; `M3LConcurrencyPool` for running async work with a fixed slot count and natural backpressure; `safeJsonStringify` and `valueToString` for serializing arbitrary values without throwing; `M3LDateTokens` for expanding date tokens in path templates; and a large family of single-purpose type guards.

## Public API

Exported from `@m3l-automation/m3l-common/core` (and the `Core` namespace):

- Paths and concurrency: `M3LPaths`, `M3LPathType`, `M3LPathEnvironmentVariables`, `M3LConcurrencyPool`
- Serialization and formatting: `safeJsonStringify`, `valueToString`, `M3LDateTokens`, `formatBytes`, `smartTruncate`, `truncatePath`, `truncateText`, `isPath`, `formatConfigValueDisplay`, `formatConfigSourceDisplay`
- Type guards: `isNullish`, `isPrimitive`, `isError`, `isNodeError`, `isEnoentError`, `isPlainObject`, `isObject`, `isArray`, `isString`, `isNumber`, `isBoolean`, `isFunction`, `isDate`, `isValidDate`, `isBuffer`, `isMap`, `isSet`, `isRegExp`, `isSymbol`, `isBigInt`, `isPromise`, `isNonEmptyString`, `isNonEmptyArray`, `hasProperty`, `hasMessage`

## Path resolution with `M3LPaths`

`M3LPaths` resolves the standard project directories (data, config, input, output, cache) relative to the detected deployment mode — either the monorepo root or a standalone base directory. The `M3LPathType` type names the directory kinds, and `M3LPathEnvironmentVariables` documents the override variables.

Every directory is overridable through environment variables:

| Variable              | Overrides                                    |
| --------------------- | -------------------------------------------- |
| `M3L_DATA_DIR`        | Data directory                               |
| `M3L_CONFIG_DIR`      | Config directory                             |
| `M3L_INPUT_DIR`       | Input directory                              |
| `M3L_OUTPUT_DIR`      | Output directory                             |
| `M3L_BASE_DIR`        | Standalone base directory                    |
| `M3L_DEPLOYMENT_MODE` | Forces `monorepo` or `standalone` resolution |

```typescript
import { Core } from "@m3l-automation/m3l-common";

const paths = new Core.M3LPaths();

const inputDir = paths.getInputDir();
const outputDir = paths.getOutputDir();
```

> Note: `getProjectRoot()` throws in standalone mode — there is no monorepo root to return. Guard standalone code paths accordingly, or set `M3L_DEPLOYMENT_MODE=monorepo` only when a real monorepo root exists.

## Safe serialization with `safeJsonStringify`

`safeJsonStringify` produces a JSON-like string from any value without throwing on inputs that `JSON.stringify` cannot handle:

- Circular references are replaced with `'[Circular]'` (tracked via a `WeakSet`).
- Nesting beyond the depth limit (default `10`) is replaced with `'[Max Depth]'`.
- `BigInt` is serialized as its string form.
- `Symbol` is serialized as its description.
- `Function` is serialized as `''`.
- `Map` and `Set` are serialized to their JSON equivalents.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const node: { name: string; self?: unknown } = { name: "root" };
node.self = node; // circular

const json = Core.safeJsonStringify(node);
// e.g. {"name":"root","self":"[Circular]"}
```

`valueToString` is the companion helper for turning an arbitrary value into a human-readable string (for example in log output).

## Bounded concurrency with `M3LConcurrencyPool`

`M3LConcurrencyPool` limits the number of concurrent async tasks using a slot-count FIFO queue. Its `runEach(items, worker)` method consumes items on demand as slots free up, so memory stays proportional to the pool limit rather than the total number of items — this is the backpressure guarantee that makes it safe over large inputs.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const pool = new Core.M3LConcurrencyPool(5);

await pool.runEach(itemIds, async (id) => {
  await processItem(id);
});
```

## Date tokens with `M3LDateTokens`

`M3LDateTokens` expands date tokens such as `{YYYY}`, `{MM}`, and `{DD}` inside path templates, producing time-stamped output directories. It is the mechanism behind the `outputs/{timestamp}/` layout used by `M3LPaths`.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const expanded = Core.M3LDateTokens.expand("outputs/{YYYY}-{MM}-{DD}");
// e.g. outputs/2026-06-27
```

## Formatting helpers

- `formatBytes` renders a byte count as a human-readable size.
- `smartTruncate`, `truncatePath`, `truncateText` shorten long strings, with `truncatePath` preserving path-significant segments.
- `isPath` tests whether a string looks like a filesystem path.
- `formatConfigValueDisplay` and `formatConfigSourceDisplay` format a configuration value and its source for display (used by config-related output).

## Type guards

The module exports a complete set of runtime type guards. Each narrows `unknown` to a concrete type, supporting the strict, `any`-free style used throughout the library.

| Guard                                              | Narrows to                                            |
| -------------------------------------------------- | ----------------------------------------------------- |
| `isNullish`                                        | `null` or `undefined`                                 |
| `isPrimitive`                                      | a JS primitive                                        |
| `isError` / `isNodeError` / `isEnoentError`        | `Error` / Node `ErrnoException` / an `ENOENT` error   |
| `isPlainObject` / `isObject`                       | plain object / any object                             |
| `isArray` / `isNonEmptyArray`                      | array / non-empty array                               |
| `isString` / `isNonEmptyString`                    | string / non-empty string                             |
| `isNumber` / `isBoolean` / `isBigInt` / `isSymbol` | corresponding primitive                               |
| `isFunction` / `isPromise`                         | function / promise-like                               |
| `isDate` / `isValidDate`                           | `Date` / a valid `Date`                               |
| `isBuffer` / `isMap` / `isSet` / `isRegExp`        | corresponding built-in                                |
| `hasProperty` / `hasMessage`                       | object with a given property / with a `message` field |

```typescript
import { Core } from "@m3l-automation/m3l-common";

function describe(value: unknown): string {
  if (Core.isNonEmptyString(value)) return `string: ${value}`;
  if (Core.isError(value)) return `error: ${value.message}`;
  if (Core.isEnoentError(value)) return "file not found";
  return Core.valueToString(value);
}
```

## Notes and behavior

- `M3LPaths` reads deployment mode from `M3LExecutionEnvironment`; the `M3L_*` overrides take precedence over detection.
- `getProjectRoot()` is the one `M3LPaths` method that throws by design; treat it as monorepo-only.
- `safeJsonStringify` never throws — unsupported inputs degrade to the placeholder strings above rather than raising.
- `M3LConcurrencyPool` preserves FIFO order of task starts; results are returned per the pool's contract, but task scheduling is bounded by the slot count.

## See also

- [Paths and environments guide](../../guides/environments-and-paths.md)
- [environment](./environment.md)
- [json](./json.md)
- [polling](./polling.md)
- [Architecture overview](../../m3l-common-architecture.md)
