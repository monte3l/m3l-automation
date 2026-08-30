/**
 * Tests for aws/bedrock-runtime's conversation-state helpers (V5 Slice B).
 *
 * Contract source: `<scratchpad>/slice-b/contract.md` §2.1 (Mode 1 contract,
 * re-derived against live Slice A code + ADR-0059), authoritative over
 * `docs/plans/2026-08-29-v5-tool-use-loop-primitives.md` § "Slice B" where
 * they differ.
 *
 * Deliberately imports ONLY the conversation-state symbols
 * (`M3LBedrockConversation`, `createBedrockConversation`,
 * `appendBedrockMessage`, `appendBedrockUserText`) plus the pre-existing
 * `M3LBedrockMessage` base type, so `perFile` v8 coverage binds within this
 * slice (`vitest.config.ts:73`) and this file stays independent of
 * `tests/bedrock-runtime-loop.test.ts`.
 *
 * This is the TDD RED seam: none of `M3LBedrockConversation`,
 * `createBedrockConversation`, `appendBedrockMessage`, or
 * `appendBedrockUserText` exist in `src/` yet — every test here is expected
 * to fail on import/typecheck, not on an assertion inside a running test.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  appendBedrockMessage,
  appendBedrockUserText,
  createBedrockConversation,
} from "../src/aws/index.js";
import type {
  M3LBedrockConversation,
  M3LBedrockMessage,
} from "../src/aws/index.js";

const USER_HI: M3LBedrockMessage = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

const ASSISTANT_HELLO: M3LBedrockMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
};

describe("M3LBedrockConversation — type shape", () => {
  test("readonly messages array plus an optional system prompt, nothing else", () => {
    expectTypeOf<M3LBedrockConversation>().toEqualTypeOf<{
      readonly messages: readonly M3LBedrockMessage[];
      readonly system?: string;
    }>();
  });
});

describe("createBedrockConversation", () => {
  test("with no options, returns empty messages and OMITS the system key (not undefined)", () => {
    const conversation = createBedrockConversation();
    expect(conversation.messages).toEqual([]);
    expect(Object.hasOwn(conversation, "system")).toBe(false);
  });

  test("carries a supplied system prompt verbatim", () => {
    const conversation = createBedrockConversation({ system: "be terse" });
    expect(conversation.system).toBe("be terse");
  });

  test("carries supplied messages verbatim, in order", () => {
    const conversation = createBedrockConversation({
      messages: [USER_HI, ASSISTANT_HELLO],
    });
    expect(conversation.messages).toEqual([USER_HI, ASSISTANT_HELLO]);
  });

  test("copies the caller's messages array rather than aliasing it (immutability)", () => {
    const messages: M3LBedrockMessage[] = [USER_HI];
    const conversation = createBedrockConversation({ messages });
    messages.push(ASSISTANT_HELLO);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages).toEqual([USER_HI]);
  });

  test("returns a fresh messages array reference on every call, even with identical options", () => {
    const first = createBedrockConversation();
    const second = createBedrockConversation();
    expect(first.messages).not.toBe(second.messages);
  });
});

describe("appendBedrockMessage", () => {
  test("returns a NEW conversation value and does not mutate the input (immutability)", () => {
    const original = createBedrockConversation({ messages: [USER_HI] });
    const updated = appendBedrockMessage(original, ASSISTANT_HELLO);

    expect(updated).not.toBe(original);
    expect(updated.messages).not.toBe(original.messages);
    expect(original.messages).toEqual([USER_HI]);
    expect(updated.messages).toEqual([USER_HI, ASSISTANT_HELLO]);
  });

  test("appends after every existing message, preserving prior order", () => {
    const original = createBedrockConversation({
      messages: [USER_HI, ASSISTANT_HELLO],
    });
    const third: M3LBedrockMessage = {
      role: "user",
      content: [{ type: "text", text: "third" }],
    };

    const updated = appendBedrockMessage(original, third);

    expect(updated.messages).toEqual([USER_HI, ASSISTANT_HELLO, third]);
  });

  test("preserves the conversation's system prompt across the append", () => {
    const original = createBedrockConversation({ system: "stay terse" });
    const updated = appendBedrockMessage(original, USER_HI);
    expect(updated.system).toBe("stay terse");
  });

  test("on a conversation with no system prompt, the append still OMITS the system key", () => {
    const original = createBedrockConversation();
    const updated = appendBedrockMessage(original, USER_HI);
    expect(Object.hasOwn(updated, "system")).toBe(false);
  });
});

describe("appendBedrockUserText", () => {
  test("appends a user message with a single text block carrying the given text", () => {
    const original = createBedrockConversation();
    const updated = appendBedrockUserText(original, "hello there");

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello there" }],
    });
  });

  test("does not mutate the input conversation (immutability)", () => {
    const original = createBedrockConversation();
    const updated = appendBedrockUserText(original, "hi");

    expect(original.messages).toHaveLength(0);
    expect(updated).not.toBe(original);
  });

  test("appends after every existing message, preserving prior order", () => {
    const original = createBedrockConversation({ messages: [USER_HI] });
    const updated = appendBedrockUserText(original, "second");

    expect(updated.messages).toEqual([
      USER_HI,
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
  });
});
