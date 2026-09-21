// Shared machinery for the OpenAI and Anthropic proxy entrypoints.
//
// Layout contract: each entrypoint owns only its endpoint routes and wire
// format. Everything both of them need — config, token layer, model catalog,
// upstream calls, local-gateway client, error classification, loggers, server
// bootstrap — lives here so no logic is ever duplicated across formats.

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  DEFAULT_PORTS, DEFAULT_HOST, DEFAULT_PROXY_KEY,
  LOCAL_GATEWAY_HOST as DEFAULT_GATEWAY_HOST,
  LOCAL_GATEWAY_PORT as DEFAULT_GATEWAY_PORT,
} from "./constants.js";
import { createIdentityLayer, reportRemoteClientVersion } from "./identity.js";
import { createUpstreamTransport } from "./transport.js";
import { createPacingGovernor } from "./governor.js";
import { createConfigHeartbeat } from "./heartbeat.js";

// Single source of truth for the package version (used by the UA string and
// the startup banners). Read from package.json so a release bump is one edit,
// not five. package.json is always present in the published tarball.
let VERSION = "0.0.1"; // fallback if package.json can't be read
try {
  const v = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  if (typeof v === "string" && v.length > 0) VERSION = v;
} catch (_) { /* keep fallback */ }
export { VERSION };

// ============================================================================
// Config
// ============================================================================

// Built-in last-resort catalog if even fallback-models.json is unreadable.
// The editable copy lives in lib/fallback-models.json — keep both in sync.
const BUILTIN_FALLBACK_MODELS = [
  { id: "zai_auto",                        name: "Auto",              contextWindow: 1_048_576, maxTokens: 393_216 },
  { id: "zaicoding_glm-5.3",               name: "GLM-5.3",           contextWindow: 1_048_576, maxTokens: 307_200 },
  { id: "zai_glm-5-turbo",                 name: "GLM-5-Turbo",       contextWindow: 204_800,   maxTokens: 131_072 },
  { id: "zai_glm-5.3-flash",               name: "GLM-5.3-Flash",     contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: "tdpsk_deepseek-v4-flash-202605",  name: "Deepseek-V4-Flash", contextWindow: 1_048_576, maxTokens: 393_216 },
  { id: "tdpsk_deepseek-v4-pro-202606",    name: "DeepSeek-V4-Pro",   contextWindow: 1_048_576, maxTokens: 393_216 },
];

// External fallback catalog (editable without a release), overridable via
// FALLBACK_MODELS_PATH. Never throws — a missing or malformed file degrades
// to the built-ins above, same as today.
function loadFallbackModels() {
  try {
    const override = process.env.FALLBACK_MODELS_PATH;
    const source = override ? path.resolve(override) : new URL("./fallback-models.json", import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models : parsed;
    if (Array.isArray(models) && models.length > 0
      && models.every((m) => m && typeof m.id === "string")) return models;
  } catch (_) { /* fall through to built-ins */ }
  return BUILTIN_FALLBACK_MODELS;
}

// The AutoClaw state dir, resolved the way the app resolves it. Measured in the
// shipped bundle: `process.env.OPENCLAW_STATE_DIR || join(homedir(),
// ".openclaw-autoclaw")`, and every state reader in the app goes through that one
// expression. The proxy had the *default* hardcoded, so relocating the state dir
// (second profile, another drive, a sandboxed run) silently pointed it at a stale
// or missing token with no hint why. One rule, exported, so the handful of call
// sites outside loadConfig cannot drift from it.
export function autoclawStateDir(env = process.env, homedir = os.homedir()) {
  const explicit = typeof env.OPENCLAW_STATE_DIR === "string" ? env.OPENCLAW_STATE_DIR.trim() : "";
  return explicit || path.join(homedir, ".openclaw-autoclaw");
}

// Destructuring defaults evaluate in source order — `format` MUST come before
// `defaultPort` (which reads DEFAULT_PORTS[format]) or it hits the TDZ.
export function loadConfig({ format = "openai", defaultPort = DEFAULT_PORTS[format] } = {}) {
  const PORT           = parseInt(process.env.PORT || String(defaultPort), 10) || defaultPort;
  const HOST           = process.env.HOST || DEFAULT_HOST;
  const PROXY_KEY      = process.env.PROXY_KEY || DEFAULT_PROXY_KEY;
  const LOG_LEVEL      = process.env.LOG_LEVEL || "info"; // "debug" | "info" | "silent"
  const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(50 * 1024 * 1024), 10) || 50 * 1024 * 1024;
  const RATE_LIMIT     = parseInt(process.env.RATE_LIMIT || "30", 10) || 30; // req/s per IP
  // entity / message limit. 0 / unset / non-numeric → unlimited (no cap).
  // A compression system upstream is the preferred way to handle large
  // contexts; the cap here is only a guard for setups without one.
  const MAX_MESSAGES = (() => {
    const raw = process.env.MAX_MESSAGES;
    if (!raw) return Infinity;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return Infinity;
    return n;
  })();

  // PREFER_LOCAL=1 skips the cloud attempt entirely when the local AutoClaw
  // gateway is available — useful while credits are exhausted, where every
  // doomed cloud round-trip just adds latency before the fallback fires anyway.
  const PREFER_LOCAL = process.env.PREFER_LOCAL === "1";

  // Account pacing governor (Requirement 3) — the guard against burning an
  // account into a ban. The default is deliberately LOW and documented as a
  // guess: the audit's ban envelope (8,000+ credits in ~2 h through an
  // unsupervised harness) is orders of magnitude above it, and for a safety net
  // the safe direction to be wrong in is "too strict".
  // 0 / unset → the MAX_MESSAGES convention: 0 means off, unset means default.
  const BUDGET_REQUESTS_PER_HOUR = (() => {
    const raw = process.env.BUDGET_REQUESTS_PER_HOUR;
    if (raw === undefined || raw === "") return 300;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 300;
    return n > 0 ? n : 0;
  })();
  // Minimum gap between upstream dispatches, jittered ±40% inside the governor.
  // Breaks robotic sub-10 ms bursts without feeling like latency. 0 disables.
  const MIN_GAP_MS = (() => {
    const raw = process.env.GLMP_MIN_GAP_MS;
    if (raw === undefined || raw === "") return 250;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 250;
  })();
  // The window survives a restart by default, so a crash cannot hand the
  // account a fresh budget mid-hour. GOVERNOR_PERSIST=0 opts out.
  const GOVERNOR_PERSIST = process.env.GOVERNOR_PERSIST !== "0";
  // Set by `glmproxy --test-models` for the child proxy it spawns. Operator-
  // initiated sweeps are exempt from the account budget (still counted in a
  // separate bucket) so a health scan can neither starve real traffic nor push
  // the account over the edge the governor exists to protect.
  const DIAGNOSTIC_MODE = process.env.GLMP_DIAGNOSTIC === "1";

  // Companion-traffic cadence (Requirement 5). The real app polls its model
  // config every 300 s — measured, not guessed (`startModelConfigPolling` logs
  // `interval=300s`; the dev build's 120 s is a branch we deliberately do NOT
  // copy). 0 disables the heartbeat entirely, per the 0-off convention.
  const HEARTBEAT_INTERVAL_MS = (() => {
    const raw = process.env.HEARTBEAT_INTERVAL_MS;
    if (raw === undefined || raw === "") return 300_000;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 300_000;
    return n > 0 ? n : 0;
  })();

  const JSONL_LOG       = process.env.JSONL_LOG === "true" || process.env.LOG_LEVEL === "debug";
  const JSONL_SYNC      = process.env.JSONL_SYNC === "true";
  const JSONL_MAX_BYTES = parseInt(process.env.JSONL_MAX_BYTES || String(10 * 1024 * 1024), 10) || 10 * 1024 * 1024;

  // Per-format log filenames unless explicitly overridden via env
  const REQUEST_LOG_FILE = process.env.REQUEST_LOG_FILE
    || path.join(process.cwd(), format === "anthropic" ? "proxy_requests_anthropic.json" : "proxy_requests.json");
  const JSONL_FILE = process.env.JSONL_FILE
    || path.join(process.cwd(), format === "anthropic" ? "proxy_requests_anthropic.jsonl" : "proxy_requests.jsonl");

  const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "autoglm-api.autoglm.ai";
  const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || "443", 10) || 443;
  const UPSTREAM_PATH = process.env.UPSTREAM_PATH || "/autoclaw-proxy/proxy/autoclaw/chat/completions";
  const UPSTREAM_BASE = process.env.UPSTREAM_BASE || `https://${UPSTREAM_HOST}${UPSTREAM_PORT === 443 ? "" : ":" + UPSTREAM_PORT}/autoclaw-proxy/proxy/autoclaw`;
  const MODEL_CONFIG_PATH = process.env.MODEL_CONFIG_PATH || "/autoclaw-proxy/proxy/autoclaw-model-config";

  // Operator escape hatches. The vendor budgets 20 min (timeoutSeconds: 1200)
  // per call; the proxy defaults to 2 min per attempt — tune via env if needed.
  const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "120000", 10) || 120000;
  // The local desktop-agent fallback drives a real AutoClaw agent session, which
  // legitimately takes seconds to minutes — but a client with less patience than
  // the proxy gets a hang instead of a classified error, and a timed-out client
  // retries. Bound it, and let an operator tune it without a code change.
  const LOCAL_AGENT_TIMEOUT_MS = parseInt(process.env.LOCAL_AGENT_TIMEOUT_MS || "120000", 10) || 120000;
  // Local-gateway WS protocol range (self-heals to the server's range on
  // mismatch anyway — these are the initial offer and manual override).
  const GATEWAY_MIN_PROTOCOL = parseInt(process.env.GATEWAY_MIN_PROTOCOL || "3", 10) || 3;
  const GATEWAY_MAX_PROTOCOL = parseInt(process.env.GATEWAY_MAX_PROTOCOL || "4", 10) || 4;
  const LOCAL_GATEWAY_HOST   = process.env.LOCAL_GATEWAY_HOST || DEFAULT_GATEWAY_HOST;
  const LOCAL_GATEWAY_PORT   = parseInt(process.env.LOCAL_GATEWAY_PORT || String(DEFAULT_GATEWAY_PORT), 10) || DEFAULT_GATEWAY_PORT;

  const AUTOCLAW_STATE_DIR = autoclawStateDir();
  // The proxy's own state (identity snapshot, cookie jar, governor window) lives
  // beside the app's rather than inside it, so an app reset does not take the
  // proxy's evidence with it. lib/state.js prefers this key.
  const STATE_DIR = process.env.PROXY_STATE_DIR || path.join(AUTOCLAW_STATE_DIR, "proxy-state");

  // AutoClaw writes fresh auth headers here whenever the token rotates
  const TOKEN_FILE    = path.join(AUTOCLAW_STATE_DIR, "request-headers.json");
  const TOKEN_TTL_MS  = 5 * 60 * 1000; // re-read file at most every 5 min

  // Identifies the request as coming from the AutoClaw desktop client. This is
  // the last-resort base only — getClientHeaders() overlays the live values from
  // the runtime file, and lib/identity.js snapshots the newest observed app
  // identity so a closed app lands on that instead of on this pin.
  // X-Version is what AutoClaw actually self-reports on this machine
  // (measured 2026-09-21: .startup-validation.json `version` and
  // autoclaw-compat.log `client_version=1.18.5&os=win`). The previous 1.17.5 pin
  // was two minor versions stale — the exact drift class that tripped issue #5.
  //
  // X-Harness-Type is not decoration and not an invention: the upstream gates
  // cloud completions on the system prompt (an allowlist), and the desktop app
  // carries an exemption header on every model-proxy request. Verbatim from the
  // shipped bundle (`app.asar:/out/main/index.js`):
  //   // Exempts zcode requests from api-proxy's system-prompt allowlist check.
  //
  // Probe-verified 2026-09-21 against the live upstream (2x2 of banner × header,
  // see tests/experiments/harness-type-probe.mjs):
  //   banner only 200 · banner+header 200 · header only 200 · neither 400
  // So the header is what the gate actually accepts, and — the point — it is what
  // demotes the byte-exact prompt watermark below from a single point of failure
  // to a harmless belt: if the app ever rewords its own prompt, this header still
  // opens the door, where the pinned banner string would rot.
  // Override with GLMP_HARNESS_TYPE, or set it to "" to send neither header.
  const HARNESS_TYPE = process.env.GLMP_HARNESS_TYPE === undefined
    ? "zcode"
    : process.env.GLMP_HARNESS_TYPE.trim();

  const CLIENT_HEADERS = {
    "X-Tm":          "win",
    "X-Version":     "1.18.5",
    "X-Product":     "autoclaw",
    "X-Channel":     "AutoClaw4",
    "X-Lang":        "en",
    "X-Client-Type": "pc",
    ...(HARNESS_TYPE ? { "X-Harness-Type": HARNESS_TYPE, x_trace_id: "autoclaw-desktop" } : {}),
  };

  const RUNTIME_FILE      = path.join(AUTOCLAW_STATE_DIR, "openclaw.runtime.json");
  const RUNTIME_LAST_GOOD = path.join(AUTOCLAW_STATE_DIR, "openclaw.runtime.json.last-good");
  // Ordered fallbacks — try newest first, degrade gracefully
  const RUNTIME_CANDIDATES = [RUNTIME_FILE, RUNTIME_LAST_GOOD];

  const FALLBACK_MODELS = loadFallbackModels();

  return {
    PORT, HOST, PROXY_KEY, LOG_LEVEL, MAX_BODY_BYTES, RATE_LIMIT, MAX_MESSAGES, PREFER_LOCAL,
    JSONL_LOG, JSONL_SYNC, JSONL_FILE, JSONL_MAX_BYTES, REQUEST_LOG_FILE,
    UPSTREAM_HOST, UPSTREAM_PORT, UPSTREAM_PATH,
    UPSTREAM_BASE, MODEL_CONFIG_PATH, TOKEN_FILE, TOKEN_TTL_MS,
    AUTOCLAW_STATE_DIR, STATE_DIR,
    BUDGET_REQUESTS_PER_HOUR, MIN_GAP_MS, GOVERNOR_PERSIST, DIAGNOSTIC_MODE,
    HEARTBEAT_INTERVAL_MS,
    UPSTREAM_TIMEOUT_MS, LOCAL_AGENT_TIMEOUT_MS, GATEWAY_MIN_PROTOCOL, GATEWAY_MAX_PROTOCOL,
    LOCAL_GATEWAY_HOST, LOCAL_GATEWAY_PORT,
    CLIENT_HEADERS, RUNTIME_FILE, RUNTIME_LAST_GOOD, RUNTIME_CANDIDATES, FALLBACK_MODELS,
  };
}

