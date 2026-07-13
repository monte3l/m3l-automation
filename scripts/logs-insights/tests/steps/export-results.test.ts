import { afterEach, describe, expect, it, vi } from "vitest";

import type * as M3LCommonModule from "@m3l-automation/m3l-common";

/**
 * Contract: docs/reference/scripts/logs-insights.md, `export-results` row.
 * Writes the full accumulated row set to the output file in ONE shot via the
 * exporter's whole-array `export(items)` (`format`-dispatched
 * `Core.M3LJSONListExporter` / `Core.M3LCSVListExporter`) — never
 * incrementally per window. The exporter classes/constructors are mocked
 * directly (per the brief) so the assertion is on the *calling convention*
 * (dispatch + call count + args), not on parsing a real serialized file.
 */

const mocks = vi.hoisted(() => ({
  jsonExport: vi.fn().mockResolvedValue(undefined),
  csvExport: vi.fn().mockResolvedValue(undefined),
  jsonConstructor: vi.fn(),
  csvConstructor: vi.fn(),
}));

vi.mock("@m3l-automation/m3l-common", async () => {
  const actual = await vi.importActual<typeof M3LCommonModule>(
    "@m3l-automation/m3l-common",
  );

  class FakeJSONListExporter {
    constructor(options: { filePath: string }) {
      mocks.jsonConstructor(options);
    }
    export(items: unknown): Promise<void> {
      return mocks.jsonExport(items) as Promise<void>;
    }
  }

  class FakeCSVListExporter {
    constructor(options: { filePath: string }) {
      mocks.csvConstructor(options);
    }
    export(items: unknown): Promise<void> {
      return mocks.csvExport(items) as Promise<void>;
    }
  }

  return {
    ...actual,
    Core: {
      ...actual.Core,
      M3LJSONListExporter: FakeJSONListExporter,
      M3LCSVListExporter: FakeCSVListExporter,
    },
  };
});

import { Core } from "@m3l-automation/m3l-common";

import { exportResults } from "../../src/steps/export-results.js";

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
  mocks.jsonExport.mockClear();
  mocks.csvExport.mockClear();
  mocks.jsonConstructor.mockClear();
  mocks.csvConstructor.mockClear();
});

const ROWS = [
  { "@message": "row-1" },
  { "@message": "row-2" },
  { "@message": "row-3" },
];

describe("exportResults", () => {
  it("format 'json' dispatches to M3LJSONListExporter, calling export() once with the full row set", async () => {
    const { paths, resolveOutputSpy } = buildPaths("/data/output/results.json");

    await exportResults({
      rows: ROWS,
      format: "json",
      output: "results.json",
      paths,
    });

    expect(resolveOutputSpy).toHaveBeenCalledWith("results.json");
    expect(mocks.jsonConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.jsonConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/data/output/results.json" }),
    );
    expect(mocks.jsonExport).toHaveBeenCalledTimes(1);
    expect(mocks.jsonExport).toHaveBeenCalledWith(ROWS);
    expect(mocks.csvExport).not.toHaveBeenCalled();
  });

  it("format 'csv' dispatches to M3LCSVListExporter, calling export() once with the full row set", async () => {
    const { paths, resolveOutputSpy } = buildPaths("/data/output/results.csv");

    await exportResults({
      rows: ROWS,
      format: "csv",
      output: "results.csv",
      paths,
    });

    expect(resolveOutputSpy).toHaveBeenCalledWith("results.csv");
    expect(mocks.csvConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.csvConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/data/output/results.csv" }),
    );
    expect(mocks.csvExport).toHaveBeenCalledTimes(1);
    expect(mocks.csvExport).toHaveBeenCalledWith(ROWS);
    expect(mocks.jsonExport).not.toHaveBeenCalled();
  });

  it("calls export() exactly once even with an empty row set (no per-window incremental writes)", async () => {
    const { paths } = buildPaths("/data/output/results.json");

    await exportResults({
      rows: [],
      format: "json",
      output: "results.json",
      paths,
    });

    expect(mocks.jsonExport).toHaveBeenCalledTimes(1);
    expect(mocks.jsonExport).toHaveBeenCalledWith([]);
  });
});
