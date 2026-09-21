/**
 * Identity layer — the client-identity application of the runtime-discovery
 * pattern (Requirement 1).
 *
 * The proxy impersonates the AutoClaw desktop client, so every fact it asserts
 * about that client (app version, X-* identity headers, User-Agent) must come
 * from the installed app rather than from a compiled-in constant. This is the
 * same lesson the repo already learned for the model catalog (`loadModelsFromRuntime`)
 * and applied once to these headers (`getClientHeaders`, commit 8265ae0) —
 * except the tail of that chain was still the stale pinned `1.17.5` default,
 * which is exactly the class of drift that produced issue #5's false bans.
 *
 * Discovery chain, first hit wins:
 *   1. RUNTIME_CANDIDATES[i] → models.providers.zai.models[0].headers  (live app)
 *   2. proxy-state/identity.last-good.json                            (last observed)
 *   3. config.CLIENT_HEADERS                                          (pinned, LOUD)
 * Env overrides are checked first and logged as overrides:
 *   GLMP_IDENTITY_VERSION, GLMP_USER_AGENT, GLMP_ACCEPT
 *
 * Zero dependencies (node:fs only), never throws on discovery, and degrades to
 * the previous behavior whenever every source is unavailable.
 */

import fs from "node:fs";
import path from "node:path";

import { defaultClock } from "./clock.js";
import { readJsonSafe, stateDir, writeJsonAtomic } from "./state.js";

// The identity keys that describe the client itself. The runtime entry ALSO
// carries X-Authorization (a live JWT) and X-Request-Model (per request), and
// must never leak those into the static header set. This list is deliberately
// the single source of truth for both directions: what may be read out of a
// runtime entry, and what may be written to a snapshot (Requirement 7.7).
export const CLIENT_IDENTITY_KEYS = [
  "X-Version", "X-Tm", "X-Product", "X-Channel", "X-Lang", "X-Client-Type",
];

// Transport-level identity that the app may or may not publish in its runtime
// entry. Absent today, so the chain falls through to the derived values — no
// code change is needed if a future app version starts writing them.
const UA_KEYS = ["User-Agent", "user-agent", "UserAgent"];
const ACCEPT_KEYS = ["Accept", "accept"];

export const IDENTITY_SNAPSHOT_FILE = "identity.last-good.json";

// What the real client puts on the wire, measured 2026-09-21 by reverse-engineering
// the installed app (`.dbg/autoclaw-reverse-engineering.md`): the completion call
// goes through Electron-main `globalThis.fetch` = undici, which appends its own
// User-Agent when the app sets none — and the app sets none, so the literal value
// is `node`. `Accept` the app does set, to `*/*`. There is no product-token UA and
// no `AutoClaw/<version>` string anywhere in the client.
//
// This replaces a derived `AutoClaw/<version> (<platform>)` default that was an
// invention: a UA the client never sends is a *more* distinctive signal than the
// stack default, so guessing here made things worse, not safer.
export const DEFAULT_USER_AGENT = "node";
export const DEFAULT_ACCEPT = "*/*";

// Re-warn about a pinned identity at most this often (Requirement 1.3).
export const STALE_WARN_INTERVAL_MS = 60 * 60 * 1000;

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].trim()) out[key] = obj[key];
  }
  return out;
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key];
  }
  return null;
}

// The newest client version the remote model-config advertised (when it does).
// Module-level so both the layer and `--doctor` see it without threading a new
// return shape through `fetchRemoteModelConfig`.
let _remoteClientVersion = null;

export function reportRemoteClientVersion(version) {
  if (typeof version === "string" && version.trim()) _remoteClientVersion = version.trim();
}

export function getRemoteClientVersion() {
  return _remoteClientVersion;
}

