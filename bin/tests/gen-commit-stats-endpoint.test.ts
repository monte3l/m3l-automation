import { describe, expect, test } from "vitest";
import { CANONICAL_CLAUDE_MODELS } from "../../bin/lib/claude-models.mjs";
import {
  buildEndpointPayloads,
  endpointPayload,
  modelSlug,
} from "../../bin/gen-commit-stats-endpoint.mjs";

const SCHEMA_KEYS = [
  "schemaVersion",
  "label",
  "message",
  "color",
  "labelColor",
  "style",
];

const counts = new Map([
  ["Claude Opus 4.8", 287],
  ["Claude Fable 5", 16],
  ["Claude Sonnet 4.6", 106],
  ["Claude Sonnet 5", 6],
]);

describe("modelSlug", () => {
  test.each([
    ["Claude Fable 5", "claude-fable-5"],
    ["Claude Opus 4.8", "claude-opus-4-8"],
    ["Claude Sonnet 5", "claude-sonnet-5"],
    ["Claude Sonnet 4.6", "claude-sonnet-4-6"],
    ["Claude Haiku 4.5", "claude-haiku-4-5"],
  ])("slugifies %s to %s", (name, slug) => {
    expect(modelSlug(name)).toBe(slug);
  });
});

describe("endpointPayload", () => {
  test("builds a shields.io endpoint payload with the fixed styling keys", () => {
    const payload = endpointPayload(
      "AI co-authored",
      "331 of 515 commits",
      "66D9EF",
    );
    expect(payload).toEqual({
      schemaVersion: 1,
      label: "AI co-authored",
      message: "331 of 515 commits",
      color: "66D9EF",
      labelColor: "272822",
      style: "flat-square",
    });
  });

  test("exposes exactly the six schema keys, no more, no less", () => {
    const payload = endpointPayload("label", "message", "color");
    expect(Object.keys(payload)).toEqual(SCHEMA_KEYS);
  });
});

describe("buildEndpointPayloads", () => {
  test("aggregate.json numerator is the sum of the per-model counts", () => {
    const payloads = buildEndpointPayloads(counts, 515);
    const aggregate = payloads.get("aggregate.json");
    expect(aggregate).toMatchObject({
      schemaVersion: 1,
      label: "AI co-authored",
      message: "415 of 515 commits",
      color: "66D9EF",
    });
  });

  test("builds a per-model payload with the model's own commit count", () => {
    const payloads = buildEndpointPayloads(counts, 515);
    const opus = payloads.get("claude-opus-4-8.json");
    expect(opus).toEqual({
      schemaVersion: 1,
      label: "Claude Opus 4.8",
      message: "287 commits",
      color: "A6E22E",
      labelColor: "272822",
      style: "flat-square",
    });
  });

  test("emits aggregate.json first, then one entry per canonical model in order", () => {
    const payloads = buildEndpointPayloads(counts, 515);
    expect([...payloads.keys()]).toEqual([
      "aggregate.json",
      "claude-fable-5.json",
      "claude-opus-4-8.json",
      "claude-sonnet-5.json",
      "claude-sonnet-4-6.json",
      "claude-haiku-4-5.json",
    ]);
  });

  test("emits every canonical model, one payload per CANONICAL_CLAUDE_MODELS entry", () => {
    const payloads = buildEndpointPayloads(counts, 515);
    // aggregate.json plus one per canonical model, regardless of which models
    // appear in `counts`.
    expect(payloads.size).toBe(CANONICAL_CLAUDE_MODELS.length + 1);
  });

  // Deliberately diverges from the retired static README badge row, which
  // omitted zero-count models: shields.io endpoint files are addressed
  // individually by filename, so a model with zero commits still needs a
  // "0 commits" file or its badge 404s.
  test("keeps a zero-count entry for every model absent from counts", () => {
    const payloads = buildEndpointPayloads(
      new Map([["Claude Fable 5", 2]]),
      10,
    );
    expect(payloads.get("claude-fable-5.json")).toMatchObject({
      message: "2 commits",
    });
    expect(payloads.get("claude-opus-4-8.json")).toMatchObject({
      message: "0 commits",
    });
    expect(payloads.get("claude-sonnet-5.json")).toMatchObject({
      message: "0 commits",
    });
    expect(payloads.get("claude-sonnet-4-6.json")).toMatchObject({
      message: "0 commits",
    });
    expect(payloads.get("claude-haiku-4-5.json")).toMatchObject({
      message: "0 commits",
    });
  });

  test("schema-key exactness holds for both aggregate and per-model payloads", () => {
    const payloads = buildEndpointPayloads(counts, 515);
    const aggregate = payloads.get("aggregate.json");
    const opus = payloads.get("claude-opus-4-8.json");
    expect(aggregate).toBeDefined();
    expect(opus).toBeDefined();
    expect(Object.keys(aggregate ?? {})).toEqual(SCHEMA_KEYS);
    expect(Object.keys(opus ?? {})).toEqual(SCHEMA_KEYS);
  });

  test("empty counts produces zero-commit messages for the aggregate and every model", () => {
    const payloads = buildEndpointPayloads(new Map(), 10);
    expect(payloads.get("aggregate.json")).toMatchObject({
      message: "0 of 10 commits",
    });
    for (const model of CANONICAL_CLAUDE_MODELS) {
      expect(payloads.get(`${modelSlug(model)}.json`)).toMatchObject({
        message: "0 commits",
      });
    }
  });
});
