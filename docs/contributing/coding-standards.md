# Coding Standards

These are the code-style rules for `@m3l-automation/m3l-common`. They
expand on the "Code Style", "Error Handling", and "Documentation"
sections of the project's `CLAUDE.md`. Formatting and import order are
enforced by Prettier and ESLint — do not hand-format; this page covers
the conventions tooling cannot fully decide for you.

The library is TypeScript 6.x with `strict: true`, ESM-only, targeting
Node.js 24 LTS+.

## Strict TypeScript

- `strict: true` is non-negotiable. There is **no `any` in the public
  API**, and you should avoid it everywhere — use `unknown` and narrow.
- Avoid non-null `!` assertions in `src/`. Prove the value is present
  through a guard, a default, or control flow instead.

```typescript
// Avoid: silences the type system without proving anything.
const first = items[0]!;

// Prefer: narrow explicitly.
const first = items[0];
if (first === undefined) throw new NotFoundError("empty input");
```

When you must accept untrusted data, type it as `unknown` and validate
before use:

```typescript
export function parseConfig(raw: unknown): Config {
  if (!isPlainObject(raw))
    throw new ValidationError("config must be an object");
  // ...narrow each field before returning a typed Config
}
```

## Immutability

- Prefer `readonly` for properties and parameters that do not change.
  It documents intent and lets callers avoid defensive copies.
- Prefer `const` over `let`; create new objects instead of mutating
  inputs.

```typescript
export function dedupe(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)];
}
```

## Named Exports Only

Use named exports everywhere; **no default exports**. Named exports
keep the public surface explicit, tree-shakeable, and refactor-safe.

```typescript
export class M3LConfig {
  /* ... */
} // correct
export default class M3LConfig {} // never
```

Export types next to the values they describe so a consumer importing a
function also finds its types.

## Interfaces vs. Type Aliases

- Use `interface` for object shapes that callers implement or extend.
- Use `type` for unions, intersections, mapped types, and branded
  types.

```typescript
export interface ConfigProvider {
  get(key: string): string | undefined;
}

export type LogLevel = "debug" | "info" | "warning" | "error";
```

## Control Flow and Iteration

- Use `===` / `!==`. Use `== null` only as the deliberate
  combined null/undefined check; never `==` elsewhere.
- A `switch` over a finite set should be exhaustive — handle every
  case and fail loudly on the unexpected.
- Prefer `for...of` over `forEach`; never use `for...in` on arrays.

```typescript
function describe(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "verbose detail";
    case "info":
      return "normal";
    case "warning":
      return "needs attention";
    case "error":
      return "failure";
    default: {
      const exhaustive: never = level;
      throw new LibError(`unknown level: ${String(exhaustive)}`);
    }
  }
}
```

## Public-API Typing

Model the public surface precisely. Two patterns worth standardizing:

**Branded types** for values that carry an invariant the compiler
should track:

```typescript
export type UserId = string & { readonly __brand: unique symbol };

export function toUserId(raw: string): UserId {
  if (raw.length === 0) throw new ValidationError("empty user id");
  return raw as UserId;
}
```

**Generic container types** for structured results, so callers get full
type information:

```typescript
export type Page<T> = { items: readonly T[]; total: number };

export function paginate<T>(items: readonly T[], limit: number): Page<T> {
  return { items: items.slice(0, limit), total: items.length };
}
```

Give public functions explicit return types; you may omit a return type
only where it is trivially inferable.

## TSDoc

Put TSDoc on **every** exported symbol. Add an `@example` to primary
entry points. Comment the _why_, not the _what_ — the code already
states what it does.

```typescript
/**
 * Splits a list into a single page of at most `limit` items.
 *
 * The original list is never mutated; `total` reflects the full input
 * size so callers can drive pagination UIs without a second count.
 *
 * @example
 * paginate(["a", "b", "c"], 2); // { items: ["a", "b"], total: 3 }
 */
export function paginate<T>(items: readonly T[], limit: number): Page<T> {
  return { items: items.slice(0, limit), total: items.length };
}
```

## Typed Error Hierarchy

The library throws typed errors from a single hierarchy rooted at
`M3LError`. Subclass it per failure mode so callers can discriminate.

- Never throw bare strings.
- Never swallow an error silently.
- Chain the underlying failure with the `cause` option.

```typescript
export class M3LError extends Error {}
export class NotFoundError extends M3LError {}
export class ValidationError extends M3LError {}

export function loadUser(id: UserId): User {
  const user = repo.get(id);
  if (user === undefined) throw new NotFoundError(`user ${String(id)}`);
  return user;
}
```

Preserve the original error when wrapping a lower-level failure:

```typescript
try {
  return JSON.parse(text) as unknown;
} catch (cause) {
  throw new ValidationError("config file is not valid JSON", { cause });
}
```

## Function Type-Alias Naming

When a property or parameter takes a function, extract a **named** type
alias rather than inlining the function type. The alias name MUST end
with a semantic suffix that says what role the function plays:

| Suffix        | Role                              |
| ------------- | --------------------------------- |
| `Handler`     | reacts to an event or value       |
| `Validator`   | checks input, may throw or report |
| `Transformer` | maps a value to a reshaped value  |
| `Mapper`      | maps one item to another          |
| `Predicate`   | returns a boolean                 |
| `Formatter`   | renders a value to a string       |
| `Hook`        | lifecycle callback                |

Use `Fn` only as a fallback when no semantic suffix fits. Avoid generic
names like `Callback` or `Function`.

```typescript
export type RowValidator<T> = (row: T, index: number) => void;
export type RetryPredicate = (error: unknown) => boolean;
export type LogFormatter = (event: M3LLogEvent) => string;

export interface ImportOptions<T> {
  readonly validate?: RowValidator<T>;
  readonly shouldRetry?: RetryPredicate;
}
```

## See also

- [Contributing](./contributing.md)
- [Architecture](../m3l-common-architecture.md)
