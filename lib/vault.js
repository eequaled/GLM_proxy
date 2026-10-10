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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonSafe } from "./state.js";

// ── Discovery ────────────────────────────────────────────────────────────────

// Ordered preference for the Linux config root, measured in the shipped 2.0.3
// bundle (`zwork-account-boot-environment.ts` / `autoclawUserDataRoot`):
//
//   1. AUTOCLAW_USER_DATA_ROOT  — the app's own override; parity means reading
//                                 exactly what the app reads
//   2. AUTOCLAW_CONFIG_DIR      — this proxy's operator-facing override
//   3. $XDG_CONFIG_HOME/AutoClaw (~/.config/AutoClaw)  — observed root
//   4. ~/.config/AutoClaw-oversea-official  — reported in the wild, unproven
//
// `AutoClaw-oversea-official` is deliberately last: nothing in the bundle we
// read names it, and a newer build would write to the observed root above.
const DEFAULT_CONFIG_DIR = "AutoClaw";
const LEGACY_OVEREA_DIR = "AutoClaw-oversea-official";

export function getAutoClawConfigDirs() {
  const appRoot = (process.env.AUTOCLAW_USER_DATA_ROOT || "").trim();
  if (appRoot) return [appRoot];

  const envDir = (process.env.AUTOCLAW_CONFIG_DIR || "").trim();
  if (envDir) return [envDir];

  const xdg = (process.env.XDG_CONFIG_HOME || "").trim();
  const configHome = xdg && xdg.startsWith("/") ? xdg : path.join(os.homedir(), ".config");
  return [
    path.join(configHome, DEFAULT_CONFIG_DIR),
    path.join(os.homedir(), ".config", LEGACY_OVEREA_DIR),
  ];
}

// Vault layout under each config root (`product-account-service.ts`):
//   accounts/<accountKey>/account-credentials.enc   — safeStorage ciphertext
//   accounts/<accountKey>/account-profile.json     — optional, display only
//   accounts/<accountKey>/runtime/model-catalog/remote-snapshot.json
// `<accountKey>` is a sha256 hash, but discovery globs instead of deriving it
// — one fewer fact to rot. `<id> may repeat per login; newest mtime is active.
const VAULT_REL = path.join("accounts");
const CREDENTIALS_FILE = "account-credentials.enc";
const PROFILE_FILE = "account-profile.json";
const SNAPSHOT_REL = path.join("runtime", "model-catalog", "remote-snapshot.json");

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

// ── Key chain ────────────────────────────────────────────────────────────────

// How long the live Secret Service probe may block. It runs on the token-resolve
// path (startup, TTL expiry, post-401), so a hung keyring must fail fast rather
// than stall a request.
const KEYRING_PROBE_TIMEOUT_MS = 3000;

// app names the Linux build may have registered its master password under.
const KEYRING_APPS = ["AutoClaw", "AutoClaw-oversea-official", "chromium"];

// Cached result of the live probe only. The env leg is read fresh every time so
// an operator rotating GLMP_KEYRING_PASSWORD is never served a stale value.
let _liveKeyringPassword = null;

