import { describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

import { writeJsonArtifact } from "../src/steps/write-artifact.js";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s
 * `writeJsonArtifact` (`src/steps/write-artifact.ts`), mirroring
 * `scripts/cloudwatch-logs-analysis/src/steps/write-artifact.ts`'s own test
 * file exactly — the two implementations are specified to be identical in
 * shape (`paths.resolveOutput`, `mkdir(dirname, { recursive: true })`, then
 * `M3LJSONFileExporter.export`).
 */
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");
const paths = new Core.M3LPaths();

/**
 * Narrows a `writeFile`/`readFile` mock argument to its string path. The
 * mocked signature admits a `FileHandle`/`Buffer`, so `String(...)` on it
 * would be a `no-base-to-string` hazard rather than an assertion.
 */
function asPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`expected a string path, got ${typeof value}`);
  }
  return value;
}

describe("writeJsonArtifact", () => {
  it("creates the destination directory before writing", async () => {
    const mkdir = vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    await writeJsonArtifact(paths, "nested/drain.json", { ok: true });
    expect(mkdir).toHaveBeenCalledWith(paths.resolveOutput("nested"), {
      recursive: true,
    });
    vi.restoreAllMocks();
  });

  it("writes the serialised value to the resolved output path", async () => {
    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    const writeFile = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    await writeJsonArtifact(paths, "drain.json", { ok: true });
    expect(asPath(writeFile.mock.calls[0]?.[0])).toBe(
      paths.resolveOutput("drain.json"),
    );
    expect(asPath(writeFile.mock.calls[0]?.[1])).toContain('"ok"');
    vi.restoreAllMocks();
  });

  it("propagates the containment guard for a name that escapes the output tree (failure path)", async () => {
    await expect(
      writeJsonArtifact(paths, "../escape.json", {}),
    ).rejects.toThrow(Core.M3LPathResolutionError);
  });
});
