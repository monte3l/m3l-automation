#!/usr/bin/env node
// ADR-0088: launches Claude Code already named `<kind>-<slug>`, so naming is
// applied by the harness at process start instead of a user-run `/rename`.
//
//   node bin/claude-launch.mjs                          # on feat/<slug> or
//                                                        # fix/<slug>: derives
//                                                        # kind+slug from the
//                                                        # branch, no other input
//   node bin/claude-launch.mjs --kind audit some-slug    # main-resident kinds
//                                                        # (no branch to derive
//                                                        # from): explicit
//                                                        # kind + slug
//   node bin/claude-launch.mjs -- --resume               # everything after a
//                                                        # literal `--` is
//                                                        # passed through to
//                                                        # the underlying
//                                                        # `claude` call
//
// A session already open before this launcher runs cannot be renamed by it —
// there is no way to inject a launch-time flag into a running process. That
// residual case still needs `/rename <kind>-<slug>` by hand (ADR-0088).
import process from "node:process";
import { execFileSync } from "node:child_process";
import { buildSessionName, deriveFromBranch } from "./lib/session-name.mjs";

const rawArgs = process.argv.slice(2);
const dashIndex = rawArgs.indexOf("--");
const ownArgs = dashIndex === -1 ? rawArgs : rawArgs.slice(0, dashIndex);
const passthrough = dashIndex === -1 ? [] : rawArgs.slice(dashIndex + 1);

const kindIndex = ownArgs.indexOf("--kind");
let kind = null;
if (kindIndex !== -1) {
  kind = ownArgs[kindIndex + 1];
  if (kind === undefined || kind.startsWith("--")) {
    console.error(
      "✗  claude-launch: `--kind` requires a value.\n" +
        "   Usage: pnpm session:launch --kind <kind> <slug>",
    );
    process.exit(1);
  }
  ownArgs.splice(kindIndex, 2);
}
const positionalSlug = ownArgs.find((a) => !a.startsWith("--"));

function currentBranch() {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

let name;
try {
  if (kind !== null) {
    if (!positionalSlug) {
      console.error(
        "✗  claude-launch: `--kind` requires a <slug> positional too.\n" +
          "   Usage: pnpm session:launch --kind <kind> <slug>",
      );
      process.exit(1);
    }
    name = buildSessionName(kind, positionalSlug);
  } else if (positionalSlug) {
    console.error(
      "✗  claude-launch: a <slug> positional needs `--kind <kind>` — a bare " +
        "slug can't be composed into a name without one.\n" +
        "   Usage: pnpm session:launch --kind <kind> <slug>",
    );
    process.exit(1);
  } else {
    const branch = currentBranch();
    const derived = deriveFromBranch(branch);
    if (derived === null) {
      console.error(
        `✗  claude-launch: branch "${branch}" isn't \`feat/<slug>\` or ` +
          "`fix/<slug>`, so a name can't be derived from it.\n" +
          "   Pass the kind and slug explicitly:\n" +
          "   Usage: pnpm session:launch --kind <kind> <slug>",
      );
      process.exit(1);
    }
    name = buildSessionName(derived.kind, derived.slug);
  }
} catch (error) {
  console.error(`✗  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.error(`→  launching \`claude -n ${name}\` ...`);
try {
  execFileSync("claude", ["-n", name, ...passthrough], { stdio: "inherit" });
} catch (error) {
  process.exit(
    typeof error === "object" && error !== null && "status" in error
      ? /** @type {{ status: number | null }} */ (error.status ?? 1)
      : 1,
  );
}
