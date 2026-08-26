#!/usr/bin/env node
// Validates that the ADR-0009 dependency-direction guards in eslint.config.js
// are present and correctly shaped: the `import-x/no-restricted-paths` zones
// plus the repo-wide `import-x/no-cycle` rule (ADR-0035 A8). Both are
// self-enforcing via `pnpm lint`, but only when they exist: if a zone block or
// the cycle rule is accidentally deleted or weakened, `pnpm lint` still passes
// (there is nothing left to catch), so the layering regression is SILENT. This
// structural check (the analogue of check:hooks / check:agents) fails CI
// instead.
//
// It inspects the RESOLVED config (imported, not text-matched) for:
//   1. internal/ sealing   — the public barrels may not import src/internal (ADR-0004).
//   2. aws island          — aws/** may import only core/errors, core/prompt,
//                            core/polling, core/utils/M3LSingleFlight.ts, and
//                            core/logging/{M3LLogEvent,M3LLogEventCategory}.ts
//                            (ADR-0009, ADR-0040, ADR-0041).
//   3. core/script root    — no other core module may import core/script (ADR-0009).
//   3b. core -> aws ban    — no core/** module may import aws/** (ADR-0009, ADR-0027;
//                            core/procedure, B2/#474, reaches AWS only via an
//                            injected dependency bag, never a static import).
//   4. no-cycle            — packages/m3l-common/src/**/*.ts AND scripts/*/src/**/*.ts
//                            are a DAG, `maxDepth: Infinity` (ADR-0035 A8) — see
//                            eslint.config.js's own comment on why this covers
//                            every shipped module rather than an allowlist of
//                            modules known to be clean.
//   5. script cross-import — one zone per scripts/ directory entry; a script may
//                            import only itself and @m3l-automation/m3l-common,
//                            never a sibling script's src (ADR-0029 backstop).
//   6. prod-not-to-test    — packages/m3l-common/src and scripts/*/src may not
//                            import from a tests/ tree.
//   7. type-stripping zone — scripts/*/src/config.ts bans type-directed emit
//                            (enum, runtime namespace, decorators, parameter
//                            properties) so the m3l CLI's native
//                            type-stripping fallback stays loadable (ADR-0042).
//   8. m3l-cli boundary    — packages/m3l-cli/src may import only
//                            @m3l-automation/m3l-common and node: builtins,
//                            and is covered by the no-cycle rule (ADR-0042).
//   9. console-server      — the same library+node: import boundary (ADR-0065),
//                            the ADR-0065 modular-monolith layering (one zone
//                            per module: errors is a leaf; config/auth/lifecycle
//                            may reach only errors; http may reach errors, auth
//                            and lifecycle but NOT config), its prod-not-to-test
//                            zone, and no-cycle coverage.
//
// Usage:
//   node bin/check-eslint-zones.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { readdirSync } from "node:fs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const configUrl = new URL("../eslint.config.js", import.meta.url);

const configModule = await import(configUrl);
const config = configModule.default;

if (!Array.isArray(config)) {
  reporter.error("eslint.config.js default export is not a config array.", {
    file: "eslint.config.js",
  });
  reporter.finish();
  process.exit(1);
}

// Flatten every `import-x/no-restricted-paths` zone across all config blocks.
const zones = [];
for (const block of config) {
  const rule = block?.rules?.["import-x/no-restricted-paths"];
  if (!Array.isArray(rule)) continue;
  for (const zone of rule[1]?.zones ?? []) zones.push(zone);
}

/** Normalize a zone path: forward slashes, no trailing slash. */
const norm = (value) =>
  String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

let errors = 0;
const requireZone = (label, predicate) => {
  if (!zones.some(predicate)) {
    reporter.error(`missing or malformed ADR-0009 zone: ${label}`, {
      file: "eslint.config.js",
    });
    errors++;
  }
};

requireZone(
  "internal/ sealing (public barrels must not import src/internal)",
  (zone) =>
    norm(zone.from).endsWith("/src/internal") &&
    norm(zone.target).endsWith("/src"),
);

