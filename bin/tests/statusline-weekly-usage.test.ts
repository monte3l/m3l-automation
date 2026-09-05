import { describe, expect, test } from "vitest";
import { join } from "node:path";

import {
  resolveWeeklyUsage,
  formatWeeklyModelSegments,
  buildModelRow,
  GREEN,
  YELLOW,
  RED,
  DIM,
  RESET,
  formatDuration,
} from "../../.claude/hooks/statusline-context-pressure.mjs";

describe("resolveWeeklyUsage", () => {
  const startDir = "/workspace/project";
  const usagePath = join(startDir, "tmp/usage-weekly.json");

  test("returns null when readFile returns null for the cache file", () => {
    const readFile = () => null;

    expect(resolveWeeklyUsage(readFile, startDir, Date.now())).toBeNull();
  });

  test("returns null, not throws, when the cache file contains invalid JSON", () => {
    const readFile = (path: string): string | null =>
      path === usagePath ? "{ not json" : null;

    expect(() =>
      resolveWeeklyUsage(readFile, startDir, Date.now()),
    ).not.toThrow();
    expect(resolveWeeklyUsage(readFile, startDir, Date.now())).toBeNull();
  });

  test("returns null when fetched_at is missing", () => {
    const now = 1_700_100_000_000;
    const readFile = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            models: [{ id: "opus", display_name: "Opus", used_percentage: 40 }],
          })
        : null;

    expect(resolveWeeklyUsage(readFile, startDir, now)).toBeNull();
  });

  test("returns null when fetched_at is not a finite number", () => {
    const now = 1_700_100_000_000;
    const readFile = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            fetched_at: "not-a-number",
            models: [{ id: "opus", display_name: "Opus", used_percentage: 40 }],
          })
        : null;

    expect(resolveWeeklyUsage(readFile, startDir, now)).toBeNull();
  });

  test("returns null when the cache is older than 24 hours", () => {
    const now = 1_700_100_000_000;
    const fetchedAt = now / 1000 - 25 * 3600; // 25h ago
    const readFile = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            fetched_at: fetchedAt,
            models: [{ id: "opus", display_name: "Opus", used_percentage: 40 }],
          })
        : null;

    expect(resolveWeeklyUsage(readFile, startDir, now)).toBeNull();
  });

  test("returns null when models is absent, not an array, or every entry fails validation", () => {
    const now = 1_700_100_000_000;
    const fetchedAt = now / 1000; // fresh

    const absent = (path: string): string | null =>
      path === usagePath ? JSON.stringify({ fetched_at: fetchedAt }) : null;
    const notArray = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({ fetched_at: fetchedAt, models: "nope" })
        : null;
    const allInvalid = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            fetched_at: fetchedAt,
            models: [{ id: "opus" }, { display_name: "Missing id" }],
          })
        : null;

    expect(resolveWeeklyUsage(absent, startDir, now)).toBeNull();
    expect(resolveWeeklyUsage(notArray, startDir, now)).toBeNull();
    expect(resolveWeeklyUsage(allInvalid, startDir, now)).toBeNull();
  });

  test("drops a malformed model entry while a sibling valid entry survives", () => {
    const now = 1_700_100_000_000;
    const fetchedAt = now / 1000;
    const readFile = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            fetched_at: fetchedAt,
            models: [
              { id: "opus", display_name: "Opus", used_percentage: 55 },
              { id: "sonnet" }, // missing display_name/used_percentage
            ],
          })
        : null;

    const result = resolveWeeklyUsage(readFile, startDir, now);

    expect(result).not.toBeNull();
    expect(result?.models).toEqual([
      { id: "opus", display_name: "Opus", used_percentage: 55 },
    ]);
  });

  test("returns stale: false when age is under 2 hours", () => {
    const now = 1_700_100_000_000;
    const fetchedAt = now / 1000 - 3600; // 1h ago
    const readFile = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            fetched_at: fetchedAt,
            models: [{ id: "opus", display_name: "Opus", used_percentage: 40 }],
          })
        : null;

    const result = resolveWeeklyUsage(readFile, startDir, now);

    expect(result?.stale).toBe(false);
  });

  test("returns stale: true when age is between 2 and 24 hours", () => {
    const now = 1_700_100_000_000;
    const fetchedAt = now / 1000 - 3 * 3600; // 3h ago
    const readFile = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            fetched_at: fetchedAt,
            models: [{ id: "opus", display_name: "Opus", used_percentage: 40 }],
          })
        : null;

    const result = resolveWeeklyUsage(readFile, startDir, now);

    expect(result?.stale).toBe(true);
  });

  test("computes ageSec as Math.max(0, Math.round(now/1000 - fetched_at))", () => {
    const nowFuture = 1_700_100_000_000;
    // fetched_at in the future relative to now -> raw diff negative -> clamped to 0.
    const futureFetchedAt = nowFuture / 1000 + 100;
    const readFileFuture = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            fetched_at: futureFetchedAt,
            models: [{ id: "opus", display_name: "Opus", used_percentage: 40 }],
          })
        : null;

    expect(
      resolveWeeklyUsage(readFileFuture, startDir, nowFuture)?.ageSec,
    ).toBe(0);

    // Fractional diff rounds to the nearest second.
    const now = 1_700_000_000_500;
    const fetchedAt = 1_700_000_000;
    const readFile = (path: string): string | null =>
      path === usagePath
        ? JSON.stringify({
            fetched_at: fetchedAt,
            models: [{ id: "opus", display_name: "Opus", used_percentage: 40 }],
          })
        : null;

    expect(resolveWeeklyUsage(readFile, startDir, now)?.ageSec).toBe(1);
  });
});

