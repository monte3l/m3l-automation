#!/usr/bin/env node
// Validates the Claude Code hook wiring in .claude/settings.json:
//   1. Every hook `command` that runs a .claude/hooks/*.mjs script resolves to a
//      file that actually exists (a typo or a renamed/deleted hook is an error).
//   2. No orphans: every .claude/hooks/*.mjs file is referenced by at least one
//      hook command (a hook written but never wired is dead — warned, not fatal,
//      mirroring check-agents.mjs's unused-agent warning).
//
// This is the hook-side analogue of check:agents. New hooks (the signed-push
// Bash guard, the decision-gate injector) get a safety net so a wiring mistake
// fails CI instead of silently doing nothing.
//
// Usage:
//   node bin/check-hooks.mjs   # exits 0 on success, 1 on any violation
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const settingsPath = join(root, ".claude/settings.json");
const hooksDir = join(root, ".claude/hooks");

let errors = 0;

// --- Collect the hook scripts referenced by settings.json ------------------
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const referenced = new Set();

for (const entries of Object.values(settings.hooks ?? {})) {
  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      const command = hook.command ?? "";
      // Pull out .claude/hooks/<name>.mjs regardless of the $CLAUDE_PROJECT_DIR
      // prefix / quoting around it.
      const m = command.match(/\.claude\/hooks\/([A-Za-z0-9._-]+\.mjs)/);
      if (m === null) continue;
      const name = m[1];
      referenced.add(name);
      if (!existsSync(join(hooksDir, name))) {
        console.error(
          `✗  .claude/settings.json wires "${name}" but ` +
            `.claude/hooks/${name} does not exist.`,
        );
        errors++;
      }
    }
  }
}

// --- Warn on hook files that exist but are never wired ---------------------
const onDisk = existsSync(hooksDir)
  ? readdirSync(hooksDir).filter((n) => n.endsWith(".mjs"))
  : [];

for (const name of onDisk) {
  if (!referenced.has(basename(name))) {
    console.warn(
      `⚠  .claude/hooks/${name} exists but is not wired into ` +
        `.claude/settings.json (dead hook?).`,
    );
  }
}

if (errors > 0) {
  console.error(`\n✗  ${errors} hook wiring violation(s).`);
  process.exit(1);
}

console.log(
  `✓  ${referenced.size} wired hooks valid: every referenced script exists.`,
);