// ============================================================================
// Dynamic client headers — AutoClaw app version & client identity
// ============================================================================

// AutoClaw's runtime file (the same one we read for the model catalog) carries
// the app's own request headers per model entry: X-Version, X-Tm, X-Product,
// X-Channel, X-Lang, X-Client-Type. They are merged over the hardcoded
// defaults and refreshed on a TTL, so an app update is picked up without
// editing or restarting the proxy.
//
// The identity machinery now lives in lib/identity.js (runtime file → last-good
// snapshot → pinned default, plus env overrides). These exports are the
// compatibility surface: getClientHeaders() keeps its old signature for the
// entrypoints and the main.js shim, while startIdentityWatch() lets an
// entrypoint hot-reload identity — and get the hourly pinned-identity notice —
// without a restart.
const _identityLayers = new Map();

export function getIdentityLayer(config, log = null) {
  const key = (config?.RUNTIME_CANDIDATES || []).join("|") || config?.TOKEN_FILE || "default";
  let layer = _identityLayers.get(key);
  if (!layer) {
    layer = createIdentityLayer(config, log);
    _identityLayers.set(key, layer);
  }
  return layer;
}

// Thin wrapper: every existing call site migrates by changing nothing.
export function getClientHeaders(config) {
  return getIdentityLayer(config).getIdentity().headers;
}

export function startIdentityWatch(config, log = null) {
  const layer = getIdentityLayer(config, log);
  layer.startWatch();
  return layer;
}

// ---------------------------------------------------------------------------
// Upstream transport (Requirement 2).
//
// Memoized per configured origin, like the identity layer above, so both
// entrypoints and every call site share one h2 session, one cookie jar and one
// keep-alive agent. Construction is lazy and never blocks the request path: if
// the transport cannot be built the legacy h1 branch in callUpstream() still
// serves the request (layer isolation).
// ---------------------------------------------------------------------------
const _transports = new Map();

export function getUpstreamTransport(config, log = null) {
  const key = `${config?.UPSTREAM_HOST || ""}:${config?.UPSTREAM_PORT || 443}`;
  let transport = _transports.get(key);
  if (!transport) {
    transport = createUpstreamTransport(config, log, getIdentityLayer(config, log), {
      isTransient: isTransientNetworkError,
    });
    _transports.set(key, transport);
  }
  return transport;
}

// Release every session/agent. Synchronous by design so it is safe to call from
// a process 'exit' hook.
export function closeUpstreamTransports() {
  for (const transport of _transports.values()) {
    try { transport.close(); } catch (_) { /* shutdown must never throw */ }
  }
  _transports.clear();
}

// ---------------------------------------------------------------------------
// Account pacing governor (Requirement 3).
//
// Memoized per (upstream origin + budget + gap), like the identity layer and
// the transport above, so both entrypoints and every call site share ONE window
// for the account. Two governor instances would mean two budgets per account,
// which is the bug this whole layer exists to prevent — hence the key includes
// the budget (a `--budget` change must not silently keep the old window).
// ---------------------------------------------------------------------------
const _governors = new Map();

export function getPacingGovernor(config, log = null, deps = {}) {
  const key = [
    config?.UPSTREAM_HOST || "",
    config?.BUDGET_REQUESTS_PER_HOUR ?? "",
    config?.MIN_GAP_MS ?? "",
    config?.GOVERNOR_PERSIST === false ? "off" : "on",
  ].join("|");
  let governor = _governors.get(key);
  if (!governor) {
    governor = createPacingGovernor(config, log, undefined, deps);
    _governors.set(key, governor);
  }
  return governor;
}

export function closePacingGovernors() {
  for (const governor of _governors.values()) {
    try { governor.stop(); } catch (_) { /* shutdown must never throw */ }
  }
  _governors.clear();
}

// ---------------------------------------------------------------------------
// Config heartbeat (Requirement 5).
//
// Memoized like the layers above, so both entrypoints and the CLI share ONE
// poller — two pollers would double the companion traffic this layer exists to
// mirror faithfully. The remote catalog it learns is stashed module-level so
// the catalog reader can prefer it when the app's runtime file is missing
// (self-heal: a closed app degrades to the last config we actually fetched,
// which beats the compiled-in pin).
// ---------------------------------------------------------------------------
const _heartbeats = new Map();
let _remoteCatalog = null;

export function setRemoteCatalog(models) {
  if (Array.isArray(models) && models.length > 0) _remoteCatalog = models;
}

export function getRemoteCatalog() { return _remoteCatalog; }

// The governor's own state names for "stop sending": the heartbeat must keep
// probing (that is the ban-lift detector) but slow right down.
export function isPacingPaused(config, log = null) {
  try {
    const s = getPacingGovernor(config, log).state()?.state;
    return s === "backoff" || s === "quarantined";
  } catch { return false; }
}

