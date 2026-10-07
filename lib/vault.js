/**
 * Vault layer — AutoClaw 2.x credentials discovery and extraction (Linux/Electron).
 *
 * In AutoClaw 1.x (legacy/Windows), the app wrote plaintext JSON headers to
 * ~/.openclaw-autoclaw/request-headers.json.
 *
 * In AutoClaw 2.x (including the official Linux AppImage and Electron builds),
 * credentials are encrypted on disk under ~/.config/AutoClaw-oversea-official/
 * (or ~/.config/AutoClaw/) in accounts/<accountId>/account-credentials.enc
 * using Chromium OSCrypt v11 (AES-128-CBC) with the master secret stored in
 * the OS Secret Service (GNOME Keyring / KWallet via D-Bus).
 *
 * This module:
 * 1. Discovers AutoClaw 2.x account vaults.
 * 2. Retrieves the decryption key via Secret Service / D-Bus (or cached / env).
 * 3. Decrypts account-credentials.enc using Node.js built-in crypto (zero dependencies).
 * 4. Syncs the active token to ~/.openclaw-autoclaw/request-headers.json so legacy
 *    consumers and existing file watches remain seamlessly supported.
 * 5. Discovers AutoClaw 2.x model snapshots (remote-snapshot.json).
 */

import child_process from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonSafe, stateDir, writeJsonAtomic } from "./state.js";

let _cachedKeyringPassword = null;

/**
 * Parses the payload of a JWT token without external libraries.
 */
export function parseJwtPayload(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const raw = token.replace(/^Bearer\s+/i, "").trim();
    const parts = raw.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1], "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Checks whether a JWT is expired or within bufferSeconds of expiring.
 */
export function isJwtExpired(token, bufferSeconds = 60) {
  const payload = parseJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= (payload.exp - bufferSeconds);
}

/**
 * Candidates for AutoClaw 2.x configuration base directories.
 */
