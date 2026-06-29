# Plan: Implement the `events` submodule (Core / events)

## Context

`@m3l-automation/m3l-common` implements submodules in documented dependency order.
`errors` (`✅ reviewed/done`) is the only completed submodule. `events` is **next in
Phase A** (foundational, dep-free) and is marked `❌ not-started`. It is the shared
base that importers, exporters, and `M3LHttpClient` all extend, so it must land before
any of those can start.

**Goal:** implement the `events` submodule to its documented contract
(`docs/reference/core/events.md`, 3 public symbols), surfaced through the `Core`
namespace barrel, tested ≥80%, reviewed, and committed as `feat: implement
core/events submodule` — with the three-entry `exports` map (`.`, `./core`, `./aws`)
**unchanged**.

**Process:** the project's hub-and-spoke TDD loop
(`.claude/skills/implement-submodule/SKILL.md`). The hub coordinates and owns only
`docs/implementation-status.md`; it **never writes `src/`/tests and never reviews**.
**No dependency gate** — `events` has zero runtime dependencies.

**Routing assumption:** spokes may route to **Haiku 4.5** (weakest routable model).
Every spoke dispatch below is therefore **self-contained**: it carries the full
contract, exact file paths, exact commands, the expected RED/GREEN signal, and
inline few-shot examples — nothing is left to model inference.

---

## The contract (authoritative: `docs/reference/core/events.md`)

Public surface of `events/index.ts` — **3 symbols**. Phase 1 re-derives this
verbatim from the doc; it is reproduced here to ground the plan.

**Classes (2):** `M3LEventEmitterBase<TEventMap>` (abstract), `M3LEventEmitter<TEventMap>`

**Type (1):** `M3LEventHandler<TPayload>`

### Symbol details

```typescript
M3LEventHandler<TPayload>
  = (payload: TPayload) => void | Promise<void>

M3LEventEmitterBase<TEventMap extends Record<string, unknown>>   (abstract class)
  on<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    handler: M3LEventHandler<TEventMap[TEvent]>,
  ): void                                          // public
  off<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    handler: M3LEventHandler<TEventMap[TEvent]>,
  ): void                                          // public
  emit<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): void                                          // protected
  emitAsync<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): Promise<void>                                 // protected

M3LEventEmitter<TEventMap extends Record<string, unknown>>       (concrete class)
  — extends M3LEventEmitterBase<TEventMap>
  — promotes emit and emitAsync to public so the owner of a standalone
    emitter instance can publish events without subclassing
```

> **Ambiguity flag (`M3LEventEmitter`):** the spec describes it as "the emitter
> type" without specifying whether `emit`/`emitAsync` remain protected or become
> public. The Phase 1 `spec-conformance-reviewer` resolves this. Working
> assumption above (concrete class with public `emit`/`emitAsync`) follows from
> the spec's "Defining a typed emitter" example: consumers extend
> `M3LEventEmitterBase` to hide emission; `M3LEventEmitter` serves the inverse
> pattern (owner holds the instance and emits externally). Phase 1 corrects this
> if wrong.

### Behavioral contracts (front-load these into every spoke prompt verbatim)

1. **`on<TEvent>(event, handler)`** — registers `handler` for `event`. The handler's
   payload type is inferred from `TEventMap[TEvent]` (compile-time). **Set semantics:**
   registering the same handler reference twice is a no-op; it will fire exactly once
   per emission.

2. **`off<TEvent>(event, handler)`** — removes the handler. Removing a handler that
   was never registered is a no-op (no error).

3. **`emit<TEvent>(event, payload)` (protected)** — calls all registered handlers
   synchronously in registration order. Each handler is invoked inside its own
   `try/catch`; an exception thrown by a handler is **silently swallowed** (not
   re-thrown, not logged — the library never logs by default). Other handlers
   continue to run. Async handlers may be called but their returned promises are
   intentionally discarded (`void` operator); sync `emit` does not await them.

