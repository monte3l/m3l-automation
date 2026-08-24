import { describe, expect, it, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { parseTriagePreset } from "../src/steps/load-runbook.js";
import {
  AUTHORABLE_VERDICTS,
  HANDLING_MODES,
  MAX_PATTERN_LENGTH,
  RESERVED_PRIORITY_CEILING,
  normaliseProgression,
} from "../src/steps/preset.js";

// Mirrors the value load-runbook.ts is specified to use for every thrown
// M3LError (see dlq-preset-spec.md § "Error code"). Kept as a local literal
// rather than importing an export whose presence the spec does not confirm.
const PRESET_CODE = "ERR_DLQ_TRIAGE_PRESET";

const paths = new Core.M3LPaths();
const reader = new Core.M3LInputFileReader({ paths, code: PRESET_CODE });

/** Narrows `value`, failing the test with a clear message when absent. */
function definite<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * Parses `record`, returning the thrown `M3LError` so a test can inspect
 * both its `message` and its `cause`.
 */
function rejectionErrorOf(
  record: Readonly<Record<string, unknown>>,
): Core.M3LError {
  try {
    parseTriagePreset(reader, record, "example.json");
  } catch (error) {
    expect(error).toBeInstanceOf(Core.M3LError);
    expect((error as Core.M3LError).code).toBe(PRESET_CODE);
    return error as Core.M3LError;
  }
  throw new Error("expected parseTriagePreset to reject the record");
}

/** Parses `record`, returning the thrown `M3LError`'s message. */
function rejectionOf(record: Readonly<Record<string, unknown>>): string {
  return rejectionErrorOf(record).message;
}

// --- Fixture factories -----------------------------------------------------
// Each negative test below starts from `validPreset()` (a preset that parses
// cleanly) and overrides exactly the field(s) needed to trip one numbered
// validation, so a failing assertion can only be explained by that one rule.

function baseKey(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { path: "detail.orderId", ...overrides };
}

function baseLookupTier(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    label: "orders",
    table: "orders",
    keyField: "orderId",
    ...overrides,
  };
}

function baseState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { fromState: "created", nextState: "paid", ...overrides };
}

function baseCase(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "case-hold",
    description: "Hold for review",
    prose: "Needs manual review before any action.",
    priority: 100,
    fromState: "created",
    verdict: "hold",
    followUps: [],
    ...overrides,
  };
}

function baseArm(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    label: "Default arm",
    key: baseKey(),
    lookup: [baseLookupTier()],
    onMissing: "hold",
    state: baseState(),
    cases: [baseCase()],
    ...overrides,
  };
}

/** The smallest record `parseTriagePreset` accepts: one default arm. */
function validPreset(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    queue: "orders-dlq",
    title: "Orders DLQ triage",
    handling: "runbook",
    escalateTo: "orders-team",
    routeOn: "eventType",
    envelope: { bodyIsJson: true },
    arms: [baseArm()],
    ...overrides,
  };
}