export function getConfigHeartbeat(config, log = null, deps = {}) {
  const key = `${config?.UPSTREAM_HOST || ""}|${config?.HEARTBEAT_INTERVAL_MS ?? ""}`;
  let heartbeat = _heartbeats.get(key);
  if (!heartbeat) {
    heartbeat = createConfigHeartbeat(config, log, {
      ...deps,
      // The wire call is injected: lib/heartbeat.js never touches the token
      // layer or https itself, which keeps it testable and import-cycle-free.
      fetchConfig: deps.fetchConfig || (async () => {
        let jwt = null;
        try { jwt = deps.getToken ? deps.getToken() : null; } catch (_) { return null; }
        return fetchRemoteModelConfig(config, jwt);
      }),
      onCatalog: (models, info) => {
        setRemoteCatalog(models);
        try { deps.onCatalog?.(models, info); } catch (_) { /* applying is best-effort */ }
      },
      isPaused: deps.isPaused || (() => isPacingPaused(config, log)),
    });
    _heartbeats.set(key, heartbeat);
  }
  return heartbeat;
}

export function startConfigHeartbeat(config, log = null, deps = {}) {
  const heartbeat = getConfigHeartbeat(config, log, deps);
  heartbeat.start();
  return heartbeat;
}

export function closeConfigHeartbeats() {
  for (const heartbeat of _heartbeats.values()) {
    try { heartbeat.stop(); } catch (_) { /* shutdown must never throw */ }
  }
  _heartbeats.clear();
}

// Release every long-lived upstream resource on the way out. Neither entrypoint
// had any signal handling before this: Ctrl+C and `glmproxy --stop` (which sends
// SIGTERM) both tore the process down with an h2 session and a keep-alive socket
// set still open, leaving a half-open connection on the upstream's WAF and
// watchFile handles on the app's runtime files. process.exit() is called
// unconditionally so a throwing cleanup can never swallow the signal and hang
// the terminal.
export function installShutdownHooks(config = null, log = null) {
  const release = () => {
    try { closeUpstreamTransports(); } catch (_) { /* never block exit */ }
    try { closePacingGovernors(); } catch (_) { /* never block exit */ }
    try { closeConfigHeartbeats(); } catch (_) { /* never block exit */ }
    for (const layer of _identityLayers.values()) {
      try { layer.stop(); } catch (_) { /* never block exit */ }
    }
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    try {
      process.once(signal, () => {
        try { log?.info?.(`${signal} received — closing upstream sessions`); } catch (_) {}
        release();
      });
    } catch (_) { /* no signal support (embedded use) — nothing to hook */ }
  }
}

// ============================================================================
// Model catalog — auto-healed from AutoClaw's runtime config
// ============================================================================

