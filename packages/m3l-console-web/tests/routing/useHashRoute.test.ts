import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { M3LRoute } from "../../src/routing/useHashRoute.js";
import {
  parseHashRoute,
  routeToHash,
  useHashRoute,
} from "../../src/routing/useHashRoute.js";

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("parseHashRoute", () => {
  test.each<[string, M3LRoute]>([
    ["#/scripts", { kind: "scripts" }],
    ["#/scripts/json-etl", { kind: "script", name: "json-etl" }],
    ["#/runs", { kind: "runs" }],
    [
      "#/runs/0193f0c2-1234-7abc-9def-000000000000",
      { kind: "run", id: "0193f0c2-1234-7abc-9def-000000000000" },
    ],
    ["#/sessions", { kind: "sessions" }],
    [
      "#/sessions/0193f0c2-1234-7abc-9def-000000000000",
      { kind: "session", id: "0193f0c2-1234-7abc-9def-000000000000" },
    ],
  ])("parses %s into %o", (hash, expected) => {
    expect(parseHashRoute(hash)).toEqual(expected);
  });

  test.each<string>(["", "#", "#/", "#/unknown", "#nope"])(
    "falls back to the scripts route for %j",
    (hash) => {
      expect(parseHashRoute(hash)).toEqual({ kind: "scripts" });
    },
  );

  test("falls back to scripts when a :name segment fails the kebab-case pattern", () => {
    expect(parseHashRoute("#/scripts/Not_Valid")).toEqual({
      kind: "scripts",
    });
  });

  test("falls back to scripts when a :name segment starts with a digit", () => {
    expect(parseHashRoute("#/scripts/123abc")).toEqual({ kind: "scripts" });
  });

  test("falls back to scripts when a successfully decoded :name still fails the pattern", () => {
    // %20 decodes cleanly to a space, which the anchored pattern rejects —
    // this exercises the regex guard independent of the decode-failure path.
    expect(parseHashRoute("#/scripts/my%20script")).toEqual({
      kind: "scripts",
    });
  });

  test("falls back to scripts when the :name segment has a malformed escape that throws in decodeURIComponent", () => {
    expect(parseHashRoute("#/scripts/%ZZ")).toEqual({ kind: "scripts" });
  });

  test("falls back to scripts when the :id segment has a malformed escape that throws in decodeURIComponent", () => {
    expect(parseHashRoute("#/runs/%ZZ")).toEqual({ kind: "scripts" });
  });

  test("falls back to scripts when the :id segment is empty", () => {
    expect(parseHashRoute("#/runs/")).toEqual({ kind: "scripts" });
  });

  test("falls back to scripts when the :id segment contains a slash", () => {
    expect(parseHashRoute("#/runs/abc/def")).toEqual({ kind: "scripts" });
  });

  test("accepts a :id segment containing characters the :name pattern would reject", () => {
    // :id is validated as a non-empty string with no "/", not the kebab-case
    // pattern used for :name — a UUID's hyphens and digits must not be
    // mistaken for the stricter :name rule.
    expect(parseHashRoute("#/runs/ABC-123_xyz")).toEqual({
      kind: "run",
      id: "ABC-123_xyz",
    });
  });

  // #/sessions/:id follows exactly the same id-validation rules as
  // #/runs/:id — mirrored one-for-one below rather than sharing a
  // parameterized table with the runs cases above, since this extends the
  // existing runs-shaped assertions in place rather than introducing a new
  // describe block.
  test("falls back to scripts when the session :id segment has a malformed escape that throws in decodeURIComponent", () => {
    expect(parseHashRoute("#/sessions/%ZZ")).toEqual({ kind: "scripts" });
  });

  test("falls back to scripts when the session :id segment is empty", () => {
    expect(parseHashRoute("#/sessions/")).toEqual({ kind: "scripts" });
  });

  test("falls back to scripts when the session :id segment contains a slash", () => {
    expect(parseHashRoute("#/sessions/abc/def")).toEqual({ kind: "scripts" });
  });

  test("falls back to scripts when the session route has more than 2 segments", () => {
    expect(parseHashRoute("#/sessions/abc/def/ghi")).toEqual({
      kind: "scripts",
    });
  });

  test("accepts a session :id segment containing characters the :name pattern would reject", () => {
    expect(parseHashRoute("#/sessions/ABC-123_xyz")).toEqual({
      kind: "session",
      id: "ABC-123_xyz",
    });
  });
});

describe("routeToHash", () => {
  test.each<M3LRoute>([
    { kind: "scripts" },
    { kind: "script", name: "json-etl" },
    { kind: "runs" },
    { kind: "run", id: "0193f0c2-1234-7abc-9def-000000000000" },
    { kind: "sessions" },
    { kind: "session", id: "0193f0c2-1234-7abc-9def-000000000000" },
  ])("round-trips through parseHashRoute for %o", (route) => {
    expect(parseHashRoute(routeToHash(route))).toEqual(route);
  });
});

describe("useHashRoute", () => {
  test("reads the initial route from location.hash on mount", () => {
    window.location.hash = "#/runs";

    const { result } = renderHook(() => useHashRoute());

    expect(result.current.route).toEqual({ kind: "runs" });
  });

  test("falls back to the scripts route when location.hash is empty on mount", () => {
    const { result } = renderHook(() => useHashRoute());

    expect(result.current.route).toEqual({ kind: "scripts" });
  });

  test("subscribes to hashchange on mount", () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    renderHook(() => useHashRoute());

    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "hashchange",
      expect.any(Function),
    );
  });

  test("unsubscribes from hashchange on unmount with the same listener reference", () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useHashRoute());
    const registeredCall = addEventListenerSpy.mock.calls.find(
      ([eventName]) => eventName === "hashchange",
    );
    expect(registeredCall).toBeDefined();
    const handler = registeredCall?.[1];

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith("hashchange", handler);
  });

  test("updates route when a hashchange event fires after the hash changes", () => {
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.route).toEqual({ kind: "scripts" });

    act(() => {
      window.location.hash = "#/runs";
      window.dispatchEvent(new Event("hashchange"));
    });

    expect(result.current.route).toEqual({ kind: "runs" });
  });

  test("navigate sets location.hash via routeToHash", () => {
    const { result } = renderHook(() => useHashRoute());

    act(() => {
      result.current.navigate({ kind: "script", name: "json-etl" });
    });

    expect(window.location.hash).toBe(
      routeToHash({
        kind: "script",
        name: "json-etl",
      }),
    );
  });

  test("navigate does not update route directly — only the hashchange listener does", () => {
    // Intercept addEventListener so the hook's own hashchange subscription
    // never actually attaches to window. If navigate() called setState
    // directly (bypassing the listener), route would still flip below; the
    // contract requires the hashchange listener to be the single source of
    // truth, so route must remain unchanged when that listener is absent.
    vi.spyOn(window, "addEventListener").mockImplementation(() => {
      // no-op: deliberately withhold the real registration
    });

    const { result } = renderHook(() => useHashRoute());
    expect(result.current.route).toEqual({ kind: "scripts" });

    act(() => {
      result.current.navigate({ kind: "runs" });
    });

    expect(window.location.hash).toBe("#/runs");
    expect(result.current.route).toEqual({ kind: "scripts" });
  });
});
