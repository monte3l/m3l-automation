import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { describeMergeResolution } from "../merge-driver-generated.mjs";

const scriptPath = fileURLToPath(
  new URL("../merge-driver-generated.mjs", import.meta.url),
);

describe("describeMergeResolution", () => {
  test("names the file path in the note", () => {
    expect(describeMergeResolution("docs/reference/catalog.json")).toContain(
      "docs/reference/catalog.json",
    );
  });

  test("falls back to a placeholder when the path is undefined", () => {
    expect(describeMergeResolution(undefined)).toContain("(unknown file)");
  });
});

describe("merge-driver-generated CLI (given %O/%A/%B temp fixtures)", () => {
  test("keeps %A unchanged, exits 0, and names %P in its output", () => {
    const dir = mkdtempSync(join(tmpdir(), "m3l-merge-driver-"));
    try {
      const oPath = join(dir, "O.json");
      const aPath = join(dir, "A.json");
      const bPath = join(dir, "B.json");
      writeFileSync(oPath, '{"base":true}\n');
      writeFileSync(aPath, '{"ours":true}\n');
      writeFileSync(bPath, '{"theirs":true}\n');

      const stdout = execFileSync(
        "node",
        [scriptPath, oPath, aPath, bPath, "docs/reference/symbol-map.json"],
        { encoding: "utf8" },
      );

      expect(stdout).toContain("docs/reference/symbol-map.json");
      expect(readFileSync(aPath, "utf8")).toBe('{"ours":true}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 0 even when %A is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "m3l-merge-driver-"));
    try {
      const oPath = join(dir, "O.json");
      const aPath = join(dir, "A.json");
      const bPath = join(dir, "B.json");
      writeFileSync(oPath, "");
      writeFileSync(aPath, "");
      writeFileSync(bPath, "");

      expect(() =>
        execFileSync(
          "node",
          [scriptPath, oPath, aPath, bPath, "pnpm-lock.yaml"],
          {
            encoding: "utf8",
          },
        ),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