4. **`emitAsync<TEvent>(event, payload)` (protected)** — invokes all registered
   handlers and awaits them. Use `Promise.allSettled` (not `Promise.all`) to preserve
   the same isolation guarantee as sync `emit`: a rejecting async handler does not
   prevent the others from running. Returns `Promise<void>`.

   > **Spec note:** `docs/reference/core/events.md` says "awaits all handlers via
   > `Promise.all`" but also guarantees handler-error isolation ("one failing handler
   > does not prevent the others"). These are contradictory — `Promise.all`
   > short-circuits on the first rejection. Implement with `Promise.allSettled` to
   > honour the isolation guarantee. Surface this discrepancy to the
   > `spec-conformance-reviewer` in Phase 1 so the doc can be corrected.

5. **Type safety:** `on`/`off` reject unknown event names and mismatched payload
   types at compile time. The generic constraint `TEvent extends keyof TEventMap &
string` enforces this.

6. **Visibility invariant:** `emit` and `emitAsync` are `protected` on
   `M3LEventEmitterBase` — consumers can subscribe (`on`/`off`) but cannot emit.
   `M3LEventEmitter` (if the concrete class interpretation is confirmed) overrides
   them as `public`.

---

## File layout

```text
packages/m3l-common/src/core/events/
  index.ts                  # BARREL — re-export only; no logic (coverage-excluded)
  M3LEventEmitterBase.ts    # abstract class + M3LEventHandler type + M3LEventEmitter
```

Then append **one line** to `packages/m3l-common/src/core/index.ts`:

```typescript
export * from "./events/index.js";
```

**Why logic lives in `M3LEventEmitterBase.ts`, not `index.ts`:** `vitest.config.ts`
excludes `**/index.ts` from coverage (`exclude: ["**/index.ts", "**/*.d.ts"]`). Any
logic placed in `index.ts` would be invisible to the 80% threshold gate. Given the
small symbol count (3 exports, tightly coupled), a single implementation file is
appropriate. If the Phase 1 contract reveals `M3LEventEmitter` needs a meaningfully
distinct implementation, extract it to a sibling `M3LEventEmitter.ts` and re-export
from the barrel.

Tests live at `packages/m3l-common/tests/events.test.ts`, importing from
`../src/core/events/index.js` (relative, `.js` extension — ESM; tsc does not add it).

**No new `exports`-map entry** — `events` is surfaced through the `./core` namespace
barrel. Adding a subpath is a semver event and is forbidden.

---

## Hub-and-spoke execution

| Phase      | Spoke                                                                                      | Writes                             | Hub bookkeeping after |
| ---------- | ------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------- |
| 1 Contract | `spec-conformance-reviewer` (contract mode)                                                | nothing                            | —                     |
| 2 RED      | `test-author`                                                                              | `tests/events.test.ts`             | `events` → 🧪         |
| 3 GREEN    | `submodule-implementer`                                                                    | `src/core/events/**` + barrel line | `events` → 🟢         |
| 4 Review   | `code-reviewer` + `spec-conformance-reviewer` (conformance) — **parallel, single message** | nothing                            | `events` → ✅         |
| 4b Fix     | `submodule-implementer` (only if Must-fix items found)                                     | `src/core/events/**`               | re-review until clean |

`events` is not in the documented security-sensitive list (`aws/*`, `config`,
`logging`, `security`, `text`, `importers`), so **no `security-reviewer`**.

**Hub rules:** never edit `src/`/`tests/`; never review; never add an `exports`
entry. The only file the hub writes is `docs/implementation-status.md`. Guard hooks
enforce the rest at write time (`.js` extension, no CommonJS, protected paths;
`post-edit-verify` auto-formats + typechecks + runs related tests).

### Step order

1. **Phase 1** — dispatch `spec-conformance-reviewer` (contract mode). Keep its output
   verbatim; it drives Phases 2 and 3. Surface the `Promise.all` vs
   `Promise.allSettled` discrepancy noted above.
2. **Phase 2** — dispatch `test-author` with: the Phase 1 contract output (verbatim) +
   the few-shot test examples below. Confirm RED: `pnpm vitest run
packages/m3l-common/tests/events.test.ts` must fail with a module-resolution
   error (`Cannot find module '../src/core/events/index.js'`), not a logic error.
   Mark `events` 🧪 in `docs/implementation-status.md`.
