/**
 * Wire-level security tests for aws/bedrock-runtime's V5 Slice A tool
 * vocabulary (ADR-0059) — `tests/bedrock-runtime-tools.test.ts` (and
 * `tests/bedrock-runtime.test.ts`) `vi.mock()` the whole
 * `@aws-sdk/client-bedrock-runtime` module (module-level, hoisted), so
 * every one of that file's 125+ tests inspects a captured `.send()` call
 * argument — never a serialized byte. That mock cannot observe a prototype-
 * chain/species injection surviving into the actual request the SDK's own
 * serializer would put on the wire (two rounds of exactly that were found
 * in an adversarial pass, 2026-08-29 security pass, both invisible to the
 * mocked suite at 100% line coverage).
 *
 * This file constructs a REAL `BedrockRuntimeClient` with a stub
 * `requestHandler` (no network, no real credentials) so the genuine AWS
 * request serializer runs; `handle()` captures the already-serialized
 * request body before returning a stubbed, minimal Converse HTTP response.
 * Deliberately a SEPARATE file from `bedrock-runtime-tools.test.ts` — that
 * file's `vi.mock("@aws-sdk/client-bedrock-runtime", ...)` is hoisted and
 * applies to every import of that module within the file, so a real client
 * cannot coexist with it there (confirmed against the file; not retrofitted).
 *
 * Every "no leak" assertion below inspects the CAPTURED WIRE BYTES
 * (`sent[]`, the decoded UTF-8 request body), never an internal call
 * argument — that is this file's entire reason to exist. See the first
 * `describe` block for the harness itself and a control case proving it
 * actually threads a marker through the real serializer (a "no leak"
 * assertion is vacuous if the harness never really serializes anything).
 *
 * Where this file's assertions diverge from a prior brief's expectations,
 * the divergence is called out inline: `copyDocument` (`document.ts`)
 * already fixed the M1 array-arm species bypass by never reading
 * `constructor`/`Symbol.species` at all (an index loop, not `.map()`), so a
 * species-poisoned-but-otherwise-ordinary array does not throw — it copies
 * cleanly with no injection, which is the stronger property (structurally
 * neutralized, not merely rejected). A genuinely hostile Proxy trap that
 * throws when read (not just species-poisoned) is used to prove the "no
 * raw error escapes" invariant instead, since it is the construction that
 * actually reaches that code path.
 */

import { describe, expect, test } from "vitest";

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import {
  M3LBedrockRuntimeOperationError,
  M3LBedrockRuntimeOperations,
} from "../src/aws/index.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
  M3LBedrockToolInvokeRequest,
} from "../src/aws/index.js";

/** A minimal, well-formed Converse HTTP response body (`end_turn`, one text block). */
function stubConverseResponsePayload(): Record<string, unknown> {
  return {
    output: { message: { role: "assistant", content: [{ text: "ok" }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

/** The stub `requestHandler`'s `handle()` argument shape — only what this file reads. */
interface StubHttpRequest {
  readonly body: unknown;
}

/**
 * Builds a REAL `BedrockRuntimeClient` (genuine request serializer, genuine
 * response deserializer) wired to a stub `requestHandler` that never
 * touches the network: `handle()` decodes and records the already-
 * serialized request body (a `Uint8Array` — the SDK's JSON codec, not a
 * readable stream, for this client version) into `sent`, then returns a
 * minimal successful HTTP response whose body is itself a `Uint8Array` (the
 * deserializer's `collectBody` fast path for `body instanceof Uint8Array`,
 * needing no stream/stream-collector machinery).
 *
 * No real region/credentials reach anywhere — `requestHandler.handle` is
 * the only thing ever invoked; nothing here performs I/O.
 */
function newWireClient(): {
  readonly client: BedrockRuntimeClient;
  readonly sent: string[];
} {
  const sent: string[] = [];
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "y" },
    requestHandler: {
      handle(request: StubHttpRequest) {
        sent.push(new TextDecoder().decode(request.body as Uint8Array));
        const body = new TextEncoder().encode(
          JSON.stringify(stubConverseResponsePayload()),
        );
        return Promise.resolve({
          response: { statusCode: 200, headers: {}, body },
        });
      },
    },
  });
  return { client, sent };
}

/** Constructs `M3LBedrockRuntimeOperations` against a fresh wire client. */
function newWireOps(): {
  readonly ops: M3LBedrockRuntimeOperations;
  readonly sent: string[];
} {
  const { client, sent } = newWireClient();
  return {
    ops: new M3LBedrockRuntimeOperations(client, { models: ["m1"] }),
    sent,
  };
}

/** Captures a thrown value from an async call without a try/catch at every call site. */
async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Like {@link newWireOps}, but the stub `requestHandler` returns `payload`
 * verbatim (still through the REAL deserializer) instead of
 * {@link stubConverseResponsePayload}'s fixed body — for response-side
 * coverage gaps (e.g. `tools.ts`'s `refuseServerToolUse`) that need control
 * over the reply shape itself, not just what reaches the request wire.
 */
function newWireOpsWithResponsePayload(payload: Record<string, unknown>): {
  readonly ops: M3LBedrockRuntimeOperations;
  readonly sent: string[];
} {
  const sent: string[] = [];
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "y" },
    requestHandler: {
      handle(request: StubHttpRequest) {
        sent.push(new TextDecoder().decode(request.body as Uint8Array));
        const body = new TextEncoder().encode(JSON.stringify(payload));
        return Promise.resolve({
          response: { statusCode: 200, headers: {}, body },
        });
      },
    },
  });
  return {
    ops: new M3LBedrockRuntimeOperations(client, { models: ["m1"] }),
    sent,
  };
}