// The aws island's allowed except-set is asserted EXACTLY, not with
// `.includes()` — a subset check would have silently kept passing when
// eslint.config.js widened `except` to add "polling" (2026-07-xx), which is
// how this predicate went stale until this rewrite. An exact set means the
// next widening has to touch this file too, deliberately. Widened again to
// add the single-file exception "utils/M3LSingleFlight.ts" (ADR-0040), then
// again to add the two-file leaf subgraph "logging/M3LLogEvent.ts" and
// "logging/M3LLogEventCategory.ts" (ADR-0041).
const AWS_ISLAND_EXCEPT = [
  "errors",
  "prompt",
  "polling",
  "utils/M3LSingleFlight.ts",
  "logging/M3LLogEvent.ts",
  "logging/M3LLogEventCategory.ts",
];

requireZone(
  `aws island (aws/** may import only core/${AWS_ISLAND_EXCEPT.join(", core/")})`,
  (zone) =>
    norm(zone.target).endsWith("/src/aws") &&
    norm(zone.from).endsWith("/src/core") &&
    Array.isArray(zone.except) &&
    zone.except.length === AWS_ISLAND_EXCEPT.length &&
    AWS_ISLAND_EXCEPT.every((name) => zone.except.includes(name)),
);

requireZone(
  "core/script composition root (no other core module may import core/script)",
  (zone) =>
    norm(zone.target).endsWith("/src/core") &&
    norm(zone.from).endsWith("/src/core/script"),
);

requireZone(
  "core -> aws ban (no core module may import aws/*, the reverse of the aws island)",
  (zone) =>
    norm(zone.target).endsWith("/src/core") &&
    norm(zone.from).endsWith("/src/aws"),
);

// The no-cycle rule isn't a `no-restricted-paths` zone, so it needs its own
// scan: find a config block whose `files` covers both the library's src/**
// and scripts/*/src/** and whose `import-x/no-cycle` rule is set to error
// with `maxDepth: Infinity`.
const hasNoCycleGuard = config.some((block) => {
  const files = Array.isArray(block?.files) ? block.files : [];
  const coversLibrary = files.some((f) =>
    norm(f).endsWith("packages/m3l-common/src/**/*.ts"),
  );
  const coversScripts = files.some((f) =>
    norm(f).endsWith("scripts/*/src/**/*.ts"),
  );
  const coversCli = files.some((f) =>
    norm(f).endsWith("packages/m3l-cli/src/**/*.ts"),
  );
  const coversConsoleServer = files.some((f) =>
    norm(f).endsWith("packages/m3l-console-server/src/**/*.ts"),
  );
  const rule = block?.rules?.["import-x/no-cycle"];
  const [severity, options] = Array.isArray(rule) ? rule : [rule];
  const isError = severity === "error" || severity === 2;
  const isInfiniteDepth = options?.maxDepth === Infinity;
  return (
    coversLibrary &&
    coversScripts &&
    coversCli &&
    coversConsoleServer &&
    isError &&
    isInfiniteDepth
  );
});
if (!hasNoCycleGuard) {
  reporter.error(
    "missing or malformed ADR-0035 guard: import-x/no-cycle over packages/m3l-common/src/**/*.ts, scripts/*/src/**/*.ts, packages/m3l-cli/src/**/*.ts, and packages/m3l-console-server/src/**/*.ts (maxDepth: Infinity)",
    { file: "eslint.config.js" },
  );
  errors++;
}

