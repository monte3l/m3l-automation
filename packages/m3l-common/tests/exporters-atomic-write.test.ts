/**
 * Sibling test file for `core/exporters`' `M3LFileListExporter` atomic-write
 * behavior (issue #1146) — extracted from `exporters.test.ts` after it grew
 * past its `check:file-budget` ceiling (ADR-0072). Follows this repo's
 * `<module>-<facet>.test.ts` sibling convention.
 *
 * Contract source: docs/reference/core/exporters.md
 * Exports under test: M3LFileListExporter.
 *
 * Key behavioral contracts specific to this file:
 *  - export(items) writes serialized content to a temp sibling file of the
 *    configured `filePath` (same directory, `.tmp` suffix), then renames it
 *    onto `filePath` — the live path is never truncated/written directly.
 *  - On success, no `.tmp` sibling is left behind and the target file's
 *    content matches exactly what was exported.
 *  - On a write failure (e.g. missing parent directory), no partial temp
 *    file is left behind in the existing parent directory.
 */

import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

// Named imports (not `fsp.<method>` member calls) are used for the real,
// unmocked filesystem calls in the torn-write round-trip tests below: the
// repo's `no-restricted-syntax` guard bans mutating `fs`/`fsp`/`fsPromises`
// *member-expression* calls in tests, but a bare identifier call
// (`mkdtemp(...)`) is unaffected — mirrors the pattern in
// `tests/checkpoint.test.ts`.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept individual
// functions (ESM namespace objects are non-writable).
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import { M3LError } from "../src/core/errors/index.js";
import { M3LFileListExporter } from "../src/core/exporters/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M3LFileListExporter atomicity", () => {
  interface Row {
    id: string;
  }

  test("writes to a temp sibling file, then renames it onto the configured filePath, never truncating the live path directly", async () => {
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);
    const renameSpy = vi.spyOn(fsp, "rename").mockResolvedValue(undefined);
    const filePath = "/exports/list.json";
    const exporter = new M3LFileListExporter<Row>({ filePath });

    await exporter.export([{ id: "1" }, { id: "2" }]);

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const [tempPathArgument] = writeFileSpy.mock.calls[0] ?? [];
    expect(typeof tempPathArgument).toBe("string");
    const tempPath = tempPathArgument as string;
    expect(tempPath).not.toBe(filePath);
    expect(path.dirname(tempPath)).toBe(path.dirname(filePath));
    expect(tempPath).toMatch(/\.tmp$/);

    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledWith(tempPath, filePath);
  });

  test("a real write leaves no .tmp sibling on success, and the file's content matches exactly what was exported", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m3l-exporter-atomic-"));
    try {
      const filePath = path.join(dir, "list.json");
      const exporter = new M3LFileListExporter<Row>({ filePath });
      const items = [{ id: "1" }, { id: "2" }, { id: "3" }];

      await exporter.export(items);

      const entries = await readdir(dir);
      expect(entries).toEqual([path.basename(filePath)]);

      const written = await readFile(filePath, "utf8");
      expect(JSON.parse(written)).toEqual(items);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a real write failure (missing parent directory) leaves no partial temp file behind in the existing parent directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m3l-exporter-atomic-fail-"));
    try {
      // `writeFileAtomic`'s temp path is a sibling of the *target* path, so
      // it lands inside the nonexistent subdirectory too — fsp.writeFile
      // fails with ENOENT before rename is ever reached. Reading the
      // nonexistent subdirectory itself would throw, so assert against the
      // parent `dir`, which does exist, and must remain empty.
      const filePath = path.join(dir, "no-such-subdir", "file.json");
      const exporter = new M3LFileListExporter<Row>({ filePath });

      let thrown: unknown;
      try {
        await exporter.export([{ id: "1" }]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_FILE_LIST_EXPORT");

      const entries = await readdir(dir);
      expect(entries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