export function readRuntimeModels(config) {
  for (const candidate of config.RUNTIME_CANDIDATES) {
    try {
      const raw  = fs.readFileSync(candidate, "utf-8");
      const data = JSON.parse(raw);
      const rawModels = data?.models?.providers?.zai?.models;
      if (!Array.isArray(rawModels) || rawModels.length === 0) continue;

      const models = rawModels.map((m) => ({
        id:            m.id,
        name:          m.name || m.id,
        contextWindow: m.contextWindow || 1_048_576,
        // The runtime file overstates GLM-5.3's output cap (307200 vs the
        // cloud's real 131072); never advertise more than the verified cap.
        maxTokens:     Math.min(m.maxTokens || 131_072, OUTPUT_CAPS[m.id] ?? Infinity),
      }));

      if (models.length > 0) return { models, source: candidate };
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

export function loadModelsFromRuntime(config) {
  const catalog = readRuntimeModels(config);
  if (catalog) {
    console.log(`  📋  Loaded ${catalog.models.length} model(s) from ${path.basename(catalog.source)}`);
    return catalog.models;
  }

  // Nothing worked — use hardcoded fallback
  console.warn("  ⚠️   Could not read runtime models — using built-in fallback");
  return config.FALLBACK_MODELS;
}

export function getModelCatalog(config) {
  const catalog = readRuntimeModels(config);
  if (catalog) {
    return { models: catalog.models, source: catalog.source, fallback: false };
  }
  // Self-heal: the app is closed and even its last-good runtime snapshot is
  // gone, but the heartbeat has been polling the real config all along — so
  // prefer what we actually fetched over the compiled-in pin. This is the
  // runtime-discovery chain applied to the catalog's last rung.
  const remote = getRemoteCatalog();
  if (Array.isArray(remote) && remote.length > 0) {
    return { models: remote, source: "remote model-config", fallback: false, remote: true };
  }
  return { models: config.FALLBACK_MODELS, source: null, fallback: true };
}

// Load MODELS once; each entrypoint keeps its own module-level snapshot
export function loadModelCatalog(config) {
  return { MODELS: loadModelsFromRuntime(config) };
}

// ============================================================================
// Real upstream output caps (probe-verified 2026-09-02)
// ============================================================================
// AutoClaw's runtime catalog OVERSTATES GLM-5.3's max output (307200) — the
// cloud's real cap for every GLM model is 131072. Sending max_completion_tokens
// above the cap makes the upstream silently substitute a deepseek model
// (glm-5.3 → deepseek-v4-pro, flash/turbo/auto → deepseek-v4-flash) and bill
// deepseek credits. Verified to the exact token: 131072 ok, 131073 flips.
export const OUTPUT_CAPS = Object.freeze({
  "zaicoding_glm-5.3":               131_072,
  "zai_glm-5.3-flash":               131_072,
  "zai_glm-5-turbo":                 131_072,
  "zai_auto":                        131_072,
  "tdpsk_deepseek-v4-flash-202605":  393_216,
  "tdpsk_deepseek-v4-pro-202606":    393_216,
});

// Clamp a requested max output to the model's real upstream cap. Unknown
// models (not in OUTPUT_CAPS) pass through untouched.
export function clampMaxOutput(modelId, value) {
  if (!Number.isFinite(value)) return value;
  const cap = OUTPUT_CAPS[modelId];
  if (!cap) return value;
  return Math.min(value, cap);
}

// ============================================================================
// Logger
// ============================================================================

const COLORS = {
  RESET: '\x1b[0m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  GRAY: '\x1b[90m'
};

export { COLORS };

export function formatLog(level, color, ...args) {
  const timestamp = new Date().toISOString();
  return [
    `${COLORS.GRAY}[${timestamp}]${COLORS.RESET}`,
    `${color}[${level}]${COLORS.RESET}`,
    ...args
  ];
}

export function createLogger(logLevel) {
  const log = {
    debug:   (...a) => logLevel === "debug"  && console.log(...formatLog('DEBUG', COLORS.MAGENTA, ...a)),
    info:    (...a) => logLevel !== "silent" && console.log(...formatLog('INFO',  COLORS.BLUE,    ...a)),
    warn:    (...a) => logLevel !== "silent" && console.warn(...formatLog('WARN',  COLORS.YELLOW,  ...a)),
    error:   (...a) => console.error(...formatLog('ERROR', COLORS.RED, ...a)),
    success: (...a) => logLevel !== "silent" && console.log(...formatLog('SUCCESS', COLORS.GREEN,  ...a)),
  };
  return { log };
}

// ============================================================================
// Token layer (mirrors acc's token-extractor.js)
// ============================================================================

export function createTokenLayer(config, log) {
  let _token       = null;
  let _tokenReadAt = 0;

  // Read the X-Authorization JWT from AutoClaw's local token file. Throws if AutoClaw isn't running / logged in.
  function loadToken() {
    try {
      const raw  = fs.readFileSync(config.TOKEN_FILE, "utf-8");
      const data = JSON.parse(raw);
      const auth = data?.headers?.["X-Authorization"];
      if (!auth) throw new Error("X-Authorization field missing");
      return auth; // "Bearer <jwt>"
    } catch (err) {
      throw new Error(
        `Cannot read AutoClaw token from ${config.TOKEN_FILE}. ` +
        `Make sure AutoClaw is running and you are logged in. (${err.message})`
      );
    }
  }

  // Return a cached token, refreshing from disk if the TTL has elapsed.
  function getToken() {
    if (!_token || Date.now() - _tokenReadAt > config.TOKEN_TTL_MS) {
      _token       = loadToken();
      _tokenReadAt = Date.now();
      log.info(`Token loaded (expires cache in ${config.TOKEN_TTL_MS / 60_000} min)`);
    }
    return _token;
  }

  // Force the next getToken() call to re-read the file.
  function invalidateToken() {
    _token       = null;
    _tokenReadAt = 0;
  }

  // Hot-reload token when AutoClaw rotates it — avoids restart
  function startWatch() {
    fs.watchFile(config.TOKEN_FILE, { interval: 1000 }, () => {
      try {
        _token = loadToken();
        log.info("Token reloaded");
      } catch (e) {
        log.warn(`Token reload failed: ${e.message}`);
      }
    });
  }

  return { loadToken, getToken, invalidateToken, startWatch };
}

// ============================================================================
// Error taxonomy — one classifier decides status/type/code/message for every
// failure, so clients never see a generic blob again.
//
//   quota / 402 / code-810000 / 积分不足  → 402 insufficient_credits
//   unknown model                         → 404 not_found_error
//   rate limited                          → 429 rate_limit_error (passthrough)
//   bad client input                      → 400 / 413 / 415 (handled pre-upstream)
//   cloud token missing                   → 503 service_unavailable
//   upstream timeout                      → 504
//   other upstream/network failures       → 502 (with upstream status noted)
// ============================================================================

// Translate common Chinese upstream error messages to English
const ZH_ERROR_MAP = [
  [/积分不足/, "Insufficient credits — please recharge your AutoClaw account"],
  [/非法模型/, "Invalid model — the requested model ID is not recognized upstream"],
  [/请求频率/, "Rate limited by upstream — too many requests"],
  [/令牌.*过期|token.*expired/i, "Authentication token expired"],
  [/参数.*错误|invalid.*param/i, "Invalid request parameters"],
  [/服务.*繁忙/, "Upstream service is busy — please retry"],
  [/请求.*超时/, "Upstream request timed out"],
  [/账号.*封禁|已封禁/, "Account banned by AutoClaw"],
];

export function translateUpstreamError(msg) {
  if (typeof msg !== "string") return msg;
  for (const [pattern, english] of ZH_ERROR_MAP) {
    if (pattern.test(msg)) return english;
  }
  return msg;
}

export function getUpstreamErrorMessage(body) {
  const text = typeof body === "string" ? body.trim() : "";

  try {
    const parsed = JSON.parse(text);
    const message = typeof parsed === "string"
      ? parsed
      : parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof message === "string" && message.length > 0) {
      return translateUpstreamError(message);
    }
    return "Upstream error";
  } catch {
    const title = text.match(/<title>(.*?)<\/title>/i)?.[1];
    if (title) return translateUpstreamError(title);
    if (/<(?:html|body|!doctype)\b/i.test(text)) return "Upstream returned an invalid error response";
    return translateUpstreamError(text || "Upstream error");
  }
}

// Body markers that mean "this account cannot use this model until it pays" —
// these are PERMANENT conditions, not transient hiccups, so they must never be
// retried or fallen back on. AutoClaw surfaces them as 403+code 810000, plain
// 402, or Chinese credit messages depending on which door you knock on.
const QUOTA_BODY_RE = /积分不足|free quota used up|insufficient credit|quota\s*(exceed|used up)|810000/i;

// "that model id does not exist" arrives as a 400 wearing a model_not_found
// verdict. AutoClaw retires ids without warning (zai_glm-5-turbo now answers
// 400 {"message":"非法模型"}), and a generic retryable classification for it had
// downstream consequences — see the rule in classifyUpstreamError.
const INVALID_MODEL_BODY_RE = /非法模型|invalid\s+model\b/i;

// Account-level ban (403 + code 410004 / "账号已被封禁"). PERMANENT, like quota:
// repeat requests must fail instantly instead of replaying doomed cloud
// attempts and falling into the local agent on every call.
const BANNED_BODY_RE = /账号.*封禁|已封禁|410004/i;

// Soft free-tier throttle: 403 + code 810002 with `"action":{"kind":"pay-view"}`
// and "We're experiencing high demand right now… upgrade to a monthly
// subscription for priority access". Not a ban, not quota exhaustion — the
// account works again shortly. It is classified as a rate limit on purpose:
// `shouldFallbackToLocal()` already refuses 429, and a live session measured on
// 2026-09-21 showed why that matters. Every 810002 event there fell into the
// local AutoClaw WS agent, which re-issues the *same* cloud call and came back
// with the same 403 (`FailoverError: HTTP 403 … /autoclaw-proxy/proxy/autoclaw/
// chat/completions`), burning the full 120 s budget per request — 13 of 15
// attempts died that way while the harness had already timed out and retried.
// Mapping it to 429 skips the doomed fallback *and* tells harnesses to back off,
// which is what the signal actually means.
const PAYVIEW_BODY_RE = /810002|pay-view|high demand[\s\S]*?priority access/i;

// Classify a failed cloud response into the client-facing error shape.
// `bodyText` is the raw upstream response body (may be empty).
export function classifyUpstreamError(statusCode, bodyText, modelName) {
  const text   = typeof bodyText === "string" ? bodyText : "";
  const detail = getUpstreamErrorMessage(text);

  // Account bans outrank generic 403s — same account feeds the local agent,
  // so there is no fallback worth replaying either.
  if (statusCode === 403 && BANNED_BODY_RE.test(text)) {
    return {
      status: 403,
      type: "permission_error",
      code: "account_banned",
      permanent: true,
      message: detail && detail !== "Upstream error"
        ? `${modelName || "This model"} — ${detail}`
        : `${modelName || "This model"} — account banned by AutoClaw`,
    };
  }

  // Quota outranks everything — upstream reports it under several statuses
  if (statusCode === 402 || QUOTA_BODY_RE.test(text)) {
    return {
      status: 402,
      type: "insufficient_credits",
      code: "quota_exhausted",
      permanent: true,
      message: `${modelName || "This model"} is out of credits — recharge or subscribe in AutoClaw` +
               (detail && detail !== "Upstream error" ? ` (${detail})` : ""),
    };
  }

  // A 400 that actually says "this model id does not exist" is a 404 verdict, and
  // must behave like one. Classified as a generic non-permanent 400 it engaged the
  // local desktop-agent fallback, where a doomed run held the request open for its
  // full timeout budget: the harness gave up first, retried, and multiplied traffic
  // against the account (measured 2026-09-21). As a permanent model_not_found it
  // skips the fallback, and the negative cache makes every repeat fail instantly
  // instead of replaying a doomed cloud attempt plus a doomed agent run.
  if (INVALID_MODEL_BODY_RE.test(text)) {
    return {
      status: 404, type: "not_found_error", code: "model_not_found", permanent: true,
      message: `Model ${modelName || "requested"} is not recognized by AutoClaw upstream`,
    };
  }

  // Free-tier capacity throttle. 429 rather than 403 so the client backs off and
  // — critically — so `shouldFallbackToLocal()` refuses it: the local desktop
  // agent shares this account and hits the same endpoint, so it can only fail
  // the same way, one full timeout later.
  if (PAYVIEW_BODY_RE.test(text)) {
    return {
      status: 429, type: "rate_limit_error", code: "upstream_busy", permanent: false,
      message: "AutoClaw is throttling free-tier traffic (\"high demand\") — retry shortly or upgrade for priority access",
    };
  }

  switch (statusCode) {
    case 401:
      return {
        status: 401, type: "authentication_error", code: "token_expired", permanent: false,
        message: "AutoClaw token expired or invalid — cached token invalidated, retry now",
      };
    case 403:
      return {
        status: 403, type: "permission_error", code: "forbidden_by_upstream", permanent: false,
        message: detail !== "Upstream error" ? detail : "AutoClaw upstream refused this request (HTTP 403)",
      };
    case 404:
      return {
        status: 404, type: "not_found_error", code: "model_not_found", permanent: true,
        message: `Model ${modelName || ""} is not recognized by AutoClaw upstream`.trim(),
      };
    case 429:
      return {
        status: 429, type: "rate_limit_error", code: "rate_limited_by_upstream", permanent: false,
        message: detail !== "Upstream error" ? detail : "Rate limited by AutoClaw upstream — slow down",
      };
    case 400:
      return {
        status: 400, type: "invalid_request_error", code: "invalid_request", permanent: false,
        message: detail,
      };
    default:
      if (statusCode >= 500) {
        return {
          status: 502, type: "api_error", code: "upstream_failure", permanent: false,
          message: `AutoClaw upstream failed (HTTP ${statusCode}): ${detail}`,
        };
      }
      return {
        status: statusCode >= 400 ? statusCode : 502,
        type: "api_error", code: "upstream_failure", permanent: false,
        message: detail !== "Upstream error" ? detail : "Upstream error",
      };
  }
}

// Classify an error raised by the local WebSocket agent path. The gateway's
// FailoverError strings embed the real upstream status ("FailoverError: HTTP
// 403: ...", "FailoverError: 402 status code"), so mine those first.
export function classifyLocalAgentError(err, modelName) {
  const raw = String(err?.message || err || "");

  if (/\b402\b/.test(raw)) {
    return {
      status: 402, type: "insufficient_credits", code: "quota_exhausted", permanent: true,
      message: `${modelName || "This model"} is out of credits — recharge or subscribe in AutoClaw`,
    };
  }
  if (/\b403\b/.test(raw)) {
    if (/quota|810000/i.test(raw)) {
      return {
        status: 402, type: "insufficient_credits", code: "quota_exhausted", permanent: true,
        message: `${modelName || "This model"} free quota is used up — subscribe to a membership in AutoClaw`,
      };
    }
    return {
      status: 403, type: "permission_error", code: "forbidden_by_local_gateway", permanent: false,
      message: "AutoClaw local gateway refused this request (HTTP 403)",
    };
  }
  if (/timeout/i.test(raw)) {
    return {
      status: 504, type: "api_error", code: "local_gateway_timeout", permanent: false,
      message: "AutoClaw local gateway did not finish in time — try again or check the desktop app",
    };
  }
  if (/token not found|Is AutoClaw running/i.test(raw)) {
    return {
      status: 503, type: "service_unavailable", code: "no_local_gateway", permanent: true,
      message: "AutoClaw local gateway is not reachable — make sure the desktop app is running",
    };
  }
  return {
    status: 502, type: "api_error", code: "local_gateway_failed", permanent: false,
    message: getUpstreamErrorMessage(raw),
  };
}

// Classify an error thrown by the upstream transport itself — no HTTP
// response ever arrived: dead token, connection reset after the retry budget,
// or a 2-minute timeout.
export function classifyTransportError(err) {
  const msg = String(err?.message || err || "");

  if (/Cannot read AutoClaw token/i.test(msg)) {
    return {
      status: 503, type: "service_unavailable", code: "no_token", permanent: false,
      message: msg,
    };
  }
  if (err?.code === "UPSTREAM_TIMEOUT" || /timeout/i.test(msg)) {
    return {
      status: 504, type: "api_error", code: "upstream_timeout", permanent: false,
      message: msg !== "Error" ? msg : "AutoClaw upstream did not respond in time",
    };
  }
  return {
    status: 502, type: "api_error", code: "upstream_connection_failed", permanent: false,
    message: `${msg}${err?.code ? ` (${err.code})` : ""}` || "Could not reach AutoClaw upstream",
  };
}

// Transient network failures are worth exactly one transparent retry; anything
// else (timeouts included — they already burned 2 minutes) is surfaced as-is.
export function isTransientNetworkError(err) {
  const code = err?.code || "";
  const msg  = String(err?.message || "");
  return (
    ["ECONNRESET", "EPIPE", "ECONNABORTED", "ERR_STREAM_PREMATURE_CLOSE"].includes(code) ||
    /socket hang up|premature close/i.test(msg)
  );
}

// Single shared decision for "should this failure engage the local gateway".
// 404 means the client asked for something that doesn't exist anywhere, and
// 429 means upstream is throttling us — hammering the local agent then would
// only hide the signal, so both bypass fallback.
export function shouldFallbackToLocal(statusCode) {
  return statusCode >= 400 && statusCode !== 404 && statusCode !== 429;
}

// Short-lived negative cache for PERMANENT failures (quota, unknown model).
// Without it, every request for a dead model replays: cloud attempt → doomed
// retry sleep → local agent connect → failure (~30s+). With it, repeats fail
// instantly with the exact same classified error until the TTL lapses.
export function createPermanentFailureCache(ttlMs = 60_000) {
  const _cache = new Map(); // modelId -> { status, type, code, message, expiresAt }
  return {
    mark(modelId, classification) {
      if (!classification.permanent) return;
      _cache.set(modelId, {
        status: classification.status,
        type: classification.type,
        code: classification.code,
        message: classification.message,
        expiresAt: Date.now() + ttlMs,
      });
    },
    // Returns the cached classification while fresh, else clears the entry.
    get(modelId) {
      const hit = _cache.get(modelId);
      if (!hit) return null;
      if (Date.now() > hit.expiresAt) { _cache.delete(modelId); return null; }
      return hit;
    },
    clear() { _cache.clear(); },
  };
}

// ============================================================================
// HTTP response helpers
// ============================================================================

export function sendJSON(res, data, status = 200, extraHeaders = null) {
  const body = JSON.stringify(data);
  const headers = {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(body);
}

// OpenAI shape: { error: { message, type, code } }
export function sendErrorOpenAI(res, message, type = "api_error", status = 500, code = null) {
  sendJSON(res, { error: { message, type, code } }, status);
}

// Anthropic shape: { type: "error", error: { type, message, code } }
export function sendErrorAnthropic(res, message, type = "api_error", status = 500, code = null) {
  sendJSON(res, { type: "error", error: { type, message, ...(code ? { code } : {}) } }, status);
}

// Classify a governor verdict (Requirement 3.2). The governor refuses requests
// before they reach the transport, so these carry no upstream body — the
// taxonomy exists so a client sees the same { status, type, code, message,
// permanent } shape as every other failure, plus a Retry-After it can obey.
//
// `budget_exceeded` is deliberately a 429: the request was fine, the account
// was pacing itself, and the correct client behavior is to wait — which is
// exactly what a harness does with 429 and does NOT do with a 403.
export function classifyGovernorError(verdict) {
  const reason = verdict?.reason || "budget_exceeded";
  const retryAfterMs = Number.isFinite(verdict?.retryAfterMs) && verdict.retryAfterMs > 0 ? verdict.retryAfterMs : 0;
  const retryAfterSeconds = retryAfterMs > 0 ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;
  const budget = Number.isFinite(verdict?.budget) ? verdict.budget : null;
  const used = verdict?.burn?.windowRequests;
  const wait = retryAfterSeconds ? ` — retry in ${retryAfterSeconds}s` : "";

  if (reason === "account_quarantined") {
    return {
      status: 403, type: "permission_error", code: "account_quarantined", permanent: true, retryAfterSeconds: null,
      message: "This AutoClaw account is banned upstream (code 410004) — upstream calls are paused until the ban is lifted",
    };
  }
  if (reason === "upstream_backoff") {
    return {
      status: 429, type: "rate_limit_error", code: "upstream_backoff", permanent: false, retryAfterSeconds,
      message: "AutoClaw upstream is throttling this account — the proxy is backing off instead of retrying" + wait,
    };
  }
  return {
    status: 429, type: "rate_limit_error", code: "budget_exceeded", permanent: false, retryAfterSeconds,
    message: "Hourly upstream budget reached for this AutoClaw account" +
      (budget ? ` (${budget} requests/hour${Number.isFinite(used) ? `, ${used} used` : ""})` : "") +
      wait +
      ", or set BUDGET_REQUESTS_PER_HOUR=0 to disable pacing",
  };
}

// Send a classification produced by classifyUpstreamError/classifyLocalAgentError
export function sendClassifiedErrorOpenAI(res, cls) {
  sendJSON(res, { error: { message: cls.message, type: cls.type, code: cls.code ?? null } }, cls.status, retryAfterHeaders(cls));
}

export function sendClassifiedErrorAnthropic(res, cls) {
  sendJSON(res, { type: "error", error: { type: cls.type, message: cls.message, code: cls.code ?? undefined } }, cls.status, retryAfterHeaders(cls));
}

// A classification carrying retryAfterSeconds becomes a real Retry-After
// header, so a harness backs off without parsing prose or guessing.
function retryAfterHeaders(cls) {
  const secs = Number(cls?.retryAfterSeconds);
  return Number.isFinite(secs) && secs > 0 ? { "Retry-After": String(Math.ceil(secs)) } : null;
}

export function isAuthorized(req, proxyKey) {
  if (!proxyKey) return true;
  const header = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const key    = header.startsWith("Bearer ") ? header.slice(7) : header;
  return key === proxyKey;
}

export function validateChatPayload(body, maxMessages = Infinity) {
  const envInt = (name, fallback) => {
    const raw = process.env[name];
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const MAX_MESSAGES = (maxMessages && Number.isFinite(maxMessages)) ? maxMessages : Infinity;
  // Text caps guard against runaway harness spam. Image payloads (base64
  // data URLs) are sized SEPARATELY — the cloud accepts native image_url
  // parts and screenshots are legitimately large; counting base64 as text
  // caused the 413 "an individual message is too large" bug (2026-09-04).
  const MAX_MESSAGE_TEXT_BYTES = envInt("MAX_MESSAGE_TEXT_BYTES", 256 * 1024);
  const MAX_TOTAL_MESSAGE_TEXT_BYTES = envInt("MAX_TOTAL_MESSAGE_TEXT_BYTES", 1024 * 1024);
  const MAX_IMAGE_BYTES = envInt("MAX_IMAGE_BYTES", 20 * 1024 * 1024);
  const MAX_TOOLS = 64;
  const MAX_TOOL_BYTES = 128 * 1024;
  const MAX_TOTAL_TOOL_BYTES = 512 * 1024;

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { message: "messages must be a non-empty array", statusCode: 400 };
  }
  if (body.messages.length > MAX_MESSAGES) {
    return { message: `messages must contain at most ${MAX_MESSAGES} entries`, statusCode: 413 };
  }

  // Measure one message's content: text bytes (strings + text parts) and
  // image bytes (decoded size of data: URLs in image_url parts).
  const measure = (content) => {
    if (typeof content === "string") return { textBytes: Buffer.byteLength(content), imageBytes: 0 };
    let textBytes = 0, imageBytes = 0;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") { textBytes += Buffer.byteLength(part); continue; }
        if (part?.type === "text") { textBytes += Buffer.byteLength(typeof part.text === "string" ? part.text : JSON.stringify(part.text ?? "")); continue; }
        if (part?.type === "image_url") {
          const url = part?.image_url?.url;
          if (typeof url === "string" && url.startsWith("data:")) {
            const comma = url.indexOf(",");
            const b64Chars = comma >= 0 ? url.length - comma - 1 : 0;
            imageBytes += Math.floor((b64Chars * 3) / 4); // base64 → bytes
          }
          // remote http(s) image references cost nothing locally
        }
      }
    }
    return { textBytes, imageBytes };
  };

  let totalMessageBytes = 0;
  for (const message of body.messages) {
    const { textBytes, imageBytes } = measure(message?.content);
    if (imageBytes > MAX_IMAGE_BYTES) {
      return { message: `an image attachment is too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB per image)`, statusCode: 413 };
    }
    if (textBytes > MAX_MESSAGE_TEXT_BYTES) {
      return { message: "an individual message is too large", statusCode: 413 };
    }
    totalMessageBytes += textBytes;
    if (totalMessageBytes > MAX_TOTAL_MESSAGE_TEXT_BYTES) {
      return { message: "combined message content is too large", statusCode: 413 };
    }
  }

  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return { message: "tools must be an array", statusCode: 400 };
  }
  if (body.tools?.length > MAX_TOOLS) {
    return { message: `tools must contain at most ${MAX_TOOLS} entries`, statusCode: 413 };
  }

  let totalToolBytes = 0;
  for (const tool of body.tools || []) {
    const bytes = Buffer.byteLength(JSON.stringify(tool));
    if (bytes > MAX_TOOL_BYTES) {
      return { message: "an individual tool definition is too large", statusCode: 413 };
    }
    totalToolBytes += bytes;
    if (totalToolBytes > MAX_TOTAL_TOOL_BYTES) {
      return { message: "combined tool definitions are too large", statusCode: 413 };
    }
  }

  return null;
}

export function generateId() {
  return crypto.randomBytes(12).toString("hex");
}

export function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const ct = req.headers["content-type"] || "";
    if (!ct.toLowerCase().includes("application/json")) {
      return reject(Object.assign(new Error("Content-Type must be application/json"), { statusCode: 415 }));
    }

    let totalBytes = 0;
    let limitHit = false;
    const chunks = [];
    req.on("data", (c) => {
      totalBytes += c.length;
      if (totalBytes > maxBodyBytes) {
        if (!limitHit) {
          limitHit = true;
          reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        }
        // Keep draining (chunks are discarded) so the 413 response can still
        // be delivered on this connection... unless the client is flooding far
        // past the cap (4×), in which case cut the socket — nobody legitimate
        // sends 200MB to a 50MB-capped local proxy, and draining forever just
        // hands them a free upload channel.
        if (totalBytes > maxBodyBytes * 4) {
          try { req.destroy(); } catch (_) {}
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (limitHit) return;
      try {
        let raw = Buffer.concat(chunks).toString("utf8");
        // Strip UTF-8 BOM if present
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        reject(Object.assign(new Error(`Invalid JSON: ${e.message}`), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// Collect a full upstream response body (error inspection / passthrough)
export function collectResponse(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", () => resolve(""));
  });
}

// R1: never let an upstream rejection pass without its body on record —
// quota walls hide behind bare status codes. One compact line,
// whitespace-collapsed, capped at 500 chars.
export function logUpstreamErrorBody(logger, status, bodyText) {
  const text = typeof bodyText === "string" ? bodyText.replace(/\s+/g, " ").trim() : "";
  if (!text) return;
  logger.warn(`Upstream ${status} body: ${text.slice(0, 500)}`);
}

// SSE response headers — one frozen constant instead of four copies of the
// same literal across both entrypoints' streaming writeHead calls.
export const SSE_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
});

// Model-field validation shared by both wire formats — the model drives
// everything downstream, so it is checked before any format conversion.
// Returns a sendable error descriptor or null.
export function validateModelField(body) {
  if (!body.model || typeof body.model !== "string" || body.model.length > 256 || body.model.includes("..") || /[\r\n\0]/.test(body.model)) {
    return { status: 400, message: "model must be a valid non-empty string (max 256 chars)", type: "invalid_request_error", code: "invalid_model" };
  }
  return null;
}

// Last-message preview for request logs: string content verbatim, anything
// else JSON-stringified.
export function lastMessagePreview(messages) {
  const lastMsg = messages?.[messages.length - 1];
  return typeof lastMsg?.content === "string" ? lastMsg.content : JSON.stringify(lastMsg?.content) ?? "";
}

// Cloud call with the one retry for the historically flaky 400 "invalid
// request" hiccup — but never for a model already confirmed permanently
// broken. Buffers and logs every >=400 body along the way (R1). Returns the
// terminal upstream response plus its buffered error body; success rendering
// stays at the call site so wire formats never leak in here.
export async function callUpstreamWithInvalidRequestRetry(callUpstream, modelId, permanentFailures, log) {
  let res = await callUpstream();
  let errBody = "";
  if (res.statusCode === 400) {
    errBody = await collectResponse(res);
    logUpstreamErrorBody(log, res.statusCode, errBody);
    if (errBody.includes('"invalid request"') && !permanentFailures.get(modelId)) {
      log.info("Upstream 400 invalid request — retrying once");
      await new Promise(r => setTimeout(r, 2000));
      res = await callUpstream();
      if (res.statusCode < 400) return { res, errBody: "" };
      errBody = await collectResponse(res);
      logUpstreamErrorBody(log, res.statusCode, errBody);
    }
  } else if (res.statusCode >= 400) {
    errBody = await collectResponse(res);
    logUpstreamErrorBody(log, res.statusCode, errBody);
  }
  return { res, errBody };
}

// ============================================================================
// Rate limiter — simple token bucket per client IP
// ============================================================================

export function createRateLimiter(rateLimit) {
  const _buckets = new Map();
  function limit(ip) {
    const now = Date.now();
    const b = _buckets.get(ip);
    if (!b) { _buckets.set(ip, { tokens: Math.max(0, rateLimit - 1), last: now }); return true; }
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(rateLimit, b.tokens + elapsed * rateLimit);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  // Drop stale buckets so the map can't grow unbounded (unref'd — doesn't hold the process open)
  function startBucketSweep() {
    setInterval(() => {
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const [ip, b] of _buckets) if (b.last < cutoff) _buckets.delete(ip);
    }, 3600 * 1000).unref();
  }
  return { rateLimit: limit, startBucketSweep };
}

// Resolve the client IP for rate limiting. X-Forwarded-For is trusted ONLY
// from peers listed in TRUSTED_PROXIES (comma-separated IPs) — trusting it
// from arbitrary non-loopback peers lets a remote client rotate fake IPs to
// dodge the limiter. Both entrypoints share this single implementation.
export function resolveClientIp(req) {
  const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || "").split(",").map(s => s.trim()).filter(Boolean);
  const peer = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  if (TRUSTED_PROXIES.includes(peer)) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return xff.split(",")[0].trim().replace(/^::ffff:/, "");
  }
  return peer;
}

// ============================================================================
// Request loggers
// ============================================================================

// JSON ring logger — keeps the last N requests on disk.
// Concurrency-safe across processes via an exclusive lockfile: without it, two
// proxies doing read-modify-write silently eat each other's entries (observed:
// --test-models results vanishing while the main proxy served traffic).
export function createRequestLogger(filePath) {
  const MAX_LOG_ENTRIES = 50;
  const LOCK_PATH = `${filePath}.lock`;

  function acquireLock(deadlineMs = 1500) {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      try {
        fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" }); // exclusive create
        return true;
      } catch (_) {
        // Steal a stale lock (>2s old) so a crashed writer can't wedge logging
        try {
          if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 2000) { fs.unlinkSync(LOCK_PATH); continue; }
        } catch (_) { /* lock vanished between stat and unlink — loop retries */ }
        if (Date.now() > deadline) return false; // give up; write unlocked rather than lose the entry
        // Synchronous sleep that doesn't starve the event loop
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
        catch (_) { const end = Date.now() + 25; while (Date.now() < end) { /* spin */ } }
      }
    }
  }

  function releaseLock() {
    try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  }

  function logRequest(entry) {
    let locked = false;
    try {
      locked = acquireLock();
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch (_) {}
      entries.push(entry);
      if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(-MAX_LOG_ENTRIES);
      fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
    } catch (_) { /* never let logging break request handling */ }
    finally { if (locked) releaseLock(); }
  }

  return { logRequest };
}

