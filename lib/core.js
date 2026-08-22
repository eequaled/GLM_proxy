// Shared machinery for the OpenAI and Anthropic proxy entrypoints.

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

// Config

export function loadConfig({ defaultPort, format = "openai" }) {
  const PORT       = parseInt(process.env.PORT     || String(defaultPort), 10) || defaultPort;
  const PROXY_KEY  = process.env.PROXY_KEY          || "mewmew";
  const LOG_LEVEL  = process.env.LOG_LEVEL          || "info"; // "debug" | "info" | "silent"
  const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(50 * 1024 * 1024), 10) || 50 * 1024 * 1024;
  const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "30", 10) || 30; // req/s per IP

  // PREFER_LOCAL=1 skips the cloud attempt entirely when the local AutoClaw
  // gateway is available — useful while credits are exhausted, where every
  // doomed cloud round-trip just adds latency before the fallback fires anyway.
  const PREFER_LOCAL = process.env.PREFER_LOCAL === "1";

  const JSONL_LOG  = process.env.JSONL_LOG === "true" || process.env.LOG_LEVEL === "debug";
  const JSONL_SYNC = process.env.JSONL_SYNC === "true";
  // Default JSONL + JSON request-log filenames are per-format, supplied by the caller
  const JSONL_FILE     = process.env.JSONL_FILE || path.join(process.cwd(), "proxy_requests.jsonl");
  const JSONL_MAX_BYTES = parseInt(process.env.JSONL_MAX_BYTES || String(10 * 1024 * 1024), 10) || 10 * 1024 * 1024;
  const REQUEST_LOG_FILE = process.env.REQUEST_LOG_FILE || path.join(process.cwd(), "proxy_requests.json");

  const UPSTREAM_BASE = "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw";
  const MODEL_CONFIG_PATH = "/autoclaw-proxy/proxy/autoclaw-model-config";
  const UPSTREAM_URL  = `${UPSTREAM_BASE}/v1/chat/completions`;

  // AutoClaw writes fresh auth headers here whenever the token rotates
  const TOKEN_FILE    = path.join(os.homedir(), ".openclaw-autoclaw", "request-headers.json");
  const TOKEN_TTL_MS  = 5 * 60 * 1000; // re-read file at most every 5 min

  // Identifies the request as coming from the AutoClaw desktop client
  const CLIENT_HEADERS = {
    "X-Tm":          "win",
    "X-Version":     "1.17.2",
    "X-Product":     "autoclaw",
    "X-Channel":     "AutoClaw4",
    "X-Lang":        "en",
    "X-Client-Type": "pc",
  };

  const RUNTIME_FILE      = path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.runtime.json");
  const RUNTIME_LAST_GOOD = path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.runtime.json.last-good");
  // Ordered fallbacks — try newest first, degrade gracefully
  const RUNTIME_CANDIDATES = [RUNTIME_FILE, RUNTIME_LAST_GOOD];

  // Hardcoded last-resort fallback in case all runtime files are unreadable
  const FALLBACK_MODELS = [
    { id: "zai_auto",                         name: "Auto",              contextWindow: 1_048_576, maxTokens: 393_216 },
    { id: "zaicoding_glm-5.3",               name: "GLM-5.3",           contextWindow: 1_048_576, maxTokens: 307_200 },
    { id: "zai_glm-5-turbo",                 name: "GLM-5-Turbo",       contextWindow: 204_800,   maxTokens: 131_072 },
    { id: "tdpsk_deepseek-v4-flash-202605",  name: "Deepseek-V4-Flash", contextWindow: 1_048_576, maxTokens: 393_216 },
    { id: "tdpsk_deepseek-v4-pro-202606",    name: "DeepSeek-V4-Pro",   contextWindow: 1_048_576, maxTokens: 393_216 },
  ];

  return {
    PORT, PROXY_KEY, LOG_LEVEL, MAX_BODY_BYTES, RATE_LIMIT, PREFER_LOCAL,
    JSONL_LOG, JSONL_SYNC, JSONL_FILE, JSONL_MAX_BYTES, REQUEST_LOG_FILE,
    UPSTREAM_BASE, MODEL_CONFIG_PATH, TOKEN_FILE, TOKEN_TTL_MS,
    CLIENT_HEADERS, RUNTIME_FILE, RUNTIME_LAST_GOOD, RUNTIME_CANDIDATES, FALLBACK_MODELS,
  };
}