3. **Phase 3** — dispatch `submodule-implementer` with: Phase 1 contract (verbatim) +
   the RED test file contents (verbatim) + the few-shot implementation examples below.
   Drive tests green with `pnpm vitest run packages/m3l-common/tests/events.test.ts`,
   then `pnpm test` (full suite — no regressions). Mark `events` 🟢.
4. **Phase 4** — dispatch `code-reviewer` and `spec-conformance-reviewer` in the same
   message (parallel). Route Must-fix items back to `submodule-implementer` (Phase
   4b). Repeat until both reviewers are clean. Mark `events` ✅.
5. **Verify + commit** — full gate (see below), then
   `feat: implement core/events submodule`.

---

## Few-shot examples (carry these inline into the spoke prompts)

### Example 1 — Concrete test-subclass pattern (test-author)

`M3LEventEmitterBase` is abstract and `emit`/`emitAsync` are protected. Tests
cannot instantiate the base directly or call the protected methods from outside.
Every test suite must define a thin inner subclass that delegates to the protected
methods:

```typescript
// packages/m3l-common/tests/events.test.ts

import { describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  M3LEventEmitter,
  M3LEventEmitterBase,
  M3LEventHandler,
} from "../src/core/events/index.js";

// Concrete test subclass — only for testing; not exported.
// The type parameter is explicit so TypeScript enforces payload shapes.
interface TestEvents {
  ping: { id: string };
  tick: number;
}

class TestEmitter extends M3LEventEmitterBase<TestEvents> {
  fire<TEvent extends keyof TestEvents & string>(
    event: TEvent,
    payload: TestEvents[TEvent],
  ): void {
    this.emit(event, payload);
  }

  async fireAsync<TEvent extends keyof TestEvents & string>(
    event: TEvent,
    payload: TestEvents[TEvent],
  ): Promise<void> {
    await this.emitAsync(event, payload);
  }
}

describe("M3LEventEmitterBase — on / off", () => {
  test("registered handler receives the emitted payload", () => {
    const emitter = new TestEmitter();
    const received: Array<{ id: string }> = [];

    emitter.on("ping", (p) => {
      received.push(p);
    });
    emitter.fire("ping", { id: "a" });

    expect(received).toEqual([{ id: "a" }]);
  });

  test("off removes the handler — no further invocations", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    emitter.on("ping", handler);
    emitter.off("ping", handler);
    emitter.fire("ping", { id: "b" });

    expect(handler).not.toHaveBeenCalled();
  });

  test("registering the same handler reference twice is a no-op (set semantics)", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    emitter.on("ping", handler);
    emitter.on("ping", handler); // duplicate — ignored
    emitter.fire("ping", { id: "c" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("removing a handler that was never registered is a no-op", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    // Should not throw
    expect(() => emitter.off("ping", handler)).not.toThrow();
  });
});
```

### Example 2 — Handler-error isolation (test-author)

Both sync (`emit`) and async (`emitAsync`) must isolate individual handler failures.
These tests verify the critical behavioral contract; a Haiku-4.5 implementer must
see them to understand that swallowing errors is intentional, not a bug:

```typescript
describe("M3LEventEmitterBase — emit error isolation", () => {
  test("a throwing handler does not prevent subsequent handlers from running", () => {
    const emitter = new TestEmitter();
    const log: string[] = [];

    emitter.on("tick", () => {
      throw new Error("boom");
    });
    emitter.on("tick", () => {
      log.push("ran");
    });

    // Must not propagate the error to the caller
    expect(() => emitter.fire("tick", 1)).not.toThrow();
    // Second handler must have executed despite the first failing
    expect(log).toEqual(["ran"]);
  });
});

describe("M3LEventEmitterBase — emitAsync", () => {
  test("awaits all handlers — later handlers run after earlier async handlers resolve", async () => {
    const emitter = new TestEmitter();
    const order: number[] = [];

    emitter.on("tick", async () => {
      await Promise.resolve(); // yield once
      order.push(1);
    });
    emitter.on("tick", () => {
      order.push(2);
    });

    await emitter.fireAsync("tick", 42);
    expect(order).toHaveLength(2);
  });

  test("a rejecting async handler does not prevent other handlers from running", async () => {
    const emitter = new TestEmitter();
    const log: string[] = [];

    emitter.on("tick", async () => {
      throw new Error("async boom");
    });
    emitter.on("tick", async () => {
      log.push("ran");
    });

    // emitAsync resolves (does not reject) despite the failing handler
    await expect(emitter.fireAsync("tick", 1)).resolves.toBeUndefined();
    expect(log).toEqual(["ran"]);
  });
});
```