// Resolve the OSCrypt master password. Precedence:
//   1. GLMP_KEYRING_PASSWORD      — headless/Docker/CI: no bus, no daemon
//   2. in-memory live-probe cache
//   3. Secret Service via a disposable python3/dbus one-liner (Linux only)
// Every leg can fail; the caller decides what a missing password means. The
// subprocess is the only non-built-in step in this whole module, and it is
// absent from the request path whenever leg 1 or 2 answers.
export function getKeyringPassword(config = null, log = null) {
  const envPw = (process.env.GLMP_KEYRING_PASSWORD || "").trim();
  if (envPw) return envPw;

  if (_liveKeyringPassword) return _liveKeyringPassword;

  if (process.platform !== "linux") return null;

  const pyScript = `
import sys
try:
    import dbus
    bus = dbus.SessionBus()
    service = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
    ss = dbus.Interface(service, 'org.freedesktop.Secret.Service')
    session = ss.OpenSession('plain', '')[1]
    queries = [
        {'application': 'AutoClaw'},
        {'application': 'AutoClaw-oversea-official'},
        {'application': 'chromium'},
        {'server': 'Chromium Keys'},
        {'server': 'AutoClaw Keys'},
        {'server': 'Chrome Keys'},
    ]
    for q in queries:
        unlocked, _ = ss.SearchItems(q)
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
    const res = spawnSync("python3", ["-c", pyScript], {
      encoding: "utf-8",
      timeout: KEYRING_PROBE_TIMEOUT_MS,
    });
    if (res.status === 0 && res.stdout.trim()) {
      _liveKeyringPassword = res.stdout.trim();
      return _liveKeyringPassword;
    }
  } catch (err) {
    log?.warn?.(`Secret Service probe failed for the AutoClaw key (${err.message})`);
  }
  return null;
}

// ── Extraction ───────────────────────────────────────────────────────────────

// The newest vault's credential, or null. Every failure mode (no vault, no
// password, wrong password, unknown cipher, corrupt JSON) returns null with one
// warning — the repo's degrade-never-throw contract starts at this boundary.
// Callers fall back to the legacy headers file; nothing here throws.
export function extractAutoClawVaultToken(config = null, log = null) {
  const vaults = findAutoClawVaults();
  if (vaults.length === 0) return null;

  const newest = vaults[0];
  const pw = getKeyringPassword(config, log);
  if (!pw) {
    log?.warn?.("AutoClaw vault found but the keyring password is unavailable");
    return null;
  }

  let creds;
  try {
    creds = decryptCredentials(fs.readFileSync(newest.encFile), pw);
  } catch (err) {
    log?.warn?.(`Failed to decrypt the AutoClaw vault (${err.message})`);
    return null;
  }

  const raw = creds?.accessToken;
  if (typeof raw !== "string" || raw.length === 0) {
    log?.warn?.("Decrypted AutoClaw credentials do not contain accessToken");
    return null;
  }

  const profile = newest.profileFile ? readJsonSafe(newest.profileFile, null)?.profile ?? null : null;
  const who = profile?.displayName || profile?.email;
  log?.info?.("AutoClaw vault token loaded for account " + (who || newest.accountDir));

  return {
    token: raw.startsWith("Bearer ") ? raw : `Bearer ${raw}`,
    profile,
    vaultFile: newest.encFile,
    accountDir: newest.accountDir,
    mtimeMs: newest.mtimeMs,
  };
}

// ── Source gates ─────────────────────────────────────────────────────────────

// The vault leg only runs on a config that says it is looking at AutoClaw 2.x.
// An undefined IS_AUTOCLAW2 (every config before spec/linux-support Task 3)
// keeps the Windows file path byte-identical. GLMP_VAULT=0 disables the leg
// outright, following the repo's "0 disables" convention.
export function isVaultEnabled(config) {
  if (config?.IS_AUTOCLAW2 !== true) return false;
  return process.env.GLMP_VAULT !== "0";
}

// A directly supplied JWT, for headless/Docker/CI runs where no vault, keyring
// or app is present. In-memory only: it is read per resolve and never written.
export function getDirectToken() {
  const raw = (process.env.GLMP_AUTOCLAW_TOKEN || "").trim();
  return raw.length > 0 ? raw : null;
}

// ── Decryption ───────────────────────────────────────────────────────────────

// Chromium OSCrypt writes a version prefix before the ciphertext so a reader
// can refuse an unknown scheme instead of guessing. Linux Electron/Chromium
// builds emit `v10`; `v11` has been observed in the wild, so both are
// accepted and anything else fails with a named error. If a future build
// changes the KDF or the cipher, decryption stops parsing and this list is the
// single place to extend — never a silent fallback.
const OSCRYPT_PREFIXES = ["v10", "v11"];

// Chromium OSCrypt "safe storage" parameters the Linux build inherits from
// Electron: PBKDF2 over the OS-keyring password, AES-128-CBC with a fixed IV.
const OSCRYPT_SALT = "saltysalt";
const OSCRYPT_ITERATIONS = 1;
const OSCRYPT_IV = Buffer.alloc(16, 0x20);

export function decryptCredentials(encBuffer, keyringPassword) {
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < 3) {
    throw new Error("Invalid credentials buffer");
  }
  const prefix = encBuffer.subarray(0, 3).toString("utf-8");
  if (!OSCRYPT_PREFIXES.includes(prefix)) {
    throw new Error(`Unsupported credentials encryption format: ${prefix}`);
  }
  if (typeof keyringPassword !== "string" || keyringPassword.length === 0) {
    throw new Error("AutoClaw keyring password is required for decryption");
  }

  const key = crypto.pbkdf2Sync(keyringPassword, OSCRYPT_SALT, OSCRYPT_ITERATIONS, 16, "sha1");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, OSCRYPT_IV);
  const plaintext = Buffer.concat([decipher.update(encBuffer.subarray(3)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf-8"));
}
