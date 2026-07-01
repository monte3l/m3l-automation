import * as path from "node:path";

/**
 * Builds an OS-native absolute path from segments, for use as a fake
 * filesystem root in tests. `path.resolve(path.sep, ...)` yields
 * `/fake/monorepo` on POSIX and a real drive-rooted path (e.g.
 * `C:\fake\monorepo`) on Windows, matching whatever the production code's
 * own `path.join`/`path.resolve` calls produce on that OS — so fixtures
 * never hardcode a POSIX-only separator.
 */
export function fakeRoot(...segments: readonly string[]): string {
  return path.resolve(path.sep, ...segments);
}
