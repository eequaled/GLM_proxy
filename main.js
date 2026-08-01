/**
 * AutoClaw Proxy
 *
 * OpenAI-compatible HTTP proxy for AutoClaw's Zhipu AI backend.
 *
 * How it works (same pattern as antigravity-claude-proxy / acc):
 *   AutoClaw keeps a fresh JWT at ~/.openclaw-autoclaw/request-headers.json,
 *   auto-refreshed whenever it rotates. We read that file on startup and
 *   re-read it every TOKEN_TTL_MS — zero manual auth setup required.
 *
 *   Requests are forwarded to AutoClaw's real OpenAI-compatible API:
 *   https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/v1/chat/completions
 *
 * Usage:
 *   node main.js
 *   PORT=3001 node main.js
 *
 * OpenCode / any OpenAI-compatible client:
 *   baseURL : http://localhost:18791/v1
 *   apiKey  : (value of PROXY_KEY env, default "mewmew")
 */

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

// Config

const PORT       = parseInt(process.env.PORT     || "18791", 10) || 18791;
const PROXY_KEY  = process.env.PROXY_KEY          || "mewmew";
const LOG_LEVEL  = process.env.LOG_LEVEL          || "info"; // "debug" | "info" | "silent"
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(50 * 1024 * 1024), 10) || 50 * 1024 * 1024;
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "30", 10) || 30; // req/s per IP

const JSONL_LOG  = process.env.JSONL_LOG === "true" || process.env.LOG_LEVEL === "debug";
const JSONL_FILE = process.env.JSONL_FILE || path.join(process.cwd(), "proxy_requests.jsonl");
const JSONL_MAX_BYTES = parseInt(process.env.JSONL_MAX_BYTES || String(10 * 1024 * 1024), 10) || 10 * 1024 * 1024;

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

// Model catalog — auto-healed from AutoClaw's runtime config

const RUNTIME_FILE      = path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.runtime.json");
const RUNTIME_LAST_GOOD = path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.runtime.json.last-good");
// Ordered fallbacks — try newest first, degrade gracefully
const RUNTIME_CANDIDATES = [RUNTIME_FILE, RUNTIME_LAST_GOOD];

/** Hardcoded last-resort fallback in case all runtime files are unreadable. */
const FALLBACK_MODELS = [
  { id: "zai_auto",           name: "Auto",        contextWindow: 1_048_576, maxTokens: 393_216 },
  { id: "zai_glm-5-turbo",    name: "GLM-5-Turbo", contextWindow: 204_800,   maxTokens: 131_072 },
  { id: "zaicoding_glm-5.2",  name: "GLM-5.2",     contextWindow: 1_048_576, maxTokens: 307_200 },
];

function loadModelsFromRuntime() {
  for (const candidate of RUNTIME_CANDIDATES) {
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
  return FALLBACK_MODELS;
}

const MODELS       = loadModelsFromRuntime();
const KNOWN_IDS    = new Set(MODELS.map((m) => m.id));

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

const formatLog = (level, color, ...args) => {
  const timestamp = new Date().toISOString();
  return [
    `${COLORS.GRAY}[${timestamp}]${COLORS.RESET}`,
    `${color}[${level}]${COLORS.RESET}`,
    ...args
  ];
};

const log = {
  debug: (...a) => LOG_LEVEL === "debug" && console.log(...formatLog('DEBUG', COLORS.MAGENTA, ...a)),
  info:  (...a) => LOG_LEVEL !== "silent" && console.log(...formatLog('INFO', COLORS.BLUE, ...a)),
  warn:  (...a) => LOG_LEVEL !== "silent" && console.warn(...formatLog('WARN', COLORS.YELLOW, ...a)),
  error: (...a) => console.error(...formatLog('ERROR', COLORS.RED, ...a)),
  success: (...a) => LOG_LEVEL !== "silent" && console.log(...formatLog('SUCCESS', COLORS.GREEN, ...a)),
};

// Request log file (last N requests on disk, not terminal)

const REQUEST_LOG_FILE = path.join(process.cwd(), "proxy_requests.json");
const MAX_LOG_ENTRIES   = 50;

function logRequest(entry) {
  try {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(REQUEST_LOG_FILE, "utf-8")); } catch (_) {}
    entries.push(entry);
    if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(-MAX_LOG_ENTRIES);
    fs.writeFileSync(REQUEST_LOG_FILE, JSON.stringify(entries, null, 2));
  } catch (_) { /* silently skip if disk write fails */ }
}

// Token layer (mirrors acc's token-extractor.js)

let _token       = null;
let _tokenReadAt = 0;

