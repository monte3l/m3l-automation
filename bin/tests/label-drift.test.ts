import { describe, expect, test } from "vitest";
import { deriveLabelDrift } from "../lib/label-drift.mjs";

// ---------------------------------------------------------------------------
// Synthetic fixtures — deliberately not the real bin/lib/label-defs.mjs
// values, since deriveLabelDrift is a pure diff and its behavior does not
// depend on the real ADR-0032 label set. bin/tests/check-label-drift.test.ts
// covers the real LABEL_DEFS integration.
// ---------------------------------------------------------------------------

const HUB_SYNC_DEF = {
  name: "hub-sync",
  color: "0e8a16",
  description:
    "Managed by the ADR-0032 visibility hub sync — do not edit manually.",
};

const PRIORITY_DEF = {
  name: "priority:0-now",
  color: "b60205",
  description: "Now — unblock-first work; do before more consumer scripts.",
};

// ---------------------------------------------------------------------------
// deriveLabelDrift
// ---------------------------------------------------------------------------

describe("deriveLabelDrift", () => {
  test("a fully matching liveLabels set reports no drift", () => {
    const findings = deriveLabelDrift(
      [HUB_SYNC_DEF, PRIORITY_DEF],
      [{ ...HUB_SYNC_DEF }, { ...PRIORITY_DEF }],
    );
    expect(findings).toEqual([]);
  });

  test("reports a missing label with the exact message shape from the JSDoc @example", () => {
    const findings = deriveLabelDrift([HUB_SYNC_DEF], []);
    expect(findings).toEqual([
      'Label "hub-sync" is missing on the live repository — run ' +
        "`pnpm sync:hub -- --apply` to create it.",
    ]);
  });

  test("reports a description drift naming both the actual and expected description", () => {
    const findings = deriveLabelDrift(
      [HUB_SYNC_DEF],
      [{ ...HUB_SYNC_DEF, description: "some other description" }],
    );
    expect(findings).toEqual([
      'Label "hub-sync" description is "some other description", expected ' +
        `"${HUB_SYNC_DEF.description}" — run \`pnpm sync:hub -- --apply\` to fix it.`,
    ]);
  });

  test("reports a color drift naming both the actual and expected color", () => {
    const findings = deriveLabelDrift(
      [HUB_SYNC_DEF],
      [{ ...HUB_SYNC_DEF, color: "ffffff" }],
    );
    expect(findings).toEqual([
      'Label "hub-sync" color is "ffffff", expected ' +
        `"${HUB_SYNC_DEF.color}" — run \`pnpm sync:hub -- --apply\` to fix it.`,
    ]);
  });

  test("treats color comparison as case-insensitive: a same color in a different case is not drift", () => {
    const findings = deriveLabelDrift(
      [HUB_SYNC_DEF],
      [{ ...HUB_SYNC_DEF, color: HUB_SYNC_DEF.color.toUpperCase() }],
    );
    expect(findings).toEqual([]);
  });

  test("never reports a live-only label absent from labelDefs (unmanaged extras like bug/enhancement/dependencies)", () => {
    const findings = deriveLabelDrift(
      [HUB_SYNC_DEF],
      [
        { ...HUB_SYNC_DEF },
        {
          name: "bug",
          color: "d73a4a",
          description: "Something isn't working",
        },
        { name: "dependencies", color: "0366d6", description: "" },
      ],
    );
    expect(findings).toEqual([]);
  });

  test("reports every mismatched managed label at once, not just the first", () => {
    const findings = deriveLabelDrift(
      [HUB_SYNC_DEF, PRIORITY_DEF],
      [{ ...PRIORITY_DEF, description: "drifted" }],
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatch(/^Label "hub-sync" is missing/);
    expect(findings[1]).toMatch(
      /^Label "priority:0-now" description is "drifted"/,
    );
  });

  test.each([
    [
      "missing label",
      [HUB_SYNC_DEF],
      [] as { name: string; description: string; color: string }[],
      [/^Label "hub-sync" is missing on the live repository/],
    ],
    [
      "description drift only",
      [HUB_SYNC_DEF],
      [{ ...HUB_SYNC_DEF, description: "wrong" }],
      [/^Label "hub-sync" description is "wrong", expected/],
    ],
    [
      "color drift only",
      [HUB_SYNC_DEF],
      [{ ...HUB_SYNC_DEF, color: "123456" }],
      [/^Label "hub-sync" color is "123456", expected/],
    ],
    [
      "description and color drift on the same label",
      [HUB_SYNC_DEF],
      [{ ...HUB_SYNC_DEF, description: "wrong", color: "123456" }],
      [
        /^Label "hub-sync" description is "wrong", expected/,
        /^Label "hub-sync" color is "123456", expected/,
      ],
    ],
  ])("%s", (_scenario, labelDefs, liveLabels, patterns) => {
    const findings = deriveLabelDrift(labelDefs, liveLabels);
    expect(findings).toHaveLength(patterns.length);
    for (const [index, pattern] of patterns.entries()) {
      expect(findings[index]).toMatch(pattern);
    }
  });
});