### Example 3 — Implementation skeleton (submodule-implementer)

This shows the shape of `M3LEventEmitterBase.ts`. The implementer must write
complete TSDoc (`@typeParam`, `@param`, `@returns`, `@example`) on every exported
symbol — the eslint-plugin-tsdoc rule enforces this:

````typescript
// packages/m3l-common/src/core/events/M3LEventEmitterBase.ts

/**
 * Handler type accepted by the emitter.
 *
 * Handlers may be synchronous or asynchronous.
 * `emit` discards the returned Promise (sync callers are not blocked);
 * `emitAsync` awaits it via `Promise.allSettled`.
 *
 * @typeParam TPayload - The event payload type, inferred from the event map.
 * @public
 */
export type M3LEventHandler<TPayload> = (
  payload: TPayload,
) => void | Promise<void>;

/**
 * Generic base class for typed event emitters.
 *
 * Parameterize with an event-map interface to get compile-time enforcement
 * on event names and payload shapes.
 *
 * @typeParam TEventMap - Maps event name strings to their payload types.
 * @example
 * ```typescript
 * interface JobEvents { "job:done": { id: string } }
 * class JobRunner extends M3LEventEmitterBase<JobEvents> {
 *   finish(id: string): void { this.emit("job:done", { id }); }
 * }
 * ```
 * @public
 */
export abstract class M3LEventEmitterBase<
  TEventMap extends Record<string, unknown>,
> {
  // Store handlers loosely typed internally; type safety is at the public
  // boundary (on/off generic signatures). The cast at registration is a
  // single covariant widening and is safe: the event key and payload type
  // are always aligned at the call site.
  readonly #handlers = new Map<
    keyof TEventMap & string,
    Set<M3LEventHandler<unknown>>
  >();

  on<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    handler: M3LEventHandler<TEventMap[TEvent]>,
  ): void {
    let set = this.#handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    // Widen to unknown — safe: only ever called with TEventMap[TEvent] payload
    set.add(handler as M3LEventHandler<unknown>);
  }

  off<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    handler: M3LEventHandler<TEventMap[TEvent]>,
  ): void {
    this.#handlers.get(event)?.delete(handler as M3LEventHandler<unknown>);
  }

  protected emit<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): void {
    const set = this.#handlers.get(event);
    if (set === undefined) return;
    for (const handler of set) {
      try {
        // void discards any returned Promise — sync emit does not await async handlers
        void handler(payload);
      } catch (_err: unknown) {
        // Isolated: one failing handler must not stop others (see spec).
        // The library never logs by default; errors are swallowed here.
      }
    }
  }

  protected async emitAsync<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): Promise<void> {
    const set = this.#handlers.get(event);
    if (set === undefined) return;
    // Promise.allSettled preserves the isolation guarantee:
    // a rejecting handler does not short-circuit the others.
    // (The spec says Promise.all but also guarantees isolation — see plan.)
    await Promise.allSettled([...set].map((handler) => handler(payload)));
  }
}

/**
 * Concrete, instantiable event emitter — promotes emit/emitAsync to public
 * for use cases where the owner holds the instance and emits directly (no subclassing).
 *
 * @typeParam TEventMap - Maps event name strings to their payload types.
 * @example
 * ```typescript
 * const bus = new M3LEventEmitter<{ update: string }>();
 * bus.on("update", console.log);
 * bus.emit("update", "hello");
 * ```
 * @public
 */
export class M3LEventEmitter<
  TEventMap extends Record<string, unknown>,
> extends M3LEventEmitterBase<TEventMap> {
  public override emit<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): void {
    super.emit(event, payload);
  }

  public override async emitAsync<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): Promise<void> {
    await super.emitAsync(event, payload);
  }
}
````

