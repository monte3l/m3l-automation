import { describe, expect, test } from "vitest";
import {
  computeExitCode,
  findTarball,
  formatRunFailure,
} from "../check-exports.mjs";

describe("formatRunFailure", () => {
  test("a spawn error (command not found) is reported by its message", () => {
    const res = {
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    };
    expect(formatRunFailure(res, "pnpm", ["pack"])).toBe(
      "check:exports: could not run `pnpm pack`: ENOENT",
    );
  });

  test("a killed process is reported by its signal, not a generic failure", () => {
    const res = { signal: "SIGTERM" };
    expect(formatRunFailure(res, "pnpm", ["exec", "attw", "x.tgz"])).toBe(
      "check:exports: `pnpm exec attw x.tgz` was killed by SIGTERM.",
    );
  });

  test("error takes precedence over signal when spawnSync somehow reports both", () => {
    const res = {
      error: new Error("spawn failed"),
      signal: "SIGTERM",
    };
    expect(formatRunFailure(res, "pnpm", ["pack"])).toBe(
      "check:exports: could not run `pnpm pack`: spawn failed",
    );
  });

  test("a plain non-zero exit (no error, no signal) falls back to a generic message", () => {
    const res = {};
    expect(formatRunFailure(res, "pnpm", ["exec", "publint", "pkg"])).toBe(
      "check:exports: `pnpm exec publint pkg` failed.",
    );
  });
});

describe("findTarball", () => {
  test("picks the .tgz out of a mixed directory listing", () => {
    expect(
      findTarball([
        "README.md",
        "m3l-automation-m3l-common-4.7.0.tgz",
        ".DS_Store",
      ]),
    ).toBe("m3l-automation-m3l-common-4.7.0.tgz");
  });

  test("returns undefined when no .tgz is present", () => {
    expect(findTarball(["README.md", "package.json"])).toBeUndefined();
  });

  test("returns undefined for an empty listing", () => {
    expect(findTarball([])).toBeUndefined();
  });

  test("a filename merely containing .tgz mid-string (not as the extension) is not matched", () => {
    expect(findTarball(["not-a.tgz.backup"])).toBeUndefined();
  });

  test("the first matching .tgz wins when more than one is present", () => {
    expect(findTarball(["a.tgz", "b.tgz"])).toBe("a.tgz");
  });
});

describe("computeExitCode", () => {
  test("both tools passing (status 0) yields 0", () => {
    expect(computeExitCode(0, 0)).toBe(0);
  });

  test("publint failing yields 1 even when attw passed", () => {
    expect(computeExitCode(1, 0)).toBe(1);
  });

  test("attw failing yields 1 even when publint passed", () => {
    expect(computeExitCode(0, 1)).toBe(1);
  });

  test("attw never reached (undefined — pack failed or no tarball) yields 1, not a pass by omission", () => {
    expect(computeExitCode(0, undefined)).toBe(1);
  });

  test("both failing yields 1", () => {
    expect(computeExitCode(1, 1)).toBe(1);
  });
});