// JSONL structured log — one line per request, rotated past the cap so disk
// can't fill. This append-only stream is the reliable source of truth; treat
// the pretty ring file above as best-effort.
export function createJsonlLogger({ enabled, sync = false, file, maxBytes }) {
  function logJsonl(entry) {
    if (!enabled) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    } catch (_) {}
    try {
      if (sync) fs.appendFileSync(file, line);
      else fs.appendFile(file, line, () => {});
    } catch (_) {}
  }
  return { logJsonl };
}

// ============================================================================
// Local WebSocket bridge (L-route) — drives AutoClaw's own gateway on
// 127.0.0.1:18789 as a fallback when the cloud upstream fails.
// ============================================================================

export function encodeWsFrame(text) {
  const payload = Buffer.from(text, 'utf-8');
  const length = payload.length;
  let header;
  const mask = crypto.randomBytes(4);
  if (length <= 125) {
    header = Buffer.alloc(2 + 4);
    header[0] = 0x81; header[1] = 0x80 | length; mask.copy(header, 2);
  } else if (length <= 65535) {
    header = Buffer.alloc(4 + 4);
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(length, 2); mask.copy(header, 4);
  } else {
    header = Buffer.alloc(10 + 4);
    header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2); mask.copy(header, 10);
  }
  const maskedPayload = Buffer.alloc(length);
  for (let i = 0; i < length; i++) maskedPayload[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, maskedPayload]);
}