describe("wire harness sanity — proves the real serializer actually runs", () => {
  test("a benign marker placed in inputSchema IS present in the captured wire body", async () => {
    const { ops, sent } = newWireOps();
    const MARKER = "WIRE_HARNESS_CONTROL_MARKER_9f3a";

    const result = await ops.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          name: "toolA",
          inputSchema: { note: MARKER },
        },
      ],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).toContain(MARKER);
  });
});

/** A fake array-species constructor: if ever actually constructed, it would inject `marker`. Typed `unknown` for `[Symbol.species]`'s own sake — the fixed `copyDocument` never invokes it either way. */
function fakeSpeciesConstructor(marker: string): unknown {
  function EvilCtor(): Record<string, unknown> {
    return { [marker]: "SCHEMA_INJECT" };
  }
  return EvilCtor;
}

/** A species-poisoned array via an own `constructor` property + `[Symbol.species]`. */
function speciesArrayOwnConstructor(marker: string): unknown[] {
  const array: unknown[] = [1, 2, 3];
  class Evil {
    static get [Symbol.species](): unknown {
      return fakeSpeciesConstructor(marker);
    }
  }
  Object.defineProperty(array, "constructor", {
    value: Evil,
    enumerable: false,
    configurable: true,
  });
  return array;
}

/** A species-poisoned array where `constructor` is supplied ONLY via a Proxy `get` trap — no own property at all. */
function speciesArrayProxyConstructor(marker: string): unknown[] {
  const target: unknown[] = [1, 2, 3];
  class Evil {
    static get [Symbol.species](): unknown {
      return fakeSpeciesConstructor(marker);
    }
  }
  return new Proxy(target, {
    get(t, prop, receiver: unknown): unknown {
      if (prop === "constructor") return Evil;
      const value: unknown = Reflect.get(t, prop, receiver);
      return value;
    },
  });
}

const SPECIES_VARIANTS: readonly (readonly [
  string,
  (marker: string) => unknown[],
])[] = [
  ["own constructor property + Symbol.species", speciesArrayOwnConstructor],
  [
    "Proxy get-trap constructor (no own property)",
    speciesArrayProxyConstructor,
  ],
];

const MARKER_KEY = "INJECTED_KEY";

/** Builds a request driving the malicious array through `tools[].inputSchema`. */
function requestViaInputSchema(
  evilArray: unknown,
): M3LBedrockToolInvokeRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      {
        name: "toolA",
        inputSchema: { evil: evilArray },
      },
    ],
  };
}

/** Builds a request driving the malicious array through a request-side `toolResult` `json` payload. */
function requestViaToolResultJson(
  evilArray: unknown,
): M3LBedrockToolInvokeRequest {
  const block = {
    type: "toolResult",
    toolUseId: "call-1",
    content: [{ type: "json", json: { evil: evilArray } }],
  } as unknown as M3LBedrockContentBlock;
  return { messages: [{ role: "user", content: [block] }] };
}

/** Builds a request driving the malicious array through a request-side `toolUse.input`. */
function requestViaToolUseInput(
  evilArray: unknown,
): M3LBedrockToolInvokeRequest {
  const block = {
    type: "toolUse",
    toolUseId: "call-1",
    name: "toolA",
    input: { evil: evilArray },
  } as unknown as M3LBedrockContentBlock;
  return { messages: [{ role: "assistant", content: [block] }] };
}

const DOCUMENT_SINKS: readonly (readonly [
  string,
  (evilArray: unknown) => M3LBedrockToolInvokeRequest,
])[] = [
  ["tools[].inputSchema", requestViaInputSchema],
  ["request-side toolResult json payload", requestViaToolResultJson],
  ["request-side toolUse.input", requestViaToolUseInput],
];