describe("parseTriagePreset — valid preset round-trip", () => {
  it("parses every field of a realistic two-arm preset, defaulting absent optional fields to undefined", () => {
    const raw: Record<string, unknown> = {
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      handling: "runbook",
      prohibitions: ["do-not-redrive-without-ticket"],
      fifo: false,
      sourceQueue: "orders-inbound",
      envelope: { bodyIsJson: true, payloadPath: "detail" },
      routeOn: "detail.eventType",
      escalateTo: "orders-team",
      followUps: ["notify-oncall"],
      todos: [],
      arms: [
        {
          match: "order.created",
          label: "Order created",
          key: {
            path: "detail.orderId",
            stripPrefix: "ord_",
            capture: "ord_(\\w+)",
          },
          lookup: [
            { label: "orders-primary", table: "orders", keyField: "orderId" },
            {
              label: "orders-archive",
              table: "orders-archive",
              keyField: "orderId",
            },
          ],
          onMissing: "escalate",
          state: {
            fromState: "order.status",
            nextState: "detail.status",
            progression: "detail.progression",
          },
          cases: [
            {
              id: "duplicate-order-created",
              description: "Duplicate order.created event",
              prose: "The order was already created; skip re-processing.",
              priority: 100,
              fromState: "created",
              nextState: "created",
              eventType: "order.created",
              signature: '"eventType":"order.created"',
              requiredProgression: ["created"],
              verdict: "known-no-action",
              resolution: "skip",
              followUps: ["log-duplicate"],
            },
          ],
        },
        {
          label: "Default arm",
          key: { path: "detail.id", addSuffix: "-key" },
          lookup: [{ label: "payments", table: "payments", keyField: "id" }],
          onMissing: "hold",
          state: { fromState: "a", nextState: "b" },
          cases: [],
        },
      ],
    };

    const preset = parseTriagePreset(reader, raw, "example.json");

    expect(preset).toEqual({
      queue: "orders-dlq",
      title: "Orders DLQ triage",
      handling: "runbook",
      prohibitions: ["do-not-redrive-without-ticket"],
      fifo: false,
      orderBy: undefined,
      sourceQueue: "orders-inbound",
      envelope: { bodyIsJson: true, payloadPath: "detail" },
      routeOn: "detail.eventType",
      arms: [
        {
          match: "order.created",
          label: "Order created",
          key: {
            path: "detail.orderId",
            stripPrefix: "ord_",
            addSuffix: undefined,
            capture: "ord_(\\w+)",
          },
          lookup: [
            { label: "orders-primary", table: "orders", keyField: "orderId" },
            {
              label: "orders-archive",
              table: "orders-archive",
              keyField: "orderId",
            },
          ],
          onMissing: "escalate",
          state: {
            fromState: "order.status",
            nextState: "detail.status",
            progression: "detail.progression",
          },
          cases: [
            {
              id: "duplicate-order-created",
              description: "Duplicate order.created event",
              prose: "The order was already created; skip re-processing.",
              priority: 100,
              fromState: "created",
              nextState: "created",
              eventType: "order.created",
              signature: '"eventType":"order.created"',
              requiredProgression: ["created"],
              verdict: "known-no-action",
              ticket: undefined,
              resolution: "skip",
              escalateTo: undefined,
              followUps: ["log-duplicate"],
            },
          ],
        },
        {
          match: undefined,
          label: "Default arm",
          key: {
            path: "detail.id",
            stripPrefix: undefined,
            addSuffix: "-key",
            capture: undefined,
          },
          lookup: [{ label: "payments", table: "payments", keyField: "id" }],
          onMissing: "hold",
          state: { fromState: "a", nextState: "b", progression: undefined },
          cases: [],
        },
      ],
      escalateTo: "orders-team",
      followUps: ["notify-oncall"],
      todos: [],
    });

    // `toEqual` alone cannot distinguish a key that is present with value
    // `undefined` from one that is absent — spot-check the two forms
    // directly, since the contract is `readonly x: T | undefined`, not
    // `x?: T`.
    const arm0 = definite(preset.arms[0], "arms[0]");
    const arm1 = definite(preset.arms[1], "arms[1]");
    expect(Object.hasOwn(arm1, "match")).toBe(true);
    expect(arm1.match).toBeUndefined();
    expect(Object.hasOwn(arm0.key, "addSuffix")).toBe(true);
    expect(arm0.key.addSuffix).toBeUndefined();
    expect(Object.hasOwn(arm1.key, "stripPrefix")).toBe(true);
    expect(arm1.key.stripPrefix).toBeUndefined();
    expect(Object.hasOwn(arm1.key, "capture")).toBe(true);
    expect(arm1.key.capture).toBeUndefined();
    expect(Object.hasOwn(arm1.state, "progression")).toBe(true);
    expect(arm1.state.progression).toBeUndefined();
    const case0 = definite(arm0.cases[0], "arms[0].cases[0]");
    expect(Object.hasOwn(case0, "ticket")).toBe(true);
    expect(case0.ticket).toBeUndefined();
    expect(Object.hasOwn(case0, "escalateTo")).toBe(true);
    expect(case0.escalateTo).toBeUndefined();
  });
});

