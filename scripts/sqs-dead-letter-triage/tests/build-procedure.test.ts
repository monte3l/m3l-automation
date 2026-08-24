import { describe, expect, it, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { buildTriageProcedure } from "../src/steps/build-procedure.js";
import { createTriageRunState, readPath } from "../src/steps/preset.js";
import type {
  TriageArm,
  TriageCase,
  TriageConclusion,
  TriageDeps,
  TriageEntityLookup,
  TriageKeyRule,
  TriageLookupTier,
  TriageMessage,
  TriageOnMissing,
  TriagePreset,
  TriageShape,
  TriageStateMap,
  TriageVerdict,
} from "../src/steps/preset.js";

// ---------------------------------------------------------------------------
// Fixture factories — mirrors load-runbook.test.ts's style: each factory
// returns a fully-populated value a test then overrides just the field(s)
// it cares about. These build TypeScript objects directly (bypassing the
// loader/trust-boundary), since buildTriageProcedure consumes an already
// validated TriagePreset.
// ---------------------------------------------------------------------------

function baseKey(overrides: Partial<TriageKeyRule> = {}): TriageKeyRule {
  return {
    path: "orderId",
    stripPrefix: undefined,
    addSuffix: undefined,
    capture: undefined,
    ...overrides,
  };
}

function baseLookupTier(
  overrides: Partial<TriageLookupTier> = {},
): TriageLookupTier {
  return {
    label: "primary",
    table: "orders",
    keyField: "orderId",
    ...overrides,
  };
}

function baseState(overrides: Partial<TriageStateMap> = {}): TriageStateMap {
  return {
    fromState: "status",
    nextState: "status",
    progression: undefined,
    ...overrides,
  };
}

function baseCase(
  overrides: Partial<TriageCase> &
    Pick<TriageCase, "id" | "priority" | "verdict">,
): TriageCase {
  return {
    description: `case ${overrides.id}`,
    prose: `prose for ${overrides.id}`,
    fromState: undefined,
    nextState: undefined,
    eventType: undefined,
    signature: undefined,
    requiredProgression: undefined,
    ticket: undefined,
    resolution: undefined,
    escalateTo: undefined,
    followUps: [],
    ...overrides,
  };
}

function baseArm(overrides: Partial<TriageArm> = {}): TriageArm {
  return {
    match: "order.created",
    label: "order-created-arm",
    key: baseKey(),
    lookup: [baseLookupTier()],
    onMissing: "hold",
    state: baseState(),
    cases: [],
    ...overrides,
  };
}

function basePreset(overrides: Partial<TriagePreset> = {}): TriagePreset {
  return {
    queue: "orders-dlq",
    title: "Orders DLQ triage",
    handling: "runbook",
    prohibitions: [],
    fifo: false,
    orderBy: undefined,
    sourceQueue: undefined,
    // `groupIdPath` is required-but-nullable (same shape as `orderBy` /
    // `sourceQueue`) — `exactOptionalPropertyTypes` needs it stated
    // explicitly even when the fixture is non-FIFO.
    groupIdPath: undefined,
    envelope: { bodyIsJson: true, payloadPath: undefined },
    routeOn: "eventType",
    arms: [baseArm()],
    escalateTo: "orders-team",
    followUps: [],
    todos: [],
    ...overrides,
  };
}

/** Builds a message; a string `body` is used verbatim, else JSON-stringified. */
function message(
  body: unknown,
  overrides: Partial<TriageMessage> = {},
): TriageMessage {
  return {
    messageId: "msg-1",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...overrides,
  };
}

/** A default JSON payload matching `basePreset()`'s single default arm. */
function standardPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventType: "order.created",
    orderId: "ord-1",
    status: "paid",
    ...overrides,
  };
}

interface LookupCall {
  readonly tier: TriageLookupTier;
  readonly key: string;
}

interface FakeLookup extends TriageEntityLookup {
  readonly calls: LookupCall[];
}

/**
 * Builds a lookup double. Responses are consumed in call order; an
 * exhausted queue resolves `undefined`, matching a genuine miss.
 */
