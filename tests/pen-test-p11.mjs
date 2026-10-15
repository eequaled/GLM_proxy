// Pen-test p11 — the keyring-password credential chain, end to end (spec/linux-support Task 7).
//
// Runs on Linux and macOS: both unlock the CBC vault from an operator-supplied
// master secret, and the only difference between them is the KDF's iteration
// count, which the fixture below takes from the host.
//
// What this suite is for
// ----------------------
// tests/vault.mjs proves the vault functions in isolation. This suite proves the
// *whole* chain through a real spawned proxy: a vault file laid out exactly as
// AutoClaw 2.0.3 writes it (safeStorage/OSCrypt `v10` ciphertext of
// `{schemaVersion, revision, accessToken, refreshToken, updatedAt}` under
// `$AUTOCLAW_USER_DATA_ROOT/AutoClaw/accounts/<key>/`), a keyring password,
// IS_AUTOCLAW2 detection, and the token source precedence the proxy actually
// serves — asserted on the Authorization header the TLS mock received.
//
// Everything is hermetic: a throwaway HOME and a throwaway config root, an
// encrypted fixture written by the suite itself, and the local TLS mock as
// upstream. No live upstream, no credits, no real keyring.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PEN_TEST_PORTS } from "../lib/constants.js";
import { check, post, proxyOutput, startProxy, startTlsMock, stopProxy, summary } from "./_helpers.mjs";

const PORT = PEN_TEST_PORTS.p11;

const KEYRING_PASSWORD = "p11-master-password";
const VAULT_TOKEN = "Bearer p11-vault-token";
const LEGACY_TOKEN = "Bearer p11-legacy-token";
const DIRECT_TOKEN = "Bearer p11-direct-token";

// The exact scheme Electron's safeStorage uses (Chromium OSCrypt v10): PBKDF2
// over the OS master secret, AES-128-CBC with a 16×0x20 IV, and the version
// prefix in front of the ciphertext. Linux and macOS share the cipher and the
// salt and differ only in Chromium's iteration count (1 on Linux, 1003 on the
// Keychain path), and the proxy picks that count from the host — so the fixture
// has to as well, or a macOS run decrypts a Linux blob and dies with "bad
// decrypt" while the proxy is behaving correctly.
const OSCRYPT_ITERATIONS = process.platform === "darwin" ? 1003 : 1;

function encryptV10(plaintextObj, password) {
  const key = crypto.pbkdf2Sync(password, "saltysalt", OSCRYPT_ITERATIONS, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintextObj), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from("v10", "utf8"), body]);
}

// A home with the two token sources a real mixed install can have, and a
// separate AUTOCLAW_USER_DATA_ROOT for the Linux vault.
function makeHome({ withVault = true, withLegacy = true, vaultPassword = KEYRING_PASSWORD } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glmp-p11-"));
  const legacyDir = path.join(home, ".openclaw-autoclaw");
  fs.mkdirSync(legacyDir, { recursive: true });

  if (withLegacy) {
    fs.writeFileSync(path.join(legacyDir, "request-headers.json"), JSON.stringify({
      headers: { "X-Authorization": LEGACY_TOKEN },
    }), "utf8");
  }

  const userData = path.join(home, "linux-config");
  if (withVault) {
    const accountDir = path.join(userData, "accounts", "a".repeat(64));
    fs.mkdirSync(accountDir, { recursive: true });
    fs.writeFileSync(path.join(accountDir, "account-credentials.enc"), encryptV10({
      schemaVersion: 1,
      revision: 1,
      accessToken: VAULT_TOKEN,
      refreshToken: "p11-refresh",
      updatedAt: new Date().toISOString(),
    }, vaultPassword));
    fs.writeFileSync(path.join(accountDir, "account-profile.json"),
      JSON.stringify({ profile: { displayName: "p11-operator" } }), "utf8");
  }

  return { home, legacyDir, userData };
}

