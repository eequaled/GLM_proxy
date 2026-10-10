// Offline tests for the Linux vault discovery + decrypt core (spec/linux-support Task 1).
// Hermetic: every discovery case points AUTOCLAW_CONFIG_DIR at a tmp fixture or
// asserts only the override shape — no real HOME, keyring, or host vault is read.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { check, summary } from "./_helpers.mjs";
import {
  getAutoClawConfigDirs,
  findAutoClawVaults,
  findAutoClawRuntimeCatalogs,
  parseJwtPayload,
  isJwtExpired,
  decryptCredentials,
} from "../lib/vault.js";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeVault(root, accountId, mtimeEpochSec, { profile = true } = {}) {
  const accountDir = path.join(root, "accounts", accountId);
  fs.mkdirSync(accountDir, { recursive: true });
  const encFile = path.join(accountDir, "account-credentials.enc");
  fs.writeFileSync(encFile, "v11-fake-ciphertext");
  const t = new Date(mtimeEpochSec * 1000);
  fs.utimesSync(encFile, t, t);
  if (profile) {
    fs.writeFileSync(path.join(accountDir, "account-profile.json"),
      JSON.stringify({ profile: { displayName: accountId } }));
  }
  return { accountDir, encFile };
}

function makeSnapshot(root, accountId, mtimeEpochSec) {
  const snapDir = path.join(root, "accounts", accountId, "runtime", "model-catalog");
  fs.mkdirSync(snapDir, { recursive: true });
  const file = path.join(snapDir, "remote-snapshot.json");
  fs.writeFileSync(file, JSON.stringify({ models: [] }));
  const t = new Date(mtimeEpochSec * 1000);
  fs.utimesSync(file, t, t);
  return file;
}

function fakeJwt(payloadObj) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
  return `${header}.${payload}.sig`;
}

function encryptV11(plaintextObj, password) {
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintextObj), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from("v11", "utf8"), body]);
}

// ── Discovery ────────────────────────────────────────────────────────────────

{
  const root = tmp("vault-missing-");
  const prev = process.env.AUTOCLAW_CONFIG_DIR;
  process.env.AUTOCLAW_CONFIG_DIR = root;
  try {
    check("no accounts dir → empty vault list, no throw", () => {
      assert.deepEqual(findAutoClawVaults(), []);
    });
    check("no snapshots → empty catalog list", () => {
      assert.deepEqual(findAutoClawRuntimeCatalogs(), []);
    });
  } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmp("vault-override-");
  const other = tmp("vault-override-other-");
  const prev = process.env.AUTOCLAW_CONFIG_DIR;
  process.env.AUTOCLAW_CONFIG_DIR = root;
  try {
    makeVault(other, "ignored-account", 2_000_000_000);
    makeVault(root, "visible-account", 1_000_000_000);

    check("AUTOCLAW_CONFIG_DIR replaces the default roots", () => {
      assert.deepEqual(getAutoClawConfigDirs(), [root]);
    });
    check("vault outside the override dir is not discovered", () => {
      const vaults = findAutoClawVaults();
      assert.equal(vaults.length, 1);
      assert.equal(vaults[0].accountDir, path.join(root, "accounts", "visible-account"));
    });
  } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
}

