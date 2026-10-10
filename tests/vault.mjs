import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decryptCredentials,
  findAutoClawRuntimeCatalogs,
  findAutoClawVaults,
  isJwtExpired,
  parseJwtPayload,
  syncTokenToHeadersFile,
} from "../lib/vault.js";
import { createTokenLayer, loadConfig } from "../lib/core.js";

test("parseJwtPayload extracts claims from valid JWTs", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
  const payload = Buffer.from(JSON.stringify({ user_id: 12345, exp: 1999999999, email: "test@example.com" })).toString("base64");
  const fakeJwt = `${header}.${payload}.signature`;

  const parsed = parseJwtPayload(`Bearer ${fakeJwt}`);
  assert.equal(parsed?.user_id, 12345);
  assert.equal(parsed?.email, "test@example.com");

  const parsedRaw = parseJwtPayload(fakeJwt);
  assert.equal(parsedRaw?.user_id, 12345);

  assert.equal(parseJwtPayload("invalid-token"), null);
  assert.equal(parseJwtPayload(null), null);
});

test("isJwtExpired correctly identifies expired vs valid tokens", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64");

  // Token expired in the past
  const pastExp = Math.floor(Date.now() / 1000) - 300;
  const expiredPayload = Buffer.from(JSON.stringify({ exp: pastExp })).toString("base64");
  const expiredToken = `Bearer ${header}.${expiredPayload}.sig`;
  assert.equal(isJwtExpired(expiredToken), true);

  // Token valid far into the future
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const validPayload = Buffer.from(JSON.stringify({ exp: futureExp })).toString("base64");
  const validToken = `Bearer ${header}.${validPayload}.sig`;
  assert.equal(isJwtExpired(validToken), false);

  // Non-JWT token is not treated as expired
  assert.equal(isJwtExpired("Bearer non-jwt-token"), false);
});

test("decryptCredentials correctly decrypts v11 OSCrypt payload", () => {
  const password = "test-master-password";
  const plaintext = JSON.stringify({
    schemaVersion: 1,
    accessToken: "Bearer decrypted-secret-token",
    refreshToken: "refresh-123",
  });

  const key = crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);

  const encBuffer = Buffer.concat([Buffer.from("v11", "utf8"), ciphertext]);
  const decrypted = decryptCredentials(encBuffer, password);

  assert.equal(decrypted.accessToken, "Bearer decrypted-secret-token");
  assert.equal(decrypted.refreshToken, "refresh-123");
});

test("syncTokenToHeadersFile atomically writes valid headers format", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-sync-test-"));
  const targetFile = path.join(tmpDir, "request-headers.json");

  syncTokenToHeadersFile("Bearer test-token-123", targetFile);

  assert.ok(fs.existsSync(targetFile));
  const content = JSON.parse(fs.readFileSync(targetFile, "utf8"));
  assert.equal(content?.headers?.["X-Authorization"], "Bearer test-token-123");
  assert.equal(content?.source, "autoclaw-vault-extractor");
});

test("createTokenLayer loads from vault and syncs to token file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-layer-test-"));
  const tokenFile = path.join(tmpDir, "request-headers.json");
  const accountsDir = path.join(tmpDir, "accounts", "test-user");
  fs.mkdirSync(accountsDir, { recursive: true });

  const password = "test-master-password";
  const plaintext = JSON.stringify({
    schemaVersion: 1,
    accessToken: "Bearer mock-vault-token-xyz",
    refreshToken: "mock-refresh-xyz",
  });
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const encBuffer = Buffer.concat([Buffer.from("v11", "utf8"), ciphertext]);
  fs.writeFileSync(path.join(accountsDir, "account-credentials.enc"), encBuffer);

  const prevConfigDir = process.env.AUTOCLAW_CONFIG_DIR;
  const prevKeyringPw = process.env.GLMP_KEYRING_PASSWORD;

  process.env.AUTOCLAW_CONFIG_DIR = tmpDir;
  process.env.GLMP_KEYRING_PASSWORD = password;

  try {
    const config = {
      TOKEN_FILE: tokenFile,
      TOKEN_TTL_MS: 10000,
    };

    const logs = [];
    const log = {
      info: (msg) => logs.push(msg),
      warn: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    };

    const layer = createTokenLayer(config, log);
    const token = layer.getToken();

    assert.equal(token, "Bearer mock-vault-token-xyz");
    assert.ok(fs.existsSync(tokenFile));

    const synced = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.equal(synced.headers["X-Authorization"], "Bearer mock-vault-token-xyz");
  } finally {
    if (prevConfigDir !== undefined) process.env.AUTOCLAW_CONFIG_DIR = prevConfigDir;
    else delete process.env.AUTOCLAW_CONFIG_DIR;
    if (prevKeyringPw !== undefined) process.env.GLMP_KEYRING_PASSWORD = prevKeyringPw;
    else delete process.env.GLMP_KEYRING_PASSWORD;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});