async function withCase(options, env, fn) {
  const { home, legacyDir, userData } = makeHome(options);
  const { mock, port } = await startTlsMock({});
  const proxyEnv = {
    HOME: home, USERPROFILE: home,
    OPENCLAW_STATE_DIR: legacyDir,
    UPSTREAM_HOST: "127.0.0.1", UPSTREAM_PORT: String(port),
    AUTOCLAW_USER_DATA_ROOT: options.withVault !== false ? userData : path.join(userData, "empty"),
    LOG_LEVEL: "info",
    ...env,
  };
  const proxy = await startProxy(PORT, proxyEnv);
  const log = () => proxyOutput(proxy).all || "";
  try {
    await fn({ mock, proxy, log });
  } finally {
    await stopProxy(proxy);
    await mock.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const ask = () => post(PORT, {
  body: { model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
  timeoutMs: 20000,
});

const authSeenBy = (mock) => {
  const h = mock.getLastRequest()?.headers || {};
  return h["x-authorization"] || h.authorization;
};
const completionSeen = (mock) => (mock.getRequests() || []).filter((r) => (r.url || "").includes("chat/completions"));

// ---- 1. the vault is the source when the app is 2.x -------------------------

await withCase({}, { GLMP_KEYRING_PASSWORD: KEYRING_PASSWORD }, async ({ mock, log }) => {
  const res = await ask();
  check("vault: 2.x detection found the vault (the proxy logged the account)",
    /AutoClaw vault token loaded for account p11-operator/.test(log()),
    log().split("\n").filter((l) => /vault/.test(l)).join(" | "));
  check("vault: the mock received the vault token, not the legacy one",
    authSeenBy(mock) === VAULT_TOKEN, authSeenBy(mock));
  check("vault: the completion still renders", res.status === 200, res.status);
});

// ---- 2. the kill switch and the explicit override ----------------------------

await withCase({}, { GLMP_KEYRING_PASSWORD: KEYRING_PASSWORD, GLMP_VAULT: "0" }, async ({ mock }) => {
  await ask();
  check("GLMP_VAULT=0: the legacy headers file serves instead",
    authSeenBy(mock) === LEGACY_TOKEN, authSeenBy(mock));
});

await withCase({}, { GLMP_AUTOCLAW_TOKEN: DIRECT_TOKEN }, async ({ mock }) => {
  await ask();
  check("GLMP_AUTOCLAW_TOKEN: the direct token short-circuits both files",
    authSeenBy(mock) === DIRECT_TOKEN, authSeenBy(mock));
});

// ---- 3. every degrade path still serves --------------------------------------

await withCase({ withVault: false }, { GLMP_KEYRING_PASSWORD: KEYRING_PASSWORD }, async ({ mock, log }) => {
  const res = await ask();
  check("no vault and no override: the vault leg stays dark and the file serves",
    res.status === 200 && authSeenBy(mock) === LEGACY_TOKEN, authSeenBy(mock));
  check("no vault and no override: nothing warns about a missing vault",
    !/vault/.test(log()), log().split("\n").filter((l) => /vault/.test(l)).join(" | "));
});

await withCase({ withVault: false }, { GLMP_KEYRING_PASSWORD: KEYRING_PASSWORD, GLMP_AUTOCLAW2: "1" }, async ({ mock, log }) => {
  await ask();
  check("GLMP_AUTOCLAW2=1 with no vault: exactly one warning, then the file serves",
    authSeenBy(mock) === LEGACY_TOKEN && (log().match(/vault/g) || []).length >= 1,
    authSeenBy(mock));
});

await withCase({ withVault: false, withLegacy: false }, { GLMP_KEYRING_PASSWORD: KEYRING_PASSWORD, GLMP_AUTOCLAW2: "1" }, async ({ mock }) => {
  const res = await ask();
  check("no vault and no file: the client sees 503 no_token, not a crash",
    res.status === 503 && /no_token/.test(res.body), `${res.status} ${res.body.slice(0, 120)}`);
  check("no vault and no file: nothing reached the upstream",
    completionSeen(mock).length === 0, String(completionSeen(mock).length));
});

// ---- 4. a wrong keyring password degrades, it does not stall -----------------

await withCase({ vaultPassword: "not-the-password" }, { GLMP_KEYRING_PASSWORD: KEYRING_PASSWORD }, async ({ mock, log }) => {
  const res = await ask();
  check("wrong keyring password: one decrypt warning and the legacy token serves",
    res.status === 200 && authSeenBy(mock) === LEGACY_TOKEN, authSeenBy(mock));
  check("wrong keyring password: the failure is named in the log",
    /Failed to decrypt the AutoClaw vault/.test(log()),
    log().split("\n").filter((l) => /vault/i.test(l)).join(" | "));
});

// ---- 5. the direct token is never written anywhere ---------------------------

await withCase({}, { GLMP_AUTOCLAW_TOKEN: DIRECT_TOKEN }, async ({ log }) => {
  await ask();
  check("direct token: the proxy never logs the secret",
    !log().includes(DIRECT_TOKEN), "token appeared in the proxy log");
});

summary();
