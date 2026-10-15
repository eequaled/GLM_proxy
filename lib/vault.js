/**
 * Vault layer — Linux credential discovery and decryption (spec/linux-support).
 *
 * AutoClaw 1.x wrote a plaintext `~/.openclaw-autoclaw/request-headers.json`,
 * which is the token seam the proxy has always read. The 2.x builds ship an
 * encrypted vault on every platform instead:
 *
 *   Linux   — ~/.config/AutoClaw-oversea-official/ (or ~/.config/AutoClaw/)
 *             v11 = AES-128-CBC, key = PBKDF2(1 iteration, "saltysalt")
 *   Windows — %APPDATA%\AutoClaw-oversea-official\ (or \AutoClaw\)
 *             v10 = AES-256-GCM, key sealed with DPAPI in `Local State`
 *   macOS   — ~/Library/Application Support/AutoClaw-oversea-official/
 *             v10 = AES-128-CBC, key = Keychain password + PBKDF2(1003)
 *
 * All three share the vault layout under the config root:
 *     accounts/<accountId>/account-credentials.enc
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

// Ordered preference for the AutoClaw config root:
//
//   1. AUTOCLAW_USER_DATA_ROOT  — the app's own override; parity means reading
//                                 exactly what the app reads
//   2. AUTOCLAW_CONFIG_DIR      — this proxy's operator-facing override
//   3. platform defaults (see below)
//
// 2.x ships an encrypted vault on BOTH platforms; only the cipher and the root
// differ. Linux roots, measured in the shipped 2.0.3 bundle
// (`zwork-account-boot-environment.ts` / `autoclawUserDataRoot`):
//
//   3a. $XDG_CONFIG_HOME/AutoClaw (~/.config/AutoClaw)  — observed root
//   3b. ~/.config/AutoClaw-oversea-official  — reported in the wild, unproven
//
// `AutoClaw-oversea-official` is deliberately last on Linux: nothing in the
// bundle we read names it, and a newer build would write to the observed root
// above. Windows and macOS roots are Electron's `userData` dir — Windows
// `<home>\AppData\Roaming\<productName>`, macOS `<home>/Library/Application
// Support/<productName>` — measured 2026-10-15: AutoClaw2 writes the
// `AutoClaw-oversea-official` variant on both.
const DEFAULT_CONFIG_DIR = "AutoClaw";
const LEGACY_OVEREA_DIR = "AutoClaw-oversea-official";

function linuxConfigDirs(env, homedir) {
  const xdg = (env.XDG_CONFIG_HOME || "").trim();
  const configHome = xdg && xdg.startsWith("/") ? xdg : path.join(homedir, ".config");
  return [
    path.join(configHome, DEFAULT_CONFIG_DIR),
    path.join(homedir, ".config", LEGACY_OVEREA_DIR),
  ];
}

// The overseas build is first because it is the one measured in the wild this
// session; the plain `AutoClaw` root is the alternate product name.
//
// AppData is derived from the home dir rather than read from `%APPDATA%` so a
// fake `HOME`/`USERPROFILE` isolates discovery the way it already isolates the
// Linux roots — every offline suite swaps the home dir to hide the real app, and
// `%APPDATA%` would defeat that on a machine that has a live 2.x install. A
// redirected `%APPDATA%` is still reachable via AUTOCLAW_USER_DATA_ROOT.
function windowsConfigDirs(homedir) {
  const appData = path.join(homedir, "AppData", "Roaming");
  return [
    path.join(appData, LEGACY_OVEREA_DIR),
    path.join(appData, DEFAULT_CONFIG_DIR),
  ];
}

// macOS follows the same rule as Windows: home-derived, both product names,
// overseas first. The vault files are byte-identical in layout; only the
// cipher and the master secret differ (see the decryption section).
function macosConfigDirs(homedir) {
  const appSupport = path.join(homedir, "Library", "Application Support");
  return [
    path.join(appSupport, LEGACY_OVEREA_DIR),
    path.join(appSupport, DEFAULT_CONFIG_DIR),
  ];
}

export function getAutoClawConfigDirs(env = process.env, platform = process.platform, homedir = os.homedir()) {
  const appRoot = (env.AUTOCLAW_USER_DATA_ROOT || "").trim();
  if (appRoot) return [appRoot];

  const envDir = (env.AUTOCLAW_CONFIG_DIR || "").trim();
  if (envDir) return [envDir];

  if (platform === "win32") return windowsConfigDirs(homedir);
  if (platform === "darwin") return macosConfigDirs(homedir);
  return linuxConfigDirs(env, homedir);
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
        root: base,          // config root holding this account (Windows: Local State lives here)
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

// ── Windows OSCrypt key (DPAPI) ──────────────────────────────────────────────

// The Windows AutoClaw 2.x build is Electron, so `safeStorage` there is
// Chromium's OSCrypt: a `v10`-prefixed **AES-256-GCM** blob (12-byte nonce,
// 16-byte tag) whose 32-byte key lives in `<userData>/Local State` under
// `os_crypt.encrypted_key`, itself wrapped by Windows DPAPI for the current
// user. Node has no DPAPI binding and this repo ships no native dependency, so
// unprotecting that key is the one step that cannot be pure Node — it shells to
// PowerShell once per process and caches the result. Precedence mirrors the
// Linux key leg: an explicit `GLMP_DPAPI_KEY` (base64 of the raw 32-byte key)
// wins for headless/CI, then the in-memory cache, then the live DPAPI probe.
const DPAPI_PROBE_TIMEOUT_MS = 5000;
let _liveOsCryptKey = null;

// base64 → 32-byte Buffer, or null for anything else. Never throws.
function decodeDpapiKeyEnv(raw) {
  const v = (raw || "").trim();
  if (!v) return null;
  try {
    const buf = Buffer.from(v, "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

// The Local State path rides in an env var so no path quoting reaches the
// command line; the script prints the key as base64, and any failure exits
// non-zero, so a missing or garbled key is a clean miss rather than a guess.
const DPAPI_PS_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "Add-Type -AssemblyName System.Security;",
  "$ls = Get-Content -Raw -LiteralPath $env:GLMP_LOCAL_STATE | ConvertFrom-Json;",
  "$raw = [Convert]::FromBase64String($ls.os_crypt.encrypted_key);",
  "$blob = $raw[5..($raw.Length-1)];",
  "$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "Write-Output ([Convert]::ToBase64String($key))",
].join(" ");

function readOsCryptKeyFromLocalState(root, log = null) {
  if (!root) return null;
  const localState = path.join(root, "Local State");
  if (!fs.existsSync(localState)) return null;
  try {
    const res = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", DPAPI_PS_SCRIPT,
    ], {
      encoding: "utf-8",
      timeout: DPAPI_PROBE_TIMEOUT_MS,
      env: { ...process.env, GLMP_LOCAL_STATE: localState },
    });
    if (res.status === 0 && res.stdout) {
      const buf = Buffer.from(res.stdout.trim(), "base64");
      if (buf.length === 32) return buf;
    }
  } catch (err) {
    log?.warn?.(`DPAPI probe failed for the AutoClaw key (${err.message})`);
  }
  return null;
}

// The live Windows OSCrypt key for a config root, or null. Never throws.
export function getWindowsOsCryptKey(root, log = null) {
  if (_liveOsCryptKey) return _liveOsCryptKey;
  if (process.platform !== "win32") return null;
  const key = readOsCryptKeyFromLocalState(root, log);
  if (key) _liveOsCryptKey = key;
  return key;
}

// ── macOS OSCrypt master secret (login Keychain) ─────────────────────────────

// Electron's macOS `safeStorage` keeps its OSCrypt master secret in the login
// Keychain, and the `security` CLI that ships with macOS reads the same item
// back: `find-generic-password -s <service> -w` prints the password and exits 0
// only when the item exists. The service name is derived from the app's display
// name, so builds differ; a candidate list is tried in order, then a clean miss.
// No item, locked Keychain, missing CLI: null, never a throw.
//
// The macOS KDF is the same PBKDF2(saltysalt) as Linux — only Chromium's macOS
// iteration count (1003) differs, so this leg is one constant rather than a
// second cipher.
const KEYCHAIN_PROBE_TIMEOUT_MS = 3000;
const MACOS_KEYCHAIN_SERVICES = [
  "AutoClaw Safe Storage",
  "AutoClaw-oversea-official Safe Storage",
  "Chrome Safe Storage",
  "Chromium Safe Storage",
  "Electron Safe Storage",
];
let _liveKeychainPassword = null;

// The `services` parameter is the test seam (p13-style injection): production
// always uses the candidate list, while a test can point the probe at a
// throwaway Keychain item it just created. Caching applies only to the default
// list — an injected list is a per-call question, not a memo.
export function getKeychainPassword(log = null, services = MACOS_KEYCHAIN_SERVICES) {
  const useCache = services === MACOS_KEYCHAIN_SERVICES;
  if (useCache && _liveKeychainPassword) return _liveKeychainPassword;
  if (process.platform !== "darwin") return null;
  try {
    for (const service of services) {
      const res = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
        encoding: "utf-8",
        timeout: KEYCHAIN_PROBE_TIMEOUT_MS,
      });
      if (res.status === 0) {
        const password = (res.stdout || "").trim();
        if (password) {
          if (useCache) _liveKeychainPassword = password;
          return password;
        }
      }
    }
  } catch (err) {
    log?.warn?.(`Keychain probe failed for the AutoClaw key (${err.message})`);
  }
  return null;
}

// Which scheme decrypts this account's vault, and the material for it, or null.
// Explicit env first so the choice is deterministic and testable on any host,
// then the platform's live key source:
//   GLMP_KEYRING_PASSWORD → `v10`/`v11` PBKDF2 + AES-128-CBC
//   GLMP_DPAPI_KEY        → Windows `v10` AES-256-GCM
//   (no override)         → win32: DPAPI from Local State
//                           darwin: login Keychain
//                           else: Secret Service keyring
// The two CBC legs share a cipher and differ only in iteration count (Linux 1,
// macOS 1003), so both return `iterations` alongside the password.
function resolveVaultScheme(root, config, log) {
  const keyringPw = (process.env.GLMP_KEYRING_PASSWORD || "").trim();
  if (keyringPw) {
    return { scheme: "cbc", password: keyringPw, iterations: cbcIterations() };
  }

  const dpapiRaw = (process.env.GLMP_DPAPI_KEY || "").trim();
  if (dpapiRaw) {
    const key = decodeDpapiKeyEnv(dpapiRaw);
    if (key) return { scheme: "gcm", key };
    log?.warn?.("GLMP_DPAPI_KEY is not a base64-encoded 32-byte key — ignoring it");
  }

  if (process.platform === "win32") {
    const key = getWindowsOsCryptKey(root, log);
    return key ? { scheme: "gcm", key } : null;
  }
  if (process.platform === "darwin") {
    const live = getKeychainPassword(log);
    return live ? { scheme: "cbc", password: live, iterations: OSCRYPT_ITERATIONS_MACOS } : null;
  }
  const live = getKeyringPassword(config, log);
  return live ? { scheme: "cbc", password: live, iterations: OSCRYPT_ITERATIONS } : null;
}

// ── Extraction ───────────────────────────────────────────────────────────────

// The newest vault's credential, or null. Every failure mode (no vault, no
// key, wrong key, unknown cipher, corrupt JSON) returns null with one warning —
// the repo's degrade-never-throw contract starts at this boundary. Callers fall
// back to the legacy headers file; nothing here throws.
export function extractAutoClawVaultToken(config = null, log = null) {
  const vaults = findAutoClawVaults();
  if (vaults.length === 0) return null;

  const newest = vaults[0];
  const source = resolveVaultScheme(newest.root, config, log);
  if (!source) {
    log?.warn?.("AutoClaw vault found but no usable key (DPAPI/keyring) is available");
    return null;
  }

  let creds;
  try {
    const encBuffer = fs.readFileSync(newest.encFile);
    creds = source.scheme === "gcm"
      ? decryptWindowsCredentials(encBuffer, source.key)
      : decryptCredentials(encBuffer, source.password, source.iterations);
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

// Chromium OSCrypt "safe storage" parameters: PBKDF2 over the OS master secret
// (Secret Service keyring on Linux, login Keychain on macOS), AES-128-CBC with
// a fixed IV. Same salt and IV on both; only the iteration count differs by
// platform, and Chromium's macOS count is 1003 where Linux uses 1.
const OSCRYPT_SALT = "saltysalt";
const OSCRYPT_ITERATIONS = 1;
const OSCRYPT_ITERATIONS_MACOS = 1003;
const OSCRYPT_IV = Buffer.alloc(16, 0x20);

function cbcIterations() {
  return process.platform === "darwin" ? OSCRYPT_ITERATIONS_MACOS : OSCRYPT_ITERATIONS;
}

export function decryptCredentials(encBuffer, keyringPassword, iterations = OSCRYPT_ITERATIONS) {
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
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("AutoClaw OSCrypt iteration count must be a positive integer");
  }

  const key = crypto.pbkdf2Sync(keyringPassword, OSCRYPT_SALT, iterations, 16, "sha1");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, OSCRYPT_IV);
  const plaintext = Buffer.concat([decipher.update(encBuffer.subarray(3)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf-8"));
}

// ── Windows decryption ───────────────────────────────────────────────────────

// Windows Electron `safeStorage` is Chromium OSCrypt, not the Linux cipher: a
// `v10` prefix, a 12-byte nonce, the AES-256-GCM ciphertext, and a trailing
// 16-byte tag, keyed by the DPAPI-unprotected `os_crypt.encrypted_key`. The
// prefix is the SAME `v10` Linux emits for a different cipher, which is why this
// is a distinct function rather than a branch inside decryptCredentials: the
// platform, not the prefix, selects the cipher.
export function decryptWindowsCredentials(encBuffer, aesKey) {
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < 3 + 12 + 16) {
    throw new Error("Invalid credentials buffer");
  }
  const prefix = encBuffer.subarray(0, 3).toString("utf-8");
  if (prefix !== "v10") {
    throw new Error(`Unsupported Windows credentials encryption format: ${prefix}`);
  }
  if (!Buffer.isBuffer(aesKey) || aesKey.length !== 32) {
    throw new Error("AutoClaw DPAPI key is required for decryption");
  }

  const nonce = encBuffer.subarray(3, 15);
  const tag = encBuffer.subarray(encBuffer.length - 16);
  const ciphertext = encBuffer.subarray(15, encBuffer.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf-8"));
}
