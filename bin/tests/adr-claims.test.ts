import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
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
    expect(ADR_CLAIMS).toHaveLength(11);
    expect(checkAdrClaims(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// package-manager-pin probe (via ADR_CLAIMS) — exercises the real, unexported
// probePackageManagerPin through the exported ADR_CLAIMS table's entry, per
// this repo's "don't export a sibling probe just to unit test it" convention.
// ---------------------------------------------------------------------------

describe("package-manager-pin probe (via ADR_CLAIMS)", () => {
  let sandbox: string | undefined;

  afterEach(() => {
    if (sandbox !== undefined) {
      rmSync(sandbox, { recursive: true, force: true });
      sandbox = undefined;
    }
  });

  function writePackageManagerFixture(packageManager: string): string {
    const root = mkdtempSync(join(tmpdir(), "adr-claims-pm-pin-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager }),
    );
    return root;
  }

  test("reports exact: true and the major version for an exact pnpm pin", () => {
    sandbox = writePackageManagerFixture("pnpm@12.4.0");
    const claim = ADR_CLAIMS.find((c) => c.id === "package-manager-pin");
    expect(claim).toBeDefined();
    expect(claim?.probe(sandbox)).toEqual({
      manager: "pnpm",
      exact: true,
      major: 12,
    });
  });

  test("reports exact: false and major: null for a range/non-exact pin", () => {
    sandbox = writePackageManagerFixture("pnpm@^12.0.0");
    const claim = ADR_CLAIMS.find((c) => c.id === "package-manager-pin");
    expect(claim).toBeDefined();
    expect(claim?.probe(sandbox)).toEqual({
      manager: "pnpm",
      exact: false,
      major: null,
    });
  });

  test("reports whichever manager is pinned, not just pnpm", () => {
    sandbox = writePackageManagerFixture("yarn@4.0.0");
    const claim = ADR_CLAIMS.find((c) => c.id === "package-manager-pin");
    expect(claim).toBeDefined();
    expect(claim?.probe(sandbox)).toEqual({
      manager: "yarn",
      exact: true,
      major: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// eslint-heap-ceilings probe (via ADR_CLAIMS) — same "exercise the real,
// unexported probe through its ADR_CLAIMS entry" convention as above.
//
// The probe guards ADR-0080's 2026-09-15 Update. Its predecessor claim rotted
// silently (a measured exemption for `lint:library` stopped being true as
// packages/m3l-common grew), so these cases pin the two properties that make
// the guard non-vacuous: it must NAME an unflagged eslint script, and it must
// NOT match a script that merely mentions the word.
// ---------------------------------------------------------------------------

describe("eslint-heap-ceilings probe (via ADR_CLAIMS)", () => {
  let sandbox: string | undefined;

  afterEach(() => {
    if (sandbox !== undefined) {
      rmSync(sandbox, { recursive: true, force: true });
      sandbox = undefined;
    }
  });

  function writeScriptsFixture(scripts: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "adr-claims-eslint-heap-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
    return root;
  }

  function probeScripts(scripts: Record<string, string>): unknown {
    sandbox = writeScriptsFixture(scripts);
    const claim = ADR_CLAIMS.find((c) => c.id === "eslint-heap-ceilings");
    expect(claim).toBeDefined();
    return claim?.probe(sandbox);
  }

  const FLAG = 'NODE_OPTIONS="--max-old-space-size=8192"';

  test("returns [] when every eslint-invoking script carries a heap ceiling", () => {
    expect(
      probeScripts({
        "lint:library": `${FLAG} eslint packages/m3l-common`,
        "lint:workspace": `${FLAG} eslint .`,
      }),
    ).toEqual([]);
  });

  test("names an eslint script that has no heap ceiling", () => {
    expect(
      probeScripts({
        "lint:library": "eslint packages/m3l-common --concurrency=1",
        "lint:workspace": `${FLAG} eslint .`,
      }),
    ).toEqual(["lint:library"]);
  });

  test("names every offender, sorted, not just the first", () => {
    expect(
      probeScripts({
        "lint:workspace": "eslint .",
        "lint:library": "eslint packages/m3l-common",
      }),
    ).toEqual(["lint:library", "lint:workspace"]);
  });

  test("ignores a composite script that only delegates", () => {
    expect(
      probeScripts({
        lint: "pnpm lint:library && pnpm lint:workspace",
        "lint:library": `${FLAG} eslint packages/m3l-common`,
      }),
    ).toEqual([]);
  });

  test("ignores a script that names eslint inside a path but never invokes it", () => {
    // The live `check:zones` shape. A bare `includes("eslint")` matcher would
    // report this unflagged script as an offender; the word-boundary anchors
    // are what prevent it.
    expect(
      probeScripts({
        "check:zones": "node bin/check-eslint-zones.mjs",
        "lint:md": "rumdl check .",
      }),
    ).toEqual([]);
  });

  test("still matches an eslint invocation reached through pnpm exec", () => {
    expect(
      probeScripts({ "lint:library": "pnpm exec eslint packages/m3l-common" }),
    ).toEqual(["lint:library"]);
  });

  test("does not credit a --cache-location path containing 'eslint' as a ceiling", () => {
    // The live `:fast` scripts carry such a path. It must not be mistaken for
    // the flag, or a genuinely unflagged fast script would pass.
    expect(
      probeScripts({
        "lint:library:fast":
          "eslint packages/m3l-common --cache-location node_modules/.cache/eslint/library.eslintcache",
      }),
    ).toEqual(["lint:library:fast"]);
  });

  test("returns [] for a package.json with no scripts block at all", () => {
    const root = mkdtempSync(join(tmpdir(), "adr-claims-eslint-heap-"));
    sandbox = root;
    writeFileSync(join(root, "package.json"), JSON.stringify({}));
    const claim = ADR_CLAIMS.find((c) => c.id === "eslint-heap-ceilings");
    expect(claim?.probe(root)).toEqual([]);
  });
});
