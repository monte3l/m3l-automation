#!/usr/bin/env node
// Tears down the console pod started by `pnpm console:up` (ADR-0091).
// `podman kube down` matches resources by name from the manifest it's given
// — it needs no host-specific values resolved, so it runs directly against
// the committed console-pod.yaml rather than console-up.mjs's substituted
// temp copy.
//
// Usage:
//   pnpm console:down
import process from "node:process";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

try {
  execFileSync("podman", ["kube", "down", "console-pod.yaml"], {
    stdio: "inherit",
    cwd: root,
  });
} catch (cause) {
  console.error(
    "✗  console:down: `podman kube down` failed (see the error above). " +
      "Check `podman pod ps` for the pod's actual state.",
  );
  process.exit(
    cause instanceof Error && "status" in cause ? Number(cause.status) || 1 : 1,
  );
}

console.log("✓  Console pod stopped.");
