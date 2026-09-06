import { describe, expect, test } from "vitest";
import {
  checkAdrProvenance,
  deriveProvenanceEntry,
  extractPathCandidates,
} from "../lib/adr-provenance.mjs";

// ---------------------------------------------------------------------------
// extractPathCandidates
// ---------------------------------------------------------------------------

describe("extractPathCandidates", () => {
  test("extracts a simple backtick-quoted path", () => {
    expect(
      extractPathCandidates("See `bin/check-foo.mjs` for details."),
    ).toEqual(["bin/check-foo.mjs"]);
  });

  test("extracts root-level allowlisted files even without a slash", () => {
    expect(extractPathCandidates("Configured in `package.json`.")).toContain(
      "package.json",
    );
    expect(extractPathCandidates("Wired through `lefthook.yml`.")).toContain(
      "lefthook.yml",
    );
  });

  test("strips trailing prose punctuation outside the backtick span", () => {
    expect(extractPathCandidates("`docs/adr/0057-x.md`.")).toEqual([
      "docs/adr/0057-x.md",
    ]);
  });

  test("strips trailing punctuation that sits inside the backtick span itself", () => {
    expect(extractPathCandidates("`bin/foo.mjs,`")).toEqual(["bin/foo.mjs"]);
  });

  test("[KNOWN FIX] rejects a glob — nothing to hash", () => {
    expect(extractPathCandidates("`packages/*/src/**`")).toEqual([]);
  });

  test("[KNOWN FIX] rejects a bare ADR cross-reference", () => {
    expect(extractPathCandidates("`ADR-0057`")).toEqual([]);
  });

  test("[KNOWN FIX] rejects a package specifier that merely contains a slash", () => {
    expect(extractPathCandidates("`@m3l-automation/m3l-common`")).toEqual([]);
  });

  test("[KNOWN FIX] rejects a URL", () => {
    expect(extractPathCandidates("`https://example.com/path`")).toEqual([]);
  });

  test("deduplicates a path cited twice, keeping first-seen order relative to other distinct paths", () => {
    const content =
      "First see `bin/a.mjs`, then `bin/b.mjs`, and again `bin/a.mjs`.";
    expect(extractPathCandidates(content)).toEqual(["bin/a.mjs", "bin/b.mjs"]);
  });

  test("returns [] for text with no backtick-quoted paths and no allowlisted root file mentions", () => {
    expect(
      extractPathCandidates("Just some plain prose, no citations."),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveProvenanceEntry
// ---------------------------------------------------------------------------

describe("deriveProvenanceEntry", () => {
  test("with no previous entry, stamps today's date and sorts sourceFiles by path", () => {
    const resolved = [
      { path: "a.ts", blob: "sha1" },
      { path: "b.ts", blob: "sha2" },
    ];
    expect(deriveProvenanceEntry(resolved, "2026-09-06", undefined)).toEqual({
      sourceFiles: [
        { path: "a.ts", blob: "sha1" },
        { path: "b.ts", blob: "sha2" },
      ],
      verifiedAt: "2026-09-06",
    });
  });

  test("when resolved exactly matches previous, verifiedAt is unchanged (not re-stamped)", () => {
    const resolved = [
      { path: "a.ts", blob: "sha1" },
      { path: "b.ts", blob: "sha2" },
    ];
    const previous = {
      sourceFiles: [
        { path: "a.ts", blob: "sha1" },
        { path: "b.ts", blob: "sha2" },
      ],
      verifiedAt: "2026-01-01",
    };
    const entry = deriveProvenanceEntry(resolved, "2026-09-06", previous);
    expect(entry?.verifiedAt).toBe("2026-01-01");
  });

  test("when a blob differs from previous for the same path, re-stamps verifiedAt to today", () => {
    const resolved = [{ path: "a.ts", blob: "sha1-changed" }];
    const previous = {
      sourceFiles: [{ path: "a.ts", blob: "sha1" }],
      verifiedAt: "2026-01-01",
    };
    const entry = deriveProvenanceEntry(resolved, "2026-09-06", previous);
    expect(entry?.verifiedAt).toBe("2026-09-06");
  });

  test("when the set of paths differs from previous (one added), re-stamps verifiedAt to today", () => {
    const resolved = [
      { path: "a.ts", blob: "sha1" },
      { path: "b.ts", blob: "sha2" },
    ];
    const previous = {
      sourceFiles: [{ path: "a.ts", blob: "sha1" }],
      verifiedAt: "2026-01-01",
    };
    const entry = deriveProvenanceEntry(resolved, "2026-09-06", previous);
    expect(entry?.verifiedAt).toBe("2026-09-06");
  });

  test("when the set of paths differs from previous (one removed), re-stamps verifiedAt to today", () => {
    const resolved = [{ path: "a.ts", blob: "sha1" }];
    const previous = {
      sourceFiles: [
        { path: "a.ts", blob: "sha1" },
        { path: "b.ts", blob: "sha2" },
      ],
      verifiedAt: "2026-01-01",
    };
    const entry = deriveProvenanceEntry(resolved, "2026-09-06", previous);
    expect(entry?.verifiedAt).toBe("2026-09-06");
  });

  test("returns undefined for an empty resolved list", () => {
    expect(deriveProvenanceEntry([], "2026-09-06", undefined)).toBeUndefined();
  });

  test("returns undefined when every entry's blob is undefined (all filtered out)", () => {
    const resolved = [
      { path: "a.ts", blob: undefined },
      { path: "b.ts", blob: undefined },
    ];
    expect(
      deriveProvenanceEntry(resolved, "2026-09-06", undefined),
    ).toBeUndefined();
  });

  test("sorts sourceFiles alphabetically by path regardless of input order", () => {
    const resolved = [
      { path: "z.ts", blob: "sha-z" },
      { path: "a.ts", blob: "sha-a" },
      { path: "m.ts", blob: "sha-m" },
    ];
    const entry = deriveProvenanceEntry(resolved, "2026-09-06", undefined);
    expect(entry?.sourceFiles.map((s) => s.path)).toEqual([
      "a.ts",
      "m.ts",
      "z.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// checkAdrProvenance
// ---------------------------------------------------------------------------

describe("checkAdrProvenance", () => {
  test("returns [] when committed and fresh are identical", () => {
    const data = {
      "0001": {
        sourceFiles: [{ path: "a.ts", blob: "sha1" }],
        verifiedAt: "2026-01-01",
      },
    };
    expect(checkAdrProvenance(data, data)).toEqual([]);
  });

  test("a changed blob for the same path produces a finding naming the path, 'changed since', and the committed verifiedAt date", () => {
    const committed = {
      "0001": {
        sourceFiles: [{ path: "a.ts", blob: "sha1" }],
        verifiedAt: "2026-01-01",
      },
    };
    const fresh = {
      "0001": {
        sourceFiles: [{ path: "a.ts", blob: "sha1-new" }],
        verifiedAt: "2026-01-01",
      },
    };
    const findings = checkAdrProvenance(committed, fresh);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("a.ts");
    expect(findings[0]).toContain("changed since");
    expect(findings[0]).toContain("2026-01-01");
  });

  test("a newly-cited path in fresh produces a finding naming the path and 'newly cited'", () => {
    const committed = {
      "0001": {
        sourceFiles: [{ path: "a.ts", blob: "sha1" }],
        verifiedAt: "2026-01-01",
      },
    };
    const fresh = {
      "0001": {
        sourceFiles: [
          { path: "a.ts", blob: "sha1" },
          { path: "new.ts", blob: "sha-new" },
        ],
        verifiedAt: "2026-01-01",
      },
    };
    const findings = checkAdrProvenance(committed, fresh);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("new.ts");
    expect(findings[0]).toContain("newly cited");
  });

  test("a path present in committed but absent from fresh produces a finding naming the path and 'no longer exists'", () => {
    const committed = {
      "0001": {
        sourceFiles: [
          { path: "a.ts", blob: "sha1" },
          { path: "gone.ts", blob: "sha-gone" },
        ],
        verifiedAt: "2026-01-01",
      },
    };
    const fresh = {
      "0001": {
        sourceFiles: [{ path: "a.ts", blob: "sha1" }],
        verifiedAt: "2026-01-01",
      },
    };
    const findings = checkAdrProvenance(committed, fresh);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("gone.ts");
    expect(findings[0]).toContain("no longer exists");
  });

  test("an ADR present in committed but entirely absent from fresh produces a finding mentioning re-running gen:adr-provenance", () => {
    const committed = {
      "0001": {
        sourceFiles: [{ path: "a.ts", blob: "sha1" }],
        verifiedAt: "2026-01-01",
      },
    };
    const fresh = {};
    const findings = checkAdrProvenance(committed, fresh);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("0001");
    expect(findings[0]).toContain("gen:adr-provenance");
  });

  test("multiple ADRs with mixed drift/no-drift report one finding per drifted ADR, correctly attributed", () => {
    const committed = {
      "0001": {
        sourceFiles: [{ path: "a.ts", blob: "sha1" }],
        verifiedAt: "2026-01-01",
      },
      "0002": {
        sourceFiles: [{ path: "b.ts", blob: "sha2" }],
        verifiedAt: "2026-01-02",
      },
      "0003": {
        sourceFiles: [{ path: "c.ts", blob: "sha3" }],
        verifiedAt: "2026-01-03",
      },
    };
    const fresh = {
      "0001": {
        sourceFiles: [{ path: "a.ts", blob: "sha1" }],
        verifiedAt: "2026-01-01",
      },
      "0002": {
        sourceFiles: [{ path: "b.ts", blob: "sha2-changed" }],
        verifiedAt: "2026-01-02",
      },
      "0003": {
        sourceFiles: [{ path: "c.ts", blob: "sha3" }],
        verifiedAt: "2026-01-03",
      },
    };
    const findings = checkAdrProvenance(committed, fresh);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("0002");
    expect(findings[0]).toContain("b.ts");
    expect(findings[0]).not.toContain("0001");
    expect(findings[0]).not.toContain("0003");
  });
});
