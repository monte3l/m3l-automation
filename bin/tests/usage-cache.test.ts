import { describe, expect, test, vi } from "vitest";
import { join } from "node:path";

import {
  resolveCredential,
  isCacheFresh,
  normalizeUsageResponse,
  fetchUsage,
} from "../usage-cache.mjs";

describe("resolveCredential", () => {
  const homeDir = "/home/tester";
  const credentialsPath = join(homeDir, ".claude", ".credentials.json");

  test("prefers a non-empty CLAUDE_CODE_OAUTH_TOKEN env var and never reads the credentials file", () => {
    const calls: string[] = [];
    const readFile = (path: string): string | null => {
      calls.push(path);
      return null;
    };

    const result = resolveCredential(
      { CLAUDE_CODE_OAUTH_TOKEN: "env-token-value" },
      readFile,
      homeDir,
    );

    expect(result).toEqual({ source: "env", token: "env-token-value" });
    expect(calls).toEqual([]);
  });

  test("env wins over a credentials file that would otherwise resolve", () => {
    const readFile = (path: string): string | null =>
      path === credentialsPath
        ? JSON.stringify({
            claudeAiOauth: { accessToken: "file-token-value" },
          })
        : null;

    const result = resolveCredential(
      { CLAUDE_CODE_OAUTH_TOKEN: "env-token-value" },
      readFile,
      homeDir,
    );

    expect(result).toEqual({ source: "env", token: "env-token-value" });
  });

  test("falls back to the credentials file when the env var is absent or empty", () => {
    const readFile = (path: string): string | null =>
      path === credentialsPath
        ? JSON.stringify({
            claudeAiOauth: { accessToken: "file-token-value" },
          })
        : null;

    expect(resolveCredential({}, readFile, homeDir)).toEqual({
      source: "credentials-file",
      token: "file-token-value",
    });
    expect(
      resolveCredential({ CLAUDE_CODE_OAUTH_TOKEN: "" }, readFile, homeDir),
    ).toEqual({
      source: "credentials-file",
      token: "file-token-value",
    });
  });

  test("returns null when the credentials file is unreadable", () => {
    const readFile = () => null;

    expect(resolveCredential({}, readFile, homeDir)).toBeNull();
  });

  test("returns null, not throws, when the credentials file contains invalid JSON", () => {
    const readFile = (path: string): string | null =>
      path === credentialsPath ? "{ not json" : null;

    expect(() => resolveCredential({}, readFile, homeDir)).not.toThrow();
    expect(resolveCredential({}, readFile, homeDir)).toBeNull();
  });

  test("returns null when claudeAiOauth is absent or not an object", () => {
    const absent = (path: string): string | null =>
      path === credentialsPath ? JSON.stringify({}) : null;
    const notObject = (path: string): string | null =>
      path === credentialsPath
        ? JSON.stringify({ claudeAiOauth: "nope" })
        : null;

    expect(resolveCredential({}, absent, homeDir)).toBeNull();
    expect(resolveCredential({}, notObject, homeDir)).toBeNull();
  });

  test("returns null when accessToken is absent or not a non-empty string", () => {
    const missing = (path: string): string | null =>
      path === credentialsPath ? JSON.stringify({ claudeAiOauth: {} }) : null;
    const empty = (path: string): string | null =>
      path === credentialsPath
        ? JSON.stringify({ claudeAiOauth: { accessToken: "" } })
        : null;
    const wrongType = (path: string): string | null =>
      path === credentialsPath
        ? JSON.stringify({ claudeAiOauth: { accessToken: 12345 } })
        : null;

    expect(resolveCredential({}, missing, homeDir)).toBeNull();
    expect(resolveCredential({}, empty, homeDir)).toBeNull();
    expect(resolveCredential({}, wrongType, homeDir)).toBeNull();
  });
});

describe("isCacheFresh", () => {
  test("returns true when now - mtimeMs is under the ttl", () => {
    expect(isCacheFresh(1000, 1000 + 500, 1000)).toBe(true);
  });

  test("returns false when now - mtimeMs equals or exceeds the ttl (boundary)", () => {
    expect(isCacheFresh(1000, 1000 + 1000, 1000)).toBe(false);
    expect(isCacheFresh(1000, 1000 + 1500, 1000)).toBe(false);
  });

  test("returns false when mtimeMs is null regardless of now/ttl", () => {
    expect(isCacheFresh(null, 10_000_000, 1000)).toBe(false);
  });

  test("returns false when mtimeMs is not a number", () => {
    expect(isCacheFresh("not-a-number", 10_000_000, 1000)).toBe(false);
  });
});

