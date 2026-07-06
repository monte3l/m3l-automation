# Core / events

A type-safe, generic event emitter for `@m3l-automation/m3l-common`. It is the shared base class that importers, exporters, and the HTTP client extend to publish strongly-typed events.

## Overview

`M3LEventEmitterBase<TEventMap>` is parameterized by an event-map type that maps each event name to its payload type. Subscription methods enforce that handler signatures match the declared payload, so subscribing to a misspelled event or destructuring the wrong payload shape is a compile-time error.

Subscription (`on` / `off`) is public; emission (`emit` / `emitAsync`) is `protected`, so only the subclass that owns the emitter can publish events. Handler errors are isolated: one failing handler does not prevent the others from running. A failure is not swallowed silently — it is surfaced as a best-effort `process.stderr` diagnostic naming the event and the error (the event payload is never included, since it may carry caller-supplied data), never routed through the library's log handlers, and never re-thrown.

## Public API

Public surface (`events/index.ts`):

- `M3LEventEmitterBase` — the generic base class.
- `M3LEventEmitter` — the emitter type.
- `M3LEventHandler` — the typed handler function type.

### `M3LEventEmitterBase<TEventMap>`

- `on<TEvent>(event, handler)` — subscribe a typed handler; the handler's payload type is inferred from `TEventMap[TEvent]`.
- `off<TEvent>(event, handler)` — unsubscribe a previously registered handler.
- `emit<TEvent>(event, payload)` _(protected)_ — synchronously invoke all handlers; a handler that throws is caught (so one failure does not stop the others) and reported as a best-effort `process.stderr` diagnostic; `emit` itself never throws.
- `emitAsync<TEvent>(event, payload)` _(protected)_ — awaits all handlers via `Promise.allSettled`, so a rejecting handler does not prevent others from running; each rejection is reported as a best-effort `process.stderr` diagnostic, and `emitAsync` always resolves (never rejects).

## Usage examples

### Defining a typed emitter

```typescript
import { Core } from "@m3l-automation/m3l-common";

interface JobEvents {
  "job:started": { id: string };
  "job:progress": { id: string; processed: number };
  "job:completed": { id: string; total: number };
}

class JobRunner extends Core.M3LEventEmitterBase<JobEvents> {
  async run(id: string): Promise<void> {
    this.emit("job:started", { id });
    for (let processed = 1; processed <= 3; processed++) {
      this.emit("job:progress", { id, processed });
    }
    // emitAsync awaits async subscribers before resolving.
    await this.emitAsync("job:completed", { id, total: 3 });
  }
}
```

### Subscribing with typed handlers

```typescript
const runner = new JobRunner();

runner.on("job:progress", (payload) => {
  // payload is { id: string; processed: number } — fully inferred.
  console.log(`${payload.id}: ${payload.processed}`);
});

await runner.run("import-42");
```

## Notes and behavior

- The event map is the contract: `on` / `off` reject unknown event names and mismatched payload types at compile time.
- `emit` and `emitAsync` are `protected`, so consumers cannot emit on an emitter they did not author — they can only subscribe.
- Handler-error isolation means a throwing subscriber is contained; other subscribers still run. The contained failure is written as a best-effort diagnostic to `process.stderr` (event name + error detail, never the payload) — mirroring `M3LLogger`'s handler-failure diagnostic — so a listener bug in unattended automation leaves a trace instead of vanishing. Use `emitAsync` when handlers are asynchronous and the emitter must wait for them.
- This base class is extended across the library: the list importers (`M3LListImporter` implementations) emit events such as `import:item` and `import:progress`; the list exporters emit `export:started` / `export:completed` / `export:error`; and `M3LHttpClient` extends it for request lifecycle events.

## See also

- [Core / errors](./errors.md)
- [Core / importers](./importers.md) — emit `import:*` events
- [Core / exporters](./exporters.md) — emit `export:*` events
- [Core / network](./network.md) — `M3LHttpClient` extends the emitter base
- [Architecture overview](../../m3l-common-architecture.md)
