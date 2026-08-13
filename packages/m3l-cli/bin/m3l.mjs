#!/usr/bin/env node
// Process entry for the m3l CLI. Kept outside src/ so every TypeScript
// module stays import-inert (fully exercisable under the per-file coverage
// gate); this wrapper is the only place that touches process.argv.
const { runCli } = await import("../dist/main.js");
process.exitCode = await runCli(process.argv.slice(2));
