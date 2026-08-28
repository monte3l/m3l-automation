/**
 * `stream/event-stream` — the generic, transport-agnostic event fan-out leaf
 * backing X4 live run streaming (#552).
 *
 * A pure in-memory data structure: a monotonic per-stream id counter, a
 * bounded ring buffer of the most recently published events, and a set of
 * live subscribers. Deliberately has no I/O and no logger dependency — it is
 * generic over `TPayload`, so it never names a run-specific shape, and
 * `stream/` is only ever allowed to import `@m3l-automation/m3l-common`,
 * `node:` builtins, and `../errors/` (ADR-0065, ADR-0066): `runs/` publishes
 * into a stream and `http/` serves it, so any edge out of `stream/` would
 * drag transport and orchestration into each other.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * One event a {@link M3LEventStream} has published, or replayed to a
 * resuming subscriber.
 *
 * `id` is monotonic and 1-based within a single stream: the first published
 * event is `1`, never `0` — that is what makes `0` a safe "nothing seen yet"
 * sentinel on {@link M3LSubscribeOptions.lastEventId}.
 *
 * @example
 * ```ts
 * const event: M3LStreamEvent<string> = { id: 1, payload: "hello" };
 * ```
 */
export interface M3LStreamEvent<TPayload> {
  /** Monotonic, 1-based id, unique within the owning stream. */
  readonly id: number;
  /** The published value. */
  readonly payload: TPayload;
}

/**
 * A subscriber's event callback, invoked once per delivered
 * {@link M3LStreamEvent} — both for a live publish and for a replayed
 * catch-up event.
 *
 * @example
 * ```ts
 * const onEvent: M3LStreamListener<string> = (event) => {
 *   console.log(event.id, event.payload);
 * };
 * ```
 */
export type M3LStreamListener<TPayload> = (
  event: M3LStreamEvent<TPayload>,
) => void;

/**
 * Why a stream ended: `"completed"` for an ordinary run finish, `"draining"`
 * for a server-initiated shutdown (ADR-0049).
 *
 * @example
 * ```ts
 * const reason: M3LStreamEndReason = "completed";
 * ```
 */
export type M3LStreamEndReason = "completed" | "draining";

/**
 * The handle {@link M3LEventStream.subscribe} returns. `unsubscribe` is
 * idempotent — calling it more than once, or after the stream itself has
 * ended, is always safe and never throws.
 *
 * @example
 * ```ts
 * declare const subscription: M3LStreamSubscription;
 * subscription.unsubscribe();
 * subscription.unsubscribe(); // still safe
 * ```
 */
export interface M3LStreamSubscription {
  /** Stops further delivery to this subscription. Idempotent. */
  unsubscribe(): void;
}

/**
 * Options for {@link M3LEventStream.subscribe}.
 *
 * `lastEventId`, when supplied (including `0`), triggers a resume replay
 * before any live event is delivered — see {@link M3LEventStream.subscribe}
 * for the exact dispatch rules. Omitting it entirely opts into live-only
 * delivery: no replay, and no `onGap` call either.
 *
 * @example
 * ```ts
 * const options: M3LSubscribeOptions<string> = {
 *   onEvent: (event) => console.log(event.payload),
 *   onEnd: (reason) => console.log("ended:", reason),
 *   onGap: (oldestRetainedId) => console.log("gap from:", oldestRetainedId),
 *   lastEventId: 2,
 * };
 * ```
 */
export interface M3LSubscribeOptions<TPayload> {
  /** Called once per delivered event, live or replayed. */
  readonly onEvent: M3LStreamListener<TPayload>;
  /** Called at most once, when the stream ends. */
  readonly onEnd: (reason: M3LStreamEndReason) => void;
  /**
   * Called when the resume position this subscriber requested can no
   * longer be satisfied from the retained buffer, or is ahead of anything
   * ever published. Receives the oldest id still retained (`0` when
   * nothing is retained).
   */
  readonly onGap: (oldestRetainedId: number) => void;
  /**
   * The last event id this subscriber has already seen, if any. `0` is a
   * safe "seen nothing" sentinel (ids are 1-based). Omit entirely for a
   * fresh subscriber that only wants events published from now on.
   */
  readonly lastEventId?: number;
}

/**
 * A single, generic, in-memory event stream. Retains up to `bufferSize`
 * most-recently-published events (evicting the oldest first) so a
 * reconnecting subscriber can resume from `lastEventId`.
 *
 * @example
 * ```ts
 * import { createEventStreamHub } from "@m3l-automation/m3l-console-server/stream/event-stream.js";
 *
 * const hub = createEventStreamHub<string>({ bufferSize: 100 });
 * const stream = hub.open("run-1");
 * stream.publish("hello");
 * ```
 */
