import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ADR_CLAIMS,
  checkAdrClaims,
  extractYamlListKey,
} from "../lib/adr-claims.mjs";

// bin/check-adr-claims.mjs computes `root` via repoRoot(import.meta.url) from
// its own location (bin/check-adr-claims.mjs), i.e. the repo root. This test
// file lives one directory deeper (bin/tests/), so the same repo root needs
// one extra dirname() hop from here.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ---------------------------------------------------------------------------
// extractYamlListKey
// ---------------------------------------------------------------------------

describe("extractYamlListKey", () => {
  test("extracts a simple quoted list under a top-level key", () => {
    const yamlText = 'packages:\n  - "packages/*"\n  - "scripts/*"\n';
    expect(extractYamlListKey(yamlText, "packages")).toEqual([
      "packages/*",
      "scripts/*",
    ]);
  });

  test("stops at the next top-level key, never reading into it", () => {
    const yamlText = 'packages:\n  - "a"\noverrides:\n  "x": "y"\n';
    expect(extractYamlListKey(yamlText, "packages")).toEqual(["a"]);
  });

  test("returns [] when the key does not exist in the text at all", () => {
    const yamlText = 'other:\n  - "a"\n';
    expect(extractYamlListKey(yamlText, "packages")).toEqual([]);
  });

  test("returns [] for a key that exists but has no list items under it", () => {
    const yamlText = "packages:\noverrides:\n  x: y\n";
    expect(extractYamlListKey(yamlText, "packages")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkAdrClaims
// ---------------------------------------------------------------------------

describe("checkAdrClaims", () => {
  test("returns [] when a claim's probe returns exactly expect", () => {
    const claims = [
      {
        id: "always-true",
        adr: "0001",
        claim: "the probe always returns true",
        probe: () => true,
        expect: true,
      },
    ];
    expect(checkAdrClaims("/fake", claims)).toEqual([]);
  });

  test("returns one finding for a primitive mismatch", () => {
    const claims = [
      {
        id: "node-floor",
        adr: "0003",
        claim: "the node floor is 24",
        probe: () => "23",
        expect: "24",
      },
    ];
    const findings = checkAdrClaims("/fake", claims);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("node-floor");
    expect(findings[0]?.adr).toBe("0003");
    expect(findings[0]?.message).toContain("ADR-0003");
    expect(findings[0]?.message).toContain("no longer holds");
  });

  test("returns one finding for an object mismatch", () => {
    const claims = [
      {
        id: "esm-only-no-require",
        adr: "0002",
        claim: "esm only, no require condition",
        probe: () => ({ type: "module", hasRequireCondition: true }),
        expect: { type: "module", hasRequireCondition: false },
      },
    ];
    const findings = checkAdrClaims("/fake", claims);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("esm-only-no-require");
    expect(findings[0]?.adr).toBe("0002");
    expect(findings[0]?.message).toContain("ADR-0002");
    expect(findings[0]?.message).toContain("no longer holds");
  });

  test("returns one finding for a package-manager-pin mismatch", () => {
    const claims = [
      {
        id: "package-manager-pin",
        adr: "0001",
        claim:
          "package.json's packageManager field pins an exact pnpm 12.x version",
        probe: () => ({ manager: "pnpm", exact: true, major: 13 }),
        expect: { manager: "pnpm", exact: true, major: 12 },
      },
    ];
    const findings = checkAdrClaims("/fake", claims);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("package-manager-pin");
    expect(findings[0]?.adr).toBe("0001");
    expect(findings[0]?.message).toContain("ADR-0001");
    expect(findings[0]?.message).toContain("no longer holds");
  });

  test("a throwing probe produces one finding naming the probe failure, without crashing the rest of the run", () => {
    const claims = [
      {
        id: "throws",
        adr: "0099",
        claim: "a claim whose probe blows up",
        probe: () => {
          throw new Error("boom");
        },
        expect: true,
      },
      {
        id: "still-passes",
        adr: "0098",
        claim: "a claim after the throwing one",
        probe: () => true,
        expect: true,
      },
    ];
    const findings = checkAdrClaims("/fake", claims);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("throws");
    expect(findings[0]?.message).toContain("boom");
    expect(findings[0]?.message).toContain("probe itself failed");
  });

  test("multiple claims with mixed outcomes report exactly one finding per failing/throwing claim, in input order", () => {
    const claims = [
      {
        id: "passing-1",
        adr: "0010",
        claim: "passes",
        probe: () => 1,
        expect: 1,
      },
      {
        id: "failing-1",
        adr: "0011",
        claim: "fails",
        probe: () => 2,
        expect: 3,
      },
      {
        id: "throwing-1",
        adr: "0012",
        claim: "throws",
        probe: () => {
          throw new Error("kaboom");
        },
        expect: true,
      },
      {
        id: "passing-2",
        adr: "0013",
        claim: "also passes",
        probe: () => "x",
        expect: "x",
      },
    ];
    const findings = checkAdrClaims("/fake", claims);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.id)).toEqual(["failing-1", "throwing-1"]);
  });

  test("live-repo sanity check: every real ADR_CLAIMS entry currently holds", () => {
    expect(ADR_CLAIMS).toHaveLength(10);
    expect(checkAdrClaims(root)).toEqual([]);
  });
});