// Model catalog — auto-healed from AutoClaw's runtime config

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
        maxTokens:     m.maxTokens     || 131_072,
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
  return {
    models:   catalog?.models || config.FALLBACK_MODELS,
    source:   catalog?.source || null,
    fallback: !catalog,
  };
}

// Load MODELS + KNOWN_IDS once; each entrypoint keeps its own module-level snapshot
export function loadModelCatalog(config) {
  const MODELS    = loadModelsFromRuntime(config);
  const KNOWN_IDS = new Set(MODELS.map((m) => m.id));
  return { MODELS, KNOWN_IDS };
}

// Logger

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

// Token layer (mirrors acc's token-extractor.js)

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

// HTTP helpers (pure, no config deps)

export function generateId() {
  return crypto.randomBytes(12).toString("hex");
}

// Translate common Chinese upstream error messages to English
const ZH_ERROR_MAP = [
  [/积分不足/, "Insufficient credits — please recharge your AutoClaw account"],
  [/非法模型/, "Invalid model — the requested model ID is not recognized upstream"],
  [/请求频率/, "Rate limited by upstream — too many requests"],
  [/令牌.*过期|token.*expired/i, "Authentication token expired"],
  [/参数.*错误|invalid.*param/i, "Invalid request parameters"],
  [/服务.*繁忙/, "Upstream service is busy — please retry"],
  [/请求.*超时/, "Upstream request timed out"],
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

// Classify a failed cloud response into the client-facing error shape.
export function classifyUpstreamError(statusCode, bodyText, modelName) {
  const text   = typeof bodyText === "string" ? bodyText : "";
  const detail = getUpstreamErrorMessage(text);

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

  switch (statusCode) {
    case 401:
      return { status: 401, type: "authentication_error", code: "token_expired", permanent: false, message: "AutoClaw token expired or invalid — cached token invalidated, retry now" };
    case 403:
      return { status: 403, type: "permission_error", code: "forbidden_by_upstream", permanent: false, message: detail !== "Upstream error" ? detail : "AutoClaw upstream refused this request (HTTP 403)" };
    case 404:
      return { status: 404, type: "not_found_error", code: "model_not_found", permanent: true, message: `Model ${modelName || ""} is not recognized by AutoClaw upstream`.trim() };
    case 429:
      return { status: 429, type: "rate_limit_error", code: "rate_limited_by_upstream", permanent: false, message: detail !== "Upstream error" ? detail : "Rate limited by AutoClaw upstream — slow down" };
    case 400:
      return { status: 400, type: "invalid_request_error", code: "invalid_request", permanent: false, message: detail };
    default:
      if (statusCode >= 500) {
        return { status: 502, type: "api_error", code: "upstream_failure", permanent: false, message: `AutoClaw upstream failed (HTTP ${statusCode}): ${detail}` };
      }
      return { status: statusCode >= 400 ? statusCode : 502, type: "api_error", code: "upstream_failure", permanent: false, message: detail !== "Upstream error" ? detail : "Upstream error" };
  }
}

// Classify an error raised by the local WebSocket agent path. The gateway's
// FailoverError strings embed the real upstream status ("FailoverError: HTTP
// 403: ...", "FailoverError: 402 status code"), so mine those first.
export function classifyLocalAgentError(err, modelName) {
  const raw = String(err?.message || err || "");

  if (/\b402\b/.test(raw)) {
    return { status: 402, type: "insufficient_credits", code: "quota_exhausted", permanent: true, message: `${modelName || "This model"} is out of credits — recharge or subscribe in AutoClaw` };
  }
  if (/\b403\b/.test(raw)) {
    if (/quota|810000/i.test(raw)) {
      return { status: 402, type: "insufficient_credits", code: "quota_exhausted", permanent: true, message: `${modelName || "This model"} free quota is used up — subscribe to a membership in AutoClaw` };
    }
    return { status: 403, type: "permission_error", code: "forbidden_by_local_gateway", permanent: false, message: "AutoClaw local gateway refused this request (HTTP 403)" };
  }
  if (/timeout/i.test(raw)) {
    return { status: 504, type: "api_error", code: "local_gateway_timeout", permanent: false, message: "AutoClaw local gateway did not finish in time — try again or check the desktop app" };
  }
  if (/token not found|Is AutoClaw running/i.test(raw)) {
    return { status: 503, type: "service_unavailable", code: "no_local_gateway", permanent: true, message: "AutoClaw local gateway is not reachable — make sure the desktop app is running" };
  }
  return { status: 502, type: "api_error", code: "local_gateway_failed", permanent: false, message: getUpstreamErrorMessage(raw) };
}

// Classify an error thrown by the upstream transport itself — no HTTP
// response ever arrived: dead token, connection reset after the retry budget,
// or a 2-minute timeout.
export function classifyTransportError(err) {
  const msg = String(err?.message || err || "");

  if (/Cannot read AutoClaw token/i.test(msg)) {
    return { status: 503, type: "service_unavailable", code: "no_token", permanent: false, message: msg };
  }
  if (err?.code === "UPSTREAM_TIMEOUT" || /timeout/i.test(msg)) {
    return { status: 504, type: "api_error", code: "upstream_timeout", permanent: false, message: msg !== "Error" ? msg : "AutoClaw upstream did not respond in time" };
  }
  return { status: 502, type: "api_error", code: "upstream_connection_failed", permanent: false, message: `${msg}${err?.code ? ` (${err.code})` : ""}` || "Could not reach AutoClaw upstream" };
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
export function shouldFallbackToLocal(statusCode) {
  return statusCode >= 400 && statusCode !== 404 && statusCode !== 429;
}

// Short-lived negative cache for PERMANENT failures (quota, unknown model).
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

export function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
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

// Send a classification produced by classifyUpstreamError/classifyLocalAgentError
export function sendClassifiedErrorOpenAI(res, cls) {
  sendJSON(res, { error: { message: cls.message, type: cls.type, code: cls.code ?? null } }, cls.status);
}

export function sendClassifiedErrorAnthropic(res, cls) {
  sendJSON(res, { type: "error", error: { type: cls.type, message: cls.message, code: cls.code ?? undefined } }, cls.status);
}

export function isAuthorized(req, proxyKey) {
  if (!proxyKey) return true;
  const header = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const key    = header.startsWith("Bearer ") ? header.slice(7) : header;
  return key === proxyKey;
}

export function validateChatPayload(body) {
  const MAX_MESSAGES = 128;
  const MAX_MESSAGE_TEXT_BYTES = 256 * 1024;
  const MAX_TOTAL_MESSAGE_TEXT_BYTES = 1024 * 1024;
  const MAX_TOOLS = 64;
  const MAX_TOOL_BYTES = 128 * 1024;
  const MAX_TOTAL_TOOL_BYTES = 512 * 1024;

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { message: "messages must be a non-empty array", statusCode: 400 };
  }
  if (body.messages.length > MAX_MESSAGES) {
    return { message: `messages must contain at most ${MAX_MESSAGES} entries`, statusCode: 413 };
  }

  let totalMessageBytes = 0;
  for (const message of body.messages) {
    const content = message?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_MESSAGE_TEXT_BYTES) {
      return { message: "an individual message is too large", statusCode: 413 };
    }
    totalMessageBytes += bytes;
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

// Rate limiter — simple token bucket per client IP

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

// Resolve the client IP for rate limiting — OpenAI variant (trusts configured proxy IPs)
export function clientIpOpenAI(req) {
  // Trust X-Forwarded-For only from explicitly configured proxy IPs — spoofable otherwise
  const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || "").split(",").map(s => s.trim()).filter(Boolean);
  const peer = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  if (TRUSTED_PROXIES.includes(peer)) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return xff.split(",")[0].trim();
  }
  return peer;
}