describe("M1 regression — array-arm species injection is structurally neutralized, not merely rejected", () => {
  test.each(
    SPECIES_VARIANTS.flatMap(([variantName, buildArray]) =>
      DOCUMENT_SINKS.map(
        ([sinkName, buildRequest]) =>
          [variantName, sinkName, buildArray, buildRequest] as const,
      ),
    ),
  )(
    "%s via %s: resolves cleanly, and the injected marker never reaches the wire body (copyDocument's index loop never reads constructor/Symbol.species — see file doc comment for why this is 'resolves', not 'rejects')",
    async (_variantName, _sinkName, buildArray, buildRequest) => {
      const { ops, sent } = newWireOps();
      const evilArray = buildArray(MARKER_KEY);

      const result = await ops.invoke(buildRequest(evilArray));

      expect(result.stopReason).toBe("end_turn");
      expect(sent).toHaveLength(1);
      for (const body of sent) {
        expect(body).not.toContain(MARKER_KEY);
        expect(body).not.toContain("SCHEMA_INJECT");
        expect(body).not.toContain("TOOLUSE_INJECT");
      }
    },
  );
});

describe("Round-1 regression — a literal __proto__ own property never reaches the wire or pollutes the global prototype", () => {
  test("__proto__ as an inputSchema value: throws M3LBedrockRuntimeOperationError, no wire leak, no global pollution", async () => {
    const { ops, sent } = newWireOps();
    const polluted = JSON.parse(
      '{"a":1,"__proto__":{"injected":"X"}}',
    ) as Record<string, unknown>;

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "toolA", inputSchema: polluted }],
      }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
    expect(Object.hasOwn(Object.prototype, "injected")).toBe(false);
  });

  test("__proto__ as a request-side toolResult json payload: throws M3LBedrockRuntimeOperationError, no wire leak, no global pollution", async () => {
    const { ops, sent } = newWireOps();
    const polluted = JSON.parse(
      '{"a":1,"__proto__":{"injected":"X"}}',
    ) as Record<string, unknown>;
    const block = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [{ type: "json", json: polluted }],
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [block] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
    expect(Object.hasOwn(Object.prototype, "injected")).toBe(false);
  });
});

