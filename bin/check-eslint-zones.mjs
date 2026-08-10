#!/usr/bin/env node
// Validates that the ADR-0009 dependency-direction guards in eslint.config.js
// are present and correctly shaped: three `import-x/no-restricted-paths` zones
// plus the repo-wide `import-x/no-cycle` rule (ADR-0035 A8). Both are
// self-enforcing via `pnpm lint`, but only when they exist: if a zone block or
// the cycle rule is accidentally deleted or weakened, `pnpm lint` still passes
// (there is nothing left to catch), so the layering regression is SILENT. This
// structural check (the analogue of check:hooks / check:agents) fails CI
// instead.
//
// It inspects the RESOLVED config (imported, not text-matched) for:
//   1. internal/ sealing — the public barrels may not import src/internal (ADR-0004).
//   2. aws island        — aws/** may import only core/errors, core/prompt,
//                           and core/polling (ADR-0009).
//   3. core/script root   — no other core module may import core/script (ADR-0009).
//   4. no-cycle           — packages/m3l-common/src/**/*.ts is a DAG, `maxDepth:
//                           Infinity` (ADR-0035 A8) — see eslint.config.js's
//                           own comment on why this covers the whole package
//                           rather than an allowlist of modules known to be clean.
//
// Usage:
//   node bin/check-eslint-zones.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";

const configUrl = new URL("../eslint.config.js", import.meta.url);

const configModule = await import(configUrl);
const config = configModule.default;

if (!Array.isArray(config)) {
  console.error("✗  eslint.config.js default export is not a config array.");
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
    console.error(`✗  missing or malformed ADR-0009 zone: ${label}`);
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
// next widening has to touch this file too, deliberately.
const AWS_ISLAND_EXCEPT = ["errors", "prompt", "polling"];

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

// The no-cycle rule isn't a `no-restricted-paths` zone, so it needs its own
// scan: find a config block whose `files` covers the library's src/** and
// whose `import-x/no-cycle` rule is set to error with `maxDepth: Infinity`.
const hasNoCycleGuard = config.some((block) => {
  const files = Array.isArray(block?.files) ? block.files : [];
  const scoped = files.some((f) =>
    norm(f).endsWith("packages/m3l-common/src/**/*.ts"),
  );
  const rule = block?.rules?.["import-x/no-cycle"];
  const [severity, options] = Array.isArray(rule) ? rule : [rule];
  const isError = severity === "error" || severity === 2;
  const isInfiniteDepth = options?.maxDepth === Infinity;
  return scoped && isError && isInfiniteDepth;
});
if (!hasNoCycleGuard) {
  console.error(
    "✗  missing or malformed ADR-0035 guard: import-x/no-cycle over packages/m3l-common/src/**/*.ts (maxDepth: Infinity)",
  );
  errors++;
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} ADR-0009/ADR-0035 dependency-direction check(s) failed — a zone or the no-cycle rule was removed or reshaped in eslint.config.js.`,
  );
  process.exit(1);
}

console.log(
  `✓  ADR-0009/ADR-0035 dependency-direction guards intact: internal sealing, aws island, core/script root, no-cycle (${zones.length} zone(s) + no-cycle).`,
);
