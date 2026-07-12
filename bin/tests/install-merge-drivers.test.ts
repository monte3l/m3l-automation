import { describe, expect, test } from "vitest";
import {
  installMergeDrivers,
  mergeDriverConfig,
} from "../install-merge-drivers.mjs";

describe("mergeDriverConfig", () => {
  test("uses a fixed, forward-slash, quoting-hazard-free command", () => {
    const { driver } = mergeDriverConfig();
    expect(driver).toBe("node bin/merge-driver-generated.mjs %O %A %B %P");
    expect(driver).not.toContain("\\");
  });
});

describe("installMergeDrivers", () => {
  test("writes both keys when neither is set", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === "config" && args[1] === "--get") {
        throw new Error("key not set");
      }
      return "";
    };

    const result = installMergeDrivers(runGit);

    expect(result).toEqual({ driver: "set", name: "set" });
    const writes = calls.filter((c) => c[0] === "config" && c[1] !== "--get");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual([
      "config",
      "merge.m3l-generated.driver",
      "node bin/merge-driver-generated.mjs %O %A %B %P",
    ]);
    expect(writes[1]?.[1]).toBe("merge.m3l-generated.name");
  });

  test("is idempotent: a second run with matching config is a no-op", () => {
    const { driver, name } = mergeDriverConfig();
    const current: Record<string, string> = {
      "merge.m3l-generated.driver": driver,
      "merge.m3l-generated.name": name,
    };
    const writeCalls: string[][] = [];
    const runGit = (args: string[]) => {
      if (args[0] === "config" && args[1] === "--get") {
        const key = args[2];
        if (key === undefined || !(key in current)) {
          throw new Error("key not set");
        }
        return current[key];
      }
      writeCalls.push(args);
      return "";
    };

    const result = installMergeDrivers(runGit);

    expect(result).toEqual({ driver: "unchanged", name: "unchanged" });
    expect(writeCalls).toHaveLength(0);
  });

  test("only rewrites the key whose value actually differs", () => {
    const { driver, name } = mergeDriverConfig();
    const current: Record<string, string> = {
      "merge.m3l-generated.driver": "some stale command",
      "merge.m3l-generated.name": name,
    };
    const writeCalls: string[][] = [];
    const runGit = (args: string[]) => {
      if (args[0] === "config" && args[1] === "--get") {
        const key = args[2];
        if (key === undefined || !(key in current)) {
          throw new Error("key not set");
        }
        return current[key];
      }
      writeCalls.push(args);
      return "";
    };

    const result = installMergeDrivers(runGit);

    expect(result).toEqual({ driver: "set", name: "unchanged" });
    expect(writeCalls).toEqual([
      ["config", "merge.m3l-generated.driver", driver],
    ]);
  });

  test("writes to the shared config: no --worktree/--local scoping flag", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === "config" && args[1] === "--get") {
        throw new Error("key not set");
      }
      return "";
    };

    installMergeDrivers(runGit);

    for (const call of calls) {
      expect(call).not.toContain("--worktree");
      expect(call).not.toContain("--local");
    }
  });
});