describe("M2 — no raw error escapes the copyDocument boundary", () => {
  test("a Proxy `get` trap that throws on numeric-index access surfaces as M3LBedrockRuntimeOperationError, never a bare TypeError", async () => {
    const { ops, sent } = newWireOps();
    const hostileArray = new Proxy([1, 2, 3], {
      get(target, prop, receiver: unknown): unknown {
        if (prop === "1") throw new TypeError("hostile trap boom");
        const value: unknown = Reflect.get(target, prop, receiver);
        return value;
      },
    });

    const thrown = await captureThrow(() =>
      ops.invoke(requestViaInputSchema(hostileArray)),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.code).toBe("ERR_BEDROCK_RUNTIME_OPERATION");
    expect(sent).toHaveLength(0);
  });

  test("a Proxy `get` trap that throws on `length` access surfaces as M3LBedrockRuntimeOperationError, never a bare TypeError", async () => {
    const { ops, sent } = newWireOps();
    const hostileArray = new Proxy([1, 2, 3], {
      get(target, prop, receiver: unknown): unknown {
        if (prop === "length") throw new TypeError("hostile trap boom");
        const value: unknown = Reflect.get(target, prop, receiver);
        return value;
      },
    });

    const thrown = await captureThrow(() =>
      ops.invoke(requestViaToolResultJson(hostileArray)),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.code).toBe("ERR_BEDROCK_RUNTIME_OPERATION");
    expect(sent).toHaveLength(0);
  });

  // `mapContentBlockToSdk`/`mapToolResultContentItem` read the caller-supplied
  // discriminant ONCE into a local inside a try/catch, rather than
  // `switch`ing on the property expression directly. A bare
  // `switch (block.type)` evaluates the discriminant unprotected, so a
  // throwing `type` getter would escape as a raw, un-normalized `Error`
  // before the `default` arm's typed-error handling is ever reached. Do not
  // "simplify" the guarded local read back into the `switch` line — that
  // reintroduces the unprotected read this test guards against.
  test("a throwing `type` getter on a request-side content block surfaces as M3LBedrockRuntimeOperationError, not a raw Error", async () => {
    const { ops, sent } = newWireOps();
    const evilBlock = {
      get type(): string {
        throw new Error("evil getter boom");
      },
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [evilBlock] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });

  // Same guard, via the toolResult content-item read
  // (`mapToolResultContentItem`) instead of the top-level content block read.
  test("a throwing `type` getter on a toolResult content item surfaces as M3LBedrockRuntimeOperationError, not a raw Error", async () => {
    const { ops, sent } = newWireOps();
    const evilItem = {
      get type(): string {
        throw new Error("evil getter boom");
      },
    };
    const block = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [evilItem],
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [block] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });
});

describe("M3 — the document node/depth budget bails fast on adversarial sizing", () => {
  /** Builds `{ nest: { nest: ... "leaf" } }`, `levels` deep. */
  function makeDeep(levels: number): unknown {
    let value: unknown = "leaf";
    for (let index = 0; index < levels; index += 1) {
      value = { nest: value };
    }
    return value;
  }

  test("depth 32 is accepted", async () => {
    const { ops, sent } = newWireOps();
    const result = await ops.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        { name: "toolA", inputSchema: makeDeep(32) as Record<string, unknown> },
      ],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
  });

  test("depth 33 throws M3LBedrockRuntimeOperationError", async () => {
    const { ops, sent } = newWireOps();

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [
          {
            name: "toolA",
            inputSchema: makeDeep(33) as Record<string, unknown>,
          },
        ],
      }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });

  test(
    "a cyclic document still bails via the depth ceiling, never hangs",
    { timeout: 2_000 },
    async () => {
      const { ops, sent } = newWireOps();
      const cyclic: Record<string, unknown> = {};
      cyclic["self"] = cyclic;

      const thrown = await captureThrow(() =>
        ops.invoke({
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [{ name: "toolA", inputSchema: cyclic }],
        }),
      );

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect(sent).toHaveLength(0);
    },
  );

  test(
    "a shared (2-way, 24-level) DAG that would expand exponentially rejects quickly via the node budget, never hangs or OOMs",
    // Short, explicit timeout: a regression that reintroduces exponential
    // blowup here must fail FAST, not hang the runner until a global
    // timeout (or OOM the process outright, as the pre-fix implementation
    // did against a 2 GB heap — 2026-08-29 security pass).
    { timeout: 2_000 },
    async () => {
      const { ops, sent } = newWireOps();
      // Each level shares the SAME previous-level object under two keys —
      // node count doubles per level (2^24 ~ 16.7M) while depth never
      // exceeds MAX_DOCUMENT_DEPTH (32) on any single path; see
      // document.ts's MAX_DOCUMENT_NODES doc comment for the exact proof.
      let level: unknown = { leaf: true };
      for (let index = 0; index < 24; index += 1) {
        level = { a: level, b: level };
      }

      const thrown = await captureThrow(() =>
        ops.invoke({
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [
            { name: "toolA", inputSchema: level as Record<string, unknown> },
          ],
        }),
      );

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect((thrown as Error).message).toContain("constructed nodes");
      expect(sent).toHaveLength(0);
    },
  );
});

describe("Error-channel sanitization — a secret-shaped KEY, control characters, and oversized strings never reach error.message/toJSON() unsanitized", () => {
  test("a secret used as a document KEY never appears in error.message or toJSON() — in any form (raw, escaped, or truncated)", async () => {
    const { ops, sent } = newWireOps();
    const secretKey = "sk-live-SECRETVALUE\ndef\x1b[31mred\x1b[0m";
    // Nests the secret key one level above a reserved "__proto__" own
    // property (via JSON.parse, a real own property) so copyDocument
    // throws WHILE the secret key is part of the error's path — the
    // channel this test actually proves.
    const inner = JSON.parse('{"__proto__":{"injected":1}}') as Record<
      string,
      unknown
    >;

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "toolA", inputSchema: { [secretKey]: inner } }],
      }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    // An ordinary object `key` step is rendered positionally
    // (`.<key#N>`) — the key never reaches the message at all, so
    // there is nothing left to escape: not raw, not escaped, not
    // truncated. Assert both the full key and its recognizable prefix
    // are absent, plus (defense in depth) the control chars and their
    // escaped forms it contains.
    expect(error.message).not.toContain(secretKey);
    expect(error.message).not.toContain("sk-live-SECRETVALUE");
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain("\x1b");
    expect(error.message).not.toContain("\\x0a");
    expect(error.message).not.toContain("\\x1b");
    expect(error.message).toContain("<key#1>");
    const json = JSON.stringify(error.toJSON());
    expect(json).not.toContain(secretKey);
    expect(json).not.toContain("sk-live-SECRETVALUE");
    expect(sent).toHaveLength(0);
  });

  test("a plain, control-char-free secret used as a document KEY is also absent from error.message and toJSON() (no control chars to escape — the exact leak an escaping-only fix cannot catch)", async () => {
    const { ops, sent } = newWireOps();
    const secretKey = "sk-live-PLAINSECRET";
    const inner = JSON.parse('{"__proto__":{"injected":1}}') as Record<
      string,
      unknown
    >;

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "toolA", inputSchema: { [secretKey]: inner } }],
      }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message).not.toContain(secretKey);
    expect(error.message).toContain("<key#1>");
    const json = JSON.stringify(error.toJSON());
    expect(json).not.toContain(secretKey);
    expect(sent).toHaveLength(0);
  });

  test("an oversized (150 KB) document KEY is length-capped in error.message, never proportional to input size", async () => {
    const { ops, sent } = newWireOps();
    const hugeKey = "K".repeat(150_000);
    const inner = JSON.parse('{"__proto__":{"injected":1}}') as Record<
      string,
      unknown
    >;

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "toolA", inputSchema: { [hugeKey]: inner } }],
      }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message.length).toBeLessThan(1_000);
    expect(sent).toHaveLength(0);
  });

  test("an oversized (150 KB) off-contract `type` discriminant is length-capped in error.message, never proportional to input size", async () => {
    const { ops, sent } = newWireOps();
    const hugeType = "T".repeat(150_000);
    const invalidBlock = {
      type: hugeType,
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [invalidBlock] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message.length).toBeLessThan(1_000);
    expect(sent).toHaveLength(0);
  });

  test("newline/ANSI escape sequences in an off-contract `type` discriminant are escaped, never raw, in error.message", async () => {
    const { ops, sent } = newWireOps();
    const hostileType = "nope\ninjected\x1b[31m";
    const invalidBlock = {
      type: hostileType,
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [invalidBlock] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain("\x1b");
    expect(error.message).toContain("\\x0a");
    expect(error.message).toContain("\\x1b");
    expect(sent).toHaveLength(0);
  });
});

