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
 * on event names and payload shapes. Subclass this when only the owner of
 * a class should be allowed to emit — `emit` and `emitAsync` are `protected`
 * here. Use {@link M3LEventEmitter} when you need to emit from the outside.
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
export abstract class M3LEventEmitterBase<TEventMap extends object> {
  // Store handlers loosely typed internally; type safety is at the public
  // boundary (on/off generic signatures). The cast at registration is a
  // single covariant widening and is safe: the event key and payload type
  // are always aligned at the call site.
  readonly #handlers = new Map<
    keyof TEventMap & string,
    Set<M3LEventHandler<unknown>>
  >();

  /**
   * Writes a best-effort diagnostic to `process.stderr` describing a handler
   * failure, naming the event and the error detail — never the payload,
   * which may carry caller-supplied secrets. Mirrors the precedent in
   * `core/logging`'s `M3LLogger.dispatch`, but additionally guards the write
   * itself: this module has no logging channel of its own to fall back on,
   * so a failing `process.stderr.write` must not escape and defeat the
   * "emit/emitAsync never throw" guarantee.
   */
  #reportHandlerFailure(event: keyof TEventMap & string, cause: unknown): void {
    const detail =
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    try {
      process.stderr.write(
        `m3l-events: handler threw while handling a "${event}" event: ${detail}\n`,
      );
    } catch {
      // Last-resort: if even the diagnostic write fails, there is nothing
      // further this method can safely do — emit/emitAsync must not throw.
    }
  }

  /**
   * Register a handler for the given event.
   *
   * Set semantics: registering the same handler reference a second time for
   * the same event is a no-op — it fires exactly once per emission.
   *
   * @typeParam TEvent - An event name present in the event map.
   * @param event - The event name to listen for.
   * @param handler - The callback to invoke when the event is emitted.
   */
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

  /**
   * Remove a previously registered handler for the given event.
   *
   * If the handler was never registered, this is a no-op (no error thrown).
   *
   * @typeParam TEvent - An event name present in the event map.
   * @param event - The event name.
   * @param handler - The handler reference to remove.
   */
  off<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    handler: M3LEventHandler<TEventMap[TEvent]>,
  ): void {
    this.#handlers.get(event)?.delete(handler as M3LEventHandler<unknown>);
  }

  /**
   * Emit an event synchronously, invoking all registered handlers in
   * registration order.
   *
   * Each handler runs in its own `try/catch` so a throwing handler does not
   * prevent subsequent handlers from running. A failure is not silently
   * discarded: it is written to `process.stderr` as a best-effort diagnostic
   * naming the event and the error detail — the event payload is never
   * included, since it may carry caller-supplied secrets. `emit` itself never
   * throws, even if the diagnostic write fails. Async handlers' returned
   * Promises are discarded via `void`; sync emit does not await them.
   *
   * @typeParam TEvent - An event name present in the event map.
   * @param event - The event name to emit.
   * @param payload - The payload to pass to every handler.
   */
  protected emit<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): void {
    const set = this.#handlers.get(event);
    if (set === undefined) return;
    for (const handler of set) {
      try {
        // intentional: sync emit discards async-handler promises
        void handler(payload);
      } catch (cause) {
        // Isolated: one failing handler must not stop others. The failure is
        // not silently swallowed — report it as a best-effort diagnostic.
        this.#reportHandlerFailure(event, cause);
      }
    }
  }

  /**
   * Emit an event asynchronously, awaiting all registered handlers via
   * `Promise.allSettled`.
   *
   * A rejecting handler does not short-circuit the others — all handlers run
   * to completion (or rejection) before the returned Promise resolves. Each
   * rejection is not silently discarded: it is written to `process.stderr` as
   * a best-effort diagnostic naming the event and the rejection reason — the
   * event payload is never included, since it may carry caller-supplied
   * secrets. The returned Promise always resolves to `undefined`; it never
   * rejects.
   *
   * @typeParam TEvent - An event name present in the event map.
   * @param event - The event name to emit.
   * @param payload - The payload to pass to every handler.
   * @returns A Promise that resolves to `undefined` once all handlers have settled.
   */
  protected async emitAsync<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): Promise<void> {
    const set = this.#handlers.get(event);
    if (set === undefined) return;
    // Promise.allSettled preserves the isolation guarantee:
    // a rejecting handler does not short-circuit the others.
    // Wrap each call in Promise.resolve() so that synchronous throws are
    // also captured as rejected promises rather than propagating out of .map().
    const results = await Promise.allSettled(
      [...set].map((handler) => Promise.resolve().then(() => handler(payload))),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.#reportHandlerFailure(event, result.reason);
      }
    }
  }
}

/**
 * Concrete, instantiable event emitter — promotes `emit` and `emitAsync` to
 * `public` for use-cases where the owner holds the instance and emits directly
 * without needing to subclass.
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
  TEventMap extends object,
> extends M3LEventEmitterBase<TEventMap> {
  /**
   * Emit an event synchronously (public override of the protected base method).
   *
   * @typeParam TEvent - An event name present in the event map.
   * @param event - The event name to emit.
   * @param payload - The payload to pass to every handler.
   */
  public override emit<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): void {
    super.emit(event, payload);
  }

  /**
   * Emit an event asynchronously (public override of the protected base method).
   *
   * @typeParam TEvent - An event name present in the event map.
   * @param event - The event name to emit.
   * @param payload - The payload to pass to every handler.
   * @returns A Promise that resolves to `undefined` once all handlers have settled.
   */
  public override emitAsync<TEvent extends keyof TEventMap & string>(
    event: TEvent,
    payload: TEventMap[TEvent],
  ): Promise<void> {
    return super.emitAsync(event, payload);
  }
}