describe("parseTriagePreset — numbered validations", () => {
  // 1. queue/title/routeOn/escalateTo required non-empty strings.
  test.each(["queue", "title", "routeOn", "escalateTo"] as const)(
    "rejects a preset missing the required '%s' field",
    (field) => {
      const record = validPreset();
      delete record[field];
      expect(rejectionOf(record)).toContain(field);
    },
  );

  // 2. handling must be one of HANDLING_MODES.
  it("rejects an invalid 'handling' value, naming every allowed mode", () => {
    const message = rejectionOf(validPreset({ handling: "bogus" }));
    expect(message).toBe(
      `'handling' must be one of: ${HANDLING_MODES.join(", ")}`,
    );
  });

  // 3. arms required, at least one.
  it("rejects a preset with no arms", () => {
    expect(rejectionOf(validPreset({ arms: [] }))).toContain("arms");
  });

  // 4. At most one default arm (match === undefined).
  it("rejects a preset with two default arms, both omitting 'match'", () => {
    const message = rejectionOf(
      validPreset({
        arms: [
          baseArm({ cases: [baseCase({ id: "case-first", priority: 100 })] }),
          baseArm({
            label: "Second default arm",
            cases: [baseCase({ id: "case-second", priority: 101 })],
          }),
        ],
      }),
    );
    expect(message.toLowerCase()).toContain("default");
  });

  // 5. Arm match values must be unique.
  it("rejects two arms sharing the same 'match' value", () => {
    const message = rejectionOf(
      validPreset({
        arms: [
          baseArm({
            match: "order.created",
            cases: [baseCase({ id: "case-first", priority: 100 })],
          }),
          baseArm({
            match: "order.created",
            label: "Duplicate arm",
            cases: [baseCase({ id: "case-second", priority: 101 })],
          }),
        ],
      }),
    );
    expect(message).toContain("order.created");
  });

  // 6. Each arm's lookup: at least one tier; each tier needs label/table/keyField.
  it("rejects an arm with no lookup tiers", () => {
    expect(
      rejectionOf(validPreset({ arms: [baseArm({ lookup: [] })] })),
    ).toContain("lookup");
  });

  test.each(["label", "table", "keyField"] as const)(
    "rejects a lookup tier missing '%s'",
    (field) => {
      const tier = baseLookupTier();
      delete tier[field];
      expect(
        rejectionOf(validPreset({ arms: [baseArm({ lookup: [tier] })] })),
      ).toContain(field);
    },
  );

  // 7. Each arm's onMissing must be a valid TriageOnMissing value.
  it("rejects an arm with an invalid 'onMissing' value", () => {
    expect(
      rejectionOf(validPreset({ arms: [baseArm({ onMissing: "ignore" })] })),
    ).toContain("onMissing");
  });

  // 8. state.fromState and state.nextState are required non-empty.
  test.each(["fromState", "nextState"] as const)(
    "rejects an arm state missing '%s'",
    (field) => {
      const state = baseState();
      delete state[field];
      expect(
        rejectionOf(validPreset({ arms: [baseArm({ state })] })),
      ).toContain(field);
    },
  );

  // 9. Case verdict must be in AUTHORABLE_VERDICTS — load-bearing: this is
  // what stops a row claiming the reserved 'entity-not-found' verdict, which
  // only a codified terminal case may reach.
  it("[load-bearing] rejects a case authoring the reserved 'entity-not-found' verdict", () => {
    const message = rejectionOf(
      validPreset({
        arms: [baseArm({ cases: [baseCase({ verdict: "entity-not-found" })] })],
      }),
    );
    expect(message).toContain(AUTHORABLE_VERDICTS.join(", "));
    expect(message.toLowerCase()).toContain("verdict");
  });

  it("rejects a case authoring any other reserved terminal verdict", () => {
    const message = rejectionOf(
      validPreset({
        arms: [baseArm({ cases: [baseCase({ verdict: "unrecognised" })] })],
      }),
    );
    expect(message).toContain(AUTHORABLE_VERDICTS.join(", "));
  });

  // 10. Case priority must be an integer strictly above RESERVED_PRIORITY_CEILING.
  test.each([RESERVED_PRIORITY_CEILING, 1, 0])(
    "rejects a case priority of %i, at or below the reserved ceiling",
    (priority) => {
      const message = rejectionOf(
        validPreset({ arms: [baseArm({ cases: [baseCase({ priority })] })] }),
      );
      expect(message.toLowerCase()).toContain("reserved");
    },
  );

  it("rejects a non-integer case priority above the reserved ceiling", () => {
    const message = rejectionOf(
      validPreset({
        arms: [baseArm({ cases: [baseCase({ priority: 100.5 })] })],
      }),
    );
    expect(message.toLowerCase()).toContain("reserved");
  });

  // 11. Case priorities are unique across the whole preset, not per arm.
  it("rejects duplicate case priorities across different arms, naming both case ids", () => {
    const message = rejectionOf(
      validPreset({
        arms: [
          baseArm({
            match: "order.created",
            label: "Order created arm",
            cases: [baseCase({ id: "case-a", priority: 100 })],
          }),
          baseArm({
            label: "Default arm",
            cases: [baseCase({ id: "case-b", priority: 100 })],
          }),
        ],
      }),
    );
    expect(message).toContain("case-a");
    expect(message).toContain("case-b");
  });

  // 12. Case ids are unique across the whole preset.
  it("rejects duplicate case ids across different arms", () => {
    const message = rejectionOf(
      validPreset({
        arms: [
          baseArm({
            match: "order.created",
            label: "Order created arm",
            cases: [baseCase({ id: "dup-case", priority: 100 })],
          }),
          baseArm({
            label: "Default arm",
            cases: [baseCase({ id: "dup-case", priority: 101 })],
          }),
        ],
      }),
    );
    expect(message).toContain("dup-case");
  });

  // 13. Every regex (case.signature, key.capture) is length-bounded and
  // compiled at load, for both fields.
  it("rejects a case signature pattern beyond the length limit", () => {
    const message = rejectionOf(
      validPreset({
        arms: [
          baseArm({
            cases: [
              baseCase({ signature: "a".repeat(MAX_PATTERN_LENGTH + 1) }),
            ],
          }),
        ],
      }),
    );
    expect(message).toContain(String(MAX_PATTERN_LENGTH));
  });

  it("rejects a case signature that does not compile as a regular expression, chaining the SyntaxError as cause", () => {
    const error = rejectionErrorOf(
      validPreset({
        arms: [baseArm({ cases: [baseCase({ signature: "(" })] })],
      }),
    );
    expect(error.message.toLowerCase()).toContain("valid regular expression");
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it("rejects a key.capture pattern beyond the length limit", () => {
    // Exactly one capture group, so the failure can only be the length
    // check — not an incidental group-count rejection.
    const message = rejectionOf(
      validPreset({
        arms: [
          baseArm({
            key: baseKey({ capture: `(${"a".repeat(MAX_PATTERN_LENGTH)})` }),
          }),
        ],
      }),
    );
    expect(message).toContain(String(MAX_PATTERN_LENGTH));
  });

  it("rejects a key.capture that does not compile as a regular expression, chaining the SyntaxError as cause", () => {
    const error = rejectionErrorOf(
      validPreset({ arms: [baseArm({ key: baseKey({ capture: "(" }) })] }),
    );
    expect(error.message.toLowerCase()).toContain("valid regular expression");
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  // 14. key.capture, when present, must declare exactly one capture group.
  it("rejects a key.capture with zero capture groups", () => {
    expect(
      rejectionOf(
        validPreset({
          arms: [baseArm({ key: baseKey({ capture: "id=\\w+" }) })],
        }),
      ),
    ).toContain("capture");
  });

  it("rejects a key.capture with two capture groups", () => {
    expect(
      rejectionOf(
        validPreset({
          arms: [baseArm({ key: baseKey({ capture: "id=(\\w+)-(\\w+)" }) })],
        }),
      ),
    ).toContain("capture");
  });

  it("accepts a key.capture with exactly one group, tolerating a non-capturing group and a paren character class", () => {
    // A naive open-paren count would misjudge this pattern: it has one
    // non-capturing group `(?:...)`, one real capturing group `(\w+)`, and
    // two character classes (`[(]`, `[)]`) that each contain a literal
    // parenthesis but declare no group at all. No trailing `?` on the
    // non-capturing group: the engine's own pattern-safety probe
    // (`requireSafeCapturePattern`) rejects ANY `)` immediately followed by a
    // quantifier, regardless of whether the group it closes is capturing —
    // `(?:pre-)?` would trip that same rule this pattern is meant to prove
    // is NOT tripped by an unrelated shape (a bare character-class paren).
    const capture = "(?:pre-)id[(](\\w+)[)]";
    const preset = parseTriagePreset(
      reader,
      validPreset({ arms: [baseArm({ key: baseKey({ capture }) })] }),
      "example.json",
    );
    const arm0 = definite(preset.arms[0], "arms[0]");
    expect(arm0.key.capture).toBe(capture);
  });

  // 15. A case declaring no predicate at all is rejected.
  it("rejects a case declaring no predicate at all", () => {
    const caseRow = baseCase();
    delete caseRow["fromState"];
    const message = rejectionOf(
      validPreset({ arms: [baseArm({ cases: [caseRow] })] }),
    );
    expect(message.toLowerCase()).toContain("predicate");
  });
});

// ---------------------------------------------------------------------------
// Regression coverage for the 2026-08-23 review findings.
// ---------------------------------------------------------------------------

describe("parseTriagePreset — arm.label uniqueness (finding 1)", () => {
  // Every preset-row case is scoped to its declaring arm by `armLabel`
  // equality (cases.ts's `armGuard`), not by `match` — so two arms sharing a
  // `label` would let arm A's case rows match messages routed to arm B, even
  // though their `match` values are entirely distinct. This is the exact
  // precondition the cross-arm isolation guard depends on never happening.
  it("rejects two arms with different 'match' values but the same 'label', naming the duplicate label", () => {
    const message = rejectionOf(
      validPreset({
        arms: [
          baseArm({
            match: "order.created",
            label: "orders-arm",
            cases: [baseCase({ id: "case-first", priority: 100 })],
          }),
          baseArm({
            match: "order.shipped",
            label: "orders-arm",
            cases: [baseCase({ id: "case-second", priority: 101 })],
          }),
        ],
      }),
    );
    expect(message).toContain("orders-arm");
    expect(message.toLowerCase()).toContain("label");
  });

  it("rejects a default arm sharing a label with a matched arm", () => {
    const message = rejectionOf(
      validPreset({
        arms: [
          baseArm({
            match: "order.created",
            label: "orders-arm",
            cases: [baseCase({ id: "case-first", priority: 100 })],
          }),
          baseArm({
            label: "orders-arm",
            cases: [baseCase({ id: "case-second", priority: 101 })],
          }),
        ],
      }),
    );
    expect(message).toContain("orders-arm");
    expect(message.toLowerCase()).toContain("label");
  });
});

describe("parseTriagePreset — empty-string state predicates are rejected (finding 2)", () => {
  // An empty-string fromState/nextState/eventType would otherwise collide
  // with derive-state's/route-event's own "unresolved" sentinels, silently
  // turning a narrow row into a catch-all whenever the arm's own path is
  // mistyped. Every other declared string in this schema already rejects
  // "" via M3LInputFileReader.requiredStringField; these three optional
  // predicates read through optionalStringField instead, which admits "".
  test.each(["fromState", "nextState", "eventType"] as const)(
    "rejects a case row with an empty-string '%s'",
    (field) => {
      const message = rejectionOf(
        validPreset({
          arms: [baseArm({ cases: [baseCase({ [field]: "" })] })],
        }),
      );
      expect(message).toContain(field);
      expect(message.toLowerCase()).toContain("empty");
    },
  );
});

describe("parseTriagePreset — key.capture pattern safety (finding 4)", () => {
  // This pattern already passes the pre-existing checks (it compiles, and
  // `(x+x+)+` matched against the empty string still reports exactly one
  // capture group) — only the engine's own ReDoS-shape safety check catches
  // it, which is why the loader now routes every capture pattern through it.
  it("rejects a key.capture pattern shaped for catastrophic backtracking, even though it compiles and declares exactly one group", () => {
    const message = rejectionOf(
      validPreset({
        arms: [baseArm({ key: baseKey({ capture: "^(x+x+)+y$" }) })],
      }),
    );
    expect(message).toContain("capture");
  });

  // A quantified group (`)` immediately followed by a quantifier) is the
  // other catastrophic-backtracking shape the engine's check rejects,
  // independent of the "exactly one capture group" count check above — this
  // one has zero capture groups, so it must be caught by the safety probe
  // rather than accidentally passing because the group-count check runs
  // first and never reaches it.
  it("rejects a key.capture pattern with a quantified group", () => {
    const message = rejectionOf(
      validPreset({
        arms: [baseArm({ key: baseKey({ capture: "(?:a)?b" }) })],
      }),
    );
    expect(message).toContain("capture");
  });

  it("still accepts a legitimate, non-catastrophic key.capture pattern", () => {
    const capture = "^order-([0-9]+)$";
    const preset = parseTriagePreset(
      reader,
      validPreset({ arms: [baseArm({ key: baseKey({ capture }) })] }),
      "example.json",
    );
    const arm0 = definite(preset.arms[0], "arms[0]");
    expect(arm0.key.capture).toBe(capture);
  });
});

describe("parseTriagePreset — todos are not rejected at load", () => {
  it("parses a preset whose todos are non-empty; that is validate's failure, not the loader's", () => {
    const preset = parseTriagePreset(
      reader,
      validPreset({ todos: ["arms[1].key.capture: pattern unclear"] }),
      "example.json",
    );
    expect(preset.todos).toEqual(["arms[1].key.capture: pattern unclear"]);
  });
});

// ---------------------------------------------------------------------------
// PR 3b, STEP 1: the `groupIdPath` two-way rule (decision 4). Both directions
// must fail loud offline — a `fifo: true` preset that omits `groupIdPath`
// cannot be sent at execute time, and a `groupIdPath` on a non-FIFO preset
// silently does nothing, which the spec calls worse than an absent field.
// ---------------------------------------------------------------------------

describe("parseTriagePreset — groupIdPath two-way rule (PR 3b, decision 4)", () => {
  it("rejects fifo: true with no groupIdPath, naming the field and the fifo value", () => {
    const message = rejectionOf(validPreset({ fifo: true }));
    expect(message).toContain("groupIdPath");
    expect(message).toContain("fifo");
    expect(message).toContain("true");
  });

  it("rejects groupIdPath present with fifo: false, naming the field and the fifo value", () => {
    const message = rejectionOf(
      validPreset({ fifo: false, groupIdPath: "detail.shipmentId" }),
    );
    expect(message).toContain("groupIdPath");
    expect(message).toContain("fifo");
    expect(message).toContain("false");
  });

  it("rejects groupIdPath present with fifo entirely absent (defaults to false)", () => {
    // `fifo` defaults to `false` when the preset omits it entirely
    // (load-runbook.ts: `reader.optionalBooleanField(record, "fifo") ?? false`)
    // — a declared `groupIdPath` alongside an omitted `fifo` must be rejected
    // by the same rule as an explicit `fifo: false`, not silently accepted
    // because the field was never mentioned.
    const record = validPreset({ groupIdPath: "detail.shipmentId" });
    delete record["fifo"];
    const message = rejectionOf(record);
    expect(message).toContain("groupIdPath");
    expect(message).toContain("fifo");
  });

  it("accepts fifo: true with a declared groupIdPath and orderBy", () => {
    const preset = parseTriagePreset(
      reader,
      validPreset({
        fifo: true,
        groupIdPath: "detail.shipmentId",
        orderBy: "detail.seq",
      }),
      "example.json",
    );
    expect(preset.fifo).toBe(true);
    expect(preset.groupIdPath).toBe("detail.shipmentId");
    expect(preset.orderBy).toBe("detail.seq");
  });

  it("accepts fifo: false (or omitted) with no groupIdPath", () => {
    const preset = parseTriagePreset(reader, validPreset(), "example.json");
    expect(preset.fifo).toBe(false);
    expect(preset.groupIdPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PR 3b review round 2: three offline rules that must fail `validate`, never
// be discovered mid-remediation deep inside `execute-plan.ts`/`execute-actions.ts`.
// ---------------------------------------------------------------------------

describe("parseTriagePreset — fifo/orderBy two-way rule (review round 2, MUST-FIX 9)", () => {
  it("rejects fifo: true with no orderBy, naming the field and the fifo value", () => {
    const message = rejectionOf(
      validPreset({ fifo: true, groupIdPath: "detail.shipmentId" }),
    );
    expect(message).toContain("orderBy");
    expect(message).toContain("fifo");
    expect(message).toContain("true");
  });
});

describe("parseTriagePreset — an inert prohibition is rejected (review round 2, MUST-FIX 8)", () => {
  it("rejects a prohibition string matching neither the remove nor reinsert keyword sets", () => {
    // Contains none of "redrive", "reinsert", "delete", "remove" — it would
    // pass `validate` and print in `explain` while blocking nothing at any
    // `downgradeForProhibitions` check.
    const message = rejectionOf(
      validPreset({
        prohibitions: ["always require manager sign-off before any action"],
      }),
    );
    expect(message).toContain("recognised prohibition keyword");
  });

  it("accepts a prohibition string matching a recognised keyword", () => {
    const preset = parseTriagePreset(
      reader,
      validPreset({ prohibitions: ["do-not-redrive-without-ticket"] }),
      "example.json",
    );
    expect(preset.prohibitions).toEqual(["do-not-redrive-without-ticket"]);
  });
});

describe("parseTriagePreset — a 'reinsert' verdict case requires a declared sourceQueue (review round 2, MUST-FIX 10)", () => {
  it("rejects a preset authoring a 'reinsert' verdict case with no sourceQueue declared", () => {
    const message = rejectionOf(
      validPreset({
        arms: [baseArm({ cases: [baseCase({ verdict: "reinsert" })] })],
      }),
    );
    expect(message).toContain("reinsert");
    expect(message).toContain("sourceQueue");
  });

  it("accepts a preset authoring a 'reinsert' verdict case when sourceQueue is declared", () => {
    const preset = parseTriagePreset(
      reader,
      validPreset({
        sourceQueue: "orders-inbound",
        arms: [baseArm({ cases: [baseCase({ verdict: "reinsert" })] })],
      }),
      "example.json",
    );
    expect(preset.sourceQueue).toBe("orders-inbound");
  });
});

describe("normaliseProgression", () => {
  it("joins states into a lowercased, comma-delimited form with leading and trailing commas", () => {
    expect(normaliseProgression(["created", "paid", "shipped"])).toBe(
      ",created,paid,shipped,",
    );
  });

  it("lowercases mixed-case state names", () => {
    expect(normaliseProgression(["Created", "PAID"])).toBe(",created,paid,");
  });

  it("wraps an empty progression in the same leading/trailing comma form", () => {
    expect(normaliseProgression([])).toBe(",,");
  });

  it("does not let a ',paid,' probe collide with 'unpaid' or 'paid-late' states", () => {
    // This anti-collision property is the entire reason for the
    // leading/trailing-comma delimiting: a naive `includes("paid")` check
    // would wrongly match both neighbouring state names below.
    const progression = normaliseProgression([
      "unpaid",
      "processing",
      "paid-late",
    ]);
    expect(progression).toBe(",unpaid,processing,paid-late,");
    expect(progression.includes("paid")).toBe(true);
    expect(progression.includes(",paid,")).toBe(false);
  });
});