> **Note to implementer:** the above is a shape guide, not final code. You must
> write complete TSDoc on every exported symbol. After writing each file run:
>
> ```bash
> pnpm vitest run packages/m3l-common/tests/events.test.ts
> pnpm -C packages/m3l-common build
> pnpm lint                                   # ← run lint in-loop, not just typecheck
> ```
>
> Fix any lint errors before marking done. The `void handler(payload)` pattern
> in sync `emit` is intentional and satisfies `@typescript-eslint/no-floating-promises`.
> If the rule still fires, add `// eslint-disable-next-line @typescript-eslint/no-floating-promises`
> with a comment: `// intentional: sync emit discards async-handler promises`.
> The empty `catch (_err: unknown) {}` satisfies `no-empty` via the `_err` binding
> and the comment; do not strip the variable or the comment.

### Example 4 — Type-level tests (`expectTypeOf`) — (test-author)

The type IS part of the contract for generic utilities. Add at minimum:

```typescript
describe("M3LEventHandler type", () => {
  test("is a function from payload to void | Promise<void>", () => {
    expectTypeOf<M3LEventHandler<{ id: string }>>().toEqualTypeOf<
      (payload: { id: string }) => void | Promise<void>
    >();
  });
});

describe("M3LEventEmitter type-level", () => {
  test("M3LEventEmitter is assignable to M3LEventEmitterBase (extends it)", () => {
    expectTypeOf<M3LEventEmitter<{ x: number }>>().toMatchTypeOf<
      M3LEventEmitterBase<{ x: number }>
    >();
  });

  test("emit is public on M3LEventEmitter", () => {
    // If emit were protected this property access would be a compile error
    type EmitFn = M3LEventEmitter<{ x: number }>["emit"];
    expectTypeOf<EmitFn>().toBeFunction();
  });
});

describe("M3LEventEmitterBase compile-time enforcement", () => {
  test("on rejects an event name not in the event map", () => {
    const emitter = new TestEmitter();
    // @ts-expect-error — 'unknown-event' is not a key of TestEvents
    emitter.on("unknown-event", () => {});
  });

  test("on rejects a handler with the wrong payload type", () => {
    const emitter = new TestEmitter();
    // @ts-expect-error — handler receives number but 'ping' payload is { id: string }
    emitter.on("ping", (_p: number) => {});
  });
});
```

---

## Lessons applied from `core/errors` (baked into this plan)

These lessons from `docs/logs/2026-06-29-core-errors.md` apply here:

- **Run `pnpm lint` in-loop inside the implementer spoke**, not just `pnpm
typecheck`. The `post-edit-verify` hook runs typecheck but not eslint; lint-only
  failures otherwise surface at the hub's full gate, costing an extra round.
- **All logic out of `index.ts`** (coverage-excluded by `vitest.config.ts`). Put
  everything in `M3LEventEmitterBase.ts`.
- **Front-load contract nuances verbatim** (both `Promise.allSettled` vs `Promise.all`
  and the `void` pattern for async-handler discarding in sync `emit`). Precision
  prevents drift with a Haiku-4.5 spoke.
- **Trust `pnpm typecheck`/`pnpm lint` over the LSP** — IDE diagnostics lag and
  misreport against the project `tsconfig`.
- **Read coverage from `coverage-final.json`**, not the text table — v8 text reporter
  hides 100%-covered files.

---

## Verify + commit (Phase 5)

```bash
pnpm -C packages/m3l-common build   # tsc — dist/ clean
pnpm test                            # full suite; no regressions
pnpm lint                            # eslint flat config
pnpm typecheck                       # tsc strict
pnpm check:api                       # exports snapshot — map must be unchanged
```

All must be green. Then commit (Conventional Commit — `feat:` because a new submodule
surfaces through the barrel; no `exports` entry added, so this is a **minor**, not
a breaking change):

```console
feat: implement core/events submodule

M3LEventEmitterBase<TEventMap>, M3LEventEmitter<TEventMap>, M3LEventHandler<TPayload>.
Type-safe, generic event emitter base; on/off public; emit/emitAsync protected.
Handler-error isolation via per-handler try/catch (sync) and Promise.allSettled (async).
Surfaced through Core namespace barrel; three-entry exports map unchanged.
```

Update `docs/implementation-status.md`: `events` row → `✅`.