export interface M3LEventStream<TPayload> {
  /** The stream's id, as passed to {@link M3LEventStreamHub.open}. */
  readonly id: string;
  /** The number of events currently retained (at most `bufferSize`). */
  readonly retained: number;
  /** The highest id ever published on this stream; `0` before the first publish. */
  readonly lastEventId: number;
  /** The oldest id currently retained; `0` when nothing is retained. */
  readonly oldestRetainedId: number;
  /** `true` once {@link M3LEventStream.end} has been called. */
  readonly ended: boolean;
  /**
   * Publishes `payload` as a new event with the next monotonic id, and
   * delivers it synchronously to every currently-subscribed listener.
   *
   * A listener's throw is never caught here — `stream/` may import only
   * `errors/`, so it has no logger, and swallowing the throw would mean
   * silently discarding it, which this project forbids outright. The seam
   * that does own a logger (`http/stream-writer.ts`, a later slice) is
   * responsible for never letting its own listener throw out of `publish`.
   *
   * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_STREAM_CLOSED` if the stream has
   *   already ended.
   */
  publish(payload: TPayload): M3LStreamEvent<TPayload>;
  /**
   * Ends the stream, notifying every currently-subscribed listener's
   * `onEnd` exactly once with `reason`. A second call is a no-op — `onEnd`
   * never fires more than once per subscription.
   */
  end(reason: M3LStreamEndReason): void;
  /**
   * Subscribes to this stream. See the module's resume-dispatch rules: given
   * `lastEventId: n`, the highest published id `H`, and the oldest retained
   * id `O`,
   *
   * - `lastEventId` omitted → live-only, no replay, no `onGap`.
   * - `n === H` → caught up already: no replay, no `onGap`.
   * - `n > H` → `onGap(O)` (a stale or forged id ahead of reality).
   * - `n === 0` → replay everything currently retained; never a gap.
   * - `n < O - 1` → the next id the subscriber needs has been evicted:
   *   `onGap(O)`, nothing replayed.
   * - otherwise → replay every retained event with `id > n`, ascending.
   *
   * If the stream has already ended, retained events are replayed first,
   * then `onEnd` fires — so a reconnecting client still sees the tail of
   * history before being told the stream is over.
   */
  subscribe(options: M3LSubscribeOptions<TPayload>): M3LStreamSubscription;
}

/** Options for {@link createEventStreamHub}. */
export interface M3LEventStreamHubOptions {
  /** The maximum number of events any stream opened by this hub retains. */
  readonly bufferSize: number;
}

/**
 * Owns the set of currently-open {@link M3LEventStream} instances, keyed by
 * caller-supplied id (a run id, in practice — this module never names that
 * type).
 *
 * @example
 * ```ts
 * import { createEventStreamHub } from "@m3l-automation/m3l-console-server/stream/event-stream.js";
 *
 * const hub = createEventStreamHub<string>({ bufferSize: 100 });
 * const stream = hub.open("run-1");
 * stream.publish("hello");
 * hub.endAll("draining");
 * ```
 */
export interface M3LEventStreamHub<TPayload> {
  /** The number of streams currently open. */
  readonly openCount: number;
  /**
   * Opens a new stream at `id`.
   *
   * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_STREAM_DUPLICATE` if `id` is
   *   already open.
   */
  open(id: string): M3LEventStream<TPayload>;
  /** Returns the open stream at `id`, or `undefined` if none is open. */
  get(id: string): M3LEventStream<TPayload> | undefined;
  /** Drops the stream at `id`. A no-op if none is open at that id. */
  release(id: string): void;
  /** Ends every currently-open stream with `reason`. */
  endAll(reason: M3LStreamEndReason): void;
}

/** A subscriber record retained internally by a single {@link M3LEventStream}. */
interface StreamSubscriber<TPayload> {
  readonly onEvent: M3LStreamListener<TPayload>;
  readonly onEnd: (reason: M3LStreamEndReason) => void;
  readonly onGap: (oldestRetainedId: number) => void;
}

/**
 * The three resume-dispatch outcomes {@link resolveResumeDecision} can
 * produce for a subscriber's requested `lastEventId`.
 */
type ResumeDecision<TPayload> =
  | { readonly kind: "none" }
  | { readonly kind: "gap"; readonly oldestRetainedId: number }
  | {
      readonly kind: "replay";
      readonly events: readonly M3LStreamEvent<TPayload>[];
    };