describe("document.ts guard coverage — readCallerValue/readCallerString/requireCallerArray rejection arms", () => {
  test("a throwing getter on a toolResult block's status surfaces as M3LBedrockRuntimeOperationError, not a raw Error (readCallerValue's catch)", async () => {
    const { ops, sent } = newWireOps();
    const block = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [],
      get status(): string {
        throw new Error("evil getter boom");
      },
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [block] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(sent).toHaveLength(0);
  });

  test("a non-string text value on a request-side text content block throws M3LBedrockRuntimeOperationError (readCallerString's type guard)", async () => {
    const { ops, sent } = newWireOps();
    const block = {
      type: "text",
      text: { NOT_A_STRING: 1 },
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [block] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(sent).toHaveLength(0);
  });

  test("a duck-typed (non-array) message content value throws M3LBedrockRuntimeOperationError (requireCallerArray's shape guard)", async () => {
    const { ops, sent } = newWireOps();
    const duckContent = { length: 1 };
    const message = {
      role: "user",
      content: duckContent,
    } as unknown as M3LBedrockMessage;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [message] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(sent).toHaveLength(0);
  });

  // Proves readCallerValueOrElse's fallback arm (document.ts): an unreadable
  // discriminant is treated the same as a non-"text" one, never a raw throw.
  test("invokeStream: a throwing `type` getter on a message content block is treated as non-text, rejecting with M3LBedrockRuntimeOperationError on the first .next()", async () => {
    const { ops } = newWireOps();
    const evilBlock = {
      get type(): string {
        throw new Error("evil getter boom");
      },
    } as unknown as M3LBedrockContentBlock;

    const stream = ops.invokeStream({
      messages: [{ role: "user", content: [evilBlock] }],
    });
    const thrown = await captureThrow(() => stream.next());

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain(
      "non-text message content blocks",
    );
  });
});

describe("field-readers.ts guard coverage — invokeStream's textOnly field-table build guards a non-array-shaped request.messages/content", () => {
  test("invokeStream: a messages value lacking a real .some() surfaces as M3LBedrockRuntimeOperationError, never a raw TypeError, on the first .next()", async () => {
    const { ops } = newWireOps();
    const request = {
      messages: { length: 1 },
    } as unknown as M3LBedrockInvokeRequest;

    const stream = ops.invokeStream(request);
    const thrown = await captureThrow(() => stream.next());

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain(
      "could not read request.messages/content",
    );
  });

  test("invokeStream: a message content value lacking a real .some() surfaces as M3LBedrockRuntimeOperationError, never a raw TypeError, on the first .next()", async () => {
    const { ops } = newWireOps();
    const request = {
      messages: [{ role: "user", content: { length: 1 } }],
    } as unknown as M3LBedrockInvokeRequest;

    const stream = ops.invokeStream(request);
    const thrown = await captureThrow(() => stream.next());

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain(
      "could not read request.messages/content",
    );
  });
});

describe("shared.ts guard coverage — toolResult status, message role, and toolUse.input's undefined arm", () => {
  test("a toolResult block with an invalid status value throws M3LBedrockRuntimeOperationError", async () => {
    const { ops, sent } = newWireOps();
    const block = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [],
      status: "pending",
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [block] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });

  test("a message with a role outside user/assistant throws M3LBedrockRuntimeOperationError", async () => {
    const { ops, sent } = newWireOps();
    const message = {
      role: "system",
      content: [{ type: "text", text: "hi" }],
    } as unknown as M3LBedrockMessage;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [message] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });

  // A no-argument tool call replayed as history: `input` is legitimately
  // absent, so `toolUse.input` must be forwarded as `undefined` rather than
  // derived by calling `copyDocument` on it (which throws on `undefined`).
  test("a request-side toolUse block with no input is forwarded successfully with input omitted, not derived by copying", async () => {
    const { ops, sent } = newWireOps();
    const block = {
      type: "toolUse",
      toolUseId: "call-1",
      name: "toolA",
    } as unknown as M3LBedrockContentBlock;

    const result = await ops.invoke({
      messages: [{ role: "assistant", content: [block] }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).not.toContain('"input"');
  });
});

describe("tools.ts guard coverage — refuseServerToolUse's toolUseId/name suffix ternaries", () => {
  test("a server_tool_use reply block with no toolUseId or name throws without appending either suffix to the message", async () => {
    const { ops, sent } = newWireOpsWithResponsePayload({
      output: {
        message: {
          role: "assistant",
          content: [{ toolUse: { type: "server_tool_use" } }],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const message = (thrown as Error).message;
    expect(message).not.toContain("toolUseId=");
    expect(message).not.toContain(" name=");
    expect(sent).toHaveLength(1);
  });
});

describe("flip-flopping getters — a value read twice could diverge between validation and send; every reader here reads its source exactly once, so only the FIRST read can ever reach the wire", () => {
  test("invoke(): a content block's `type` flipping text -> toolUse never lets the toolUse-only fields reach the wire", async () => {
    const { ops, sent } = newWireOps();
    let reads = 0;
    const flip = {
      get type(): string {
        reads += 1;
        return reads === 1 ? "text" : "toolUse";
      },
      text: "FLIP_VALIDATED_TEXT",
      toolUseId: "FLIP_UNVALIDATED_ID",
      name: "FLIP_UNVALIDATED_NAME",
    } as unknown as M3LBedrockContentBlock;

    const result = await ops.invoke({
      messages: [{ role: "user", content: [flip] }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).toContain("FLIP_VALIDATED_TEXT");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).not.toContain("FLIP_UNVALIDATED_ID");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).not.toContain("FLIP_UNVALIDATED_NAME");
  });

  test("invokeStream(): a content block's `type` flipping text -> toolUse never lets the toolUse-only fields reach the wire", async () => {
    const { ops, sent } = newWireOps();
    let reads = 0;
    const flip = {
      get type(): string {
        reads += 1;
        return reads === 1 ? "text" : "toolUse";
      },
      text: "FLIP_STREAM_VALIDATED_TEXT",
      toolUseId: "FLIP_STREAM_UNVALIDATED_ID",
      name: "FLIP_STREAM_UNVALIDATED_NAME",
    } as unknown as M3LBedrockContentBlock;

    const stream = ops.invokeStream({
      messages: [{ role: "user", content: [flip] }],
    });
    const thrown = await captureThrow(() => stream.next());

    // The unvalidated marker must never reach the wire, regardless of
    // whether the streamed response itself later resolves or rejects (this
    // stub `requestHandler` returns a plain JSON body, not a real event
    // stream, so what happens AFTER the request is captured is out of
    // scope here — only the captured bytes matter).
    for (const body of sent) {
      expect(body).not.toContain("FLIP_STREAM_UNVALIDATED_ID");
      expect(body).not.toContain("FLIP_STREAM_UNVALIDATED_NAME");
    }
    if (sent.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked above
      expect(sent[0]!).toContain("FLIP_STREAM_VALIDATED_TEXT");
    } else {
      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    }
  });

  test("invoke(): a text block's `text` value flipping between two reads never lets the second value reach the wire", async () => {
    const { ops, sent } = newWireOps();
    let reads = 0;
    const flip = {
      type: "text",
      get text(): string {
        reads += 1;
        return reads === 1 ? "FIRST_TEXT_VALUE" : "SECOND_TEXT_VALUE";
      },
    } as unknown as M3LBedrockContentBlock;

    const result = await ops.invoke({
      messages: [{ role: "user", content: [flip] }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).toContain("FIRST_TEXT_VALUE");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).not.toContain("SECOND_TEXT_VALUE");
  });

  test("invoke(): request.system flipping between two reads never lets the second value reach the wire", async () => {
    const { ops, sent } = newWireOps();
    let reads = 0;
    const request = {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      get system(): string {
        reads += 1;
        return reads === 1 ? "SYS_VALIDATED" : "SYS_UNVALIDATED";
      },
    } as unknown as M3LBedrockInvokeRequest;

    const result = await ops.invoke(request);

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).toContain("SYS_VALIDATED");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).not.toContain("SYS_UNVALIDATED");
  });

  test("invoke(): inferenceConfig.maxTokens flipping between two reads never lets the second value reach the wire", async () => {
    const { ops, sent } = newWireOps();
    let reads = 0;
    const inferenceConfig = {
      get maxTokens(): number {
        reads += 1;
        return reads === 1 ? 7 : 99_999;
      },
    };

    const result = await ops.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      inferenceConfig,
    } as unknown as M3LBedrockInvokeRequest);

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).toContain('"maxTokens":7');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).not.toContain("99999");
  });

  test("invoke(): toolChoice.tool flipping between two reads never lets the second (non-matching) value reach the wire", async () => {
    const { ops, sent } = newWireOps();
    let reads = 0;
    const toolChoice = {
      get tool(): string {
        reads += 1;
        return reads === 1 ? "toolA" : "toolB_UNVALIDATED";
      },
    };

    const result = await ops.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "toolA", inputSchema: {} }],
      toolChoice,
    } as unknown as M3LBedrockToolInvokeRequest);

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).toContain('"toolA"');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted above
    expect(sent[0]!).not.toContain("toolB_UNVALIDATED");
  });
});

