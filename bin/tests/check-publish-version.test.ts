/**
 * Tests for the registry-immutability publish-version gate
 * (bin/check-publish-version.mjs) — covers the four exported pure/async
 * functions (`PACKAGE_DIR`, `REGISTRY`, `readPublishTarget`,
 * `registryPathSegment`, `versionExists`). The module's CLI main block is
 * guarded behind `if (process.argv[1] === fileURLToPath(import.meta.url))`,
 * so importing it here executes nothing — same convention as
 * bin/tests/check-script-deps.test.ts and bin/tests/check-cli-scaffold.test.ts.
 *
 * `versionExists` is network-mocked via the injected `fetchImpl` seam ONLY
 * (never global `fetch`) — the `countTokensExact` pattern in
 * bin/check-context-budget.mjs / bin/tests/check-context-budget.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  PACKAGE_DIR,
  REGISTRY,
  readPublishTarget,
  registryPathSegment,
  versionExists,
} from "../check-publish-version.mjs";

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "m3l-check-publish-version-"));
}

describe("exported constants", () => {
  test("PACKAGE_DIR names the library package", () => {
    expect(PACKAGE_DIR).toBe("packages/m3l-common");
  });

  test("REGISTRY names the GitHub Packages npm registry", () => {
    expect(REGISTRY).toBe("https://npm.pkg.github.com");
  });
});

describe("registryPathSegment", () => {
  test("replaces the first slash in a scoped name with %2F, leaving the leading @ literal", () => {
    expect(registryPathSegment("@monte3l/m3l-common")).toBe(
      "@monte3l%2Fm3l-common",
    );
  });

  test("only the FIRST slash is replaced — a name with a second slash keeps it literal", () => {
    // String.replace with a string pattern (not a /g regex) only replaces
    // the first occurrence — this is deliberate, not accidental: a
    // real scoped package name has exactly one slash, but this pins the
    // documented one-replacement contract explicitly.
    expect(registryPathSegment("@scope/pkg/sub")).toBe("@scope%2Fpkg/sub");
  });

  test("a name with no slash at all is returned unchanged, not crashed on", () => {
    expect(registryPathSegment("unscoped-package")).toBe("unscoped-package");
  });
});

describe("readPublishTarget", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("reads name and version from packages/m3l-common/package.json, ignoring other fields", () => {
    dir = mktemp();
    const pkgDir = join(dir, "packages", "m3l-common");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@monte3l/m3l-common",
        version: "4.7.0",
        description: "irrelevant to this gate",
        private: true,
        publishConfig: { registry: REGISTRY },
      }),
    );

    expect(readPublishTarget(dir)).toEqual({
      name: "@monte3l/m3l-common",
      version: "4.7.0",
    });
  });
});

describe("versionExists", () => {
  const name = "@monte3l/m3l-common";
  const version = "4.7.0";
  const registry = REGISTRY;
  const token = "test-token";

  test("returns false on a 404 response — no versions have ever been published", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 404, ok: false });

    await expect(
      versionExists(name, version, { registry, token, fetchImpl }),
    ).resolves.toBe(false);
  });

  test("returns true when the version is present in the versions map", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ versions: { "4.7.0": {} } }),
    });

    await expect(
      versionExists(name, "4.7.0", { registry, token, fetchImpl }),
    ).resolves.toBe(true);
  });

  test("returns false when the versions map exists but does not contain the version under test", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ versions: { "4.7.0": {} } }),
    });

    await expect(
      versionExists(name, "5.0.0", { registry, token, fetchImpl }),
    ).resolves.toBe(false);
  });

  test("returns false, not a throw, when the versions field is entirely absent from the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });

    await expect(
      versionExists(name, version, { registry, token, fetchImpl }),
    ).resolves.toBe(false);
  });

  test.each([
    [401, "Unauthorized"],
    [500, "Internal Server Error"],
  ])(
    "throws on a non-404 non-ok response (%s %s), with the status in the message",
    async (status, statusText) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ status, ok: false, statusText });

      await expect(
        versionExists(name, version, { registry, token, fetchImpl }),
      ).rejects.toThrow(new RegExp(String(status)));
    },
  );

  test("calls fetchImpl with the %2F-encoded name in the URL and a Bearer Authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ versions: {} }),
    });

    await versionExists(name, version, { registry, token, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(`${registry}/@monte3l%2Fm3l-common`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${token}` });
  });
});