export function decodeWsFrames(buffer, onMessage) {
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let headerLen = 2;
    if (payloadLen === 126) {
      if (buffer.length - offset < 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buffer.length - offset < 10) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    if (isMasked) headerLen += 4;
    if (buffer.length - offset < headerLen + payloadLen) break;
    const payload = buffer.slice(offset + headerLen, offset + headerLen + payloadLen);
    offset += headerLen + payloadLen;
    if (opcode === 1) onMessage(payload.toString('utf-8'));
    else if (opcode === 8) break;
  }
  return buffer.slice(offset);
}

export function getLocalGatewayToken() {
  try {
    const tokenFile = path.join(autoclawStateDir(), '.gateway-token');
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, 'utf-8').trim();
    }
  } catch (_) {}
  return null;
}

// Run a prompt through AutoClaw's local `agent` RPC and stream assistant
// deltas back through callbacks. NOTE: this executes a full agentic run in
// the desktop app (tools included), not a chat completion — expect seconds to
// minutes, and fresh sessionKey per request keeps runs isolated.
//
// Protocol quirk: the RPC answers TWICE — first `res ok:true` (accepted),
// later possibly another `res` frame with the same id and `ok:false` carrying
// the failure. Handle both, or accepted-but-failed runs hang until timeout.
export function streamLocalGatewayAgent({ config, modelId, messages, onChunk, onEnd, onError, timeoutMs = 120000 }) {
  const token = getLocalGatewayToken();
  if (!token) {
    return onError(new Error("Local AutoClaw gateway token not found. Is AutoClaw running?"));
  }

  // Format conversation messages preserving roles
  const prompt = (messages || []).map((m) => {
    const role = (m.role || "user").toUpperCase();
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return `${role}: ${content}`;
  }).join("\n\n");

  const normalizedModel = modelId.startsWith("zai/") ? modelId : `zai/${modelId}`;
  const sessionKey = 'agent:main:' + crypto.randomBytes(4).toString('hex');
  const runId = 'key-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');

  let finished = false;
  let activeReq = null;      // live upgrade request of the current attempt
  let upgradedSocket = null; // after the upgrade the socket detaches from `req` —
                             // destroying req alone LEAKS the live WS connection
  let protocolRetried = false; // one reconnect allowed on PROTOCOL_MISMATCH
  const finish = (fn) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { (upgradedSocket || activeReq)?.destroy?.(); } catch (_) {}
    fn();
  };

  const timer = setTimeout(() => {
    finish(() => onError(new Error(`Local gateway execution timeout (${timeoutMs / 1000}s)`)));
  }, timeoutMs);

  // One connect attempt: upgrade + challenge + connect with the given protocol
  // range. The gateway rejects out-of-range offers with a structured
  // PROTOCOL_MISMATCH detail naming its expectedProtocol — on that exact error
  // we reconnect once with the server's own range (self-heals across app
  // updates); any other failure ends the run.
  const attemptConnect = (minProtocol, maxProtocol) => {
    const secKey = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: config.LOCAL_GATEWAY_HOST,
      port: config.LOCAL_GATEWAY_PORT,
      path: '/',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': secKey,
        'Authorization': 'Bearer ' + token
      }
    });
    activeReq = req;
    req.on('error', (err) => finish(() => onError(err)));
    req.on('upgrade', (res, socket) => {
      upgradedSocket = socket;
      socket.on('error', (err) => finish(() => onError(err)));

      let buf = Buffer.alloc(0);
      let connected = false;
      socket.on('data', chunk => {
        buf = decodeWsFrames(Buffer.concat([buf, chunk]), rawMsg => {
          try {
            const msg = JSON.parse(rawMsg);
            if (!connected) {
              if (msg.event === 'connect.challenge') {
                socket.write(encodeWsFrame(JSON.stringify({
                  type: 'req', id: 'conn-1', method: 'connect',
                  params: {
                    minProtocol, maxProtocol,
                    // client.id is allowlisted by the gateway — arbitrary
                    // values get INVALID_REQUEST before any agent can run
                    client: { id: 'gateway-client', version: getClientHeaders(config)['X-Version'] || '1.17.5', platform: 'win', mode: 'backend' },
                    role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
                    caps: ['tool_events'], commands: [], permissions: {}, auth: { token }, locale: 'en', userAgent: `glmproxy/${VERSION}`
                  }
                })));
              } else if (msg.id === 'conn-1') {
                if (!msg.ok) {
                  const details = msg.error?.details;
                  if (details?.code === 'PROTOCOL_MISMATCH' && typeof details.expectedProtocol === 'number' && !protocolRetried) {
                    // the gateway told us its protocol — reconnect with it
                    protocolRetried = true;
                    console.warn(`[gateway] protocol mismatch — reconnecting with protocol v${details.expectedProtocol}`);
                    try { socket.destroy(); } catch (_) {}
                    return attemptConnect(details.expectedProtocol, details.expectedProtocol);
                  }
                  return finish(() => onError(new Error('Gateway connect failed: ' + JSON.stringify(msg.error))));
                }
                connected = true;
                // Send agent prompt
                socket.write(encodeWsFrame(JSON.stringify({
                  type: 'req', id: 'agent-1', method: 'agent',
                  params: {
                    sessionKey,
                    message: prompt,
                    model: normalizedModel,
                    idempotencyKey: runId
                  }
                })));
              }
            } else if (msg.id === 'agent-1') {
              if (!msg.ok) {
                // Late ok:false after the earlier ok:true — the run was accepted
                // then failed upstream (e.g. FailoverError 402/403)
                return finish(() => onError(new Error('Gateway agent start failed: ' + JSON.stringify(msg.error))));
              }
            } else if (msg.type === 'event') {
              if (msg.event === 'agent' && msg.payload?.stream === 'assistant') {
                const delta = msg.payload?.data?.delta;
                if (typeof delta === 'string' && delta.length > 0) {
                  onChunk({ delta, reasoning: "" });
                }
              } else if (msg.event === 'chat' && msg.payload?.state === 'final') {
                finish(() => onEnd({ finishReason: msg.payload.stopReason || 'stop' }));
              }
            }
          } catch (err) {
            finish(() => onError(err));
          }
        });
      });
    });
    req.end();
  };

  attemptConnect(config.GATEWAY_MIN_PROTOCOL, config.GATEWAY_MAX_PROTOCOL);
}