// Resolve the client IP — Anthropic variant (trusts XFF from non-loopback peers)
export function clientIpAnthropic(req) {
  // Only trust X-Forwarded-For from non-local peers
  const peer = req.socket.remoteAddress || "unknown";
  const loopback = peer === "::1" || peer.startsWith("127.") || peer.startsWith("::ffff:127.");
  if (!loopback) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return xff.split(",")[0].trim();
  }
  return peer.replace(/^::ffff:/, "");
}

// Request loggers

// JSON file logger — keeps the last N requests on disk
export function createRequestLogger(filePath) {
  const MAX_LOG_ENTRIES = 50;
  function logRequest(entry) {
    try {
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch (_) {}
      entries.push(entry);
      if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(-MAX_LOG_ENTRIES);
      fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
    } catch (_) { /* silently skip if disk write fails */ }
  }
  return { logRequest };
}

// JSONL structured log — one line per request, rotated past the cap so disk can't fill
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

// Local WebSocket Bridge for L-route

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
    const tokenFile = path.join(os.homedir(), '.openclaw-autoclaw', '.gateway-token');
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, 'utf-8').trim();
    }
  } catch (_) {}
  return null;
}

// The local gateway's documented OpenAI endpoint keeps message roles, tools,
// model overrides, session isolation, and native SSE intact.
export function callLocalGatewayOpenAI(body, modelId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const token = getLocalGatewayToken();
    if (!token) return reject(new Error("Local AutoClaw gateway token is unavailable"));

    const payload = JSON.stringify({ ...body, model: "openclaw/default" });
    const req = http.request({
      hostname: "127.0.0.1",
      port: 18789,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-openclaw-model": modelId,
      },
      timeout: timeoutMs,
    }, resolve);

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Local AutoClaw gateway timed out"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export function getActiveSessionKey() {
  try {
    const sessionsFile = path.join(os.homedir(), '.openclaw-autoclaw', 'agents', 'main', 'sessions', 'sessions.json');
    if (fs.existsSync(sessionsFile)) {
      const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
      const keys = Object.keys(data);
      if (keys.length > 0) {
        // Return most recent session key
        keys.sort((a, b) => (data[b].updatedAt || 0) - (data[a].updatedAt || 0));
        return keys[0];
      }
    }
  } catch (_) {}
  return 'agent:main:2a1e6594';
}

