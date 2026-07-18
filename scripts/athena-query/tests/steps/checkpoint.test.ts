import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept individual
// functions directly — per this project's convention (mock the fs primitive
// itself, never a real fakeRoot path: a fakeRoot path passes on Windows but
// hits EACCES on Linux CI, per this repo's known gotcha).
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import {
  deleteCheckpoint,
  readCheckpoint,
  writeCheckpoint,
  type AthenaCheckpoint,
} from "../../src/steps/checkpoint.js";

/**
 * Contract: docs/reference/scripts/athena-query.md, `checkpoint` row + the
 * "Resume and failure semantics" section. Reads/writes a JSON checkpoint file
 * (`<output>.checkpoint.json`, resolved under `M3L_OUTPUT_DIR` via
 * `Core.M3LPaths.resolveOutput()`) recording `{ queryExecutionId?: string }`
 * — the in-flight Athena query id, if any. Simplified relative to
 * `cloudwatch-logs-insights`'s checkpoint: no rows/completedWindows, since
 * `athena-query` issues a single, non-windowed query.
 */

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Real M3LPaths instance with `resolveOutput` spied to a deterministic path.
 * Returns the spy alongside `paths` — asserting on a bare
 * `paths.resolveOutput` member reference (rather than a captured variable)
 * trips `@typescript-eslint/unbound-method`.
 */
function buildPaths(resolved: string) {
  const paths = new Core.M3LPaths();
  const resolveOutputSpy = vi
    .spyOn(paths, "resolveOutput")
    .mockReturnValue(resolved);
  return { paths, resolveOutputSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readCheckpoint", () => {
  it("resolves the checkpoint path as '<output>.checkpoint.json' via M3LPaths.resolveOutput", async () => {
    const { paths, resolveOutputSpy } = buildPaths(
      "/data/output/results.json.checkpoint.json",
    );
    vi.spyOn(fsp, "readFile").mockResolvedValue(JSON.stringify({}));

    await readCheckpoint({ paths, output: "results.json" });

    expect(resolveOutputSpy).toHaveBeenCalledWith(
      "results.json.checkpoint.json",
    );
    expect(fsp.readFile).toHaveBeenCalledWith(
      "/data/output/results.json.checkpoint.json",
      expect.anything(),
    );
  });

  it("returns an empty checkpoint ({}) when the checkpoint file does not exist (ENOENT)", async () => {
    const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
    vi.spyOn(fsp, "readFile").mockRejectedValue(errnoError("ENOENT"));

    await expect(
      readCheckpoint({ paths, output: "results.json" }),
    ).resolves.toEqual({});
  });

  it("returns the parsed checkpoint, including queryExecutionId, when the file exists", async () => {
    const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
    const checkpoint: AthenaCheckpoint = {
      queryExecutionId: "query-123",
    };
    vi.spyOn(fsp, "readFile").mockResolvedValue(JSON.stringify(checkpoint));

    await expect(
      readCheckpoint({ paths, output: "results.json" }),
    ).resolves.toEqual(checkpoint);
  });

  it.each(["EACCES", "EPERM"] as const)(
    "re-throws a %s failure instead of swallowing it",
    async (code) => {
      const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
      const error = errnoError(code);
      vi.spyOn(fsp, "readFile").mockRejectedValue(error);

      await expect(
        readCheckpoint({ paths, output: "results.json" }),
      ).rejects.toBe(error);
    },
  );

  it.each([[], "not-an-object", 42, null, { queryExecutionId: 123 }])(
    "throws an M3LError coded ERR_ATHENA_CHECKPOINT_PARSE when the parsed JSON does not match the checkpoint shape (%j)",
    async (malformed) => {
      const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
      vi.spyOn(fsp, "readFile").mockResolvedValue(JSON.stringify(malformed));

      let thrown: unknown;
      try {
        await readCheckpoint({ paths, output: "results.json" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(
        "ERR_ATHENA_CHECKPOINT_PARSE",
      );
    },
  );

  it("throws an M3LError coded ERR_ATHENA_CHECKPOINT_PARSE (not a raw SyntaxError) when the file content is not valid JSON", async () => {
    const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
    vi.spyOn(fsp, "readFile").mockResolvedValue("not valid json{{{");

    let thrown: unknown;
    try {
      await readCheckpoint({ paths, output: "results.json" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ATHENA_CHECKPOINT_PARSE");
  });
});

describe("writeCheckpoint", () => {
  it("writes the exact checkpoint shape to '<output>.checkpoint.json'", async () => {
    const { paths, resolveOutputSpy } = buildPaths(
      "/data/output/results.json.checkpoint.json",
    );
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);
    const checkpoint: AthenaCheckpoint = { queryExecutionId: "query-abc" };

    await writeCheckpoint({ paths, output: "results.json", checkpoint });

    expect(resolveOutputSpy).toHaveBeenCalledWith(
      "results.json.checkpoint.json",
    );
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeFileSpy.mock.calls[0] ?? [];
    expect(writtenPath).toBe("/data/output/results.json.checkpoint.json");
    if (typeof writtenContent !== "string") {
      throw new Error("expected writeFile to be called with a string body");
    }
    expect(JSON.parse(writtenContent) as unknown).toEqual(checkpoint);
  });

  it("overwrites a previously-written checkpoint (last write wins)", async () => {
    const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);

    await writeCheckpoint({
      paths,
      output: "results.json",
      checkpoint: { queryExecutionId: "query-first" },
    });
    await writeCheckpoint({
      paths,
      output: "results.json",
      checkpoint: { queryExecutionId: "query-second" },
    });

    expect(writeFileSpy).toHaveBeenCalledTimes(2);
    const lastCall = writeFileSpy.mock.calls[1] ?? [];
    const lastContent = lastCall[1];
    if (typeof lastContent !== "string") {
      throw new Error("expected writeFile to be called with a string body");
    }
    expect(JSON.parse(lastContent) as unknown).toEqual({
      queryExecutionId: "query-second",
    });
  });
});

describe("deleteCheckpoint", () => {
  it("deletes the checkpoint file at '<output>.checkpoint.json'", async () => {
    const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
    const unlinkSpy = vi.spyOn(fsp, "unlink").mockResolvedValue(undefined);

    await deleteCheckpoint({ paths, output: "results.json" });

    expect(unlinkSpy).toHaveBeenCalledWith(
      "/data/output/results.json.checkpoint.json",
    );
  });

  it("is ENOENT-tolerant: resolves instead of throwing when the file is already gone", async () => {
    const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
    vi.spyOn(fsp, "unlink").mockRejectedValue(errnoError("ENOENT"));

    await expect(
      deleteCheckpoint({ paths, output: "results.json" }),
    ).resolves.toBeUndefined();
  });

  it.each(["EACCES", "EPERM"] as const)(
    "re-throws a %s failure instead of swallowing it",
    async (code) => {
      const { paths } = buildPaths("/data/output/results.json.checkpoint.json");
      const error = errnoError(code);
      vi.spyOn(fsp, "unlink").mockRejectedValue(error);

      await expect(
        deleteCheckpoint({ paths, output: "results.json" }),
      ).rejects.toBe(error);
    },
  );
});