/**
 * Pure decision logic for the resume-dispatch rules documented on
 * {@link M3LEventStream.subscribe}. Extracted as its own function (rather
 * than inlined into `subscribe`) both to keep that method's cognitive
 * complexity down and so every boundary — including the easy-to-miss
 * `lastEventId === oldestRetainedId - 1` "still replayable" edge — is a
 * single, independently readable branch.
 *
 * Check order matters: `n === H` and `n === 0` must both be resolved before
 * the eviction check, or a fresh stream (`H === 0`, `O === 0`) or a full
 * resume-from-scratch (`n === 0`) would be misclassified as a gap.
 */
function resolveResumeDecision<TPayload>(
  lastEventId: number,
  highestPublishedId: number,
  oldestRetainedId: number,
  retainedEvents: readonly M3LStreamEvent<TPayload>[],
): ResumeDecision<TPayload> {
  if (lastEventId === highestPublishedId) {
    return { kind: "none" };
  }
  if (lastEventId > highestPublishedId) {
    return { kind: "gap", oldestRetainedId };
  }
  if (lastEventId === 0) {
    return { kind: "replay", events: retainedEvents };
  }
  if (lastEventId < oldestRetainedId - 1) {
    return { kind: "gap", oldestRetainedId };
  }
  return {
    kind: "replay",
    events: retainedEvents.filter((event) => event.id > lastEventId),
  };
}

/**
 * Everything {@link dispatchResume} needs to run one subscriber's resume
 * decision — bundled into a single object rather than a long parameter
 * list, since a positional call site with two numbers and two callbacks in
 * a row is easy to transpose by accident.
 */
interface ResumeContext<TPayload> {
  /**
   * The effective resume position: `undefined` means "no replay" (a fresh,
   * live-only subscriber on a still-open stream). Note this is the
   * *effective* value the caller computed — not necessarily
   * `M3LSubscribeOptions.lastEventId` verbatim, since an already-ended
   * stream substitutes `0` when the caller omitted it (see
   * {@link createEventStream}'s `subscribe`).
   */
  readonly lastEventId: number | undefined;
  readonly onEvent: M3LStreamListener<TPayload>;
  readonly onGap: (oldestRetainedId: number) => void;
  readonly highestPublishedId: number;
  readonly oldestRetainedId: number;
  readonly retainedEvents: readonly M3LStreamEvent<TPayload>[];
}

/**
 * Runs the resume-dispatch decision for a subscriber that has just been
 * registered: replays any events the decision calls for, or fires `onGap`.
 * Delivering to a snapshot array (`retainedEvents` is already a plain
 * array, never the live buffer) means nothing the replay itself does can
 * mutate what it is iterating.
 */