export function callLocalGatewayBridge(promptMessage, modelId = 'zai_auto', timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const token = getLocalGatewayToken();
    if (!token) {
      return reject(new Error('Local .gateway-token not found. Is AutoClaw running?'));
    }

    const secKey = crypto.randomBytes(16).toString('base64');
    const sessionKey = getActiveSessionKey();
    let runId = null;

    const req = http.request({
      hostname: '127.0.0.1',
      port: 18789,
      path: '/',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': secKey,
        'Authorization': 'Bearer ' + token
      }
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Local gateway execution timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);

      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        buf = decodeWsFrames(buf, rawMsg => {
          try {
            const msg = JSON.parse(rawMsg);
            if (msg.event === 'connect.challenge') {
              socket.write(encodeWsFrame(JSON.stringify({
                type: 'req', id: 'conn-1', method: 'connect',
                params: {
                  minProtocol: 3, maxProtocol: 4,
                  client: { id: 'gateway-client', version: '1.17.2', platform: 'win', mode: 'backend' },
                  role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
                  caps: [], commands: [], permissions: {}, auth: { token }, locale: 'en', userAgent: 'autoclaw-gateway/2.0.0'
                }
              })));
            } else if (msg.id === 'conn-1') {
              if (!msg.ok) {
                clearTimeout(timer);
                socket.destroy();
                return reject(new Error('Local gateway connect failed: ' + JSON.stringify(msg.error)));
              }
              // Send chat.send
              socket.write(encodeWsFrame(JSON.stringify({
                type: 'req', id: 'chat-1', method: 'chat.send',
                params: {
                  sessionKey,
                  message: promptMessage,
                  idempotencyKey: 'key-' + Date.now() + '-' + Math.random().toString(36).slice(2)
                }
              })));
            } else if (msg.id === 'chat-1') {
              if (!msg.ok) {
                clearTimeout(timer);
                socket.destroy();
                return reject(new Error('chat.send failed: ' + JSON.stringify(msg.error)));
              }
              runId = msg.payload?.runId;
              // Wait for agent execution
              socket.write(encodeWsFrame(JSON.stringify({
                type: 'req', id: 'wait-1', method: 'agent.wait',
                params: { runId, timeoutMs: Math.max(10000, timeoutMs - 5000) }
              })));
            } else if (msg.id === 'wait-1') {
              // Fetch history to get complete assistant message
              socket.write(encodeWsFrame(JSON.stringify({
                type: 'req', id: 'hist-1', method: 'chat.history',
                params: { sessionKey }
              })));
            } else if (msg.id === 'hist-1') {
              clearTimeout(timer);
              socket.destroy();
              const msgs = msg.payload?.messages || msg.payload || [];
              const last = msgs[msgs.length - 1];
              let text = '';
              let reasoning = '';
              if (typeof last?.content === 'string') text = last.content;
              else if (Array.isArray(last?.content)) {
                for (const part of last.content) {
                  if (part.type === 'text') text += part.text;
                  if (part.type === 'thinking') reasoning += part.thinking;
                }
              }
              resolve({
                content: text || '',
                reasoning: reasoning || '',
                model: last?.model || modelId,
                usage: last?.usage || { input: 0, output: 0, totalTokens: 0 }
              });
            }
          } catch (err) {
            clearTimeout(timer);
            socket.destroy();
            reject(err);
          }
        });
      });
    });

    req.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