// ADR-0042: the m3l CLI's discovery fallback executes scripts/*/src/config.ts
// via Node native type-stripping, which cannot run type-directed emit. A
// dedicated no-restricted-syntax zone must ban all four emit-requiring
// constructs — and carry the general scripts block's process.env selector,
// since flat config replaces (not merges) a rule's value and config.ts is
// ignores-excluded from that block.
const TYPE_STRIPPING_SELECTORS = [
  "TSEnumDeclaration",
  "TSModuleDeclaration:not([declare=true])",
  "Decorator",
  "TSParameterProperty",
  "MemberExpression[object.name='process'][property.name='env']",
];
const hasTypeStrippingZone = config.some((block) => {
  const files = Array.isArray(block?.files) ? block.files : [];
  if (!files.some((f) => norm(f).endsWith("scripts/*/src/config.ts"))) {
    return false;
  }
  const rule = block?.rules?.["no-restricted-syntax"];
  if (!Array.isArray(rule)) return false;
  const [severity, ...entries] = rule;
  const isError = severity === "error" || severity === 2;
  const selectors = entries.map((entry) => entry?.selector);
  return (
    isError && TYPE_STRIPPING_SELECTORS.every((sel) => selectors.includes(sel))
  );
});
if (!hasTypeStrippingZone) {
  reporter.error(
    "missing or malformed ADR-0042 guard: no-restricted-syntax type-stripping zone over scripts/*/src/config.ts (enum/namespace/decorator/parameter-property bans + process.env selector)",
    { file: "eslint.config.js" },
  );
  errors++;
}

// ADR-0042: the m3l CLI package's zero-runtime-dependency guarantee — its
// source may import only the library (or a subpath) and node: builtins.
const hasCliImportBoundary = config.some((block) => {
  const files = Array.isArray(block?.files) ? block.files : [];
  if (!files.some((f) => norm(f).endsWith("packages/m3l-cli/src/**/*.ts"))) {
    return false;
  }
  const rule = block?.rules?.["@typescript-eslint/no-restricted-imports"];
  if (!Array.isArray(rule)) return false;
  const [severity, options] = rule;
  const isError = severity === "error" || severity === 2;
  const patterns = Array.isArray(options?.patterns) ? options.patterns : [];
  return (
    isError &&
    patterns.some(
      (pattern) =>
        typeof pattern?.regex === "string" &&
        pattern.regex.includes("@m3l-automation/m3l-common") &&
        pattern.regex.includes("node:") &&
        pattern.allowTypeImports === false,
    )
  );
});
if (!hasCliImportBoundary) {
  reporter.error(
    "missing or malformed ADR-0042 guard: @typescript-eslint/no-restricted-imports boundary over packages/m3l-cli/src/**/*.ts (library + node: builtins only)",
    { file: "eslint.config.js" },
  );
  errors++;
}

// ADR-0065: the console server's dependency budget — its source may import
// only the library (or a subpath) and node: builtins. Adopting the recorded
// routing-framework fallback has to widen this zone deliberately, in the same
// PR as a dated ADR-0065 Update, rather than drifting in silently.
const hasConsoleServerImportBoundary = config.some((block) => {
  const files = Array.isArray(block?.files) ? block.files : [];
  if (
    !files.some((f) =>
      norm(f).endsWith("packages/m3l-console-server/src/**/*.ts"),
    )
  ) {
    return false;
  }
  const rule = block?.rules?.["@typescript-eslint/no-restricted-imports"];
  if (!Array.isArray(rule)) return false;
  const [severity, options] = rule;
  const isError = severity === "error" || severity === 2;
  const patterns = Array.isArray(options?.patterns) ? options.patterns : [];
  return (
    isError &&
    patterns.some(
      (pattern) =>
        typeof pattern?.regex === "string" &&
        pattern.regex.includes("@m3l-automation/m3l-common") &&
        pattern.regex.includes("node:") &&
        pattern.allowTypeImports === false,
    )
  );
});
if (!hasConsoleServerImportBoundary) {
  reporter.error(
    "missing or malformed ADR-0065 guard: @typescript-eslint/no-restricted-imports boundary over packages/m3l-console-server/src/**/*.ts (library + node: builtins only)",
    { file: "eslint.config.js" },
  );
  errors++;
}