function fakeLookup(
  ...queued: readonly (Readonly<Record<string, unknown>> | undefined)[]
): FakeLookup {
  const responses = [...queued];
  const calls: LookupCall[] = [];
  return {
    calls,
    get(tier, key, _signal) {
      calls.push({ tier, key });
      return Promise.resolve(responses.shift());
    },
  };
}

/**
 * Runs one message through a preset's built procedure with no AWS and no
 * filesystem — the whole graph is driven purely through `lookup`.
 */
function runTriage(
  preset: TriagePreset,
  triageMessage: TriageMessage,
  lookup: TriageEntityLookup,
): Promise<Core.M3LProcedureOutcome<TriageShape>> {
  const state = createTriageRunState();
  const deps: TriageDeps = { preset, message: triageMessage, lookup, state };
  return buildTriageProcedure(preset).run({
    deps,
    parameters: { queue: preset.queue, messageId: triageMessage.messageId },
  });
}

/** Narrows an outcome's conclusion, failing the test when the arm has none. */
function conclusionOf(
  outcome: Core.M3LProcedureOutcome<TriageShape>,
): TriageConclusion {
  if (outcome.status !== "matched" && outcome.status !== "unrecognized") {
    throw new Error(`expected a concluded outcome, got '${outcome.status}'`);
  }
  return outcome.conclusion;
}

// ---------------------------------------------------------------------------
// A. Happy path
// ---------------------------------------------------------------------------