// Upstream caller

// Keep the 'zai_' prefix mapping while preserving IDs from the current catalog.
export function resolveUpstreamModelId(knownIds, modelId) {
  return knownIds.has(modelId) ? modelId
    : modelId === "auto" ? "zai_auto"
    : `zai_${modelId}`;
}

// Stream or invoke via local AutoClaw WebSocket agent RPC
export function streamLocalGatewayAgent({ modelId, messages, onChunk, onEnd, onError, timeoutMs = 120000 }) {
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

  const secKey = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    hostname: '127.0.0.1',
    port: 18789,
    path: '/',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': secKey,
      'Authorization': 'Bearer ' + token
    }
  });

  let finished = false;
  const finish = (fn) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { req.destroy(); } catch (_) {}
    fn();
  };

  const timer = setTimeout(() => {
    finish(() => onError(new Error(`Local gateway execution timeout (${timeoutMs / 1000}s)`)));
  }, timeoutMs);

  req.on('upgrade', (res, socket) => {
    let buf = Buffer.alloc(0);

    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      buf = decodeWsFrames(buf, rawMsg => {
        try {
          const msg = JSON.parse(rawMsg);
          if (msg.event === 'connect.challenge') {
            socket.write(encodeWsFrame(JSON.stringify({
              type: 'req', id: 'conn-1', method: 'connect',
              params: {
                minProtocol: 3, maxProtocol: 4,
                client: { id: 'gateway-client', version: '1.17.5', platform: 'win', mode: 'backend' },
                role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
                caps: ['tool_events'], commands: [], permissions: {}, auth: { token }, locale: 'en', userAgent: 'autoclaw-gateway/2.0.0'
              }
            })));
          } else if (msg.id === 'conn-1') {
            if (!msg.ok) {
              return finish(() => onError(new Error('Gateway connect failed: ' + JSON.stringify(msg.error))));
            }
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
          } else if (msg.id === 'agent-1') {
            if (!msg.ok) {
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

  req.on('error', (err) => {
    finish(() => onError(err));
  });
  req.end();
}
export function callUpstreamOpenAI(knownIds, clientHeaders, getToken, body, modelId, log) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    // Keep 'zai_' prefix: pass known IDs as-is, map "auto", else prepend 'zai_'
    const upstreamModelId = knownIds.has(modelId) ? modelId
      : modelId === "auto" ? "zai_auto"
      : `zai_${modelId}`;

    // Trae and other clients send content as text-object arrays that Zhipu rejects (400/500) — flatten and normalize them
    const normalizedMessages = (body.messages || []).map(msg => {
      const newMsg = { ...msg };

      // Normalize role: developer -> system
      if (newMsg.role === "developer") {
        newMsg.role = "system";
      }

      // Flatten content array if it's all text blocks
      if (Array.isArray(newMsg.content)) {
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

    const sanitizedBody = {
      model: upstreamModelId,
      messages: normalizedMessages,
      stream: true,
    };

    // Forward allowed optional parameters only
    if (typeof body.temperature === "number") sanitizedBody.temperature = body.temperature;
    if (typeof body.top_p === "number") sanitizedBody.top_p = body.top_p;
    if (typeof body.max_tokens === "number") sanitizedBody.max_tokens = body.max_tokens;
    if (typeof body.max_completion_tokens === "number") sanitizedBody.max_tokens = body.max_completion_tokens;
    if (body.stop !== undefined) sanitizedBody.stop = body.stop;
    if (Array.isArray(body.tools) && body.tools.length > 0) sanitizedBody.tools = body.tools;
    if (body.tool_choice !== undefined) sanitizedBody.tool_choice = body.tool_choice;

    const payload = JSON.stringify(sanitizedBody);

    const options = {
      hostname: "autoglm-api.autoglm.ai",
      path:     "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions",
      method:   "POST",
      headers:  {
        "Content-Type":    "application/json",
        "Content-Length":  Buffer.byteLength(payload),
        "X-Authorization": token,
        "X-Request-Model": upstreamModelId,
        ...clientHeaders,
      },
      timeout: 120_000, // 2 min timeout for upstream
    };

    if (log) log.debug(`→ upstream model=${modelId}`);
    const req = https.request(options, resolve);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Upstream timeout — AutoClaw backend did not respond within 2 minutes"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Anthropic variant: no prefix mapping (already done by resolveModel), body already OpenAI format
export function callUpstreamAnthropic(clientHeaders, getToken, openAIBody, modelId) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    // Keep 'zai_' prefix — stripping it causes 500 "parse response failed"
    const upstreamModelId = modelId;

    const sanitizedBody = {
      model: upstreamModelId,
      messages: openAIBody.messages || [],
      stream: true,
    };

    if (typeof openAIBody.temperature === "number") sanitizedBody.temperature = openAIBody.temperature;
    if (typeof openAIBody.top_p === "number") sanitizedBody.top_p = openAIBody.top_p;
    if (typeof openAIBody.max_tokens === "number") sanitizedBody.max_tokens = openAIBody.max_tokens;
    if (openAIBody.stop !== undefined) sanitizedBody.stop = openAIBody.stop;
    if (Array.isArray(openAIBody.tools) && openAIBody.tools.length > 0) sanitizedBody.tools = openAIBody.tools;
    if (openAIBody.tool_choice !== undefined) sanitizedBody.tool_choice = openAIBody.tool_choice;

    const payload = JSON.stringify(sanitizedBody);
    const options = {
      hostname: "autoglm-api.autoglm.ai",
      path:     "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions",
      method:   "POST",
      headers:  {
        "Content-Type":    "application/json",
        "Content-Length":  Buffer.byteLength(payload),
        "X-Authorization": token,
        "X-Request-Model": upstreamModelId,
        ...clientHeaders,
      },
      timeout: 120_000, // 2 min timeout for upstream
    };
    const req = https.request(options, resolve);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Upstream timeout — AutoClaw backend did not respond within 2 minutes"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

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
        hostname: "autoglm-api.autoglm.ai",
        path: config.MODEL_CONFIG_PATH,
        method: "GET",
        headers: { authorization: jwt, ...config.CLIENT_HEADERS },
        timeout: timeoutMs,
      }, async (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        try {
          const data = JSON.parse(await collectResponse(res));
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

// Dashboard helper

export const BOX_W = 56; // content width between the border pipes

export function boxRow(text) {
  // account for wide (emoji/CJK) glyphs so the right border stays aligned
  const wide = /[\u{1100}-\u{115F}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1FAFF}]/u;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = wide.test(ch) ? 2 : 1;
    if (w + cw > BOX_W) break; // truncate to keep the border aligned
    out += ch;
    w += cw;
  }
  return `│ ${out}${" ".repeat(BOX_W - w)} │`;
}