{
  const root = tmp("vault-order-");
  const prev = process.env.AUTOCLAW_CONFIG_DIR;
  process.env.AUTOCLAW_CONFIG_DIR = root;
  try {
    makeVault(root, "older", 1_000_000_000, { profile: true });
    makeVault(root, "newer", 2_000_000_000, { profile: false });

    check("vaults sort newest-mtime first with the chosen dir observable", () => {
      const vaults = findAutoClawVaults();
      assert.equal(vaults.length, 2);
      assert.equal(vaults[0].accountDir, path.join(root, "accounts", "newer"));
      assert.equal(vaults[1].accountDir, path.join(root, "accounts", "older"));
      assert.ok(vaults[0].mtimeMs >= vaults[1].mtimeMs);
    });
    check("profile file is null when the account has none", () => {
      const vaults = findAutoClawVaults();
      assert.equal(vaults[0].profileFile, null);
      assert.equal(vaults[1].profileFile, path.join(root, "accounts", "older", "account-profile.json"));
    });
    check("runtime catalogs sort newest-first by snapshot mtime", () => {
      makeSnapshot(root, "older", 1_000_000_000);
      makeSnapshot(root, "newer", 2_000_000_000);
      const catalogs = findAutoClawRuntimeCatalogs();
      assert.equal(catalogs.length, 2);
      assert.ok(catalogs[0].endsWith(path.join("accounts", "newer", "runtime", "model-catalog", "remote-snapshot.json")));
      assert.ok(catalogs[1].endsWith(path.join("accounts", "older", "runtime", "model-catalog", "remote-snapshot.json")));
    });
  } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const prev = process.env.AUTOCLAW_CONFIG_DIR;
  delete process.env.AUTOCLAW_CONFIG_DIR;
  try {
    check("default roots point at both known config dirs under home", () => {
      const dirs = getAutoClawConfigDirs();
      assert.equal(dirs.length, 2);
      assert.ok(dirs[0].startsWith(path.join(os.homedir(), ".config")));
      assert.equal(dirs[1], path.join(os.homedir(), ".config", "AutoClaw"));
      assert.equal(dirs[0], path.join(os.homedir(), ".config", "AutoClaw-oversea-official"));
    });
    check("default discovery returns an array without throwing", () => {
      assert.ok(Array.isArray(findAutoClawVaults()));
      assert.ok(Array.isArray(findAutoClawRuntimeCatalogs()));
    });
  } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prev;
  }
}

// ── JWT helpers ──────────────────────────────────────────────────────────────

check("parseJwtPayload reads claims, with or without the Bearer prefix", () => {
  const jwt = fakeJwt({ user_id: 12345, device_id: "abc", exp: 1999999999 });
  assert.equal(parseJwtPayload(jwt).user_id, 12345);
  assert.equal(parseJwtPayload(`Bearer ${jwt}`).device_id, "abc");
});

check("parseJwtPayload returns null for junk, never throws", () => {
  assert.equal(parseJwtPayload("not-a-jwt"), null);
  assert.equal(parseJwtPayload("Bearer "), null);
  assert.equal(parseJwtPayload(null), null);
  assert.equal(parseJwtPayload(undefined), null);
  assert.equal(parseJwtPayload("Bearer a.b"), null);
});

check("isJwtExpired is true inside the expiry window, false outside", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isJwtExpired(`Bearer ${fakeJwt({ exp: now - 30 })}`), true);
  assert.equal(isJwtExpired(fakeJwt({ exp: now + 3600 })), false);
});

check("isJwtExpired treats a non-jwt or exp-less token as unexpired", () => {
  assert.equal(isJwtExpired("Bearer opaque"), false);
  assert.equal(isJwtExpired(fakeJwt({ user_id: 1 })), false);
});

// ── Decryption ───────────────────────────────────────────────────────────────

{
  const password = "test-master-password";
  const plaintext = { schemaVersion: 1, accessToken: "Bearer decrypted-secret-token", refreshToken: "refresh-123" };
  const enc = encryptV11(plaintext, password);

  check("v11 payload round-trips to the accessToken", () => {
    const creds = decryptCredentials(enc, password);
    assert.equal(creds.accessToken, "Bearer decrypted-secret-token");
    assert.equal(creds.refreshToken, "refresh-123");
  });

  check("wrong password throws instead of returning junk", () => {
    assert.throws(() => decryptCredentials(enc, "wrong-password"));
  });

  check("unknown crypto prefix fails with a named error, never a guess", () => {
    const bad = Buffer.concat([Buffer.from("v99", "utf8"), enc.subarray(3)]);
    assert.throws(() => decryptCredentials(bad, password), /v99/);
  });

  check("buffer too short to hold a prefix throws", () => {
    assert.throws(() => decryptCredentials(Buffer.from("v1"), password));
  });

  check("missing password is refused before any decryption", () => {
    assert.throws(() => decryptCredentials(enc, null));
    assert.throws(() => decryptCredentials(enc, ""));
  });
}

summary();