describe("document.ts's chargeElementBudget — a Proxy reporting a huge .length cannot amplify a tiny input into a huge request", () => {
  /** A well-formed message every numeric index of a huge-`.length` Proxy resolves to. */
  const VALID_MESSAGE = { role: "user", content: [] };

  /**
   * A `Proxy` wrapping a real (tiny) array but reporting a huge `.length`,
   * and resolving every numeric-index `get` to {@link VALID_MESSAGE} — so a
   * regression that dropped the per-element budget charge would walk this
   * "array" tens of thousands of times, each iteration producing a
   * plausible element, rather than failing on shape/read at index 3 the way
   * a naive out-of-range Proxy would.
   */
  function hugeLengthMessagesArray(): unknown[] {
    const target: unknown[] = [VALID_MESSAGE];
    return new Proxy(target, {
      get(_target, prop, receiver: unknown): unknown {
        if (prop === "length") return 100_000_000;
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return VALID_MESSAGE;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  test(
    "invoke(): a Proxy over a real array reporting a 100M length rejects quickly with M3LBedrockRuntimeOperationError, never hangs or amplifies the request",
    // Short, explicit timeout: a regression that drops the per-element
    // charge must fail FAST once the shared node ceiling is reintroduced,
    // not walk 100M reported elements.
    { timeout: 2_000 },
    async () => {
      const { ops, sent } = newWireOps();

      const thrown = await captureThrow(() =>
        ops.invoke({
          messages: hugeLengthMessagesArray() as M3LBedrockMessage[],
        }),
      );

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect((thrown as Error).message).toContain("constructed nodes/elements");
      expect(sent).toHaveLength(0);
    },
  );

  test(
    "invokeStream(): a Proxy over a real array reporting a 100M length rejects quickly with M3LBedrockRuntimeOperationError, never hangs or amplifies the request — the streaming path shares the SAME budget invoke() uses",
    { timeout: 2_000 },
    async () => {
      const { ops, sent } = newWireOps();

      const stream = ops.invokeStream({
        messages: hugeLengthMessagesArray() as M3LBedrockMessage[],
      });
      const thrown = await captureThrow(() => stream.next());

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect((thrown as Error).message).toContain("constructed nodes/elements");
      expect(sent).toHaveLength(0);
    },
  );

  /** Builds a flat object with `keyCount` own primitive-valued keys — cheap to construct, `keyCount + 1` budget nodes each (the object itself, plus one per key). */
  function bigFlatSchema(keyCount: number): Record<string, number> {
    const object: Record<string, number> = {};
    for (let index = 0; index < keyCount; index += 1) {
      object[`k${index}`] = index;
    }
    return object;
  }

  test("invoke(): ONE tool whose inputSchema alone is under the shared node ceiling succeeds", async () => {
    const { ops, sent } = newWireOps();

    const result = await ops.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "toolA", inputSchema: bigFlatSchema(3_400) }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
  });

  test("invoke(): the node/element budget is shared across the WHOLE request — three tools, each individually under the ceiling, sum past it and reject", async () => {
    const { ops, sent } = newWireOps();

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [
          { name: "toolA", inputSchema: bigFlatSchema(3_400) },
          { name: "toolB", inputSchema: bigFlatSchema(3_400) },
          { name: "toolC", inputSchema: bigFlatSchema(3_400) },
        ],
      }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });
});

describe("round 5 field-typing regressions — request.system / inferenceConfig / toolChoice never reach the wire when mistyped", () => {
  test("request.system as a non-string (an object with toJSON) throws M3LBedrockRuntimeOperationError, never reaching the wire", async () => {
    const { ops, sent } = newWireOps();
    const sneaky = {
      toJSON(): string {
        return "SNEAKY_SYSTEM_VALUE";
      },
    };

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        system: sneaky,
      } as unknown as M3LBedrockInvokeRequest),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });

  const INFERENCE_CONFIG_CASES: readonly (readonly [
    string,
    Record<string, unknown>,
  ])[] = [
    ["maxTokens non-integer (3.5)", { maxTokens: 3.5 }],
    ["maxTokens <= 0 (0)", { maxTokens: 0 }],
    ["temperature non-finite (NaN)", { temperature: Number.NaN }],
    [
      "temperature non-finite (Infinity)",
      { temperature: Number.POSITIVE_INFINITY },
    ],
    ["topP non-finite (Infinity)", { topP: Number.POSITIVE_INFINITY }],
    ["stopSequences containing a non-string", { stopSequences: ["ok", 123] }],
  ];

  test.each(INFERENCE_CONFIG_CASES)(
    "inferenceConfig with %s throws M3LBedrockRuntimeOperationError, never reaching the wire",
    async (_label, inferenceConfig) => {
      const { ops, sent } = newWireOps();

      const thrown = await captureThrow(() =>
        ops.invoke({
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          inferenceConfig,
        } as unknown as M3LBedrockInvokeRequest),
      );

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect(sent).toHaveLength(0);
    },
  );

  test("toolChoice: null throws M3LBedrockRuntimeOperationError, never reaching the wire", async () => {
    const { ops, sent } = newWireOps();

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "toolA", inputSchema: {} }],
        toolChoice: null,
      } as unknown as M3LBedrockToolInvokeRequest),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });

  test("toolChoice.tool as a non-string throws M3LBedrockRuntimeOperationError, never reaching the wire", async () => {
    const { ops, sent } = newWireOps();

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "toolA", inputSchema: {} }],
        toolChoice: { tool: 123 },
      } as unknown as M3LBedrockToolInvokeRequest),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(sent).toHaveLength(0);
  });

  test("a 200 KB toolChoice.tool never reaches the wire, and both error.message and JSON.stringify(error.toJSON()) are length-capped, never proportional to input size", async () => {
    const { ops, sent } = newWireOps();
    const hugeToolName = "T".repeat(200_000);

    const thrown = await captureThrow(() =>
      ops.invoke({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "toolA", inputSchema: {} }],
        toolChoice: { tool: hugeToolName },
      }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message.length).toBeLessThan(1_000);
    // Bounded, not proportional to the 200,000-character input — `toJSON()`
    // also carries a stack trace, so the cap here is generous relative to
    // `error.message`'s own cap, but still orders of magnitude below what an
    // uncapped rendering of a 200 KB string would produce.
    expect(JSON.stringify(error.toJSON()).length).toBeLessThan(10_000);
    expect(sent).toHaveLength(0);
  });
});

