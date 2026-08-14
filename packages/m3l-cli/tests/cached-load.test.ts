import { afterEach, describe, expect, test, vi } from "vitest";

import { loadParametersCached } from "../src/discovery/cached-load.js";
import { M3LCliError } from "../src/cli/errors.js";
import { loadScriptParameters } from "../src/discovery/load-config.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import {
  configMtimes,
  isCacheEntryFresh,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "../src/discovery/cache.js";
import type { M3LCliDiscoveryCacheEntry } from "../src/discovery/cache.js";

/**
 * Contract: `src/discovery/cached-load.ts` — `loadParametersCached` is the
 * shared freshness-probe -> reuse-or-load -> best-effort-persist scaffolding
 * factored out of `list.resolveRow`/`inspect.resolveParameters` (8d dedup
 * refactor, 8b review CR#4). A fresh cache entry is reused without importing
 * the config module; a stale/missing entry loads via
 * `loadScriptParameters` and best-effort persists the refreshed cache. Every
 * failure (freshness-probe or load) throws an `M3LCliError` with `cause`
 * chained — an already-typed `M3LCliError` propagates unchanged, a raw
 * failure is wrapped. See the pinned contract at `docs/reference/cli.md`.
 */

vi.mock("../src/discovery/load-config.js", () => ({
  loadScriptParameters: vi.fn(),
}));
vi.mock("../src/discovery/cache.js", () => ({
  readDiscoveryCache: vi.fn(),
  writeDiscoveryCache: vi.fn(),
  configMtimes: vi.fn(),
  isCacheEntryFresh: vi.fn(),
}));

const loadScriptParametersMock = vi.mocked(loadScriptParameters);
const readDiscoveryCacheMock = vi.mocked(readDiscoveryCache);
const writeDiscoveryCacheMock = vi.mocked(writeDiscoveryCache);
const configMtimesMock = vi.mocked(configMtimes);
const isCacheEntryFreshMock = vi.mocked(isCacheEntryFresh);

afterEach(() => {
  loadScriptParametersMock.mockReset();
  readDiscoveryCacheMock.mockReset();
  writeDiscoveryCacheMock.mockReset();
  configMtimesMock.mockReset();
  isCacheEntryFreshMock.mockReset();
});

const scriptDirectory = "/workspace/scripts/exporter";
const cacheFilePath = "/workspace/data/cache/m3l-cli/discovery.json";
const freshMtimes = { srcMtimeMs: 100, distMtimeMs: 200 };

const exporterParameters: readonly M3LCliParameterDescriptor[] = [
  {
    name: "region",
    aliases: [],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "AWS region",
  },
];

describe("loadParametersCached — fresh cache entry", () => {
  test("reuses the cached parameters and never calls loadScriptParameters or writeDiscoveryCache", async () => {
    configMtimesMock.mockReturnValue(freshMtimes);
    const cachedEntry: M3LCliDiscoveryCacheEntry = {
      ...freshMtimes,
      parameters: exporterParameters,
    };
    readDiscoveryCacheMock.mockReturnValue({ exporter: cachedEntry });
    isCacheEntryFreshMock.mockReturnValue(true);

    const result = await loadParametersCached(
      "exporter",
      scriptDirectory,
      cacheFilePath,
    );

    expect(result).toEqual(exporterParameters);
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
    expect(writeDiscoveryCacheMock).not.toHaveBeenCalled();
  });
});

describe("loadParametersCached — stale/missing cache entry", () => {
  test("loads and persists when no cache entry exists for the script", async () => {
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({});
    loadScriptParametersMock.mockResolvedValue(exporterParameters);

    const result = await loadParametersCached(
      "exporter",
      scriptDirectory,
      cacheFilePath,
    );

    expect(result).toEqual(exporterParameters);
    expect(loadScriptParametersMock).toHaveBeenCalledWith(scriptDirectory);
    expect(writeDiscoveryCacheMock).toHaveBeenCalledWith(
      cacheFilePath,
      expect.objectContaining({
        exporter: { ...freshMtimes, parameters: exporterParameters },
      }),
    );
  });

  test("reloads when the cached entry is stale (isCacheEntryFresh returns false)", async () => {
    configMtimesMock.mockReturnValue(freshMtimes);
    const staleEntry: M3LCliDiscoveryCacheEntry = {
      srcMtimeMs: 1,
      distMtimeMs: 2,
      parameters: [],
    };
    readDiscoveryCacheMock.mockReturnValue({ exporter: staleEntry });
    isCacheEntryFreshMock.mockReturnValue(false);
    loadScriptParametersMock.mockResolvedValue(exporterParameters);

    const result = await loadParametersCached(
      "exporter",
      scriptDirectory,
      cacheFilePath,
    );

    expect(result).toEqual(exporterParameters);
    expect(isCacheEntryFreshMock).toHaveBeenCalledWith(staleEntry, freshMtimes);
    expect(loadScriptParametersMock).toHaveBeenCalledWith(scriptDirectory);
  });
});

describe("loadParametersCached — freshness probe failure", () => {
  test("wraps a raw configMtimes throw into an M3LCliError with cause chained", async () => {
    readDiscoveryCacheMock.mockReturnValue({});
    const probeError = new Error("EACCES: permission denied");
    configMtimesMock.mockImplementation(() => {
      throw probeError;
    });

    let thrown: unknown;
    try {
      await loadParametersCached("exporter", scriptDirectory, cacheFilePath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).cause).toBe(probeError);
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
  });
});

describe("loadParametersCached — load failure", () => {
  test("wraps a non-M3LCliError loadScriptParameters rejection into an M3LCliError with cause chained", async () => {
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({});
    const loadError = new Error("cannot import config");
    loadScriptParametersMock.mockRejectedValue(loadError);

    let thrown: unknown;
    try {
      await loadParametersCached("exporter", scriptDirectory, cacheFilePath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).cause).toBe(loadError);
  });

  test("propagates an M3LCliError from loadScriptParameters unchanged, not double-wrapped", async () => {
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({});
    const loadError = new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      "cannot import config",
    );
    loadScriptParametersMock.mockRejectedValue(loadError);

    await expect(
      loadParametersCached("exporter", scriptDirectory, cacheFilePath),
    ).rejects.toBe(loadError);
  });
});