describe("formatWeeklyModelSegments", () => {
  test("returns [] when usage is null", () => {
    expect(formatWeeklyModelSegments(null)).toEqual([]);
  });

  test("returns [] when usage.models is empty or not an array", () => {
    expect(
      formatWeeklyModelSegments({ models: [], ageSec: 0, stale: false }),
    ).toEqual([]);
    expect(
      formatWeeklyModelSegments({
        // @ts-expect-error -- exercising a malformed models field defensively
        models: "nope",
        ageSec: 0,
        stale: false,
      }),
    ).toEqual([]);
  });

  test("sorts segments by used_percentage descending regardless of input order", () => {
    const usage = {
      models: [
        { id: "haiku", display_name: "Haiku", used_percentage: 20 },
        { id: "opus", display_name: "Opus", used_percentage: 80 },
        { id: "sonnet", display_name: "Sonnet", used_percentage: 50 },
      ],
      ageSec: 0,
      stale: false,
    };

    const result = formatWeeklyModelSegments(usage);

    expect(result.map((s) => s.id)).toEqual([
      "weekly_opus",
      "weekly_sonnet",
      "weekly_haiku",
    ]);
  });

  test("assigns descending priorities starting at 45", () => {
    const usage = {
      models: [
        { id: "a", display_name: "A", used_percentage: 10 },
        { id: "b", display_name: "B", used_percentage: 90 },
        { id: "c", display_name: "C", used_percentage: 50 },
      ],
      ageSec: 0,
      stale: false,
    };

    const result = formatWeeklyModelSegments(usage);

    expect(result.map((s) => s.priority)).toEqual([45, 44, 43]);
  });

  test("colors a segment green under the warn threshold", () => {
    const usage = {
      models: [{ id: "opus", display_name: "Opus", used_percentage: 65 }],
      ageSec: 0,
      stale: false,
    };

    const [seg] = formatWeeklyModelSegments(usage);

    expect(seg?.text).toContain(GREEN);
    expect(seg?.text).toContain("Opus");
    expect(seg?.text).toContain("65%");
  });

  test("colors a segment yellow between the warn and high thresholds", () => {
    const usage = {
      models: [{ id: "opus", display_name: "Opus", used_percentage: 78 }],
      ageSec: 0,
      stale: false,
    };

    const [seg] = formatWeeklyModelSegments(usage);

    expect(seg?.text).toContain(YELLOW);
    expect(seg?.text).toContain("Opus");
    expect(seg?.text).toContain("78%");
  });

  test("colors a segment red at or above the high threshold", () => {
    const usage = {
      models: [{ id: "opus", display_name: "Opus", used_percentage: 95 }],
      ageSec: 0,
      stale: false,
    };

    const [seg] = formatWeeklyModelSegments(usage);

    expect(seg?.text).toContain(RED);
    expect(seg?.text).toContain("Opus");
    expect(seg?.text).toContain("95%");
  });

  test("appends a trailing dim age segment with the correct duration text when stale", () => {
    const ageSec = 8100; // 2h15m
    const usage = {
      models: [
        { id: "opus", display_name: "Opus", used_percentage: 40 },
        { id: "sonnet", display_name: "Sonnet", used_percentage: 30 },
      ],
      ageSec,
      stale: true,
    };

    const result = formatWeeklyModelSegments(usage);

    expect(formatDuration(ageSec)).toBe("2h15m");
    expect(result).toHaveLength(3);
    const ageSeg = result[2];
    expect(ageSeg?.text).toContain(DIM);
    expect(ageSeg?.text).toContain(RESET);
    expect(ageSeg?.text).toContain("old");
    expect(ageSeg?.text).toContain("2h15m");
    expect(ageSeg?.priority).toBe(45 - 2);
  });

  test("does not append an age segment when fresh", () => {
    const usage = {
      models: [
        { id: "opus", display_name: "Opus", used_percentage: 40 },
        { id: "sonnet", display_name: "Sonnet", used_percentage: 30 },
      ],
      ageSec: 100,
      stale: false,
    };

    const result = formatWeeklyModelSegments(usage);

    expect(result).toHaveLength(2);
  });
});

describe("buildModelRow weekly-usage integration", () => {
  test("wires env.weeklyUsage through to the rendered model row", () => {
    const payload = { model: { display_name: "Sonnet 5" } };
    const env = {
      weeklyUsage: {
        models: [
          { id: "opus", display_name: "Opus", used_percentage: 62 },
          { id: "sonnet", display_name: "Sonnet", used_percentage: 30 },
        ],
        ageSec: 100,
        stale: false,
      },
    };

    const result = buildModelRow(payload, env, 200);

    expect(result).toContain("Opus");
    expect(result).toContain("62%");
  });
});
