// Offline tests for the cross-platform vault discovery + decrypt core.
// Hermetic: every discovery case points AUTOCLAW_CONFIG_DIR at a tmp fixture or
// asserts only the override shape — no real HOME, keyring, or host vault is read.
// The one live touch is the darwin-gated Keychain round-trip against a throwaway
// item it creates and deletes itself; on other platforms it does not run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  decryptWindowsCredentials,
  getWindowsOsCryptKey,
  getKeychainPassword,
  extractAutoClawVaultToken,
} from "../lib/vault.js";
import { createTokenLayer } from "../lib/core.js";

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

// Chromium runs the OS master secret through PBKDF2 at 1 iteration on Linux and
// 1003 on macOS, and the proxy reads that count from the host. Fixtures that must
// survive a real resolve — the keyring-password cases below — therefore encrypt
// with the host's count; the pure round-trip cases pass their count explicitly.
const HOST_OSCRYPT_ITERATIONS = process.platform === "darwin" ? 1003 : 1;

function encryptV11(plaintextObj, password, prefix = "v11", iterations = 1) {
  const key = crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintextObj), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from(prefix, "utf8"), body]);
}

// What Windows Electron `safeStorage` writes: v10 + 12-byte nonce + AES-256-GCM
// ciphertext + 16-byte tag, keyed by the 32-byte DPAPI-unprotected OSCrypt key.
function encryptV10Gcm(plaintextObj, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintextObj), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from("v10", "utf8"), nonce, body, cipher.getAuthTag()]);
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
  const prevDir = process.env.AUTOCLAW_CONFIG_DIR;
  const prevAppRoot = process.env.AUTOCLAW_USER_DATA_ROOT;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.AUTOCLAW_USER_DATA_ROOT;
  delete process.env.XDG_CONFIG_HOME;
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

    check("the app's own AUTOCLAW_USER_DATA_ROOT outranks our override", () => {
      process.env.AUTOCLAW_USER_DATA_ROOT = other;
      assert.deepEqual(getAutoClawConfigDirs(), [other]);
      // discovery follows it too
      const vaults = findAutoClawVaults();
      assert.equal(vaults.length, 1);
      assert.equal(vaults[0].accountDir, path.join(other, "accounts", "ignored-account"));
      delete process.env.AUTOCLAW_USER_DATA_ROOT;
    });

    check("XDG_CONFIG_HOME relocates the default AutoClaw root", () => {
      const xdgRoot = tmp("vault-xdg-");
      makeVault(xdgRoot, "xdg-account", 1_000_000_000);
      delete process.env.AUTOCLAW_CONFIG_DIR;
      process.env.XDG_CONFIG_HOME = xdgRoot;
      try {
        assert.deepEqual(getAutoClawConfigDirs(), [path.join(xdgRoot, "AutoClaw")]);
        const vaults = findAutoClawVaults();
        assert.equal(vaults.length, 1);
        assert.equal(vaults[0].accountDir, path.join(xdgRoot, "AutoClaw", "accounts", "xdg-account"));
      } finally {
        delete process.env.XDG_CONFIG_HOME;
        process.env.AUTOCLAW_CONFIG_DIR = root;
      }
      fs.rmSync(xdgRoot, { recursive: true, force: true });
    });
  } finally {
    if (prevAppRoot === undefined) delete process.env.AUTOCLAW_USER_DATA_ROOT;
    else process.env.AUTOCLAW_USER_DATA_ROOT = prevAppRoot;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevDir === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prevDir;
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
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevAppRoot = process.env.AUTOCLAW_USER_DATA_ROOT;
  delete process.env.AUTOCLAW_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.AUTOCLAW_USER_DATA_ROOT;
  try {
    check("default roots match the host platform (observed root first)", () => {
      const dirs = getAutoClawConfigDirs();
      assert.equal(dirs.length, 2);
      if (process.platform === "win32") {
        const appData = path.join(os.homedir(), "AppData", "Roaming");
        assert.equal(dirs[0], path.join(appData, "AutoClaw-oversea-official"));
        assert.equal(dirs[1], path.join(appData, "AutoClaw"));
      } else {
        assert.equal(dirs[0], path.join(os.homedir(), ".config", "AutoClaw"));
        assert.equal(dirs[1], path.join(os.homedir(), ".config", "AutoClaw-oversea-official"));
      }
    });
    check("win32 derives Electron userData roots from the home dir", () => {
      const dirs = getAutoClawConfigDirs({}, "win32", path.join("C:", "Users", "x"));
      assert.deepEqual(dirs, [
        path.join("C:", "Users", "x", "AppData", "Roaming", "AutoClaw-oversea-official"),
        path.join("C:", "Users", "x", "AppData", "Roaming", "AutoClaw"),
      ]);
    });
    check("non-win32 derives the Linux config roots", () => {
      const dirs = getAutoClawConfigDirs({}, "linux", path.join("/home", "x"));
      assert.deepEqual(dirs, [
        path.join("/home", "x", ".config", "AutoClaw"),
        path.join("/home", "x", ".config", "AutoClaw-oversea-official"),
      ]);
    });
    check("default discovery returns an array without throwing", () => {
      assert.ok(Array.isArray(findAutoClawVaults()));
      assert.ok(Array.isArray(findAutoClawRuntimeCatalogs()));
    });
  } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prev;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevAppRoot === undefined) delete process.env.AUTOCLAW_USER_DATA_ROOT;
    else process.env.AUTOCLAW_USER_DATA_ROOT = prevAppRoot;
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
    const creds = decryptCredentials(encryptV11(plaintext, password, "v11"), password);
    assert.equal(creds.accessToken, "Bearer decrypted-secret-token");
    assert.equal(creds.refreshToken, "refresh-123");
  });

  check("v10 payload round-trips too (what linux electron actually writes)", () => {
    const creds = decryptCredentials(encryptV11(plaintext, password, "v10"), password);
    assert.equal(creds.accessToken, "Bearer decrypted-secret-token");
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

// ── Windows decryption (v10 AES-256-GCM) ─────────────────────────────────────

{
  const key = crypto.randomBytes(32);
  const plaintext = { schemaVersion: 1, accessToken: "Bearer win-secret-token", refreshToken: "win-refresh" };
  const enc = encryptV10Gcm(plaintext, key);

  check("windows v10 GCM payload round-trips to the accessToken", () => {
    const creds = decryptWindowsCredentials(enc, key);
    assert.equal(creds.accessToken, "Bearer win-secret-token");
    assert.equal(creds.refreshToken, "win-refresh");
  });

  check("a wrong windows key fails authentication instead of returning junk", () => {
    assert.throws(() => decryptWindowsCredentials(enc, crypto.randomBytes(32)));
  });

  check("a non-v10 prefix is refused by the windows path with a named error", () => {
    const bad = Buffer.concat([Buffer.from("v11", "utf8"), enc.subarray(3)]);
    assert.throws(() => decryptWindowsCredentials(bad, key), /v11/);
  });

  check("a key of the wrong length is refused before decryption", () => {
    assert.throws(() => decryptWindowsCredentials(enc, key.subarray(0, 16)));
    assert.throws(() => decryptWindowsCredentials(enc, null));
  });

  check("a buffer too short to hold nonce+tag is refused", () => {
    assert.throws(() => decryptWindowsCredentials(Buffer.from("v10short"), key));
  });
}

// ── macOS leg ────────────────────────────────────────────────────────────────
//
// The macOS chain (Application Support roots → login Keychain → PBKDF2 at 1003
// iterations) runs end-to-end only on a macOS runner; the root and parameter
// halves are pure and run everywhere. The Keychain half is a real `security`
// round-trip against a throwaway item, skipped off-darwin.

{
  const home = path.join(path.sep, "Users", "someone");

  check("darwin derives Electron userData roots from the home dir", () => {
    const dirs = getAutoClawConfigDirs({}, "darwin", home);
    assert.deepEqual(dirs, [
      path.join(home, "Library", "Application Support", "AutoClaw-oversea-official"),
      path.join(home, "Library", "Application Support", "AutoClaw"),
    ]);
  });

  const password = "mac-master-password";
  const plaintext = { schemaVersion: 1, accessToken: "Bearer mac-secret-token" };

  check("the macOS KDF round-trips at 1003 iterations", () => {
    const enc = encryptV11(plaintext, password, "v10", 1003);
    assert.equal(decryptCredentials(enc, password, 1003).accessToken, "Bearer mac-secret-token");
  });

  check("the Linux default does not accidentally open a macOS blob", () => {
    const enc = encryptV11(plaintext, password, "v10", 1003);
    assert.throws(() => decryptCredentials(enc, password));
  });

  check("zero, negative or fractional iteration counts are refused", () => {
    const enc = encryptV11(plaintext, password, "v10", 1003);
    assert.throws(() => decryptCredentials(enc, password, 0), /iteration/);
    assert.throws(() => decryptCredentials(enc, password, -5), /iteration/);
    assert.throws(() => decryptCredentials(enc, password, 1.5), /iteration/);
  });
}

if (process.platform === "darwin") {
  const service = `glmp-test-keychain-${process.pid}-${Date.now()}`;
  const secret = `glmp-${crypto.randomBytes(8).toString("hex")}`;
  try {
    const added = spawnSync("security", [
      "add-generic-password", "-s", service, "-a", "glmp-test", "-w", secret,
    ], { encoding: "utf-8", timeout: 5000 });
    if (added.status === 0) {
      check("darwin: the Keychain probe reads back what `security` stored",
        getKeychainPassword(null, [service]) === secret);
      check("darwin: a Keychain item that does not exist is a clean null",
        getKeychainPassword(null, [`${service}-absent`]) === null);
    } else {
      check("darwin: the Live Keychain probe could not run — `security` refused to add a test item "
        + ((added.stderr || "").trim() || `exit ${added.status}`), false);
    }
  } finally {
    spawnSync("security", ["delete-generic-password", "-s", service], { encoding: "utf-8", timeout: 5000 });
  }
}

// ── Key chain + extraction ───────────────────────────────────────────────────

function writeEncryptedVault(root, accountId, password, plaintext, mtimeEpochSec = 1_000_000_000) {
  const accountDir = path.join(root, "accounts", accountId);
  fs.mkdirSync(accountDir, { recursive: true });
  const encFile = path.join(accountDir, "account-credentials.enc");
  fs.writeFileSync(encFile, encryptV11(plaintext, password, "v11", HOST_OSCRYPT_ITERATIONS));
  const t = new Date(mtimeEpochSec * 1000);
  fs.utimesSync(encFile, t, t);
  fs.writeFileSync(path.join(accountDir, "account-profile.json"),
    JSON.stringify({ profile: { displayName: `operator-${accountId}` } }));
  return encFile;
}

function spyLog() {
  const msgs = [];
  return {
    msgs,
    info: (m) => msgs.push(m),
    warn: (m) => msgs.push(m),
    error: (m) => msgs.push(m),
    debug: (m) => msgs.push(m),
  };
}

const KEYRING_PASSWORD = "test-master-password";

{
  const root = tmp("vault-keychain-");
  const prevDir = process.env.AUTOCLAW_CONFIG_DIR;
  const prevPw = process.env.GLMP_KEYRING_PASSWORD;
  process.env.AUTOCLAW_CONFIG_DIR = root;
  process.env.GLMP_KEYRING_PASSWORD = KEYRING_PASSWORD;
  try {
    writeEncryptedVault(root, "acct-1", KEYRING_PASSWORD, {
      schemaVersion: 1,
      accessToken: "Bearer vault-jwt-one",
      refreshToken: "refresh-1",
    });

    check("env keyring password unlocks the vault and reports the account", () => {
      const log = spyLog();
      const res = extractAutoClawVaultToken({}, log);
      assert.equal(res.token, "Bearer vault-jwt-one");
      assert.equal(res.profile.displayName, "operator-acct-1");
      assert.ok(log.msgs.some((m) => String(m).includes("operator-acct-1")));
    });

    check("wrong keyring password degrades to null with one warning, never throws", () => {
      process.env.GLMP_KEYRING_PASSWORD = "wrong-password";
      const log = spyLog();
      const res = extractAutoClawVaultToken({}, log);
      assert.equal(res, null);
      assert.equal(log.msgs.length, 1);
      process.env.GLMP_KEYRING_PASSWORD = KEYRING_PASSWORD;
    });

    check("no password and no keyring daemon → null, never throws", () => {
      delete process.env.GLMP_KEYRING_PASSWORD;
      const log = spyLog();
      const res = extractAutoClawVaultToken({}, log);
      assert.equal(res, null);
      assert.ok(log.msgs.length >= 1);
    });
  } finally {
    if (prevDir === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prevDir;
    if (prevPw === undefined) delete process.env.GLMP_KEYRING_PASSWORD;
    else process.env.GLMP_KEYRING_PASSWORD = prevPw;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── Windows extraction (DPAPI key env leg) ───────────────────────────────────

function writeWindowsVault(root, accountId, key, plaintext, mtimeEpochSec = 1_000_000_000) {
  const accountDir = path.join(root, "accounts", accountId);
  fs.mkdirSync(accountDir, { recursive: true });
  const encFile = path.join(accountDir, "account-credentials.enc");
  fs.writeFileSync(encFile, encryptV10Gcm(plaintext, key));
  const t = new Date(mtimeEpochSec * 1000);
  fs.utimesSync(encFile, t, t);
  fs.writeFileSync(path.join(accountDir, "account-profile.json"),
    JSON.stringify({ profile: { displayName: `operator-${accountId}` } }));
  return encFile;
}

{
  const root = tmp("vault-windows-");
  const prevDir = process.env.AUTOCLAW_CONFIG_DIR;
  const prevPw = process.env.GLMP_KEYRING_PASSWORD;
  const prevDp = process.env.GLMP_DPAPI_KEY;
  const key = crypto.randomBytes(32);
  process.env.AUTOCLAW_CONFIG_DIR = root;
  delete process.env.GLMP_KEYRING_PASSWORD;
  process.env.GLMP_DPAPI_KEY = key.toString("base64");
  try {
    writeWindowsVault(root, "win-acct", key, {
      schemaVersion: 1,
      accessToken: "Bearer win-vault-jwt",
      refreshToken: "win-refresh",
    });

    check("GLMP_DPAPI_KEY unlocks a Windows v10 GCM vault and reports the account", () => {
      const log = spyLog();
      const res = extractAutoClawVaultToken({}, log);
      assert.equal(res.token, "Bearer win-vault-jwt");
      assert.equal(res.profile.displayName, "operator-win-acct");
      assert.ok(log.msgs.some((m) => String(m).includes("operator-win-acct")));
    });

    check("a wrong DPAPI key degrades to null with one warning, never throws", () => {
      process.env.GLMP_DPAPI_KEY = crypto.randomBytes(32).toString("base64");
      const log = spyLog();
      const res = extractAutoClawVaultToken({}, log);
      assert.equal(res, null);
      assert.equal(log.msgs.length, 1);
      process.env.GLMP_DPAPI_KEY = key.toString("base64");
    });

    check("a malformed GLMP_DPAPI_KEY is warned about and never used", () => {
      process.env.GLMP_DPAPI_KEY = "not-a-32-byte-key";
      const log = spyLog();
      const res = extractAutoClawVaultToken({}, log);
      assert.equal(res, null);
      assert.ok(log.msgs.some((m) => String(m).includes("GLMP_DPAPI_KEY")));
      process.env.GLMP_DPAPI_KEY = key.toString("base64");
    });

    check("getWindowsOsCryptKey returns null without a config root, never throws", () => {
      assert.equal(getWindowsOsCryptKey(null, spyLog()), null);
    });
  } finally {
    if (prevDir === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prevDir;
    if (prevPw === undefined) delete process.env.GLMP_KEYRING_PASSWORD;
    else process.env.GLMP_KEYRING_PASSWORD = prevPw;
    if (prevDp === undefined) delete process.env.GLMP_DPAPI_KEY;
    else process.env.GLMP_DPAPI_KEY = prevDp;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── Token layer delegation ───────────────────────────────────────────────────

function writeLegacyHeaders(file, token) {
  fs.writeFileSync(file, JSON.stringify({ headers: { "X-Authorization": token } }));
}

{
  const root = tmp("vault-tokenlayer-");
  const prevDir = process.env.AUTOCLAW_CONFIG_DIR;
  const prevPw = process.env.GLMP_KEYRING_PASSWORD;
  const prevDirect = process.env.GLMP_AUTOCLAW_TOKEN;
  process.env.AUTOCLAW_CONFIG_DIR = root;
  process.env.GLMP_KEYRING_PASSWORD = KEYRING_PASSWORD;
  delete process.env.GLMP_AUTOCLAW_TOKEN;
  const legacyFile = path.join(root, "request-headers.json");
  try {
    writeEncryptedVault(root, "acct-1", KEYRING_PASSWORD, { accessToken: "Bearer vault-jwt" });
    writeLegacyHeaders(legacyFile, "Bearer legacy-jwt");
    const cfg = { TOKEN_FILE: legacyFile, TOKEN_TTL_MS: 60_000, IS_AUTOCLAW2: true };

    check("vault token wins over the legacy headers file", () => {
      const layer = createTokenLayer(cfg, spyLog());
      assert.equal(layer.getToken(), "Bearer vault-jwt");
    });

    check("GLMP_VAULT=0 restores the legacy-file path", () => {
      const prevVault = process.env.GLMP_VAULT;
      process.env.GLMP_VAULT = "0";
      try {
        const layer = createTokenLayer(cfg, spyLog());
        assert.equal(layer.getToken(), "Bearer legacy-jwt");
      } finally {
        if (prevVault === undefined) delete process.env.GLMP_VAULT;
        else process.env.GLMP_VAULT = prevVault;
      }
    });

    check("direct env token short-circuits vault and file entirely", () => {
      process.env.GLMP_AUTOCLAW_TOKEN = "Bearer direct-jwt";
      try {
        const layer = createTokenLayer({ ...cfg, IS_AUTOCLAW2: false }, spyLog());
        assert.equal(layer.getToken(), "Bearer direct-jwt");
      } finally {
        delete process.env.GLMP_AUTOCLAW_TOKEN;
      }
    });

    check("vault miss degrades to the legacy file with exactly one warning", () => {
      fs.rmSync(path.join(root, "accounts"), { recursive: true, force: true });
      const log = spyLog();
      const layer = createTokenLayer(cfg, log);
      assert.equal(layer.getToken(), "Bearer legacy-jwt");
      assert.equal(log.msgs.filter((m) => String(m).includes("vault")).length, 1);
      writeEncryptedVault(root, "acct-1", KEYRING_PASSWORD, { accessToken: "Bearer vault-jwt" });
    });

    check("neither source → the legacy error message, still thrown", () => {
      fs.rmSync(path.join(root, "accounts"), { recursive: true, force: true });
      fs.rmSync(legacyFile, { force: true });
      const layer = createTokenLayer(cfg, spyLog());
      assert.throws(() => layer.getToken(), /Cannot read AutoClaw token/);
      writeEncryptedVault(root, "acct-1", KEYRING_PASSWORD, { accessToken: "Bearer vault-jwt" });
      writeLegacyHeaders(legacyFile, "Bearer legacy-jwt");
    });

    check("expired vault token is treated as missing, not cached", () => {
      const now = Math.floor(Date.now() / 1000);
      fs.rmSync(path.join(root, "accounts"), { recursive: true, force: true });
      fs.rmSync(legacyFile, { force: true });
      writeEncryptedVault(root, "acct-exp", KEYRING_PASSWORD, { accessToken: "Bearer expired-jwt" }, now);
      const layer = createTokenLayer(cfg, spyLog());
      // no legacy file either, so the expired vault is a double-miss and throws
      assert.throws(() => layer.getToken(), /Cannot read AutoClaw token/);
      // rotate to a valid token; the layer must see it on the very next call
      fs.rmSync(path.join(root, "accounts"), { recursive: true, force: true });
      writeEncryptedVault(root, "acct-fresh", KEYRING_PASSWORD, { accessToken: "Bearer fresh-jwt" }, now + 60);
      assert.equal(layer.getToken(), "Bearer fresh-jwt");
      writeLegacyHeaders(legacyFile, "Bearer legacy-jwt");
    });

    check("invalidateToken still forces a re-resolve after rotation", () => {
      const layer = createTokenLayer(cfg, spyLog());
      const first = layer.getToken();
      layer.invalidateToken();
      assert.equal(layer.getToken(), first);
    });
  } finally {
    if (prevDir === undefined) delete process.env.AUTOCLAW_CONFIG_DIR;
    else process.env.AUTOCLAW_CONFIG_DIR = prevDir;
    if (prevPw === undefined) delete process.env.GLMP_KEYRING_PASSWORD;
    else process.env.GLMP_KEYRING_PASSWORD = prevPw;
    if (prevDirect === undefined) delete process.env.GLMP_AUTOCLAW_TOKEN;
    else process.env.GLMP_AUTOCLAW_TOKEN = prevDirect;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

summary();