/**
 * Read the X-Authorization JWT from AutoClaw's local token file.
 * Throws a descriptive error if AutoClaw isn't running or not logged in.
 */
function loadToken() {
  try {
    const raw  = fs.readFileSync(TOKEN_FILE, "utf-8");
    const data = JSON.parse(raw);
    const auth = data?.headers?.["X-Authorization"];
    if (!auth) throw new Error("X-Authorization field missing");
    return auth; // "Bearer <jwt>"
  } catch (err) {
    throw new Error(
      `Cannot read AutoClaw token from ${TOKEN_FILE}. ` +
      `Make sure AutoClaw is running and you are logged in. (${err.message})`
    );
  }
}

/**
 * Return a cached token, refreshing from disk if the TTL has elapsed.
 */
function getToken() {
  if (!_token || Date.now() - _tokenReadAt > TOKEN_TTL_MS) {
    _token       = loadToken();
    _tokenReadAt = Date.now();
    log.info(`Token loaded (expires cache in ${TOKEN_TTL_MS / 60_000} min)`);
  }
  return _token;
}

/** Force the next getToken() call to re-read the file. */
function invalidateToken() {
  _token       = null;
  _tokenReadAt = 0;
}

// Hot-reload token when AutoClaw rotates it — avoids restart
fs.watchFile(TOKEN_FILE, { interval: 1000 }, () => {
  try {
    _token = loadToken();
    log.info("Token reloaded");
  } catch (e) {
    log.warn(`Token reload failed: ${e.message}`);
  }
});

// Upstream layer

/**
 * Open an HTTPS connection to AutoClaw's upstream and return the IncomingMessage.
 * Always sends stream:true — the server layer handles assembling non-stream responses.
 */
function callUpstream(modelId, requestBody) {
  return new Promise((resolve, reject) => {
    const token   = getToken();
    // Keep 'zai_' prefix: pass known IDs as-is, map "auto", else prepend 'zai_'
    const upstreamModelId = KNOWN_IDS.has(modelId) ? modelId
      : modelId === "auto" ? "zai_auto"
      : `zai_${modelId}`;

    // Trae sends content as text-object arrays that Zhipu rejects (500) — flatten them
    const normalizedMessages = (requestBody.messages || []).map(msg => {
      const newMsg = { ...msg };
      
      // Fix 1: Flatten content array if it exists
      if (Array.isArray(newMsg.content)) {
        const allText = newMsg.content.every(c => c.type === "text");
        if (allText) {
          newMsg.content = newMsg.content.map(c => c.text).join("\n");
        }
      }
      
      return newMsg;
    });

    const sanitizedBody = {
      ...requestBody,
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
        ...CLIENT_HEADERS,
      },
      timeout: 120_000, // 2 min timeout for upstream
    };

    log.debug(`→ upstream model=${modelId}`);
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

/**
 * Collect all SSE chunks from an upstream response and assemble a single
 * non-streaming OpenAI response object.
 */
function bufferSSE(upstreamRes, modelId) {
  return new Promise((resolve, reject) => {
    let raw = "";
    upstreamRes.on("data",  (c) => (raw += c));
    upstreamRes.on("error", reject);
    upstreamRes.on("end",   () => {
      try {
        let content = "", reasoning = "";
        let id      = `chatcmpl-${generateId()}`;
        let model   = modelId;
        let promptTokens = 0, completionTokens = 0;
        let finishReason = "stop";
        const toolCalls = {};

        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          const chunk = JSON.parse(line.slice(6));
          if (chunk.id)    id    = chunk.id;
          if (chunk.model) model = chunk.model;
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content)          content   += delta.content;
          if (delta?.reasoning_content) reasoning += delta.reasoning_content;
          // Accumulate tool calls
          for (const tc of delta?.tool_calls || []) {
            if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: "", name: "", arguments: "" };
            if (tc.id)                  toolCalls[tc.index].id = tc.id;
            if (tc.function?.name)      toolCalls[tc.index].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
          }
          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (chunk.usage) {
            promptTokens     = chunk.usage.prompt_tokens     ?? 0;
            completionTokens = chunk.usage.completion_tokens ?? 0;
          }
        }

        // Build sorted tool_calls array
        const sortedToolCalls = Object.keys(toolCalls)
          .sort((a, b) => Number(a) - Number(b))
          .map((idx) => {
            const tc = toolCalls[idx];
            return {
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            };
          });

        resolve({
          id,
          object:  "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index:         0,
            message:       {
              role:    "assistant",
              content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(sortedToolCalls.length ? { tool_calls: sortedToolCalls } : {}),
            },
            finish_reason: finishReason,
          }],
          usage: {
            prompt_tokens:     promptTokens,
            completion_tokens: completionTokens,
            total_tokens:      promptTokens + completionTokens,
          },
        });
      } catch (err) {
        reject(new Error(`Failed to parse upstream SSE: ${err.message}`));
      }
    });
  });
}

