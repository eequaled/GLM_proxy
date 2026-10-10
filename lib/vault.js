/**
 * Vault layer — Linux credential discovery and decryption (spec/linux-support).
 *
 * AutoClaw 1.x (Windows/macOS) writes a plaintext
 * `~/.openclaw-autoclaw/request-headers.json`, which is the token seam the proxy
 * has always read. The Linux build (2.x AppImage) writes Chromium-OSCrypt
 * `v11` encrypted credentials instead:
 *
 *   ~/.config/AutoClaw-oversea-official/  (or ~/.config/AutoClaw/)
 *     accounts/<accountId>/account-credentials.enc   — AES-128-CBC, "v11" prefix
 *     accounts/<accountId>/account-profile.json      — optional, display only
 *     accounts/<accountId>/runtime/model-catalog/remote-snapshot.json
 *
 * One module holds the two facts that rot at different speeds: the PATHS
 * (discovery section — moves with every app packaging change) and the CRYPTO
 * (decrypt section — moves only if the app changes its cipher). Splitting them
 * internally means a path rename never re-audits crypto and a cipher change
 * never re-audits paths.
 *
 * Discovery never throws and never writes. Decryption validates its inputs and
 * throws narrow, named errors — the token layer (Task 2) wraps those into the
 * repo's degrade-never-throw contract. Key retrieval and the opt-in sync-to-file
 * bridge are deliberately NOT in this module's public surface yet; they land
 * with Task 2/3 of spec/linux-support/tasks.md.
 *
 * Zero dependencies: node:fs/os/path/crypto only.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Discovery ────────────────────────────────────────────────────────────────

// Ordered preference for the Linux config root. `AutoClaw-oversea-official` is
// listed first because it is the directory the Linux (oversea) build writes;
// plain `AutoClaw` is kept as a fallback for layouts observed in the wild.
const DEFAULT_CONFIG_DIRS = ["AutoClaw-oversea-official", "AutoClaw"];

// Vault layout relative to each config root. `accounts/<id>/` may repeat per
// login; the newest mtime is the active account.
const VAULT_REL = path.join("accounts");
const CREDENTIALS_FILE = "account-credentials.enc";
const PROFILE_FILE = "account-profile.json";
const SNAPSHOT_REL = path.join("runtime", "model-catalog", "remote-snapshot.json");

export function getAutoClawConfigDirs() {
  const envDir = (process.env.AUTOCLAW_CONFIG_DIR || "").trim();
  if (envDir) return [envDir];
  const home = os.homedir();
  return DEFAULT_CONFIG_DIRS.map((name) => path.join(home, ".config", name));
}

function listAccountDirs(base) {
  try {
    return fs.readdirSync(path.join(base, VAULT_REL), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, VAULT_REL, e.name));
  } catch {
    // Missing or unreadable accounts/ is a supported state — there is simply no
    // Linux vault on this machine.
    return [];
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// All discovered vaults, newest-mtime first. The newest vault is the one the
// desktop app itself considers active, so it is first — callers should log the
// chosen accountDir rather than silently picking.
export function findAutoClawVaults() {
  const vaults = [];
  for (const base of getAutoClawConfigDirs()) {
    for (const accountDir of listAccountDirs(base)) {
      const encFile = path.join(accountDir, CREDENTIALS_FILE);
      const stat = statOrNull(encFile);
      if (!stat) continue;
      const profileFile = path.join(accountDir, PROFILE_FILE);
      vaults.push({
        accountDir,
        encFile,
        profileFile: statOrNull(profileFile) ? profileFile : null,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return vaults.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Model-catalog snapshots, newest-first. These enter RUNTIME_CANDIDATES when
// the platform is detected as 2.x, so the existing catalog loader reads them
// with no new read path.
export function findAutoClawRuntimeCatalogs() {
  const files = [];
  for (const base of getAutoClawConfigDirs()) {
    for (const accountDir of listAccountDirs(base)) {
      const file = path.join(accountDir, SNAPSHOT_REL);
      if (statOrNull(file)) files.push({ file, mtimeMs: statOrNull(file).mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map((c) => c.file);
}

// ── JWT helpers ──────────────────────────────────────────────────────────────

// Decode the payload segment of a JWT with no signature verification — the
// upstream verifies the signature, this only reads `exp`/`user_id` to decide
// freshness and governor keying. A token that does not parse is not an error:
// an opaque non-JWT token simply gets no expiry treatment.
export function parseJwtPayload(token) {
  try {
    if (typeof token !== "string") return null;
    const raw = token.replace(/^Bearer\s+/i, "").trim();
    const parts = raw.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
    return (payload && typeof payload === "object") ? payload : null;
  } catch {
    return null;
  }
}

// A token is stale inside this many seconds BEFORE `exp`, so a request in
// flight does not race the account's forced refresh.
const EXPIRY_BUFFER_SEC = 60;

export function isJwtExpired(token, bufferSeconds = EXPIRY_BUFFER_SEC) {
  const payload = parseJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return false;
  return Math.floor(Date.now() / 1000) >= payload.exp - bufferSeconds;
}

// ── Decryption ───────────────────────────────────────────────────────────────

// Chromium OSCrypt "safe storage" parameters the Linux build inherits from
// Electron: PBKDF2 over the OS-keyring password, AES-128-CBC with a fixed IV.
// If the app changes any of these, the plaintext stops parsing and the v11
// prefix check below stops guessing — the failure is named, not silent.
const OSCRYPT_SALT = "saltysalt";
const OSCRYPT_ITERATIONS = 1;
const OSCRYPT_PREFIX = "v11";
const OSCRYPT_IV = Buffer.alloc(16, 0x20);

export function decryptCredentials(encBuffer, keyringPassword) {
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < 3) {
    throw new Error("Invalid credentials buffer");
  }
  if (encBuffer.subarray(0, 3).toString("utf-8") !== OSCRYPT_PREFIX) {
    throw new Error(`Unsupported credentials encryption format: ${encBuffer.subarray(0, 3).toString("utf-8")}`);
  }
  if (typeof keyringPassword !== "string" || keyringPassword.length === 0) {
    throw new Error("AutoClaw keyring password is required for decryption");
  }

  const key = crypto.pbkdf2Sync(keyringPassword, OSCRYPT_SALT, OSCRYPT_ITERATIONS, 16, "sha1");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, OSCRYPT_IV);
  const plaintext = Buffer.concat([decipher.update(encBuffer.subarray(3)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf-8"));
}