describe("normalizeUsageResponse", () => {
  test("returns [] for a non-object input", () => {
    expect(normalizeUsageResponse(null)).toEqual([]);
    expect(normalizeUsageResponse("a string")).toEqual([]);
    expect(normalizeUsageResponse(undefined)).toEqual([]);
  });

  test("returns [] when there is no recognizable models array", () => {
    expect(normalizeUsageResponse({})).toEqual([]);
    expect(normalizeUsageResponse({ seven_day: {} })).toEqual([]);
    expect(normalizeUsageResponse({ seven_day: { models: "nope" } })).toEqual(
      [],
    );
  });

  test("normalizes a well-formed top-level models array", () => {
    const result = normalizeUsageResponse({
      models: [
        {
          id: "opus",
          display_name: "Opus",
          used_percentage: 41,
          resets_at: 1_757_260_800,
        },
      ],
    });

    expect(result).toEqual([
      {
        id: "opus",
        display_name: "Opus",
        used_percentage: 41,
        resets_at: 1_757_260_800,
      },
    ]);
  });

  test("extracts models nested under seven_day.models", () => {
    const result = normalizeUsageResponse({
      seven_day: {
        models: [
          {
            id: "sonnet",
            display_name: "Sonnet",
            used_percentage: 33,
          },
        ],
      },
    });

    expect(result).toEqual([
      {
        id: "sonnet",
        display_name: "Sonnet",
        used_percentage: 33,
        resets_at: null,
      },
    ]);
  });

  test("accepts alternate key spellings per field", () => {
    const [byModel] = normalizeUsageResponse({
      models: [{ model: "opus", utilization: 20, reset_at: 1_700_000_000 }],
    });
    const [byModelId] = normalizeUsageResponse({
      models: [{ model_id: "sonnet", name: "Sonnet Label", percentage: 30 }],
    });
    const [bySlug] = normalizeUsageResponse({
      models: [{ slug: "haiku", label: "Haiku Label", used_percentage: 10 }],
    });

    expect(byModel).toEqual({
      id: "opus",
      display_name: "opus", // falls back to id when no name-ish field
      used_percentage: 20,
      resets_at: 1_700_000_000,
    });
    expect(byModelId?.id).toBe("sonnet");
    expect(byModelId?.display_name).toBe("Sonnet Label");
    expect(byModelId?.used_percentage).toBe(30);
    expect(bySlug?.id).toBe("haiku");
    expect(bySlug?.display_name).toBe("Haiku Label");
  });

  test("drops an entry missing both an id-ish and a usable percentage-ish field, keeping a well-formed sibling", () => {
    const result = normalizeUsageResponse({
      models: [
        { id: "opus", display_name: "Opus", used_percentage: 55 },
        { display_name: "No id or usable percentage" },
      ],
    });

    expect(result).toEqual([
      {
        id: "opus",
        display_name: "Opus",
        used_percentage: 55,
        resets_at: null,
      },
    ]);
  });

  test.each([
    [150, 100],
    [-5, 0],
    [41.6, 42],
  ])("clamps and rounds used_percentage %s -> %s", (input, expected) => {
    const [entry] = normalizeUsageResponse({
      models: [{ id: "opus", used_percentage: input }],
    });

    expect(entry?.used_percentage).toBe(expected);
  });

  test("normalizes resets_at from epoch seconds, epoch milliseconds, and ISO-8601", () => {
    const [fromSeconds] = normalizeUsageResponse({
      models: [{ id: "opus", used_percentage: 1, resets_at: 1_757_260_800 }],
    });
    const [fromMillis] = normalizeUsageResponse({
      models: [
        { id: "opus", used_percentage: 1, resets_at: 1_757_260_800_000 },
      ],
    });
    const [fromIso] = normalizeUsageResponse({
      models: [
        {
          id: "opus",
          used_percentage: 1,
          resets_at: "2025-09-07T12:00:00.000Z",
        },
      ],
    });

    expect(fromSeconds?.resets_at).toBe(1_757_260_800);
    expect(fromMillis?.resets_at).toBe(1_757_260_800);
    expect(fromIso?.resets_at).toBe(
      Math.round(Date.parse("2025-09-07T12:00:00.000Z") / 1000),
    );
  });

  test("normalizes resets_at to null for an unparseable string or absent field", () => {
    const [unparseable] = normalizeUsageResponse({
      models: [{ id: "opus", used_percentage: 1, resets_at: "not-a-date" }],
    });
    const [absent] = normalizeUsageResponse({
      models: [{ id: "opus", used_percentage: 1 }],
    });

    expect(unparseable?.resets_at).toBeNull();
    expect(absent?.resets_at).toBeNull();
  });

  test("sorts results by used_percentage descending regardless of input order", () => {
    const result = normalizeUsageResponse({
      models: [
        { id: "a", used_percentage: 10 },
        { id: "b", used_percentage: 90 },
        { id: "c", used_percentage: 50 },
      ],
    });

    expect(result.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  // The real, confirmed `/api/oauth/usage` shape (docs/adr/0092-out-of-band-usage-cache.md,
  // verified via a live call 2026-09-05): per-model weekly entries live in a
  // top-level `limits[]` array alongside session/aggregate entries, not in a
  // flat `models` array. A `limits[]` entry is a per-model weekly entry only
  // when `group === "weekly"` AND `scope.model` is a non-null object — a
  // `weekly_all` aggregate has the same group but `scope: null` and must be
  // excluded, since it duplicates `seven_day` rather than naming a model.
  test("extracts only weekly-group entries with a non-null scope.model, excluding session and weekly_all aggregate entries", () => {
    const result = normalizeUsageResponse({
      five_hour: {
        utilization: 64,
        resets_at: "2026-09-05T01:19:59.743122+00:00",
      },
      seven_day: {
        utilization: 7,
        resets_at: "2026-09-10T10:59:59.743148+00:00",
      },
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 64,
          scope: null,
          resets_at: "2026-09-05T01:19:59.743122+00:00",
          is_active: true,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 7,
          scope: null,
          resets_at: "2026-09-10T10:59:59.743148+00:00",
          is_active: false,
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 12,
          scope: {
            model: { id: "claude-opus-4", display_name: "Opus" },
            surface: null,
          },
          resets_at: null,
          is_active: false,
        },
      ],
    });

    expect(result).toEqual([
      {
        id: "claude-opus-4",
        display_name: "Opus",
        used_percentage: 12,
        resets_at: null,
      },
    ]);
  });

  test("slugifies the display_name into an id when scope.model.id is null", () => {
    const [entry] = normalizeUsageResponse({
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 3,
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          resets_at: null,
          is_active: false,
        },
      ],
    });

    expect(entry?.id).toBe("fable");
    expect(entry?.display_name).toBe("Fable");
  });

  test("uses scope.model.id as-is, not slugified/overridden, when it is non-null", () => {
    const [entry] = normalizeUsageResponse({
      limits: [
        {
          group: "weekly",
          percent: 20,
          scope: {
            model: { id: "Claude-Opus-4", display_name: "Opus" },
            surface: null,
          },
        },
      ],
    });

    expect(entry?.id).toBe("Claude-Opus-4");
  });

  test("reads the percent field (not utilization) as the usage figure from a limits[] entry", () => {
    const [entry] = normalizeUsageResponse({
      limits: [
        {
          group: "weekly",
          percent: 45,
          scope: { model: { id: "sonnet" }, surface: null },
        },
      ],
    });

    expect(entry?.used_percentage).toBe(45);
  });

  test("returns [] when limits is present but has zero qualifying weekly scope.model entries", () => {
    const result = normalizeUsageResponse({
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 64,
          scope: null,
          is_active: true,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 7,
          scope: null,
          is_active: false,
        },
      ],
    });

    expect(result).toEqual([]);
  });

  test("sorts multiple qualifying limits[] entries by usage descending", () => {
    const result = normalizeUsageResponse({
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 99,
          scope: null,
          is_active: true,
        },
        {
          group: "weekly",
          percent: 10,
          scope: { model: { id: "a" }, surface: null },
        },
        {
          group: "weekly",
          percent: 90,
          scope: { model: { id: "b" }, surface: null },
        },
        {
          group: "weekly",
          percent: 50,
          scope: { model: { id: "c" }, surface: null },
        },
      ],
    });

    expect(result.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  // Security-reviewer finding: `scope.model.id`/`display_name` from the
  // undocumented `/api/oauth/usage` response must never reach a rendered
  // statusline segment verbatim (see `sanitizeDisplayText`'s own doc comment).
  describe("sanitizes hostile scope.model.id/display_name before use", () => {
    test("strips an ESC byte and an embedded newline from display_name, leaving only their harmless literal remainder", () => {
      const [entry] = normalizeUsageResponse({
        limits: [
          {
            group: "weekly",
            percent: 12,
            scope: {
              model: {
                id: "claude-opus-4",
                display_name: "Opus\x1b[2J\nINJECTED",
              },
              surface: null,
            },
          },
        ],
      });

      // The ESC byte that would trigger the terminal's "clear screen" control
      // sequence, and the embedded newline, are both removed; the printable
      // "[2J" characters that followed the ESC are not control characters
      // themselves and remain as inert text.
      expect(entry?.display_name).toBe("Opus[2JINJECTED");
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of the ESC/CR/LF control characters the sanitizer strips
      expect(entry?.display_name).not.toMatch(/[\x1b\n\r]/);
    });

    test("clamps a display_name longer than 40 characters to exactly 40", () => {
      const longName = "A".repeat(50);
      const [entry] = normalizeUsageResponse({
        limits: [
          {
            group: "weekly",
            percent: 5,
            scope: {
              model: { id: "opus", display_name: longName },
              surface: null,
            },
          },
        ],
      });

      expect(entry?.display_name).toHaveLength(40);
      expect(entry?.display_name).toBe("A".repeat(40));
    });

    test("strips control characters from a hostile id while leaving a clean display_name untouched", () => {
      const [entry] = normalizeUsageResponse({
        limits: [
          {
            group: "weekly",
            percent: 8,
            scope: {
              model: { id: "\x1bmodel\x07-1", display_name: "Opus" },
              surface: null,
            },
          },
        ],
      });

      expect(entry?.id).toBe("model-1");
      expect(entry?.display_name).toBe("Opus");
    });

    test("falls back the display_name to the id when display_name sanitizes to an empty string but id is valid", () => {
      const [entry] = normalizeUsageResponse({
        limits: [
          {
            group: "weekly",
            percent: 9,
            scope: {
              model: { id: "opus-4", display_name: "\x1b\x07\x1f" },
              surface: null,
            },
          },
        ],
      });

      expect(entry).not.toBeUndefined();
      expect(entry?.id).toBe("opus-4");
      expect(entry?.display_name).toBe("opus-4");
    });

    test("drops the entry entirely when both id and display_name sanitize to an empty string", () => {
      const result = normalizeUsageResponse({
        limits: [
          {
            group: "weekly",
            percent: 9,
            scope: {
              model: { id: "\x1b\x07", display_name: "\x1b\x07\x1f" },
              surface: null,
            },
          },
        ],
      });

      expect(result).toEqual([]);
    });
  });
});

describe("fetchUsage", () => {
  test("returns { status, ok: true, json } on a successful response", async () => {
    const body = { models: [{ id: "opus", used_percentage: 40 }] };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(body),
    });

    const result = await fetchUsage("test-token", fetchImpl);

    expect(result).toEqual({ status: 200, ok: true, json: body });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("usage"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "anthropic-beta": "oauth-2025-04-20",
        }),
      }),
    );
  });

  test("returns { status, ok: false, json: null } on a non-ok response, without reading the body", async () => {
    const jsonSpy = vi.fn().mockResolvedValue({ should: "never be read" });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: jsonSpy,
    });

    const result = await fetchUsage("test-token", fetchImpl);

    expect(result).toEqual({ status: 401, ok: false, json: null });
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  test("returns { status: 0, ok: false, json: null } and does not reject when fetchImpl throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(fetchUsage("test-token", fetchImpl)).resolves.toEqual({
      status: 0,
      ok: false,
      json: null,
    });
  });
});