// HTTP helpers

function generateId() {
  return crypto.randomBytes(12).toString("hex");
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, message, type = "api_error", status = 500) {
  sendJSON(res, { error: { message, type, code: null } }, status);
}

function isAuthorized(req) {
  if (!PROXY_KEY) return true;
  const header = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const key    = header.startsWith("Bearer ") ? header.slice(7) : header;
  return key === PROXY_KEY;
}

function readBody(req) {
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
      if (totalBytes > MAX_BODY_BYTES) {
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

// Rate limiter — simple token bucket per client IP
const _buckets = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const b = _buckets.get(ip);
  if (!b) { _buckets.set(ip, { tokens: RATE_LIMIT, last: now }); return true; }
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(RATE_LIMIT, b.tokens + elapsed * RATE_LIMIT);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
// Drop stale buckets so the map can't grow unbounded (unref'd — doesn't hold the process open)
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [ip, b] of _buckets) if (b.last < cutoff) _buckets.delete(ip);
}, 3600 * 1000).unref();

// Resolve the client IP for rate limiting — only trust X-Forwarded-For from non-local peers
// Trust X-Forwarded-For only from explicitly configured proxy IPs — spoofable otherwise
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || "").split(",").map(s => s.trim()).filter(Boolean);
function clientIp(req) {
  const peer = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  if (TRUSTED_PROXIES.includes(peer)) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return xff.split(",")[0].trim();
  }
  return peer;
}

// Collect a full upstream response body (error inspection / passthrough)
function collectResponse(res) {
  return new Promise((resolve) => {
    let raw = "";
    res.on("data", (c) => (raw += c));
    res.on("end", () => resolve(raw));
    res.on("error", () => resolve(""));
  });
}

