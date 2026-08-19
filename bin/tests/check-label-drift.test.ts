import { describe, expect, test } from "vitest";
import { LABEL_DEFS } from "../lib/label-defs.mjs";
import { deriveLabelDrift } from "../lib/label-drift.mjs";

// Mirrors bin/tests/check-github-features.test.ts's convention: the CLI
// wrapper (bin/check-label-drift.mjs) keeps all its logic behind the
// `if (process.argv[1] === fileURLToPath(import.meta.url))` main guard with
// a local, non-exported `runGh`/`ghErrorMessage` — vitest.bin.config.ts's
// own header confirms that shape is verified only by a direct `node
// bin/check-label-drift.mjs` invocation (every pre-push/CI check:* step),
// not by vitest. So this file exercises the exact pure derivation the CLI
// wrapper calls (`deriveLabelDrift(LABEL_DEFS, liveLabels)`) against a
// realistic `gh label list --json name,description,color`-shaped payload,
// same as check-github-features.test.ts's COMPLIANT_REPO fixture.

describe("check-label-drift: LABEL_DEFS against a live `gh label list` payload", () => {
  test("a live label set that exactly mirrors LABEL_DEFS reports no drift", () => {
    const compliantLiveLabels = LABEL_DEFS.map((def) => ({ ...def }));

    expect(deriveLabelDrift(LABEL_DEFS, compliantLiveLabels)).toEqual([]);
  });

  test("a live label set with unmanaged extras (bug, enhancement, dependencies) still reports no drift", () => {
    const liveLabels = [
      ...LABEL_DEFS.map((def) => ({ ...def })),
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      {
        name: "enhancement",
        color: "a2eeef",
        description: "New feature or request",
      },
      { name: "dependencies", color: "0366d6", description: "" },
    ];

    expect(deriveLabelDrift(LABEL_DEFS, liveLabels)).toEqual([]);
  });

  test("a hand-renamed managed label (present in labelDefs but absent from live) is reported as missing", () => {
    const [firstDef, ...restDefs] = LABEL_DEFS;
    if (firstDef === undefined) {
      throw new Error("test fixture: expected LABEL_DEFS to be non-empty");
    }
    // Live label was hand-renamed on GitHub (e.g. reverting ADR-0051's
    // rename), so it no longer matches any labelDefs entry by name.
    const liveLabels = [
      ...restDefs.map((def) => ({ ...def })),
      { ...firstDef, name: `${firstDef.name}-renamed` },
    ];

    const findings = deriveLabelDrift(LABEL_DEFS, liveLabels);
    expect(findings).toEqual([
      `Label "${firstDef.name}" is missing on the live repository — run ` +
        "`pnpm sync:hub -- --apply` to create it.",
    ]);
  });

  test("a hand-edited description on one managed label is reported as description drift, others stay clean", () => {
    const [firstDef] = LABEL_DEFS;
    if (firstDef === undefined) {
      throw new Error("test fixture: expected LABEL_DEFS to be non-empty");
    }
    const liveLabels = LABEL_DEFS.map((def) =>
      def.name === firstDef.name
        ? { ...def, description: "hand-edited on GitHub" }
        : { ...def },
    );

    const findings = deriveLabelDrift(LABEL_DEFS, liveLabels);
    expect(findings).toEqual([
      `Label "${firstDef.name}" description is "hand-edited on GitHub", ` +
        `expected "${firstDef.description}" — run \`pnpm sync:hub -- --apply\` to fix it.`,
    ]);
  });

  test("a hand-edited color on one managed label is reported as color drift, others stay clean", () => {
    const [firstDef] = LABEL_DEFS;
    if (firstDef === undefined) {
      throw new Error("test fixture: expected LABEL_DEFS to be non-empty");
    }
    const liveLabels = LABEL_DEFS.map((def) =>
      def.name === firstDef.name ? { ...def, color: "000000" } : { ...def },
    );

    const findings = deriveLabelDrift(LABEL_DEFS, liveLabels);
    expect(findings).toEqual([
      `Label "${firstDef.name}" color is "000000", expected ` +
        `"${firstDef.color}" — run \`pnpm sync:hub -- --apply\` to fix it.`,
    ]);
  });
});
