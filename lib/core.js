// Shared machinery for the OpenAI and Anthropic proxy entrypoints.

import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

// Config

export function loadConfig({ defaultPort }) {
  const PORT       = parseInt(process.env.PORT     || String(defaultPort), 10) || defaultPort;
  const PROXY_KEY  = process.env.PROXY_KEY          || "mewmew";
  const LOG_LEVEL  = process.env.LOG_LEVEL          || "info"; // "debug" | "info" | "silent"
  const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(50 * 1024 * 1024), 10) || 50 * 1024 * 1024;
  const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "30", 10) || 30; // req/s per IP

  const JSONL_LOG  = process.env.JSONL_LOG === "true" || process.env.LOG_LEVEL === "debug";
  // Default JSONL + JSON request-log filenames are per-format, supplied by the caller
  const JSONL_FILE     = process.env.JSONL_FILE || path.join(process.cwd(), "proxy_requests.jsonl");
  const JSONL_MAX_BYTES = parseInt(process.env.JSONL_MAX_BYTES || String(10 * 1024 * 1024), 10) || 10 * 1024 * 1024;
  const REQUEST_LOG_FILE = process.env.REQUEST_LOG_FILE || path.join(process.cwd(), "proxy_requests.json");

  const UPSTREAM_BASE = "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw";
  const UPSTREAM_URL  = `${UPSTREAM_BASE}/v1/chat/completions`;

  // AutoClaw writes fresh auth headers here whenever the token rotates
  const TOKEN_FILE    = path.join(os.homedir(), ".openclaw-autoclaw", "request-headers.json");
  const TOKEN_TTL_MS  = 5 * 60 * 1000; // re-read file at most every 5 min

  // Identifies the request as coming from the AutoClaw desktop client
  const CLIENT_HEADERS = {
    "X-Tm":      "win",
    "X-Version": "1.10.3",
    "X-Product": "autoclaw",
    "X-Channel": "AutoClaw4",
    "X-Lang":    "en",
  };

  const RUNTIME_FILE      = path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.runtime.json");
  const RUNTIME_LAST_GOOD = path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.runtime.json.last-good");
  // Ordered fallbacks — try newest first, degrade gracefully
  const RUNTIME_CANDIDATES = [RUNTIME_FILE, RUNTIME_LAST_GOOD];

  // Hardcoded last-resort fallback in case all runtime files are unreadable
  const FALLBACK_MODELS = [
    { id: "zai_auto",           name: "Auto",        contextWindow: 1_048_576, maxTokens: 393_216 },
    { id: "zai_glm-5-turbo",    name: "GLM-5-Turbo", contextWindow: 204_800,   maxTokens: 131_072 },
    { id: "zaicoding_glm-5.2",  name: "GLM-5.2",     contextWindow: 1_048_576, maxTokens: 307_200 },
  ];

  return {
    PORT, PROXY_KEY, LOG_LEVEL, MAX_BODY_BYTES, RATE_LIMIT,
    JSONL_LOG, JSONL_FILE, JSONL_MAX_BYTES, REQUEST_LOG_FILE,
    UPSTREAM_BASE, TOKEN_FILE, TOKEN_TTL_MS,
    CLIENT_HEADERS, RUNTIME_FILE, RUNTIME_LAST_GOOD, RUNTIME_CANDIDATES, FALLBACK_MODELS,
  };
}

// Model catalog — auto-healed from AutoClaw's runtime config

export function loadModelsFromRuntime(config) {
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

      console.log(`  📋  Loaded ${models.length} model(s) from ${path.basename(candidate)}`);
      return models;
    } catch (_) { /* try next candidate */ }
  }

  // Nothing worked — use hardcoded fallback
  console.warn("  ⚠️   Could not read runtime models — using built-in fallback");
  return config.FALLBACK_MODELS;
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

export function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// OpenAI shape: { error: { message, type, code: null } }
export function sendErrorOpenAI(res, message, type = "api_error", status = 500) {
  sendJSON(res, { error: { message, type, code: null } }, status);
}

// Anthropic shape: { type: "error", error: { type, message } }
export function sendErrorAnthropic(res, message, type = "api_error", status = 500) {
  sendJSON(res, { type: "error", error: { type, message } }, status);
}

export function isAuthorized(req, proxyKey) {
  if (!proxyKey) return true;
  const header = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const key    = header.startsWith("Bearer ") ? header.slice(7) : header;
  return key === proxyKey;
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
    let raw = "";
    res.on("data", (c) => (raw += c));
    res.on("end", () => resolve(raw));
    res.on("error", () => resolve(""));
  });
}

// Rate limiter — simple token bucket per client IP

export function createRateLimiter(rateLimit) {
  const _buckets = new Map();
  function limit(ip) {
    const now = Date.now();
    const b = _buckets.get(ip);
    if (!b) { _buckets.set(ip, { tokens: rateLimit, last: now }); return true; }
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
export function createJsonlLogger({ enabled, file, maxBytes }) {
  function logJsonl(entry) {
    if (!enabled) return;
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    } catch (_) {}
    fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", () => {});
  }
  return { logJsonl };
}

// Upstream caller

// OpenAI variant: keeps the 'zai_' prefix mapping and flattens text-object arrays
export function callUpstreamOpenAI(knownIds, clientHeaders, getToken, body, modelId, log) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    // Keep 'zai_' prefix: pass known IDs as-is, map "auto", else prepend 'zai_'
    const upstreamModelId = knownIds.has(modelId) ? modelId
      : modelId === "auto" ? "zai_auto"
      : `zai_${modelId}`;

    // Trae sends content as text-object arrays that Zhipu rejects (500) — flatten them
    const normalizedMessages = (body.messages || []).map(msg => {
      const newMsg = { ...msg };

      // Flatten content array if it's all text blocks
      if (Array.isArray(newMsg.content)) {
        const allText = newMsg.content.every(c => c.type === "text");
        if (allText) {
          newMsg.content = newMsg.content.map(c => c.text).join("\n");
        }
      }

      return newMsg;
    });

    const sanitizedBody = {
      ...body,
      messages: normalizedMessages,
      model: upstreamModelId, // 500 error if this isn't strictly prefixed
      stream: true
    };

    // Remove fields that Zhipu strictly rejects if present
    delete sanitizedBody.stream_options;

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
    const payload = JSON.stringify({ ...openAIBody, model: upstreamModelId });
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