// ============================================================================
// Upstream caller (cloud)
// ============================================================================

// Keep-alive agent: reuses TCP+TLS connections instead of paying a fresh
// handshake on every request (measured latency tax under burst load).
const UPSTREAM_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
});

// POST JSON upstream with exactly one transparent retry on transient network
// errors (reset pipes, hung-up sockets). Timeouts are NOT retried — they
// already consumed their full budget.
async function postUpstreamWithRetry(options, payload, log) {
  const attemptOnce = () => new Promise((resolve, reject) => {
    const req = https.request({ ...options, agent: UPSTREAM_AGENT }, resolve);
    req.on("timeout", () => {
      req.destroy();
      reject(Object.assign(
        new Error("Upstream timeout — AutoClaw backend did not respond within 2 minutes"),
        { code: "UPSTREAM_TIMEOUT" }
      ));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  try {
    return await attemptOnce();
  } catch (err) {
    if (isTransientNetworkError(err)) {
      log?.warn(`Transient upstream network error (${err.code || err.message}) — retrying once`);
      await new Promise((r) => setTimeout(r, 250));
      return attemptOnce();
    }
    throw err;
  }
}

// Keep the 'zai_' prefix mapping while preserving IDs from the current catalog.
export function resolveUpstreamModelId(knownIds, modelId) {
  return knownIds.has(modelId) ? modelId
    : modelId === "auto" ? "zai_auto"
    : `zai_${modelId}`;
}

// upstream gates cloud requests on this exact banner inside the system prompt —
// without it every call gets 400 "invalid request" and we fall into the ws
// agent. injected on every call below. if the app ever rewords its prompt this
// breaks again and we re-bisect. full story in ROOT-CAUSE-AND-STUDY.md
// AUTOCLAW_SYSTEM_BANNER env patches a reword without a release — keep the
// "## Tooling" line intact or cloud routing silently degrades into the ws agent.
export const AUTOCLAW_SYSTEM_BANNER =
  process.env.AUTOCLAW_SYSTEM_BANNER ||
  "You are a personal assistant running inside OpenClaw.\n## Tooling";

// prepends the banner (or a system msg if the client sent none), never duplicates
function injectSystemBanner(messages) {
  const list = Array.isArray(messages) ? [...messages] : [];
  const idx = list.findIndex((m) => m && m.role === "system");
  if (idx === -1) {
    list.unshift({ role: "system", content: AUTOCLAW_SYSTEM_BANNER });
    return list;
  }
  const sys = list[idx];
  if (typeof sys.content === "string") {
    if (!sys.content.includes(AUTOCLAW_SYSTEM_BANNER)) {
      list[idx] = { ...sys, content: AUTOCLAW_SYSTEM_BANNER + "\n\n" + sys.content };
    }
    return list;
  }
  if (Array.isArray(sys.content)) {
    // Multimodal system message — prepend the banner as a text part instead of
    // flattening, so image parts survive.
    const hasBanner = sys.content.some((p) =>
      typeof p === "string" ? p.includes(AUTOCLAW_SYSTEM_BANNER)
        : p?.type === "text" && typeof p?.text === "string" && p.text.includes(AUTOCLAW_SYSTEM_BANNER));
    if (!hasBanner) {
      list[idx] = { ...sys, content: [{ type: "text", text: AUTOCLAW_SYSTEM_BANNER }, ...sys.content] };
    }
    return list;
  }
  const text = String(sys.content ?? "");
  if (!text.includes(AUTOCLAW_SYSTEM_BANNER)) {
    list[idx] = { ...sys, content: AUTOCLAW_SYSTEM_BANNER + "\n\n" + text };
  }
  return list;
}

// Only forward fields the upstream accepts; everything else is stripped.
function buildSanitizedBody(openAIBody, upstreamModelId) {
  const sanitized = {
    model: upstreamModelId,
    messages: injectSystemBanner(openAIBody.messages || []),
    stream: true,
  };
  if (typeof openAIBody.temperature === "number") sanitized.temperature = openAIBody.temperature;
  if (typeof openAIBody.top_p === "number") sanitized.top_p = openAIBody.top_p;
  // Clamp max output to the model's REAL upstream cap. Exceeding it makes the
  // cloud silently swap in a deepseek model (probe-verified 2026-09-02) and
  // bill deepseek credits — the harness sends 393216 for everything, which
  // every GLM model (real cap 131072) trips.
  if (typeof openAIBody.max_tokens === "number") sanitized.max_tokens = clampMaxOutput(upstreamModelId, openAIBody.max_tokens);
  if (typeof openAIBody.max_completion_tokens === "number") sanitized.max_tokens = clampMaxOutput(upstreamModelId, openAIBody.max_completion_tokens);
  if (openAIBody.stop !== undefined) sanitized.stop = openAIBody.stop;
  if (Array.isArray(openAIBody.tools) && openAIBody.tools.length > 0) sanitized.tools = openAIBody.tools;
  if (openAIBody.tool_choice !== undefined) sanitized.tool_choice = openAIBody.tool_choice;
  return sanitized;
}

// upstream wants bare ids (glm-4.7), clients send catalog ids (zai_glm-4.7)
export function stripProviderPrefix(modelId) { return String(modelId || "").replace(/^[a-z]+_/, ""); }

// Trae and other clients send content as text-object arrays that Zhipu rejects
// (400/500) — flatten those to plain strings. Arrays carrying anything
// non-text (image_url parts — AutoClaw's cloud accepts native vision parts,
// probe-verified 2026-09-04) are preserved untouched so images reach the model.
export function normalizeClientMessages(body) {
  return (body.messages || []).map(msg => {
    const newMsg = { ...msg };

    // Normalize role: developer -> system
    if (newMsg.role === "developer") {
      newMsg.role = "system";
    }

    // Flatten content array only when it's all text blocks
    if (Array.isArray(newMsg.content)) {
      const hasNonText = newMsg.content.some((c) => typeof c !== "string" && c?.type !== "text");
      if (hasNonText) return newMsg; // multimodal content — keep the part shapes
      const textParts = [];
      for (const c of newMsg.content) {
        if (typeof c === "string") textParts.push(c);
        else if (c?.type === "text" && typeof c.text === "string") textParts.push(c.text);
        else if (c?.text) textParts.push(String(c.text));
      }
      newMsg.content = textParts.join("\n");
    } else if (newMsg.content === null || newMsg.content === undefined) {
      newMsg.content = "";
    }

    return newMsg;
  });
}

async function callUpstream(config, clientHeaders, getToken, sanitizedBody, log, transport = null) {
  // header keeps the full catalog id; body model goes upstream bare
  const payload = JSON.stringify({ ...sanitizedBody, model: stripProviderPrefix(sanitizedBody.model) });
  // Prefer the shared transport (identity headers, cookie jar, h2-when-enabled);
  // fall back to the inline h1 path if it is somehow unavailable.
  let active = transport;
  if (!active) {
    try { active = getUpstreamTransport(config, log); }
    catch (_) { active = null; }
  }
  if (active && typeof active.request === "function") {
    const { res } = await active.request({
      path:      config.UPSTREAM_PATH || "/autoclaw-proxy/proxy/autoclaw/chat/completions",
      payload,
      headers:   {
        "Content-Type":    "application/json",
        "Content-Length":  Buffer.byteLength(payload),
        "X-Authorization": getToken(),
        "X-Request-Model": sanitizedBody.model,
        "X-Request-Id":    crypto.randomUUID(),
        "X-Agent-Id":      "main",
        ...clientHeaders,
      },
      timeoutMs: config.UPSTREAM_TIMEOUT_MS,
    });
    return res;
  }
  return postUpstreamWithRetry({
    hostname: config.UPSTREAM_HOST || "autoglm-api.autoglm.ai",
    port:     config.UPSTREAM_PORT || 443,
    path:     config.UPSTREAM_PATH || "/autoclaw-proxy/proxy/autoclaw/chat/completions",
    method:   "POST",
    headers:  {
      "Content-Type":    "application/json",
      "Content-Length":  Buffer.byteLength(payload),
      "X-Authorization": getToken(),
      "X-Request-Model": sanitizedBody.model,
      "X-Request-Id":    crypto.randomUUID(),
      "X-Agent-Id":      "main",
      ...clientHeaders,
    },
    timeout: config.UPSTREAM_TIMEOUT_MS, // per-attempt budget (idle-based; env-tunable)
  }, payload, log);
}

// OpenAI-format entrypoint: resolves aliases/prefix mapping, normalizes
// client-shaped messages, forwards.
export function callUpstreamOpenAI(config, knownIds, clientHeaders, getToken, body, modelId, log, transport = null) {
  const upstreamModelId = resolveUpstreamModelId(knownIds, modelId);
  const normalized = { ...body, messages: normalizeClientMessages(body) };
  log?.debug(`→ upstream model=${modelId}`);
  return callUpstream(config, clientHeaders, getToken, buildSanitizedBody(normalized, upstreamModelId), log, transport);
}

// Anthropic-format entrypoint: model already resolved, body already converted
// to OpenAI shape by the entrypoint's converter — forward as-is.
export function callUpstreamAnthropic(config, clientHeaders, getToken, openAIBody, modelId, transport = null) {
  return callUpstream(config, clientHeaders, getToken, buildSanitizedBody(openAIBody, modelId), null, transport);
}

// ============================================================================
// Credit-tier model routing
// ============================================================================

// Fetch AutoClaw's remote model-config (the same data its UI ranks models
// with). The JWT goes in the `authorization` header (it already includes the
// "Bearer " prefix — sending it as X-Authorization returns 401). Never throws:
// returns the top-level `models` array or null so callers can degrade to
// heuristics without startup risk.
export function fetchRemoteModelConfig(config, jwt, { timeoutMs = 5000 } = {}) {
  if (!jwt) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = https.request({
        hostname: config.UPSTREAM_HOST || "autoglm-api.autoglm.ai",
        port:     config.UPSTREAM_PORT || 443,
        path:     config.MODEL_CONFIG_PATH,
        method:   "GET",
        headers:  { authorization: jwt, ...getClientHeaders(config) },
        timeout:  timeoutMs,
      }, async (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        try {
          const data = JSON.parse(await collectResponse(res));
          // The payload advertises the client version the backend currently
          // accepts — feed it to the identity layer so --doctor can report
          // drift against the version we actually send (Requirement 1.5).
          reportRemoteClientVersion(data?.client_version ?? data?.clientVersion);
          const models = data?.models;
          resolve(Array.isArray(models) && models.length > 0 ? models.filter((m) => m?.id) : null);
        } catch { resolve(null); }
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.end();
    } catch { resolve(null); }
  });
}

// Attach a creditConsumptionLevel to every catalog model. Remote tiers win;
// otherwise fall back to heuristics mirroring the desktop app (auto → Low,
// compact glm52 identity → High), extended with glm53/turbo rules so today's
// API ids still get sane tiers when the remote config is unreachable.
export function annotateCreditTiers(models, remoteModels) {
  const remoteById = new Map((Array.isArray(remoteModels) ? remoteModels : []).map((m) => [m.id, m]));
  return models.map((m) => {
    let level = remoteById.get(m.id)?.creditConsumptionLevel || null;
    if (!level) {
      const compact = `${m.id} ${m.name}`.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (compact.includes("auto")) level = "Low";
      else if (compact.includes("glm52") || compact.includes("glm53")) level = "High";
      else if (compact.includes("turbo")) level = "Medium";
    }
    return { ...m, creditLevel: level };
  });
}

// Single routing authority for Claude aliases. Degradation rules when a tier
// has no candidates: opus High→Medium→Low→default; sonnet Medium→High→default;
// haiku Low(prefers non-auto)→Medium→default; default = sonnet target.
export function resolveTierTargets(models) {
  const at   = (level) => models.filter((m) => m.creditLevel === level);
  const pick = (list) => list.find((m) => !m.id.toLowerCase().includes("auto")) || list[0] || null;

  const sonnet = pick(at("Medium")) || pick(at("High")) || models[0] || null;
  const haiku  = pick(at("Low"))    || pick(at("Medium")) || sonnet;
  const opus   = pick(at("High"))   || pick(at("Medium")) || pick(at("Low")) || sonnet;

  const id = (m) => (m ? m.id : null);
  return { opus: id(opus), sonnet: id(sonnet), haiku: id(haiku), default: id(sonnet) };
}

// ============================================================================
// Bootstrap helpers shared by both entrypoints
// ============================================================================

export function makeHealthHandler(config, getToken) {
  return function handleHealth(req, res) {
    let tokenOk = true, tokenError = null;
    try { getToken(); }
    catch (e) { tokenOk = false; tokenError = e.message; }

    sendJSON(res, {
      ok:       tokenOk,
      status:   tokenOk ? "live" : "no_token",
      upstream: config.UPSTREAM_BASE,
      port:     config.PORT,
      ...(tokenError ? { error: tokenError } : {}),
    });
  };
}

// Shared HTTP server: CORS, auth, rate limiting, route dispatch. Routes are
// [{ method, path, handler }] — method omitted matches any method. sendError
// carries the entrypoint's format-specific envelope.
export function createGatewayServer({ config, log, rateLimit, sendError, routes }) {
  return http.createServer(async (req, res) => {
    // CORS — allow all origins so any local tool can talk to this proxy
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Anthropic-Version, Anthropic-Beta");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const clientIp = resolveClientIp(req);
    if (!rateLimit(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }));
      return;
    }

    if (!isAuthorized(req, config.PROXY_KEY)) {
      return sendError(res, "Invalid or missing API key", "authentication_error", 401, "invalid_api_key");
    }

    const { pathname } = new URL(req.url, "http://localhost");

    for (const route of routes) {
      if (route.method && route.method !== req.method) continue;
      if (pathname !== route.path) continue;
      try {
        return await route.handler(req, res);
      } catch (err) {
        log.error("Unhandled:", err);
        if (!res.headersSent) sendError(res, err.message, "api_error", 500, "internal_error");
        else { try { res.end(); } catch (_) {} }
        return;
      }
    }

    sendError(res, `${req.method} ${pathname} not found`, "not_found_error", 404, "not_found");
  }).on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`✗ Port ${err.port} is already in use — another gateway instance is listening there. Stop it or choose a different port.`);
      process.exitCode = 1;
      process.exit(1);
    }
    throw err;
  });
}

