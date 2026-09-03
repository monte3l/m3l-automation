#!/usr/bin/env node
// Builds both console images and plays console-pod.yaml under rootless
// Podman (ADR-0091). Kubernetes YAML has no `${VAR:?message}`-style host
// interpolation the way compose.yaml had, so this script does the two jobs
// compose used to do for free: validate the operator env vars and resolve
// the two host-specific hostPath tokens (`__DATA_DIR__`, `__AWS_DIR__`)
// before handing the manifest to `podman kube play`.
//
// `--network pasta` and `--userns keep-id` are not optional conveniences —
// ADR-0091's spike found rootless Podman fails to network at all without one
// (no `nft` binary, the default netavark backend's dependency) and fails to
// boot the server without the other (rootless Podman does not map container
// uid 1000 to the host user's uid by default) — both with failure modes that
// give no hint a flag is the fix. Baking them in here means an operator
// never has to rediscover either.
//
// Usage:
//   pnpm console:up
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

const operatorName = (process.env.M3L_CONSOLE_OPERATOR_NAME ?? "").trim();
if (!operatorName) {
  console.error(
    "✗  console:up: M3L_CONSOLE_OPERATOR_NAME must be set (e.g. `export " +
      'M3L_CONSOLE_OPERATOR_NAME="Jane Operator"`) — the console server ' +
      "refuses to boot without it (ADR-0071).",
  );
  process.exit(1);
}
const operatorEmail = process.env.M3L_CONSOLE_OPERATOR_EMAIL ?? "";

const home = process.env.HOME;
if (!home) {
  console.error(
    "✗  console:up: HOME must be set to locate your AWS SSO credential " +
      "chain (~/.aws is mounted read-only into the server container).",
  );
  process.exit(1);
}
const awsDir = join(home, ".aws");
if (!existsSync(awsDir)) {
  console.error(
    `✗  console:up: ${awsDir} does not exist. Run \`aws sso login\` (or ` +
      "create the directory) before starting the console — a script run " +
      "inside the pod resolves AWS credentials from this mount.",
  );
  process.exit(1);
}

const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: root });
}

console.log("→  Building m3l-console-server image ...");
run("podman", [
  "build",
  "-f",
  "packages/m3l-console-server/Containerfile",
  "-t",
  "localhost/m3l-console-server:local",
  ".",
]);

console.log("→  Building m3l-console-web image ...");
run("podman", [
  "build",
  "-f",
  "packages/m3l-console-web/Containerfile",
  "-t",
  "localhost/m3l-console-web:local",
  ".",
]);

const workDir = mkdtempSync(join(tmpdir(), "m3l-console-pod-"));

const podManifest = readFileSync(join(root, "console-pod.yaml"), "utf8")
  .replaceAll("__DATA_DIR__", dataDir)
  .replaceAll("__AWS_DIR__", awsDir);
const podPath = join(workDir, "console-pod.yaml");
writeFileSync(podPath, podManifest);

// A generated ConfigMap is the documented `podman kube play --configmap`
// mechanism for getting host env values into a static Kube manifest — the
// values are JSON-string-encoded, which is also valid YAML flow-scalar
// syntax, so no separate YAML-escaping logic is needed.
const configMap = [
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: console-env",
  "data:",
  `  M3L_CONSOLE_OPERATOR_NAME: ${JSON.stringify(operatorName)}`,
  `  M3L_CONSOLE_OPERATOR_EMAIL: ${JSON.stringify(operatorEmail)}`,
  "",
].join("\n");
const configMapPath = join(workDir, "console-env.configmap.yaml");
writeFileSync(configMapPath, configMap);

console.log("→  Playing console-pod.yaml ...");
run("podman", [
  "kube",
  "play",
  "--replace",
  "--network",
  "pasta",
  "--userns",
  "keep-id",
  "--configmap",
  configMapPath,
  podPath,
]);

console.log(
  "\n✓  Console pod running. http://127.0.0.1:8080 (nginx) proxies " +
    "/health, /ready, and /api to the server. `pnpm console:down` to stop.",
);
