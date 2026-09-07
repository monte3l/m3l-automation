import { describe, expect, test } from "vitest";
import { parseArgs } from "../check-should-fix-ack.mjs";

describe("parseArgs", () => {
  test("reads --repo, --pr, --base, and --head", () => {
    expect(
      parseArgs([
        "--repo",
        "owner/repo",
        "--pr",
        "42",
        "--base",
        "abc",
        "--head",
        "def",
      ]),
    ).toEqual({
      repo: "owner/repo",
      pr: "42",
      base: "abc",
      head: "def",
    });
  });

  test("reads all four flags regardless of order", () => {
    expect(
      parseArgs([
        "--head",
        "def",
        "--base",
        "abc",
        "--pr",
        "42",
        "--repo",
        "owner/repo",
      ]),
    ).toEqual({
      repo: "owner/repo",
      pr: "42",
      base: "abc",
      head: "def",
    });
  });

  test("missing flags are undefined", () => {
    expect(parseArgs([])).toEqual({
      repo: undefined,
      pr: undefined,
      base: undefined,
      head: undefined,
    });
  });

  test("partial flags leave the rest undefined", () => {
    expect(parseArgs(["--repo", "owner/repo", "--pr", "42"])).toEqual({
      repo: "owner/repo",
      pr: "42",
      base: undefined,
      head: undefined,
    });
  });
});
