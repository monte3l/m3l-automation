import { describe, expect, test } from "vitest";
import { deriveReferenceFreshnessIssues } from "../lib/reference-freshness.mjs";

const manifests = [{ devDependencies: { foo: "1.5.0" } }];

describe("deriveReferenceFreshnessIssues", () => {
  test("a non-Context7 references file is ignored entirely", () => {
    const files = [
      {
        path: ".claude/skills/researching-anthropic-guidance/references/official-sources.md",
        content: "# Official sources\n\nNo Context7 provenance here.",
      },
    ];
    expect(deriveReferenceFreshnessIssues(files, manifests)).toEqual({
      missingStamp: [],
      malformedStamp: [],
      staleTracked: [],
      retiredClaims: [],
      unknownTracked: [],
      driftWarnings: [],
    });
  });

  test("a Context7-sourced file with no stamp is flagged missingStamp", () => {
    const files = [
      {
        path: ".claude/skills/eslint-flat-config/references/eslint-flat-config.md",
        content:
          "# ESLint flat config\n\n> **Provenance** — Source: Context7 `/eslint/eslint/v10.5.0`.\n\nNo stamp here.",
      },
    ];
    const result = deriveReferenceFreshnessIssues(files, manifests);
    expect(result.missingStamp).toEqual([
      ".claude/skills/eslint-flat-config/references/eslint-flat-config.md",
    ]);
  });

  test("a stamp missing the refresh field is flagged malformedStamp", () => {
    const files = [
      {
        path: "x/references/x.md",
        content:
          "Source: Context7\n<!-- reference-freshness: library=/foo/bar tracks=foo@1.2.0 snapshot=2026-07-02 -->",
      },
    ];
    const result = deriveReferenceFreshnessIssues(files, manifests);
    expect(result.malformedStamp).toEqual(["x/references/x.md"]);
  });

  test("a stamp with an unparseable tracks= entry is flagged malformedStamp", () => {
    const files = [
      {
        path: "x/references/x.md",
        content:
          "Source: Context7\n<!-- reference-freshness: library=/foo/bar tracks=not-a-version snapshot=2026-07-02 refresh=major -->",
      },
    ];
    const result = deriveReferenceFreshnessIssues(files, manifests);
    expect(result.malformedStamp).toEqual(["x/references/x.md"]);
  });

  test("refresh=major stays green (only warns) on a minor-only bump", () => {
    const files = [
      {
        path: "x/references/x.md",
        content:
          "Source: Context7\n<!-- reference-freshness: library=/foo/bar tracks=foo@1.2.0 snapshot=2026-07-02 refresh=major -->",
      },
    ];
    const result = deriveReferenceFreshnessIssues(files, manifests);
    expect(result.staleTracked).toEqual([]);
    expect(result.driftWarnings).toEqual([
      'x/references/x.md: "foo" installed at 1.5.0, drifted from stamped 1.2.0 (within refresh=major policy)',
    ]);
  });

  test("refresh=major fails on a major bump", () => {
    const files = [
      {
        path: "x/references/x.md",
        content:
          "Source: Context7\n<!-- reference-freshness: library=/foo/bar tracks=foo@1.2.0 snapshot=2026-07-02 refresh=major -->",
      },
    ];
    const majorBumpManifests = [{ devDependencies: { foo: "2.0.0" } }];
    const result = deriveReferenceFreshnessIssues(files, majorBumpManifests);
    expect(result.staleTracked).toEqual([
      'x/references/x.md: "foo" installed at 2.0.0 but stamp tracks 1.2.0 (refresh=major policy exceeded)',
    ]);
  });

  test("refresh=minor fails on a minor bump, but stays green (only warns) on a patch bump", () => {
    const files = [
      {
        path: "x/references/x.md",
        content:
          "Source: Context7\n<!-- reference-freshness: library=/foo/bar tracks=foo@1.2.0,bar@1.2.0 snapshot=2026-07-02 refresh=minor -->",
      },
    ];
    const mixedManifests = [
      { devDependencies: { foo: "1.3.0", bar: "1.2.5" } },
    ];
    const result = deriveReferenceFreshnessIssues(files, mixedManifests);
    expect(result.staleTracked).toEqual([
      'x/references/x.md: "foo" installed at 1.3.0 but stamp tracks 1.2.0 (refresh=minor policy exceeded)',
    ]);
    expect(result.driftWarnings).toEqual([
      'x/references/x.md: "bar" installed at 1.2.5, drifted from stamped 1.2.0 (within refresh=minor policy)',
    ]);
  });

  test("a tracked package absent from every manifest warns without failing", () => {
    const files = [
      {
        path: "x/references/x.md",
        content:
          "Source: Context7\n<!-- reference-freshness: library=/foo/bar tracks=missing-pkg@1.0.0 snapshot=2026-07-02 refresh=major -->",
      },
    ];
    const result = deriveReferenceFreshnessIssues(files, manifests);
    expect(result.staleTracked).toEqual([]);
    expect(result.unknownTracked).toEqual([
      'x/references/x.md: tracked package "missing-pkg" not found in any manifest',
    ]);
  });

  test("the retired `ctx7 skills generate` CLI instruction is flagged wherever it appears", () => {
    const files = [
      {
        path: "x/references/x.md",
        content:
          "Source: Context7\n<!-- reference-freshness: library=/foo/bar tracks=foo@1.5.0 snapshot=2026-07-02 refresh=major -->\n\nRefresh: re-run `/skill-creator` (or `ctx7 skills generate`) on a major bump.",
      },
    ];
    const result = deriveReferenceFreshnessIssues(files, manifests);
    expect(result.retiredClaims).toEqual(["x/references/x.md"]);
  });

  test("resolves an installed version from a later manifest when the first lacks it", () => {
    const files = [
      {
        path: "x/references/x.md",
        content:
          "Source: Context7\n<!-- reference-freshness: library=/foo/bar tracks=scoped-pkg@1.0.0 snapshot=2026-07-02 refresh=major -->",
      },
    ];
    const layeredManifests = [
      { devDependencies: { foo: "1.5.0" } },
      { dependencies: { "scoped-pkg": "1.0.0" } },
    ];
    const result = deriveReferenceFreshnessIssues(files, layeredManifests);
    expect(result.staleTracked).toEqual([]);
    expect(result.unknownTracked).toEqual([]);
    expect(result.driftWarnings).toEqual([]);
  });
});