// Startup banner. Long rows wrap onto multiple box lines instead of being
// truncated (the model list used to get chopped mid-name).
export const BOX_W = 56; // content width between the border pipes

export function boxRow(text) {
  // account for wide (emoji/CJK) glyphs so the right border stays aligned
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw > BOX_W) break; // truncate to keep the border aligned
    out += ch;
    w += cw;
  }
  return `│ ${out}${" ".repeat(BOX_W - w)} │`;
}

function charWidth(ch) {
  const wide = /[\u{1100}-\u{115F}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1FAFF}]/u;
  return wide.test(ch) ? 2 : 1;
}

// Greedy-wrap text to the box width, preferring spaces/comma boundaries.
export function wrapBox(text) {
  const lines = [];
  let line = "", w = 0;
  for (const ch of String(text)) {
    const cw = charWidth(ch);
    if (w + cw > BOX_W) {
      // backtrack to a soft boundary if there is one in this line
      const cut = Math.max(line.lastIndexOf(" "), line.lastIndexOf(","));
      if (cut > BOX_W * 0.5) { lines.push(line.slice(0, cut)); line = line.slice(cut + 1); }
      else { lines.push(line); line = ""; }
      w = 0;
      for (const c of line) w += charWidth(c);
    }
    line += ch;
    w += cw;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export function printStartupBanner({ title, rows = [], footers = [] }) {
  const edge = (ch) => `  ┌${ch.repeat(BOX_W + 2)}┐`;
  const mid  = (ch) => `  ├${ch.repeat(BOX_W + 2)}┤`;
  const bottom = `  └${"─".repeat(BOX_W + 2)}┘`;
  const lines = [edge("─"), `  ${boxRow(title)}`, mid("─")];
  for (const row of rows) for (const piece of wrapBox(row)) lines.push(`  ${boxRow(piece)}`);
  if (footers.length) {
    lines.push(mid("─"));
    for (const f of footers) for (const piece of wrapBox(f)) lines.push(`  ${boxRow(piece)}`);
  }
  lines.push(bottom);
  console.log("\n" + lines.join("\n") + "\n");
}

export function installProcessGuards(log) {
  // Keep the server alive through unexpected async throws — log loudly instead
  // of dying mid-session (an ERR_HTTP_HEADERS_SENT inside a timer callback
  // used to take the whole proxy down).
  process.on("uncaughtException",  (e) => log.error("Uncaught exception:",   e));
  process.on("unhandledRejection", (e) => log.error("Unhandled rejection:",  e));
}