export function getAutoClawConfigDirs() {
  const dirs = [];
  const envDir = (process.env.AUTOCLAW_CONFIG_DIR || "").trim();
  if (envDir && !dirs.includes(envDir)) dirs.push(envDir);

  const home = os.homedir();
  const defaults = [
    path.join(home, ".config", "AutoClaw-oversea-official"),
    path.join(home, ".config", "AutoClaw"),
  ];

  for (const d of defaults) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

/**
 * Discovers AutoClaw 2.x encrypted account credential vaults.
 * Returns an array of vault objects sorted by mtime descending (most recent first).
 */
export function findAutoClawVaults() {
  const configDirs = getAutoClawConfigDirs();
  const vaults = [];

  for (const base of configDirs) {
    const accountsDir = path.join(base, "accounts");
    if (!fs.existsSync(accountsDir)) continue;

    let subdirs;
    try {
      subdirs = fs.readdirSync(accountsDir);
    } catch {
      continue;
    }

    for (const sub of subdirs) {
      const accountDir = path.join(accountsDir, sub);
      const encFile = path.join(accountDir, "account-credentials.enc");
      if (fs.existsSync(encFile)) {
        try {
          const stat = fs.statSync(encFile);
          const profileFile = path.join(accountDir, "account-profile.json");
          vaults.push({
            accountDir,
            encFile,
            profileFile: fs.existsSync(profileFile) ? profileFile : null,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // ignore unreadable
        }
      }
    }
  }

  return vaults.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Discovers AutoClaw 2.x model catalog snapshots (remote-snapshot.json).
 */
export function findAutoClawRuntimeCatalogs() {
  const configDirs = getAutoClawConfigDirs();
  const catalogs = [];

  for (const base of configDirs) {
    const accountsDir = path.join(base, "accounts");
    if (!fs.existsSync(accountsDir)) continue;

    let subdirs;
    try {
      subdirs = fs.readdirSync(accountsDir);
    } catch {
      continue;
    }

    for (const sub of subdirs) {
      const snapshot = path.join(accountsDir, sub, "runtime", "model-catalog", "remote-snapshot.json");
      if (fs.existsSync(snapshot)) {
        try {
          const stat = fs.statSync(snapshot);
          catalogs.push({ file: snapshot, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  }

  return catalogs.sort((a, b) => b.mtimeMs - a.mtimeMs).map((c) => c.file);
}

/**
 * Retrieves the AutoClaw master password from the OS Keyring.
 * On Linux, queries GNOME Keyring / Secret Service via D-Bus (using python3).
 * Falls back to GLMP_KEYRING_PASSWORD env or cached state.
 */
export function getKeyringPassword(config = null, log = null) {
  if (process.env.GLMP_KEYRING_PASSWORD) {
    return process.env.GLMP_KEYRING_PASSWORD.trim();
  }

  if (_cachedKeyringPassword) {
    return _cachedKeyringPassword;
  }

  // Check persistent cache in stateDir
  const cacheFile = path.join(stateDir(config), "autoclaw-keyring.json");
  const cached = readJsonSafe(cacheFile, null);
  if (cached?.password && typeof cached.password === "string") {
    _cachedKeyringPassword = cached.password;
    return cached.password;
  }

  // On Linux, query Secret Service via python3 dbus
  if (process.platform === "linux") {
    const pyScript = `
import dbus, sys
try:
    bus = dbus.SessionBus()
    service = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
    ss = dbus.Interface(service, 'org.freedesktop.Secret.Service')
    session = ss.OpenSession('plain', '')[1]
    for app in ['AutoClaw', 'AutoClaw-oversea-official', 'chromium']:
        unlocked, _ = ss.SearchItems({'application': app})
        if unlocked:
            item = bus.get_object('org.freedesktop.secrets', unlocked[0])
            pw = bytes(dbus.Interface(item, 'org.freedesktop.Secret.Item').GetSecret(session)[2]).decode('utf-8')
            print(pw)
            sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
`;
    try {
      const res = child_process.spawnSync("python3", ["-c", pyScript], {
        encoding: "utf-8",
        timeout: 3000,
      });
      if (res.status === 0 && res.stdout.trim()) {
        const pw = res.stdout.trim();
        _cachedKeyringPassword = pw;
        try {
          writeJsonAtomic(cacheFile, { password: pw, updatedAt: Date.now() });
        } catch (_) {}
        return pw;
      }
    } catch (err) {
      log?.warn?.(`Failed to query Secret Service for AutoClaw key: ${err.message}`);
    }
  }

  return null;
}

/**
 * Decrypts Chromium OSCrypt v11 ciphertext.
 * Algorithm: AES-128-CBC, IV: 16 spaces (0x20), PBKDF2: 1 iteration, salt: "saltysalt".
 */
export function decryptCredentials(encBuffer, keyringPassword) {
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < 4) {
    throw new Error("Invalid credentials buffer");
  }

  const prefix = encBuffer.subarray(0, 3).toString("utf-8");
  if (prefix !== "v11") {
    throw new Error(`Unsupported credentials encryption format: ${prefix}`);
  }

  if (!keyringPassword) {
    throw new Error("AutoClaw keyring password is required for decryption");
  }

  const ciphertext = encBuffer.subarray(3);
  const key = crypto.pbkdf2Sync(keyringPassword, "saltysalt", 1, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);

  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8"));
}

/**
 * Extracts and returns the active AutoClaw token from the newest vault.
 * Returns { token, account, vaultFile, mtimeMs } or null if no vault exists.
 */
export function extractAutoClawVaultToken(config = null, log = null) {
  const vaults = findAutoClawVaults();
  if (vaults.length === 0) return null;

  const newest = vaults[0];
  const pw = getKeyringPassword(config, log);
  if (!pw) {
    log?.warn?.("AutoClaw vault found but keyring password is unavailable");
    return null;
  }

  try {
    const encBuffer = fs.readFileSync(newest.encFile);
    const creds = decryptCredentials(encBuffer, pw);
    if (!creds?.accessToken) {
      log?.warn?.("Decrypted AutoClaw credentials do not contain accessToken");
      return null;
    }

    const token = creds.accessToken.startsWith("Bearer ")
      ? creds.accessToken
      : `Bearer ${creds.accessToken}`;

    let profile = null;
    if (newest.profileFile) {
      const profData = readJsonSafe(newest.profileFile, null);
      if (profData?.profile) {
        profile = profData.profile;
      }
    }

    return {
      token,
      profile,
      vaultFile: newest.encFile,
      accountDir: newest.accountDir,
      mtimeMs: newest.mtimeMs,
    };
  } catch (err) {
    log?.warn?.(`Failed to decrypt AutoClaw vault (${err.message})`);
    return null;
  }
}

/**
 * Synchronizes the token to ~/.openclaw-autoclaw/request-headers.json.
 */
export function syncTokenToHeadersFile(token, targetFile) {
  if (!token || !targetFile) return;
  try {
    writeJsonAtomic(targetFile, {
      headers: {
        "X-Authorization": token,
      },
      updatedAt: new Date().toISOString(),
      source: "autoclaw-vault-extractor",
    });
  } catch (_) {
    // writing sync file is best-effort
  }
}
