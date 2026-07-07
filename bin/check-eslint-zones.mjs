#!/usr/bin/env node
// Validates that the ADR-0009 dependency-direction zones in eslint.config.js are
// present and correctly shaped. These `import-x/no-restricted-paths` zones are
// self-enforcing via `pnpm lint`, but only when they exist: if a zone block is
// accidentally deleted or weakened, `pnpm lint` still passes (there is nothing
// left to catch), so the layering regression is SILENT. This structural check
// (the analogue of check:hooks / check:agents) fails CI instead.
//
// It inspects the RESOLVED config (imported, not text-matched) for three zones:
//   1. internal/ sealing — the public barrels may not import src/internal (ADR-0004).
//   2. aws island        — aws/** may import only core/errors + core/prompt (ADR-0009).
//   3. core/script root   — no other core module may import core/script (ADR-0009).
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

requireZone(
  'aws island (aws/** may import only core/errors + core/prompt; except ["errors","prompt"])',
  (zone) =>
    norm(zone.target).endsWith("/src/aws") &&
    norm(zone.from).endsWith("/src/core") &&
    Array.isArray(zone.except) &&
    zone.except.includes("errors") &&
    zone.except.includes("prompt"),
);

requireZone(
  "core/script composition root (no other core module may import core/script)",
  (zone) =>
    norm(zone.target).endsWith("/src/core") &&
    norm(zone.from).endsWith("/src/core/script"),
);

if (errors > 0) {
  console.error(
    `\n✗  ${errors} ADR-0009 dependency-zone check(s) failed — a zone was removed or reshaped in eslint.config.js.`,
  );
  process.exit(1);
}

console.log(
  `✓  ADR-0009 dependency zones intact: internal sealing, aws island, core/script root (${zones.length} zone(s) total).`,
);