export function createIdentityLayer(config, log = null, clock = defaultClock) {
  const ttl = config?.TOKEN_TTL_MS || 5 * 60 * 1000;

  let _identity = null;
  let _identityAt = 0;
  let _lastSeenVersion = null;
  let _lastCapturedVersion = null;
  let _lastStaleWarnAt = 0;
  let _lastOverrideWarnedFor = null;
  let _watchFiles = null;
  let _staleTimer = null;

  const warn = (msg) => {
    if (log && typeof log.warn === "function") log.warn(msg);
    else console.warn(msg);
  };
  const info = (msg) => {
    if (log && typeof log.info === "function") log.info(msg);
  };

  const snapshotPath = () => path.join(stateDir(config), IDENTITY_SNAPSHOT_FILE);

  // ---- discovery sources -------------------------------------------------

  function fromRuntime() {
    for (const candidate of config?.RUNTIME_CANDIDATES || []) {
      try {
        const data = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        const entry = data?.models?.providers?.zai?.models?.[0]?.headers;
        if (!entry || typeof entry !== "object") continue;
        const headers = pick(entry, CLIENT_IDENTITY_KEYS);
        if (!headers["X-Version"]) continue;
        return {
          headers,
          userAgent: pickFirst(entry, UA_KEYS),
          accept: pickFirst(entry, ACCEPT_KEYS),
          source: "runtime",
          observedAt: clock.now(),
        };
      } catch (_) { /* try the next candidate */ }
    }
    return null;
  }

  function fromSnapshot() {
    const snap = readJsonSafe(snapshotPath(), null, log);
    if (!snap || typeof snap !== "object") return null;
    const headers = pick(snap.headers, CLIENT_IDENTITY_KEYS);
    if (!headers["X-Version"]) return null;
    const observedAt = Date.parse(snap.observedAt);
    return {
      headers,
      userAgent: pickFirst(snap, UA_KEYS) || pickFirst(snap, ["userAgent"]),
      accept: pickFirst(snap, ACCEPT_KEYS) || pickFirst(snap, ["accept"]),
      source: "snapshot",
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
    };
  }

  // ---- resolution --------------------------------------------------------

  function resolve() {
    const discovered = fromRuntime() || fromSnapshot() || null;
    const headers = { ...(config?.CLIENT_HEADERS || {}), ...(discovered?.headers || {}) };

    const ovVersion = process.env.GLMP_IDENTITY_VERSION || null;
    const ovUa = process.env.GLMP_USER_AGENT || null;
    const ovAccept = process.env.GLMP_ACCEPT || null;
    const overridden = Boolean(ovVersion || ovUa || ovAccept);

    if (ovVersion) headers["X-Version"] = ovVersion;

    const version = headers["X-Version"] || null;
    if (discovered) _lastSeenVersion = discovered.headers["X-Version"] || _lastSeenVersion;

    // Source: env override outranks discovery; discovery outranks the pin.
    const source = overridden ? "override" : (discovered?.source || "pinned");

    const userAgent = ovUa || discovered?.userAgent || DEFAULT_USER_AGENT;
    const accept = ovAccept || discovered?.accept || DEFAULT_ACCEPT;

    return {
      version,
      headers,
      userAgent,
      accept,
      source,
      observedAt: discovered?.observedAt ?? null,
      pinnedVersion: config?.CLIENT_HEADERS?.["X-Version"] || null,
    };
  }

  // ---- persistence -------------------------------------------------------

  // Snapshot the live app's identity so the NEXT time AutoClaw is closed the
  // chain lands on the last observed truth instead of the compiled-in pin.
  // Throttled to one write per distinct version, and serialized through the
  // same whitelist that governs discovery — a live JWT can never be written.
  function capture(identity) {
    if (!identity || identity.source !== "runtime") return;
    const version = identity.headers["X-Version"];
    if (!version || version === _lastCapturedVersion) return;
    try {
      writeJsonAtomic(snapshotPath(), {
        version,
        headers: pick(identity.headers, CLIENT_IDENTITY_KEYS),
        userAgent: identity.userAgent || null,
        accept: identity.accept || null,
        observedAt: new Date(clock.now()).toISOString(),
        source: "runtime",
      });
      _lastCapturedVersion = version;
    } catch (err) {
      warn(`identity: could not write identity snapshot (${err.message}) — continuing`);
    }
  }

  // ---- warnings ----------------------------------------------------------

  function warnStale(force = false) {
    const now = clock.now();
    if (!force && now - _lastStaleWarnAt < STALE_WARN_INTERVAL_MS) return;
    _lastStaleWarnAt = now;
    const pinned = config?.CLIENT_HEADERS?.["X-Version"] || "unknown";
    const drift = _lastSeenVersion && _lastSeenVersion !== pinned
      ? ` Newest observed AutoClaw version: ${_lastSeenVersion}.`
      : "";
    warn(
      `identity: running on pinned identity X-Version=${pinned} — no AutoClaw app version was discoverable, ` +
      `so upstream identity gates may see a stale client.${drift} ` +
      `Run AutoClaw once, or set GLMP_IDENTITY_VERSION to silence this.`
    );
  }

  function warnOverride(version) {
    if (_lastOverrideWarnedFor === version) return;
    _lastOverrideWarnedFor = version;
    warn(
      `identity: GLMP_IDENTITY_VERSION override active (${version}) — ` +
      `parity checks against the installed app are disabled while this is set.`
    );
  }

  // ---- public surface ----------------------------------------------------

  function getIdentity() {
    const now = clock.now();
    if (_identity && now - _identityAt < ttl) return _identity;

    const identity = resolve();
    _identity = identity;
    _identityAt = now;

    if (identity.source === "runtime") capture(identity);
    else if (identity.source === "pinned") warnStale();
    else if (identity.source === "override") warnOverride(identity.version);

    return identity;
  }

  function freshness() {
    const identity = getIdentity();
    const local = identity.version;
    const drift = _remoteClientVersion && local && _remoteClientVersion !== local
      ? { remoteVersion: _remoteClientVersion, localVersion: local }
      : null;
    return {
      source: identity.source,
      version: local,
      pinnedVersion: identity.pinnedVersion,
      userAgent: identity.userAgent,
      accept: identity.accept,
      ageMs: identity.observedAt != null ? clock.now() - identity.observedAt : null,
      lastSeenVersion: _lastSeenVersion,
      knownDrift: drift,
    };
  }

  // Re-check staleness on the hourly cadence (Requirement 1.3). Exposed so a
  // test can drive it with an injected clock instead of waiting an hour.
  function checkStaleness() {
    if (getIdentity().source === "pinned") warnStale();
  }

  // Hot-reload on file change — the token layer's watchFile precedent, but for
  // the runtime file that carries both the catalog and the identity headers.
  function startWatch() {
    if (_watchFiles) return;
    _watchFiles = [];
    for (const candidate of config?.RUNTIME_CANDIDATES || []) {
      try {
        fs.watchFile(candidate, { interval: 1000 }, () => {
          const before = _identity?.version;
          _identity = null;
          _identityAt = 0;
          const after = getIdentity().version;
          if (after !== before) info(`identity reloaded: ${before || "(none)"} → ${after || "(none)"}`);
        });
        _watchFiles.push(candidate);
      } catch (_) { /* unwatchable path — TTL re-read still applies */ }
    }
    if (!_staleTimer) {
      _staleTimer = setInterval(() => { try { checkStaleness(); } catch (_) {} }, STALE_WARN_INTERVAL_MS);
      if (typeof _staleTimer.unref === "function") _staleTimer.unref();
    }
  }

  function stop() {
    for (const file of _watchFiles || []) {
      try { fs.unwatchFile(file); } catch (_) {}
    }
    _watchFiles = null;
    if (_staleTimer) { clearInterval(_staleTimer); _staleTimer = null; }
  }

  // Resolve once at construction so the operator sees the startup warning even
  // if nothing has called getIdentity() yet.
  try { getIdentity(); } catch (_) { /* discovery must never block startup */ }

  return {
    getIdentity,
    freshness,
    capture,
    checkStaleness,
    startWatch,
    stop,
    snapshotPath,
  };
}
