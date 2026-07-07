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

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT       = parseInt(process.env.PORT     || "18791", 10);
const PROXY_KEY  = process.env.PROXY_KEY          || "mewmew";
const LOG_LEVEL  = process.env.LOG_LEVEL          || "info"; // "debug" | "info" | "silent"

const UPSTREAM_BASE = "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw";
const UPSTREAM_URL  = `${UPSTREAM_BASE}/v1/chat/completions`;

// AutoClaw writes fresh auth headers here whenever the token rotates
const TOKEN_FILE    = path.join(os.homedir(), ".openclaw-autoclaw", "request-headers.json");
const TOKEN_TTL_MS  = 5 * 60 * 1000; // re-read file at most every 5 min

// Headers AutoClaw always includes — identifies the request as coming from the desktop client
const CLIENT_HEADERS = {
  "X-Tm":      "win",
  "X-Version": "1.10.3",
  "X-Product": "autoclaw",
  "X-Channel": "AutoClaw4",
  "X-Lang":    "en",
};

// ─────────────────────────────────────────────────────────────────────────────
// Model catalog  (sourced from ~/.openclaw-autoclaw/openclaw.runtime.json)
// ─────────────────────────────────────────────────────────────────────────────

const MODELS = [
  {
    id:            "zai_auto",
    name:          "Auto",
    description:   "Smart Select — routes to optimal model (DeepSeek-V4, GLM-5.1, GLM-5-turbo, …)",
    contextWindow: 1_048_576,
    maxTokens:     393_216,
  },
  {
    id:            "zai_glm-5-turbo",
    name:          "GLM-5-Turbo",
    description:   "Zhipu AI GLM-5 Turbo with extended reasoning",
    contextWindow: 204_800,
    maxTokens:     131_072,
  },
  {
    id:            "openrouter_glm-5.2",
    name:          "GLM-5.2",
    description:   "Latest GLM-5.2 via OpenRouter",
    contextWindow: 1_048_576,
    maxTokens:     307_200,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Request log file  (keeps last N requests on disk, not in terminal)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Token layer  (mirrors acc's token-extractor.js)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Upstream layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open an HTTPS connection to AutoClaw's upstream and return the IncomingMessage.
 * Always sends stream:true — the server layer handles assembling non-stream responses.
 */
function callUpstream(modelId, requestBody) {
  return new Promise((resolve, reject) => {
    const token   = getToken();
    // The backend ONLY accepts the original 'zai_' prefixed model string.
    // E.g., 'zai_auto' or 'zai_glm-5-turbo'. Do NOT strip the 'zai_' prefix!
    // But OpenCode uses "auto", so map "auto" back to "zai_auto".
    const upstreamModelId = modelId === "auto" ? "zai_auto"
      : modelId.startsWith("zai_") || modelId.startsWith("openrouter_") ? modelId
      : `zai_${modelId}`;

    // Normalize messages: some clients (like Trae) send `content` as an array of text objects,
    // which AutoClaw/Zhipu's backend often rejects with "parse response failed" (500).
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

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
    const chunks = [];
    req.on("data",  (c) => chunks.push(c));
    req.on("end",   () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────────────

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
      description:    m.description,
      context_window: m.contextWindow,
      max_tokens:     m.maxTokens,
    })),
  });
}

async function handleChatCompletions(req, res) {
  const body    = await readBody(req);
  const modelId = body.model  || "zai_auto";
  const stream  = body.stream !== false; // default true

  log.info(`chat model=${modelId} stream=${stream}`);

  let upstreamRes;
  try {
    upstreamRes = await callUpstream(modelId, body);
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
    let errBody = "";
    upstreamRes.on("data", (c) => (errBody += c));
    upstreamRes.on("end",  () => {
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
    });
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

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

server.listen(PORT, () => {
  console.log(`
  🛸  AutoClaw Proxy  v1.0.0
  ──────────────────────────────────
  Port     : ${PORT}
  Upstream : ${UPSTREAM_BASE}
  Token    : ${TOKEN_FILE}
  Auth key : ${PROXY_KEY}
  Models   : ${MODELS.map((m) => m.id).join(", ")}
  ──────────────────────────────────
  OpenCode / OpenAI-SDK config:
    baseURL → http://localhost:${PORT}/v1
    apiKey  → ${PROXY_KEY}
  `);

  try {
    getToken();
    console.log("  ✅  Token loaded — ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});