// JSONL structured log — one line per request, rotated past the cap so disk can't fill
function logJsonl(entry) {
  if (!JSONL_LOG) return;
  try {
    if (fs.statSync(JSONL_FILE).size > JSONL_MAX_BYTES) fs.renameSync(JSONL_FILE, `${JSONL_FILE}.1`);
  } catch (_) {}
  fs.appendFile(JSONL_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", () => {});
}

// Route handlers

function handleHealth(res) {
  let tokenOk = true, tokenError = null;
  try   { getToken(); }
  catch (e) { tokenOk = false; tokenError = e.message; }

  sendJSON(res, {
    ok:       tokenOk,
    status:   tokenOk ? "live" : "no_token",
    upstream: UPSTREAM_BASE,
    port:     PORT,
    ...(tokenError ? { error: tokenError } : {}),
  });
}

function handleModels(res) {
  sendJSON(res, {
    object: "list",
    data:   MODELS.map((m) => ({
      id:             m.id,
      object:         "model",
      created:        Math.floor(Date.now() / 1000),
      owned_by:       "autoclaw",
      name:           m.name,
      description:    m.name,
      context_window: m.contextWindow,
      max_tokens:     m.maxTokens,
    })),
  });
}

async function handleChatCompletions(req, res) {
  const startTime = Date.now();
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    const status = err.statusCode || 400;
    return sendError(res, err.message, "invalid_request", status);
  }
  // Input validation
  if (!body.model || typeof body.model !== "string" || body.model.length > 256) {
    return sendError(res, "model must be a non-empty string (max 256 chars)", "invalid_request", 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, "messages must be a non-empty array", "invalid_request", 400);
  }
  const modelId = body.model;
  const stream  = body.stream !== false; // default true

  log.info(`chat model=${modelId} stream=${stream}`);

  let upstreamRes;
  let upstreamErrBody = "";
  try {
    // 400 "invalid request" is AutoClaw's known transient hiccup — retry it once
    upstreamRes = await callUpstream(modelId, body);
    if (upstreamRes.statusCode === 400) {
      upstreamErrBody = await collectResponse(upstreamRes);
      if (upstreamErrBody.includes('"invalid request"')) {
        log.info("Upstream 400 invalid request — retrying once");
        await new Promise(r => setTimeout(r, 2000));
        upstreamRes = await callUpstream(modelId, body);
      }
    }
  } catch (err) {
    const status  = err.message.includes("Cannot read AutoClaw token") ? 503 : 502;
    const errType = status === 503 ? "service_unavailable" : "upstream_error";
    return sendError(res, err.message, errType, status);
  }

  log.debug(`← upstream status=${upstreamRes.statusCode}`);

  // Save request details + status to file (not terminal)
  const lastMsg = body.messages?.[body.messages.length - 1];
  logRequest({
    timestamp: new Date().toISOString(),
    model: modelId,
    status: upstreamRes.statusCode,
    last_message: typeof lastMsg?.content === "string"
      ? lastMsg.content.substring(0, 300)
      : JSON.stringify(lastMsg?.content).substring(0, 300),
    message_count: body.messages?.length || 0,
  });

  logJsonl({ model: modelId, status: upstreamRes.statusCode, ip: clientIp(req), latencyMs: Date.now() - startTime });

  // 401 → invalidate cached token so next request gets a fresh one
  if (upstreamRes.statusCode === 401) {
    invalidateToken();
    return sendError(res,
      "AutoClaw token expired — invalidated cache, retry the request",
      "authentication_error", 401
    );
  }

  // Any other upstream error → pass body through
  if (upstreamRes.statusCode >= 400) {
    const errBody = upstreamErrBody || await collectResponse(upstreamRes);
    try {
      const parsed = JSON.parse(errBody);
      log.error(`Upstream error ${upstreamRes.statusCode}:`, parsed.error?.message || errBody);
      sendJSON(res, parsed, upstreamRes.statusCode);
    } catch {
      // Response wasn't JSON (e.g., nginx HTML error like 413)
      const cleanMsg = errBody.match(/<title>(.*?)<\/title>/i)?.[1] || errBody || "Upstream error";
      log.error(`Upstream error ${upstreamRes.statusCode}:`, cleanMsg);
      sendError(res, cleanMsg, "api_error", upstreamRes.statusCode);
    }
    return;
  }

  if (stream) {
    // Pipe SSE straight through to the client
    res.writeHead(200, {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache",
      "Connection":      "keep-alive",
      "X-Accel-Buffering": "no",
    });
    upstreamRes.pipe(res);
    return;
  }

  // Non-stream: buffer SSE, assemble full response object
  try {
    const response = await bufferSSE(upstreamRes, modelId);
    sendJSON(res, response);
  } catch (err) {
    sendError(res, err.message, "api_error", 502);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS — allow all origins so any local tool can talk to this proxy
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Rate limit before auth so brute-force attempts can't bypass the throttle
  if (!rateLimit(clientIp(req))) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }));
    return;
  }

  if (!isAuthorized(req)) {
    return sendError(res, "Invalid or missing API key", "authentication_error", 401);
  }

  const { pathname } = new URL(req.url, "http://localhost");

  try {
    if (req.method === "GET"  && pathname === "/healthz")              return handleHealth(res);
    if (req.method === "GET"  && pathname === "/v1/models")            return handleModels(res);
    if (req.method === "POST" && pathname === "/v1/chat/completions")  return handleChatCompletions(req, res);
    sendError(res, `${req.method} ${pathname} not found`, "not_found_error", 404);
  } catch (err) {
    log.error("Unhandled:", err);
    if (!res.headersSent) sendError(res, err.message, "api_error", 500);
  }
});

process.on("uncaughtException",  (e) => log.error("Uncaught exception:",   e));
process.on("unhandledRejection", (e) => log.error("Unhandled rejection:",  e));

const HOST = process.env.HOST || "127.0.0.1";

// Dashboard helpers
const BOX_W = 56; // content width between the border pipes
function boxRow(text) {
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
  return `  │ ${out}${" ".repeat(BOX_W - w)} │`;
}

server.listen(PORT, HOST, () => {
  console.log(`
  ┌${"─".repeat(BOX_W + 2)}┐
  ${boxRow("🛸  AUTOCLAW GATEWAY PROXY (OpenAI Format v1.0.0)")}
  ├${"─".repeat(BOX_W + 2)}┤
  ${boxRow(`Host     : ${HOST}`)}
  ${boxRow(`Port     : ${PORT}`)}
  ${boxRow(`Auth Key : ${PROXY_KEY}`)}
  ${boxRow(`Rate Lim : ${RATE_LIMIT} req/s per IP`)}
  ${boxRow(`Models   : ${MODELS.map(m => m.id).join(", ")}`)}
  ├${"─".repeat(BOX_W + 2)}┤
  ${boxRow("OpenCode / OpenAI SDK Base URL:")}
  ${boxRow(`http://${HOST}:${PORT}/v1`)}
  └${"─".repeat(BOX_W + 2)}┘
  `);

  try {
    getToken();
    console.log("  ✅  Token loaded — ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});