function dispatchResume<TPayload>(context: ResumeContext<TPayload>): void {
  if (context.lastEventId === undefined) return;

  const decision = resolveResumeDecision(
    context.lastEventId,
    context.highestPublishedId,
    context.oldestRetainedId,
    context.retainedEvents,
  );
  switch (decision.kind) {
    case "none":
      return;
    case "gap":
      context.onGap(decision.oldestRetainedId);
      return;
    case "replay":
      for (const event of decision.events) {
        context.onEvent(event);
      }
      return;
    default: {
      const exhaustive: never = decision;
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `unhandled resume decision: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Non-exported {@link M3LEventStream} implementation. A class (mutating
 * `this` in each method) rather than closures over local `let`s, purely to
 * keep every operation its own short, independently readable method instead
 * of one long factory-function body — the same shape `lifecycle/drain.ts`'s
 * `DrainControllerImpl` uses for the same reason.
 */
class EventStreamImpl<TPayload> implements M3LEventStream<TPayload> {
  private readonly buffer: M3LStreamEvent<TPayload>[] = [];
  private readonly subscribers = new Set<StreamSubscriber<TPayload>>();
  private highestPublishedIdValue = 0;
  private endInfo: { readonly reason: M3LStreamEndReason } | undefined;

  constructor(
    readonly id: string,
    private readonly bufferSize: number,
  ) {}

  get retained(): number {
    return this.buffer.length;
  }

  get lastEventId(): number {
    return this.highestPublishedIdValue;
  }

  get oldestRetainedId(): number {
    return this.buffer.at(0)?.id ?? 0;
  }

  get ended(): boolean {
    return this.endInfo !== undefined;
  }

  publish(payload: TPayload): M3LStreamEvent<TPayload> {
    if (this.endInfo !== undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_STREAM_CLOSED",
        `cannot publish on stream "${this.id}": it has already ended`,
      );
    }
    this.highestPublishedIdValue += 1;
    const event: M3LStreamEvent<TPayload> = {
      id: this.highestPublishedIdValue,
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }
    // Iterate a snapshot: an `onEvent` that unsubscribes itself (or
    // another subscriber) must not disturb delivery to the remaining
    // subscribers of this same event.
    for (const subscriber of [...this.subscribers]) {
      if (!this.subscribers.has(subscriber)) continue;
      subscriber.onEvent(event);
    }
    return event;
  }

  end(reason: M3LStreamEndReason): void {
    if (this.endInfo !== undefined) return;
    this.endInfo = { reason };
    const toNotify = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of toNotify) {
      subscriber.onEnd(reason);
    }
  }

  subscribe(options: M3LSubscribeOptions<TPayload>): M3LStreamSubscription {
    const subscriber: StreamSubscriber<TPayload> = {
      onEvent: options.onEvent,
      onEnd: options.onEnd,
      onGap: options.onGap,
    };
    this.subscribers.add(subscriber);

    // An already-ended stream has no future live events, so a caller that
    // omitted `lastEventId` (opting into live-only delivery) would
    // otherwise receive nothing at all; substituting `0` gives it the same
    // full-backlog replay an explicit `lastEventId: 0` would.
    const effectiveLastEventId =
      options.lastEventId ?? (this.endInfo !== undefined ? 0 : undefined);

    dispatchResume({
      lastEventId: effectiveLastEventId,
      onEvent: options.onEvent,
      onGap: options.onGap,
      highestPublishedId: this.highestPublishedIdValue,
      oldestRetainedId: this.oldestRetainedId,
      retainedEvents: [...this.buffer],
    });

    if (this.endInfo !== undefined) {
      this.subscribers.delete(subscriber);
      options.onEnd(this.endInfo.reason);
    }

    return {
      unsubscribe: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }
}

/** Creates a single {@link M3LEventStream} bounded to `bufferSize` retained events. */
function createEventStream<TPayload>(
  id: string,
  bufferSize: number,
): M3LEventStream<TPayload> {
  return new EventStreamImpl<TPayload>(id, bufferSize);
}

/**
 * Rejects a `bufferSize` that is not a positive integer. `Number.isInteger`
 * alone already rejects `NaN` (it is not an integer), so no separate
 * `Number.isNaN` check is needed.
 */
function validateBufferSize(bufferSize: number): void {
  if (!Number.isInteger(bufferSize) || bufferSize <= 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `event stream hub bufferSize must be a positive integer, got ${String(bufferSize)}`,
    );
  }
}

/**
 * Creates an {@link M3LEventStreamHub} whose streams each retain up to
 * `options.bufferSize` events.
 *
 * @param options - Hub-wide options; `bufferSize` must be a positive
 *   integer.
 * @returns A new, empty hub.
 * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_INTERNAL` if `bufferSize` is not a
 *   positive integer. A bad value reaching this constructor is an internal
 *   defect — operator-supplied configuration is validated at boot,
 *   elsewhere.
 *
 * @example
 * ```ts
 * import { createEventStreamHub } from "@m3l-automation/m3l-console-server/stream/event-stream.js";
 *
 * const hub = createEventStreamHub<string>({ bufferSize: 100 });
 * const stream = hub.open("run-1");
 * const subscription = stream.subscribe({
 *   onEvent: (event) => console.log(event.payload),
 *   onEnd: (reason) => console.log("ended:", reason),
 *   onGap: (oldestRetainedId) => console.log("gap from:", oldestRetainedId),
 * });
 * stream.publish("hello");
 * subscription.unsubscribe();
 * hub.release("run-1");
 * ```
 */
export function createEventStreamHub<TPayload>(
  options: M3LEventStreamHubOptions,
): M3LEventStreamHub<TPayload> {
  validateBufferSize(options.bufferSize);

  const streams = new Map<string, M3LEventStream<TPayload>>();

  return {
    get openCount() {
      return streams.size;
    },
    open(id) {
      if (streams.has(id)) {
        throw new M3LConsoleError(
          "ERR_CONSOLE_STREAM_DUPLICATE",
          `stream "${id}" is already open`,
        );
      }
      const stream = createEventStream<TPayload>(id, options.bufferSize);
      streams.set(id, stream);
      return stream;
    },
    get(id) {
      return streams.get(id);
    },
    release(id) {
      streams.delete(id);
    },
    endAll(reason) {
      for (const stream of streams.values()) {
        stream.end(reason);
      }
    },
  };
}