describe("message-safety.ts — sanitizeForMessage's length cap and U+2028/U+2029/U+202E escapes", () => {
  test("an oversized off-contract `type` discriminant is truncated with an ellipsis marker, never left unbounded", async () => {
    const { ops, sent } = newWireOps();
    const hugeType = "T".repeat(500);
    const invalidBlock = {
      type: hugeType,
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [invalidBlock] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message).toContain("…");
    expect(error.message).not.toContain("T".repeat(500));
    expect(sent).toHaveLength(0);
  });

  test("U+2028/U+2029/U+202E in an off-contract `type` discriminant are escaped to \\xNN, never left as raw line/direction-override characters", async () => {
    const { ops, sent } = newWireOps();
    const hostileType = "before\u2028mid\u2029more\u202eend";
    const invalidBlock = {
      type: hostileType,
    } as unknown as M3LBedrockContentBlock;

    const thrown = await captureThrow(() =>
      ops.invoke({ messages: [{ role: "user", content: [invalidBlock] }] }),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message).not.toContain("\u2028");
    expect(error.message).not.toContain("\u2029");
    expect(error.message).not.toContain("\u202e");
    expect(error.message).toContain("\\x2028");
    expect(error.message).toContain("\\x2029");
    expect(error.message).toContain("\\x202e");
    expect(sent).toHaveLength(0);
  });
});
