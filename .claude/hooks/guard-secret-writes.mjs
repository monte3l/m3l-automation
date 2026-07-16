#!/usr/bin/env node
/**
 * PreToolUse blocking (Write|Edit): refuse to write a real secret to disk.
 *
 * CLAUDE.md § Security and § Forbidden Patterns require that no secret or token
 * ever land in source, tests, or fixtures, and explicitly suggest backing that
 * rule with a PreToolUse hook. The CI `gitleaks` scan (ci.yml) is the backstop;
 * this hook is the earlier, write-time block so a credential never reaches the
 * working tree — where it would linger in git reflog/objects even after a fix.
 *
 * Two independent triggers, both hard-block (exit 2):
 *   1. Path: a dotenv file (`.env`, `.env.local`, …) — these are gitignored
 *      secret stores and should never be authored by the agent. Template
 *      variants (`.env.example`/`.sample`/`.template`/`.dist`) are allowed.
 *   2. Content: a known secret-key assignment carrying a *real* value, or a
 *      recognised high-entropy token/private-key literal. References and
 *      placeholders (`${{ secrets.X }}`, `process.env.X`, `<your-token>`, …)
 *      are NOT flagged — the point is to catch values, not names.
 *
 * Detection is deliberately conservative: prefix-anchored token shapes and
 * placeholder exclusion keep false positives off legitimate config/docs (e.g.
 * `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in a workflow).
 */
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Env-var names whose assigned *value* is a secret we must never persist. */
export const SECRET_KEYS = [
  "NPM_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
  "GITLEAKS_LICENSE",
  "CONTEXT7_API_KEY",
];

// High-signal literal shapes — a match is almost certainly a real credential.
const TOKEN_LITERALS = [
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub personal access token
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, // GitHub fine-grained PAT
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm automation token
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bctx7sk-[A-Za-z0-9-]{20,}\b/, // Context7 API key (MCP config, ADR-0030)
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, // PEM private key
];

/**
 * A value is a placeholder/reference, not a real secret, when it defers to an
 * env var or CI secret, or is an obvious dummy. Such values must not be flagged.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholderValue(value) {
  const v = value.trim().replace(/^["']|["']$/g, "");
  if (v.length === 0) return true;
  if (/\$\{|\$\(|process\.env|secrets\.|env\./.test(v)) return true; // reference
  if (/^<.*>$/.test(v)) return true; // <your-token>
  if (
    /(example|placeholder|changeme|your[-_]|xxx+|dummy|fake|redacted)/i.test(v)
  )
    return true;
  // Too short / low-entropy to be a real token.
  return v.length < 16;
}

/**
 * True when the basename is a real dotenv file (not a committed template).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isEnvFilePath(filePath) {
  const base = path.basename(filePath);
  if (!/^\.env(\.|$)/.test(base)) return false;
  return !/\.(example|sample|template|dist)$/.test(base);
}

/**
 * Scan `content` for secret-key assignments carrying a real value or for a
 * recognised token/private-key literal. Returns a human-readable reason per
 * match (empty array when clean).
 *
 * @param {string} content
 * @returns {string[]}
 */
export function findSecrets(content) {
  const hits = [];

  for (const key of SECRET_KEYS) {
    // KEY = value  or  KEY: value  (env/yaml/json-ish), value runs to EOL.
    const re = new RegExp(`\\b${key}\\b\\s*[:=]\\s*(.+)`, "g");
    for (const m of content.matchAll(re)) {
      if (!isPlaceholderValue(m[1]))
        hits.push(`${key} assigned a literal value`);
    }
  }

  for (const re of TOKEN_LITERALS) {
    if (re.test(content))
      hits.push(`recognised token/key literal (${re.source})`);
  }

  return hits;
}

/**
 * Combined verdict for a write. Returns the block reasons (empty when allowed).
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {string[]}
 */
export function isSecretWrite(filePath, content) {
  const reasons = [];
  if (isEnvFilePath(filePath)) {
    reasons.push(`writing a dotenv secret file (${path.basename(filePath)})`);
  }
  reasons.push(...findSecrets(content ?? ""));
  return reasons;
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path ?? "";
  if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

  // Content by field presence (Write → content, Edit → new_string), matching
  // the sibling-hook convention so the guard stays live if tool_name is absent.
  const ti = input.tool_input ?? {};
  const content =
    typeof ti.content === "string"
      ? ti.content
      : typeof ti.new_string === "string"
        ? ti.new_string
        : "";

  const reasons = isSecretWrite(filePath, content);
  if (reasons.length === 0) process.exit(0);

  process.stderr.write(`\
[guard-secret-writes] Blocked write to ${filePath}:
${reasons.map((r) => `  - ${r}`).join("\n")}

Secrets and tokens must never be written to the working tree — they persist in
git objects/reflog even after removal (CLAUDE.md § Security). Use a CI secret or
an env var reference instead of a literal value, and keep real dotenv files out
of the repo (.env* is gitignored; author .env.example with placeholders).
`);
  process.exit(2);
}
