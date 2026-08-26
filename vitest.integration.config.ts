import { defineConfig } from "vitest/config";

// Integration run for tests that bind a real loopback socket, invoked as a
// third pass by `pnpm test` / `pnpm test:coverage` (see package.json)
// alongside vitest.config.ts and vitest.bin.config.ts.
//
// Why this exists: the console server's transport tier has guarantees that
// only a real `node:http` server can demonstrate — that `content-length` is
// the BYTE length rather than the string length (a naive `body.length` passes
// every ASCII assertion and corrupts any multi-byte response), and that a
// failed response write genuinely ends the socket rather than leaving it open
// until the client gives up. Both of those were real defects caught by tests
// of exactly this shape.
//
// Those tests are not unit tests, though, and must not masquerade as them.
// `eslint.config.js`'s `no-restricted-syntax` bans bare `fetch()` in tests
// precisely because a unit test must not make network calls; reaching for
// `node:http`'s own client instead routes around that rule rather than
// satisfying it. So the socket-bound cases live here, under an explicitly
// separate project, and `vitest.config.ts` excludes `**/tests/integration/**`
// so the unit run stays socket-free.
//
// Coverage is deliberately OFF here. The unit run remains the single coverage
// authority: its `perFile` thresholds gate every `packages/*/src` file, and a
// src file must still clear that floor from unit tests alone. Enabling
// coverage here would both double-count those files and clobber
// `coverage/coverage-final.json` (the two existing configs already share that
// directory — the bin pass overwrites the main pass's report, which is why the
// main config has to be re-run alone to inspect per-file numbers). These tests
// earn their place as a correctness gate, not as a way to reach a threshold.
export default defineConfig({
  test: {
    include: ["**/tests/integration/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**", "**/.claude/worktrees/**"],
    coverage: {
      enabled: false,
    },
  },
});