// ADR-0065 modular-monolith layering. One zone per module, asserted with an
// EXACT `except` set for the same reason the aws island is: a subset check
// would keep passing after someone widened `except` to let http/ reach
// config/, which is precisely the edge the layering forbids.
//
// `net` is the second leaf: loopback classification is needed by config/ (to
// validate the requested bind host), lifecycle/ (to re-assert it against the
// address actually bound) and http/ (the Host/Origin rebinding guard). Its
// row asserts an except set of exactly ["net"] so it can never quietly grow
// an inbound edge and stop being a leaf.
const CONSOLE_SERVER_LAYERS = [
  ["net", ["net"]],
  ["errors", ["errors"]],
  ["config", ["config", "errors", "net"]],
  ["auth", ["auth", "errors"]],
  ["lifecycle", ["lifecycle", "errors", "net"]],
  ["http", ["http", "errors", "auth", "lifecycle", "net"]],
];

for (const [layer, allowed] of CONSOLE_SERVER_LAYERS) {
  requireZone(
    `console-server layering for src/${layer} (may import only ${allowed.join(", ")})`,
    (zone) =>
      norm(zone.target).endsWith(`packages/m3l-console-server/src/${layer}`) &&
      norm(zone.from).endsWith("packages/m3l-console-server/src") &&
      Array.isArray(zone.except) &&
      zone.except.length === allowed.length &&
      allowed.every((name) => zone.except.includes(name)),
  );
}

requireZone(
  "prod-not-to-test guard for packages/m3l-console-server/src (must not import packages/m3l-console-server/tests)",
  (zone) =>
    norm(zone.target).endsWith("packages/m3l-console-server/src") &&
    norm(zone.from).endsWith("packages/m3l-console-server/tests"),
);

// Toolchain-hardening follow-up: one `no-restricted-paths` zone per
// scripts/ directory entry, forbidding a script from importing any sibling
// script's src via a relative path (ADR-0029 backstop 2). Derived from the
// live scripts/ listing so a newly scaffolded script is required to have its
// own zone rather than silently inheriting none.
const scriptNames = readdirSync(new URL("../scripts/", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const name of scriptNames) {
  requireZone(
    `script cross-import guard for scripts/${name} (may import only itself + @m3l-automation/m3l-common)`,
    (zone) =>
      norm(zone.target).endsWith(`/scripts/${name}`) &&
      norm(zone.from).endsWith("/scripts") &&
      Array.isArray(zone.except) &&
      zone.except.length === 1 &&
      zone.except[0] === name,
  );
}

// Toolchain-hardening follow-up: production source must not import from a
// tests/ tree — one zone for the library, one for scripts/*.
requireZone(
  "prod-not-to-test guard for packages/m3l-common/src (must not import packages/m3l-common/tests)",
  (zone) =>
    norm(zone.target).endsWith("packages/m3l-common/src") &&
    norm(zone.from).endsWith("packages/m3l-common/tests"),
);

requireZone(
  "prod-not-to-test guard for scripts/*/src (must not import scripts/*/tests)",
  // `target`/`from` must carry a trailing `/**` here — a bare `scripts/*/src`
  // contains a glob character (`*`), which routes eslint-plugin-import-x's
  // no-restricted-paths through minimatch instead of prefix-containment, and
  // plain `*` never crosses `/`; without `/**` the zone matches zero real
  // files (found by the toolchain-hardening PR review).
  (zone) =>
    norm(zone.target).endsWith("scripts/*/src/**") &&
    norm(zone.from).endsWith("scripts/*/tests/**"),
);

if (errors > 0) {
  if (!json) {
    console.error(
      `\n✗  ${errors} ADR-0009/ADR-0035 dependency-direction check(s) failed — a zone or the no-cycle rule was removed or reshaped in eslint.config.js.`,
    );
  }
  reporter.finish();
  process.exit(1);
}

reporter.succeed(
  `ADR-0009/ADR-0035 dependency-direction guards intact: internal sealing, aws island, core/script root, no-cycle (${zones.length} zone(s) + no-cycle).`,
);
reporter.finish();
