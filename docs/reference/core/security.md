# Core: `security`

A focused prototype-pollution guard: detect dangerous object keys before they are written during deserialization.

## Overview

The `security` module guards against prototype-pollution attacks, where attacker-controlled input uses keys like `__proto__` to mutate an object's prototype chain. It exposes `isDangerousKey`, which flags such keys, and `formatUnsafeKeyLocation`, which formats where an unsafe key was found for diagnostics. The config module uses this guard while deserializing objects from external sources.

## Public API

Exported from `@m3l-automation/m3l-common/core` (and the `Core` namespace):

- `isDangerousKey`
- `formatUnsafeKeyLocation`

## The prototype-pollution guard

`isDangerousKey(key)` returns `true` for keys that can corrupt an object's prototype:

- `'__proto__'`
- `'constructor'`
- `'prototype'`

Any other key returns `false`. Use it as a gate before assigning untrusted keys onto a target object.

```typescript
import { Core } from "@m3l-automation/m3l-common";

function assignSafely(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (Core.isDangerousKey(key)) {
      throw new Error(Core.formatUnsafeKeyLocation(key));
    }
    target[key] = value;
  }
}
```

`formatUnsafeKeyLocation` produces a readable description of where an unsafe key occurred, suitable for inclusion in an error message or log entry when a dangerous key is rejected.

## Usage during config deserialization

This guard is applied by the `config` module when objects are deserialized from external providers (for example JSON and YAML config files). Because configuration data can originate outside the application, every key is checked so that a malicious or malformed config cannot pollute object prototypes during parsing.

## Notes and behavior

- The check is purely key-name based; it does not inspect values.
- Reject or skip any key for which `isDangerousKey` returns `true` before assigning it to a target object.
- Validate all external input at the public API boundary; this guard is one layer of that validation.

## See also

- [config](./config.md)
- [json](./json.md)
- [utils](./utils.md)
- [Architecture overview](../../m3l-common-architecture.md)
