import { describe, expect, test } from "vitest";
import {
  findSecrets,
  isEnvFilePath,
  isSecretWrite,
  SECRET_KEYS,
} from "../../.claude/hooks/guard-secret-writes.mjs";

// Fake, structurally-valid-but-not-real tokens used only as detector fixtures.
const FAKE_GH_PAT = `ghp_${"a1B2c3D4e5F6".repeat(3)}`; // ghp_ + 36 chars
const FAKE_NPM = `npm_${"z9Y8x7W6v5U4".repeat(3)}`; // npm_ + 36 chars
const FAKE_AKIA = "AKIA1234567890ABCDEF"; // AKIA + 16 chars
const FAKE_CTX7 = `ctx7sk-${"0000aaaa-1111-2222-3333-bbbb4444cccc"}`; // ctx7sk- + 36 chars, fake

describe("isEnvFilePath", () => {
  test("flags a bare .env file", () => {
    expect(isEnvFilePath("/repo/.env")).toBe(true);
  });

  test("flags a .env.local variant", () => {
    expect(isEnvFilePath("packages/x/.env.local")).toBe(true);
  });

  test("allows committed template variants", () => {
    expect(isEnvFilePath(".env.example")).toBe(false);
    expect(isEnvFilePath(".env.sample")).toBe(false);
    expect(isEnvFilePath(".env.template")).toBe(false);
  });

  test("ignores unrelated files", () => {
    expect(isEnvFilePath("src/environment.ts")).toBe(false);
    expect(isEnvFilePath("README.md")).toBe(false);
  });
});

describe("findSecrets", () => {
  test("clean content returns no hits", () => {
    expect(findSecrets("const answer = 42;")).toEqual([]);
  });

  test("flags a secret key assigned a real literal value", () => {
    expect(findSecrets(`NPM_TOKEN=${"a1B2c3D4e5F6g7H8"}`)).not.toEqual([]);
  });

  test("does NOT flag a CI-secret reference", () => {
    expect(findSecrets("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}")).toEqual(
      [],
    );
  });

  test("does NOT flag a process.env reference", () => {
    expect(findSecrets("const t = process.env.NPM_TOKEN;")).toEqual([]);
  });

  test("does NOT flag a placeholder value", () => {
    expect(findSecrets("AWS_SECRET_ACCESS_KEY=<your-secret-here>")).toEqual([]);
    expect(findSecrets("NPM_TOKEN=changeme")).toEqual([]);
  });

  test("flags recognised token literals by shape", () => {
    expect(findSecrets(`token: "${FAKE_GH_PAT}"`)).not.toEqual([]);
    expect(findSecrets(`token: "${FAKE_NPM}"`)).not.toEqual([]);
    expect(findSecrets(`id = ${FAKE_AKIA}`)).not.toEqual([]);
    expect(findSecrets(`"CONTEXT7_API_KEY": "${FAKE_CTX7}"`)).not.toEqual([]);
  });

  test("flags a PEM private key block", () => {
    expect(
      findSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n"),
    ).not.toEqual([]);
  });

  test("does NOT flag the secretless .mcp.json env-expansion shape", () => {
    expect(findSecrets('"CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"')).toEqual(
      [],
    );
  });

  test("every known secret key is covered", () => {
    for (const key of SECRET_KEYS) {
      expect(findSecrets(`${key}=a1B2c3D4e5F6g7H8i9`)).not.toEqual([]);
    }
  });
});

describe("isSecretWrite", () => {
  test("blocks a dotenv file even when content is empty", () => {
    expect(isSecretWrite(".env", "")).not.toEqual([]);
  });

  test("allows an ordinary source write", () => {
    expect(isSecretWrite("src/index.ts", "export const x = 1;")).toEqual([]);
  });

  test("allows a template file with placeholder content", () => {
    expect(isSecretWrite(".env.example", "NPM_TOKEN=<set-in-ci>")).toEqual([]);
  });
});