describe("the happy path", () => {
  it("resolves a matching case's verdict, caseId and escalateTo, with no prohibition", async () => {
    const preset = basePreset({
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "confirm-paid",
              priority: 100,
              fromState: "created",
              nextState: "paid",
              verdict: "known-no-action",
              escalateTo: "payments-team",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "Created" }),
    );

    expect(outcome.status).toBe("matched");
    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("known-no-action");
    expect(conclusion.caseId).toBe("confirm-paid");
    expect(conclusion.escalateTo).toBe("payments-team");
    expect(conclusion.prohibited).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B. Every codified terminal case, one test each
// ---------------------------------------------------------------------------

describe("codified terminal case: not-runbook-managed", () => {
  it("resolves when the preset's handling is not 'runbook', without also matching unparseable", async () => {
    const preset = basePreset({ handling: "redrive" });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup(),
    );

    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("not-runbook-managed");
    expect(conclusion.caseId).toBe("not-runbook-managed");
    if (outcome.status === "matched") {
      expect(outcome.alsoMatched.map((match) => match.caseId)).not.toContain(
        "unparseable",
      );
    }
  });
});

describe("codified terminal case: unparseable", () => {
  it("resolves for a non-JSON body, and never carries a fragment of the body", async () => {
    const preset = basePreset();
    const marker = "NOT-VALID-JSON-BODY-MARKER";
    const outcome = await runTriage(
      preset,
      message(`${marker}-{{{`),
      fakeLookup(),
    );

    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("unparseable");
    expect(conclusion.caseId).toBe("unparseable");
    expect(JSON.stringify(conclusion)).not.toContain(marker);
  });
});

describe("codified terminal case: unrouted", () => {
  it("resolves when the discriminator matches no arm and there is no default arm", async () => {
    const preset = basePreset({
      arms: [baseArm({ match: "order.created" })],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload({ eventType: "order.cancelled" })),
      fakeLookup(),
    );

    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("unrouted");
    expect(conclusion.caseId).toBe("unrouted");
  });
});

describe("codified terminal case: no-key", () => {
  it("resolves when the key path is absent from the payload", async () => {
    const preset = basePreset({
      arms: [baseArm({ key: baseKey({ path: "orderId" }) })],
    });
    const outcome = await runTriage(
      preset,
      message({ eventType: "order.created" }),
      fakeLookup(),
    );

    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("no-key");
    expect(conclusion.caseId).toBe("no-key");
  });

  it("resolves when the extracted key fails the safe-value allow-list, without echoing it", async () => {
    const preset = basePreset({
      arms: [baseArm({ key: baseKey({ path: "orderId" }) })],
    });
    const rejectedKey = "bad key!";
    const outcome = await runTriage(
      preset,
      message(standardPayload({ orderId: rejectedKey })),
      fakeLookup(),
    );

    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("no-key");
    expect(conclusion.caseId).toBe("no-key");
    expect(JSON.stringify(conclusion)).not.toContain(rejectedKey);
    if (outcome.status === "matched" || outcome.status === "unrecognized") {
      const notes = outcome.telemetry.steps
        .map((step) => step.note ?? "")
        .join(" ");
      expect(notes).not.toContain(rejectedKey);
    }
  });
});

describe("codified terminal case: entity-not-found", () => {
  test.each<[TriageOnMissing, TriageVerdict]>([
    ["entity-not-found", "entity-not-found"],
    ["escalate", "escalate"],
    ["hold", "hold"],
  ])(
    "honours onMissing '%s' (verdict '%s') while the case id stays 'entity-not-found'",
    async (onMissing, expectedVerdict) => {
      const preset = basePreset({
        arms: [baseArm({ onMissing, lookup: [baseLookupTier()] })],
      });
      const outcome = await runTriage(
        preset,
        message(standardPayload()),
        fakeLookup(undefined),
      );

      const conclusion = conclusionOf(outcome);
      expect(conclusion.verdict).toBe(expectedVerdict);
      expect(conclusion.caseId).toBe("entity-not-found");
    },
  );
});

// ---------------------------------------------------------------------------
// C. The unrecognised fallback
// ---------------------------------------------------------------------------

describe("the unrecognised fallback", () => {
  it("resolves when an entity is found and state derived, but no case's predicates hold", async () => {
    const preset = basePreset({
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "only-case",
              priority: 100,
              fromState: "shipped",
              verdict: "hold",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "created" }),
    );

    expect(outcome.status).toBe("unrecognized");
    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("unrecognised");
    expect(conclusion.caseId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D. The widen-lookup back edge
// ---------------------------------------------------------------------------

describe("the widen-lookup back edge", () => {
  const tier1 = baseLookupTier({ label: "primary" });
  const tier2 = baseLookupTier({ label: "archive", table: "orders-archive" });
  const tier3 = baseLookupTier({ label: "cold-storage", table: "orders-cold" });

  function widenPreset(lookup: readonly TriageLookupTier[]): TriagePreset {
    return basePreset({
      arms: [
        baseArm({
          lookup,
          // Explicit rather than relying on baseArm()'s default: the
          // exhaustion test below reaches the entity-not-found terminal
          // case, whose verdict depends on onMissing — naming it here keeps
          // that test from passing or failing by accident on the default.
          onMissing: "entity-not-found",
          cases: [
            baseCase({
              id: "found-eventually",
              priority: 100,
              fromState: "created",
              verdict: "hold",
            }),
          ],
        }),
      ],
    });
  }

  it("misses tier 1 and hits tier 2, calling the lookup twice in tier order", async () => {
    const lookup = fakeLookup(undefined, { status: "created" });
    const outcome = await runTriage(
      widenPreset([tier1, tier2]),
      message(standardPayload()),
      lookup,
    );

    expect(lookup.calls).toHaveLength(2);
    expect(lookup.calls[0]?.tier.label).toBe("primary");
    expect(lookup.calls[1]?.tier.label).toBe("archive");
    expect(conclusionOf(outcome).caseId).toBe("found-eventually");
  });

  it("walks three tiers, hitting on the third", async () => {
    const lookup = fakeLookup(undefined, undefined, { status: "created" });
    const outcome = await runTriage(
      widenPreset([tier1, tier2, tier3]),
      message(standardPayload()),
      lookup,
    );

    expect(lookup.calls).toHaveLength(3);
    expect(lookup.calls[2]?.tier.label).toBe("cold-storage");
    expect(conclusionOf(outcome).caseId).toBe("found-eventually");
  });

  it("stops once every tier is exhausted, rather than looping forever", async () => {
    const lookup = fakeLookup(undefined, undefined);
    const outcome = await runTriage(
      widenPreset([tier1, tier2]),
      message(standardPayload()),
      lookup,
    );

    expect(lookup.calls).toHaveLength(2);
    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("entity-not-found");
    expect(conclusion.caseId).toBe("entity-not-found");
  });

  it("actually revisits check-entity-present, not just resolving the final verdict", async () => {
    const lookup = fakeLookup(undefined, { status: "created" });
    const outcome = await runTriage(
      widenPreset([tier1, tier2]),
      message(standardPayload()),
      lookup,
    );

    const widenExecutions = outcome.telemetry.steps.filter(
      (step) => step.id === "widen-lookup",
    );
    const checkExecutions = outcome.telemetry.steps.filter(
      (step) => step.id === "check-entity-present",
    );
    // A test that only checked the final verdict would pass even if the
    // back edge never fired — this asserts the loop actually ran twice.
    expect(widenExecutions).toHaveLength(2);
    expect(checkExecutions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// E. Arm isolation
// ---------------------------------------------------------------------------

describe("arm isolation", () => {
  it("does not let a non-selected arm's case win, even when its predicates would otherwise match", async () => {
    const armA = baseArm({
      match: "order.created",
      label: "arm-a",
      cases: [
        baseCase({
          id: "case-a-wins",
          priority: 200,
          fromState: "created",
          nextState: "paid",
          verdict: "known-no-action",
        }),
      ],
    });
    const armB = baseArm({
      match: "order.cancelled",
      label: "arm-b",
      cases: [
        baseCase({
          id: "case-b-must-not-win",
          // Deliberately higher priority than arm A's case, and predicates
          // that WOULD match the message's derived state — the only thing
          // that should stop it winning is the armLabel guard.
          priority: 999,
          fromState: "created",
          nextState: "paid",
          verdict: "escalate",
        }),
      ],
    });
    const preset = basePreset({ arms: [armA, armB] });

    // Routed to arm A: eventType "order.created".
    const outcome = await runTriage(
      preset,
      message(standardPayload({ eventType: "order.created" })),
      fakeLookup({ status: "created" }),
    );

    expect(outcome.status).toBe("matched");
    if (outcome.status !== "matched") throw new Error("expected a match");
    expect(outcome.primary.caseId).toBe("case-a-wins");
    expect(outcome.alsoMatched.map((match) => match.caseId)).not.toContain(
      "case-b-must-not-win",
    );
    expect(outcome.conclusion.verdict).toBe("known-no-action");
  });
});

// ---------------------------------------------------------------------------
// F. Predicate combinations
// ---------------------------------------------------------------------------

describe("predicate combinations", () => {
  it("matches a row declaring only eventType", async () => {
    const preset = basePreset({
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "event-only",
              priority: 100,
              eventType: "order.created",
              verdict: "hold",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "whatever" }),
    );
    expect(conclusionOf(outcome).caseId).toBe("event-only");
  });

  it("matches a row declaring only signature, against the raw message body", async () => {
    const marker = "SIGNATURE-MARK-42";
    const preset = basePreset({
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "signature-only",
              priority: 100,
              signature: marker,
              verdict: "hold",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload({ note: marker })),
      fakeLookup({ status: "whatever" }),
    );
    expect(conclusionOf(outcome).caseId).toBe("signature-only");
  });

  describe("fromState + nextState + requiredProgression, all three required", () => {
    function progressionPreset(): TriagePreset {
      return basePreset({
        arms: [
          baseArm({
            state: baseState({
              fromState: "status",
              nextState: "status",
              progression: "progression",
            }),
            cases: [
              baseCase({
                id: "progression-case",
                priority: 100,
                fromState: "created",
                nextState: "paid",
                requiredProgression: ["paid"],
                verdict: "hold",
              }),
            ],
          }),
        ],
      });
    }

    it("matches when all three predicates hold", async () => {
      const outcome = await runTriage(
        progressionPreset(),
        message(standardPayload({ status: "paid" })),
        fakeLookup({ status: "created", progression: ["created", "paid"] }),
      );
      expect(outcome.status).toBe("matched");
      expect(conclusionOf(outcome).caseId).toBe("progression-case");
    });

    it("stops matching when fromState is flipped", async () => {
      const outcome = await runTriage(
        progressionPreset(),
        message(standardPayload({ status: "paid" })),
        fakeLookup({ status: "shipped", progression: ["created", "paid"] }),
      );
      expect(outcome.status).toBe("unrecognized");
    });

    it("stops matching when nextState is flipped", async () => {
      const outcome = await runTriage(
        progressionPreset(),
        message(standardPayload({ status: "unpaid" })),
        fakeLookup({ status: "created", progression: ["created", "paid"] }),
      );
      expect(outcome.status).toBe("unrecognized");
    });

    it("stops matching when requiredProgression is flipped", async () => {
      const outcome = await runTriage(
        progressionPreset(),
        message(standardPayload({ status: "paid" })),
        fakeLookup({ status: "created", progression: ["shipped"] }),
      );
      expect(outcome.status).toBe("unrecognized");
    });
  });

  it("lets the higher-priority narrow row win over a broader row declared first", async () => {
    const preset = basePreset({
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "broad",
              priority: 100,
              eventType: "order.created",
              verdict: "hold",
            }),
            baseCase({
              id: "narrow",
              priority: 500,
              eventType: "order.created",
              fromState: "created",
              nextState: "paid",
              verdict: "escalate",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "created" }),
    );
    expect(outcome.status).toBe("matched");
    if (outcome.status !== "matched") throw new Error("expected a match");
    expect(outcome.primary.caseId).toBe("narrow");
    expect(outcome.alsoMatched.map((match) => match.caseId)).toContain("broad");
    expect(outcome.conclusion.verdict).toBe("escalate");
  });

  it("does not let a ',paid,' probe collide with an 'unpaid' progression entry", async () => {
    const preset = basePreset({
      arms: [
        baseArm({
          state: baseState({ progression: "progression" }),
          cases: [
            baseCase({
              id: "requires-paid",
              priority: 100,
              requiredProgression: ["paid"],
              verdict: "hold",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "created", progression: ["unpaid", "processing"] }),
    );
    expect(outcome.status).toBe("unrecognized");
  });
});

// ---------------------------------------------------------------------------
// G. Prohibition downgrade
// ---------------------------------------------------------------------------

describe("the prohibition downgrade", () => {
  it("downgrades 'remove' to 'hold' under a prohibition mentioning delete", async () => {
    const preset = basePreset({
      prohibitions: ["do-not-delete-without-ticket"],
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "remove-case",
              priority: 100,
              eventType: "order.created",
              verdict: "remove",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "created" }),
    );
    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("hold");
    expect(conclusion.prohibited).toBe("do-not-delete-without-ticket");
    expect(
      conclusion.followUps.some((entry) =>
        entry.toLowerCase().includes("remove"),
      ),
    ).toBe(true);
  });

  it("downgrades 'reinsert' to 'hold' under a prohibition mentioning redrive", async () => {
    const preset = basePreset({
      prohibitions: ["no-auto-redrive"],
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "reinsert-case",
              priority: 100,
              eventType: "order.created",
              verdict: "reinsert",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "created" }),
    );
    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("hold");
    expect(conclusion.prohibited).toBe("no-auto-redrive");
    expect(
      conclusion.followUps.some((entry) =>
        entry.toLowerCase().includes("reinsert"),
      ),
    ).toBe(true);
  });

  it("blocks nothing when the prohibition text matches neither wording (fail-safe direction)", async () => {
    const preset = basePreset({
      prohibitions: ["needs-manager-approval"],
      arms: [
        baseArm({
          cases: [
            baseCase({
              id: "remove-case",
              priority: 100,
              eventType: "order.created",
              verdict: "remove",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "created" }),
    );
    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("remove");
    expect(conclusion.prohibited).toBeUndefined();
  });

  test.each<TriageVerdict>(["hold", "escalate", "known-no-action"])(
    "leaves a '%s' verdict unaffected by a prohibition, even one mentioning delete and redrive",
    async (verdict) => {
      const preset = basePreset({
        prohibitions: ["always-delete-and-redrive-forbidden"],
        arms: [
          baseArm({
            cases: [
              baseCase({
                id: "unaffected-case",
                priority: 100,
                eventType: "order.created",
                verdict,
              }),
            ],
          }),
        ],
      });
      const outcome = await runTriage(
        preset,
        message(standardPayload()),
        fakeLookup({ status: "created" }),
      );
      const conclusion = conclusionOf(outcome);
      expect(conclusion.verdict).toBe(verdict);
      expect(conclusion.prohibited).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// H. readPath hardening
// ---------------------------------------------------------------------------

describe("readPath", () => {
  it("returns undefined for a missing path without throwing", () => {
    expect(readPath({ a: { b: 1 } }, "a.c.d")).toBeUndefined();
    expect(readPath({}, "missing")).toBeUndefined();
  });

  it("does not resolve an inherited value through a __proto__ segment", () => {
    // Object.hasOwn({ b: 1 }, "__proto__") is false for an ordinary object,
    // so the walk must stop there rather than falling through to
    // Object.prototype and reading .constructor off it.
    expect(
      readPath({ a: { b: 1 } }, "a.__proto__.constructor"),
    ).toBeUndefined();
  });

  it("refuses to index an array by a numeric segment", () => {
    expect(readPath({ a: [1, 2, 3] }, "a.0")).toBeUndefined();
  });

  it("does not fall through to a polluted Object.prototype property", () => {
    const key = "triageLeakProbe";
    // Deliberately mutating the shared prototype to prove readPath does not
    // consult it; restored unconditionally in `finally` below. Cast to a
    // `Record<string, unknown>` rather than `any` so the mutation itself
    // stays type-checked.
    const prototypeRecord = Object.prototype as unknown as Record<
      string,
      unknown
    >;
    prototypeRecord[key] = "leaked";
    try {
      expect(readPath({}, key)).toBeUndefined();
    } finally {
      Reflect.deleteProperty(prototypeRecord, key);
    }
    // Confirm the mutation left no trace, so the rest of the suite is safe.
    expect(Object.hasOwn(Object.prototype, key)).toBe(false);
    expect(readPath({}, key)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// I. describe() and digest
// ---------------------------------------------------------------------------

describe("describe() and the definition digest", () => {
  it("declares the nine steps in declaration order", () => {
    expect(
      buildTriageProcedure(basePreset())
        .describe()
        .steps.map((step: { id: string }) => step.id),
    ).toEqual([
      "resolve-mode",
      "parse-envelope",
      "route-event",
      "extract-key",
      "widen-lookup",
      "lookup-entity",
      "check-entity-present",
      "derive-state",
      "match-known-cases",
    ]);
  });

  it("produces an identical digest for two builds of the same preset", () => {
    expect(buildTriageProcedure(basePreset()).digest).toBe(
      buildTriageProcedure(basePreset()).digest,
    );
  });

  it("produces a different digest for a preset differing by one field", () => {
    const first = buildTriageProcedure(basePreset());
    const second = buildTriageProcedure(basePreset({ queue: "payments-dlq" }));
    expect(first.digest).not.toBe(second.digest);
  });
});

// ---------------------------------------------------------------------------
// J. Regression coverage for the 2026-08-23 review findings.
// ---------------------------------------------------------------------------

describe("arm.label uniqueness — why the loader's guard matters (finding 1)", () => {
  // `buildTriageProcedure` compiles an already-validated `TriagePreset`; the
  // label-uniqueness check itself lives entirely at the load-runbook.ts trust
  // boundary (see load-runbook.test.ts), which is the ONLY place such a
  // preset can be rejected — the engine has no independent guard of its own.
  // This test bypasses the loader (as every fixture in this file does) to
  // characterise exactly why that boundary check exists: two arms sharing a
  // label share the SAME armGuard identity in cases.ts, so a message routed
  // to one arm can still match the other arm's case row.
  it("[characterizes the pre-loader-guard hazard] lets a non-selected arm's row win when two arms illegally share a label", async () => {
    const armA = baseArm({
      match: "order.created",
      label: "shared-label",
      state: baseState({ fromState: "status" }),
      cases: [
        baseCase({
          id: "case-a-from-arm-a",
          priority: 200,
          fromState: "created",
          verdict: "escalate",
        }),
      ],
    });
    const armB = baseArm({
      match: "order.shipped",
      label: "shared-label",
      state: baseState({ fromState: "status" }),
      cases: [
        baseCase({
          id: "case-b-from-arm-b",
          priority: 100,
          fromState: "created",
          verdict: "hold",
        }),
      ],
    });
    const preset = basePreset({ arms: [armA, armB] });

    // Routed to arm B ("order.shipped"), never to arm A.
    const outcome = await runTriage(
      preset,
      message(standardPayload({ eventType: "order.shipped" })),
      fakeLookup({ status: "created" }),
    );

    expect(outcome.status).toBe("matched");
    if (outcome.status !== "matched") throw new Error("expected a match");
    // Arm A's higher-priority row wins even though the message was routed to
    // arm B — the cross-arm leak the label-uniqueness guard exists to
    // prevent. This is exactly why load-runbook.ts must never let two arms
    // share a label; it is not a property this engine layer can enforce.
    expect(outcome.primary.caseId).toBe("case-a-from-arm-a");
  });
});

describe("state predicate matching survives a mistyped arm state path (finding 2)", () => {
  // The motivating scenario for rejecting an empty-string case predicate at
  // load: derive-state normalises a missing/mistyped fromState path to "".
  // A row declaring a concrete (non-empty) fromState must never coincide
  // with that "" sentinel — it must simply fail to match, falling through
  // to the unrecognised fallback rather than resolving any row's verdict.
  it("does not let a concrete fromState row match when the arm's own fromState path resolves to nothing, falling through to unrecognised", async () => {
    const preset = basePreset({
      arms: [
        baseArm({
          // Mistyped/absent path: the entity never has "statusTypo", so
          // derive-state's fromState always normalises to "".
          state: baseState({ fromState: "statusTypo" }),
          cases: [
            baseCase({
              id: "only-case",
              priority: 100,
              fromState: "shipped",
              verdict: "hold",
            }),
          ],
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload()),
      fakeLookup({ status: "shipped" }),
    );

    expect(outcome.status).toBe("unrecognized");
    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("unrecognised");
    expect(conclusion.caseId).toBeUndefined();
  });
});

describe("no caller data in step notes (finding 3)", () => {
  it("does not leak the message's discriminator into the 'unrouted' step's note or conclusion", async () => {
    const sentinel = "SENSITIVE-VALUE-1234";
    // basePreset()'s single arm has an explicit 'match', so there is no
    // default arm — the sentinel discriminator matches nothing and routing
    // stops.
    const preset = basePreset();
    const outcome = await runTriage(
      preset,
      message(standardPayload({ eventType: sentinel })),
      fakeLookup(),
    );

    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("unrouted");

    // Walk the whole outcome: every step's note, the conclusion, and (were
    // this run to fail) its error — never just the conclusion alone, since
    // the leak this finding fixed lived in a step's `note`, not the
    // conclusion.
    const notes = outcome.telemetry.steps
      .map((step) => step.note ?? "")
      .join(" ");
    expect(notes).not.toContain(sentinel);
    expect(JSON.stringify(conclusion)).not.toContain(sentinel);
    if (outcome.status === "failed" || outcome.status === "aborted") {
      expect(JSON.stringify(outcome.error)).not.toContain(sentinel);
    }
  });
});

describe("extract-key bounds the key length before running the capture regex (finding 4)", () => {
  it("stops with a note naming the match-input limit, rather than running the capture regex against an oversized key", async () => {
    const oversizedKey = "x".repeat(
      Core.M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH + 1,
    );
    const preset = basePreset({
      arms: [
        baseArm({
          key: baseKey({ path: "orderId", capture: "^(x+)$" }),
        }),
      ],
    });
    const outcome = await runTriage(
      preset,
      message(standardPayload({ orderId: oversizedKey })),
      fakeLookup(),
    );

    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("no-key");
    const notes = outcome.telemetry.steps
      .map((step) => step.note ?? "")
      .join(" ");
    expect(notes).toContain(String(Core.M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH));
    expect(notes).not.toContain(oversizedKey);
  });
});
