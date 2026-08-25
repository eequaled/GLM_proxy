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

// ============================================================================
// Config
// ============================================================================

export function loadConfig({ defaultPort, format = "openai" }) {
  const PORT           = parseInt(process.env.PORT || String(defaultPort), 10) || defaultPort;
  const PROXY_KEY      = process.env.PROXY_KEY || "mewmew";
  const LOG_LEVEL      = process.env.LOG_LEVEL || "info"; // "debug" | "info" | "silent"
  const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(50 * 1024 * 1024), 10) || 50 * 1024 * 1024;
  const RATE_LIMIT     = parseInt(process.env.RATE_LIMIT || "30", 10) || 30; // req/s per IP

  // PREFER_LOCAL=1 skips the cloud attempt entirely when the local AutoClaw
  // gateway is available — useful while credits are exhausted, where every
  // doomed cloud round-trip just adds latency before the fallback fires anyway.
  const PREFER_LOCAL = process.env.PREFER_LOCAL === "1";

  const JSONL_LOG       = process.env.JSONL_LOG === "true" || process.env.LOG_LEVEL === "debug";
  const JSONL_SYNC      = process.env.JSONL_SYNC === "true";
  const JSONL_MAX_BYTES = parseInt(process.env.JSONL_MAX_BYTES || String(10 * 1024 * 1024), 10) || 10 * 1024 * 1024;

  // Per-format log filenames unless explicitly overridden via env
  const REQUEST_LOG_FILE = process.env.REQUEST_LOG_FILE
    || path.join(process.cwd(), format === "anthropic" ? "proxy_requests_anthropic.json" : "proxy_requests.json");
  const JSONL_FILE = process.env.JSONL_FILE
    || path.join(process.cwd(), format === "anthropic" ? "proxy_requests_anthropic.jsonl" : "proxy_requests.jsonl");

  const UPSTREAM_BASE = "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw";
  const MODEL_CONFIG_PATH = "/autoclaw-proxy/proxy/autoclaw-model-config";

  // AutoClaw writes fresh auth headers here whenever the token rotates
  const TOKEN_FILE    = path.join(os.homedir(), ".openclaw-autoclaw", "request-headers.json");
  const TOKEN_TTL_MS  = 5 * 60 * 1000; // re-read file at most every 5 min

  // Identifies the request as coming from the AutoClaw desktop client
  const CLIENT_HEADERS = {
    "X-Tm":          "win",
    "X-Version":     "1.17.5",
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
    { id: "zai_auto",                        name: "Auto",              contextWindow: 1_048_576, maxTokens: 393_216 },
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

// Load MODELS once; each entrypoint keeps its own module-level snapshot
export function loadModelCatalog(config) {
  return { MODELS: loadModelsFromRuntime(config) };
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
// `bodyText` is the raw upstream response body (may be empty).
export function classifyUpstreamError(statusCode, bodyText, modelName) {
  const text   = typeof bodyText === "string" ? bodyText : "";
  const detail = getUpstreamErrorMessage(text);

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
    const tokenFile = path.join(os.homedir(), '.openclaw-autoclaw', '.gateway-token');
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
  let upgradedSocket = null; // after the upgrade the socket detaches from `req` —
                             // destroying req alone LEAKS the live WS connection
  const finish = (fn) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { (upgradedSocket || req).destroy(); } catch (_) {}
    fn();
  };

  const timer = setTimeout(() => {
    finish(() => onError(new Error(`Local gateway execution timeout (${timeoutMs / 1000}s)`)));
  }, timeoutMs);

  req.on('upgrade', (res, socket) => {
    upgradedSocket = socket;
    socket.on('error', (err) => finish(() => onError(err)));

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = decodeWsFrames(Buffer.concat([buf, chunk]), rawMsg => {
        try {
          const msg = JSON.parse(rawMsg);
          if (msg.event === 'connect.challenge') {
            socket.write(encodeWsFrame(JSON.stringify({
              type: 'req', id: 'conn-1', method: 'connect',
              params: {
                minProtocol: 3, maxProtocol: 4,
                // client.id is allowlisted by the gateway — arbitrary values
                // get INVALID_REQUEST before any agent can run
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

  req.on('error', (err) => {
    finish(() => onError(err));
  });
  req.end();
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
export const AUTOCLAW_SYSTEM_BANNER =
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
  const text = typeof sys.content === "string"
    ? sys.content
    : Array.isArray(sys.content)
      ? sys.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n")
      : String(sys.content ?? "");
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
  if (typeof openAIBody.max_tokens === "number") sanitized.max_tokens = openAIBody.max_tokens;
  if (typeof openAIBody.max_completion_tokens === "number") sanitized.max_tokens = openAIBody.max_completion_tokens;
  if (openAIBody.stop !== undefined) sanitized.stop = openAIBody.stop;
  if (Array.isArray(openAIBody.tools) && openAIBody.tools.length > 0) sanitized.tools = openAIBody.tools;
  if (openAIBody.tool_choice !== undefined) sanitized.tool_choice = openAIBody.tool_choice;
  return sanitized;
}

// upstream wants bare ids (glm-4.7), clients send catalog ids (zai_glm-4.7)
export function stripProviderPrefix(modelId) { return String(modelId || "").replace(/^[a-z]+_/, ""); }

// Trae and other clients send content as text-object arrays that Zhipu rejects
// (400/500) — flatten and normalize them before forwarding.
function normalizeClientMessages(body) {
  return (body.messages || []).map(msg => {
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
}

async function callUpstream(clientHeaders, getToken, sanitizedBody, log) {
  // header keeps the full catalog id; body model goes upstream bare
  const payload = JSON.stringify({ ...sanitizedBody, model: stripProviderPrefix(sanitizedBody.model) });
  return postUpstreamWithRetry({
    hostname: "autoglm-api.autoglm.ai",
    path:     "/autoclaw-proxy/proxy/autoclaw/chat/completions",
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
    timeout: 120_000, // 2 min budget per attempt
  }, payload, log);
}

// OpenAI-format entrypoint: resolves aliases/prefix mapping, normalizes
// client-shaped messages, forwards.
export function callUpstreamOpenAI(knownIds, clientHeaders, getToken, body, modelId, log) {
  const upstreamModelId = resolveUpstreamModelId(knownIds, modelId);
  const normalized = { ...body, messages: normalizeClientMessages(body) };
  log?.debug(`→ upstream model=${modelId}`);
  return callUpstream(clientHeaders, getToken, buildSanitizedBody(normalized, upstreamModelId), log);
}

// Anthropic-format entrypoint: model already resolved, body already converted
// to OpenAI shape by the entrypoint's converter — forward as-is.
export function callUpstreamAnthropic(clientHeaders, getToken, openAIBody, modelId) {
  return callUpstream(clientHeaders, getToken, buildSanitizedBody(openAIBody, modelId), null);
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
