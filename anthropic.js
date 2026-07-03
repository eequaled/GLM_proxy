/**
 * AutoClaw Proxy - Anthropic format
 *
 * Same as main.js but speaks the Anthropic Messages API instead of OpenAI.
 * Use this with Claude Code CLI or any tool that targets the Anthropic SDK.
 *
 * Usage:
 *   node anthropic.js
 *   PORT=18792 node anthropic.js
 *
 * Claude Code CLI setup (~/.claude/settings.json):
 *   {
 *     "env": {
 *       "ANTHROPIC_BASE_URL": "http://localhost:18792",
 *       "ANTHROPIC_AUTH_TOKEN": "mewmew"
 *     }
 *   }
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

const PORT      = parseInt(process.env.PORT      || "18792", 10);
const PROXY_KEY = process.env.PROXY_KEY           || "mewmew";
const LOG_LEVEL = process.env.LOG_LEVEL           || "info";

const UPSTREAM_BASE = "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw";
const TOKEN_FILE    = path.join(os.homedir(), ".openclaw-autoclaw", "request-headers.json");
const TOKEN_TTL_MS  = 5 * 60 * 1000;

const CLIENT_HEADERS = {
  "X-Tm":      "win",
  "X-Version": "1.10.3",
  "X-Product": "autoclaw",
  "X-Channel": "AutoClaw4",
  "X-Lang":    "en",
};

// Model class routing - regex-based so any future claude-opus-X / sonnet-X / haiku-X
// works automatically without needing updates to this file.
// You can also override per-model via ANTHROPIC_DEFAULT_OPUS_MODEL etc. in Claude Code settings.
const CLASS_MAP = [
  { pattern: /opus/i,   target: "openrouter_glm-5.2" }, // Opus class   - highest capability
  { pattern: /sonnet/i, target: "zai_auto"            }, // Sonnet class - smart select
  { pattern: /haiku/i,  target: "zai_glm-5-turbo"    }, // Haiku class  - fastest
];

const DEFAULT_MODEL = "zai_auto";

const MODELS = [
  { id: "zai_auto",           name: "Auto",        contextWindow: 1_048_576, maxTokens: 393_216 },
  { id: "zai_glm-5-turbo",    name: "GLM-5-Turbo", contextWindow: 204_800,   maxTokens: 131_072 },
  { id: "openrouter_glm-5.2", name: "GLM-5.2",     contextWindow: 1_048_576, maxTokens: 307_200 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = {
  debug: (...a) => LOG_LEVEL === "debug" && console.log("[debug]", ...a),
  info:  (...a) => LOG_LEVEL !== "silent" && console.log("[info] ", ...a),
  warn:  (...a) => LOG_LEVEL !== "silent" && console.warn("[warn] ", ...a),
  error: (...a) => console.error("[error]", ...a),
};

// ─────────────────────────────────────────────────────────────────────────────
// Token layer  (identical to main.js)
// ─────────────────────────────────────────────────────────────────────────────

let _token = null, _tokenReadAt = 0;

function loadToken() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    const auth = data?.headers?.["X-Authorization"];
    if (!auth) throw new Error("X-Authorization field missing");
    return auth;
  } catch (err) {
    throw new Error(
      `Cannot read AutoClaw token from ${TOKEN_FILE}. ` +
      `Make sure AutoClaw is running and you are logged in. (${err.message})`
    );
  }
}

function getToken() {
  if (!_token || Date.now() - _tokenReadAt > TOKEN_TTL_MS) {
    _token       = loadToken();
    _tokenReadAt = Date.now();
    log.info("Token loaded");
  }
  return _token;
}

function invalidateToken() { _token = null; _tokenReadAt = 0; }

// ─────────────────────────────────────────────────────────────────────────────
// Format conversion  (Anthropic <-> OpenAI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve any Anthropic model name to an AutoClaw model ID.
 * - Native AutoClaw IDs pass through unchanged.
 * - Claude model names match by class (opus/sonnet/haiku) via regex.
 * - Anything unrecognised falls back to zai_auto.
 */
function resolveModel(anthropicModel) {
  if (!anthropicModel) return DEFAULT_MODEL;
  if (MODELS.some((m) => m.id === anthropicModel)) return anthropicModel;
  const match = CLASS_MAP.find((c) => c.pattern.test(anthropicModel));
  return match ? match.target : DEFAULT_MODEL;
}

/**
 * Convert an Anthropic Messages request body to OpenAI chat/completions format.
 */
function anthropicToOpenAI(body, modelId) {
  const messages = [];

  // System prompt
  if (body.system) {
    const text = typeof body.system === "string"
      ? body.system
      : body.system.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  // Convert messages
  for (const msg of body.messages || []) {
    let content = msg.content;

    if (typeof content === "string") {
      messages.push({ role: msg.role, content });
      continue;
    }

    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          if (block.type === "text")        return block.text;
          if (block.type === "tool_result") return `[tool_result id=${block.tool_use_id}]: ${JSON.stringify(block.content)}`;
          if (block.type === "tool_use")    return `[tool_use id=${block.id} name=${block.name}]: ${JSON.stringify(block.input)}`;
          if (block.type === "thinking")    return ""; // skip thinking blocks
          return JSON.stringify(block);
        })
        .filter(Boolean)
        .join("\n");
      messages.push({ role: msg.role, content: text });
    }
  }

  return {
    model:       modelId,
    messages,
    stream:      true, // always stream upstream
    max_tokens:  body.max_tokens  ?? 4096,
    temperature: body.temperature ?? undefined,
    top_p:       body.top_p       ?? undefined,
    stop:        body.stop_sequences?.length ? body.stop_sequences : undefined,
  };
}

/**
 * Buffer all OpenAI SSE chunks and assemble a single Anthropic response object.
 */
function openAIChunksToAnthropic(raw, modelId, inputTokens) {
  let content = "", reasoning = "";
  let id = `msg_${generateId()}`;
  let model = modelId;
  let outputTokens = 0;
  let stopReason = "end_turn";

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6));
      if (chunk.id)    id    = chunk.id;
      if (chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content)           content   += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr === "length") stopReason = "max_tokens";
      if (chunk.usage) outputTokens = chunk.usage.completion_tokens ?? 0;
    } catch { /* skip malformed lines */ }
  }

  const contentBlocks = [];
  if (reasoning) contentBlocks.push({ type: "thinking", thinking: reasoning });
  contentBlocks.push({ type: "text", text: content });

  return {
    id,
    type:          "message",
    role:          "assistant",
    model,
    content:       contentBlocks,
    stop_reason:   stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:  inputTokens ?? 0,
      output_tokens: outputTokens,
    },
  };
}

/**
 * Convert a single OpenAI SSE line to one or more Anthropic SSE event strings.
 */
function openAIChunkToAnthropicEvents(line, state) {
  if (!line.startsWith("data: ")) return [];

  if (line === "data: [DONE]") {
    const events = [];
    if (state.blockOpen) {
      events.push(fmt("content_block_stop", { type: "content_block_stop", index: state.blockIndex }));
      state.blockOpen = false;
    }
    events.push(fmt("message_delta", {
      type:  "message_delta",
      delta: { stop_reason: state.finishReason || "end_turn", stop_sequence: null },
      usage: { output_tokens: state.outputTokens },
    }));
    events.push(fmt("message_stop", { type: "message_stop" }));
    return events;
  }

  let chunk;
  try { chunk = JSON.parse(line.slice(6)); } catch { return []; }

  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return [];

  const events    = [];
  const content   = delta.content           ?? "";
  const reasoning = delta.reasoning_content ?? "";
  const fr        = chunk.choices?.[0]?.finish_reason;

  if (chunk.usage) state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
  if (fr === "length") state.finishReason = "max_tokens";
  if (fr === "stop")   state.finishReason = "end_turn";

  // Open thinking block on first reasoning chunk
  if (reasoning && !state.thinkingOpen) {
    if (state.blockOpen) {
      events.push(fmt("content_block_stop", { type: "content_block_stop", index: state.blockIndex }));
      state.blockIndex++;
    }
    events.push(fmt("content_block_start", {
      type: "content_block_start", index: state.blockIndex,
      content_block: { type: "thinking", thinking: "" },
    }));
    state.thinkingOpen = true;
    state.blockOpen    = true;
  }

  if (reasoning) {
    events.push(fmt("content_block_delta", {
      type:  "content_block_delta", index: state.blockIndex,
      delta: { type: "thinking_delta", thinking: reasoning },
    }));
  }

  // Open text block on first content chunk (closing thinking block first if needed)
  if (content && !state.textOpen) {
    if (state.thinkingOpen) {
      events.push(fmt("content_block_stop", { type: "content_block_stop", index: state.blockIndex }));
      state.blockIndex++;
      state.thinkingOpen = false;
    } else if (state.blockOpen) {
      events.push(fmt("content_block_stop", { type: "content_block_stop", index: state.blockIndex }));
      state.blockIndex++;
    }
    events.push(fmt("content_block_start", {
      type: "content_block_start", index: state.blockIndex,
      content_block: { type: "text", text: "" },
    }));
    state.textOpen  = true;
    state.blockOpen = true;
  }

  if (content) {
    events.push(fmt("content_block_delta", {
      type:  "content_block_delta", index: state.blockIndex,
      delta: { type: "text_delta", text: content },
    }));
  }

  return events;
}

function fmt(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream layer
// ─────────────────────────────────────────────────────────────────────────────

function callUpstream(modelId, openAIBody) {
  return new Promise((resolve, reject) => {
    const token   = getToken();
    const payload = JSON.stringify(openAIBody);
    const options = {
      hostname: "autoglm-api.autoglm.ai",
      path:     "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions",
      method:   "POST",
      headers:  {
        "Content-Type":    "application/json",
        "Content-Length":  Buffer.byteLength(payload),
        "X-Authorization": token,
        "X-Request-Model": modelId,
        ...CLIENT_HEADERS,
      },
    };
    const req = https.request(options, resolve);
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateId() { return crypto.randomBytes(12).toString("hex"); }

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, message, type = "api_error", status = 500) {
  sendJSON(res, { type: "error", error: { type, message } }, status);
}

function isAuthorized(req) {
  if (!PROXY_KEY) return true;
  const h   = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const key = h.startsWith("Bearer ") ? h.slice(7) : h;
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
    ok: tokenOk, status: tokenOk ? "live" : "no_token",
    upstream: UPSTREAM_BASE, port: PORT,
    ...(tokenError ? { error: tokenError } : {}),
  });
}

function handleModels(res) {
  sendJSON(res, {
    data: MODELS.map((m) => ({
      type:         "model",
      id:           m.id,
      display_name: m.name,
      created_at:   new Date().toISOString(),
    })),
    has_more: false,
    first_id: MODELS[0].id,
    last_id:  MODELS[MODELS.length - 1].id,
  });
}

async function handleMessages(req, res) {
  const body       = await readBody(req);
  const modelId    = resolveModel(body.model);
  const stream     = body.stream === true;
  const openAIBody = anthropicToOpenAI(body, modelId);

  log.info(`messages model=${body.model} -> ${modelId} stream=${stream}`);

  let upstreamRes;
  try {
    upstreamRes = await callUpstream(modelId, openAIBody);
  } catch (err) {
    const status = err.message.includes("Cannot read AutoClaw token") ? 503 : 502;
    return sendError(res, err.message, "api_error", status);
  }

  log.debug(`upstream status=${upstreamRes.statusCode}`);

  if (upstreamRes.statusCode === 401) {
    invalidateToken();
    return sendError(res, "AutoClaw token expired - invalidated cache, retry the request", "authentication_error", 401);
  }

  if (upstreamRes.statusCode >= 400) {
    let errBody = "";
    upstreamRes.on("data", (c) => (errBody += c));
    upstreamRes.on("end",  () => {
      try   { sendJSON(res, JSON.parse(errBody), upstreamRes.statusCode); }
      catch { sendError(res, errBody || "Upstream error", "api_error", upstreamRes.statusCode); }
    });
    return;
  }

  if (stream) {
    res.writeHead(200, {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send message_start immediately
    res.write(fmt("message_start", {
      type:    "message_start",
      message: {
        id: `msg_${generateId()}`, type: "message", role: "assistant",
        model: modelId, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
    res.write(fmt("ping", { type: "ping" }));

    const state = {
      blockIndex: 0, blockOpen: false,
      thinkingOpen: false, textOpen: false,
      outputTokens: 0, finishReason: "end_turn",
    };

    let buffer = "";
    upstreamRes.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        for (const e of openAIChunkToAnthropicEvents(line.trim(), state)) res.write(e);
      }
    });

    upstreamRes.on("end", () => {
      if (buffer.trim()) {
        for (const e of openAIChunkToAnthropicEvents(buffer.trim(), state)) res.write(e);
      }
      for (const e of openAIChunkToAnthropicEvents("data: [DONE]", state)) res.write(e);
      res.end();
    });

    upstreamRes.on("error", (err) => { log.error("Stream error:", err); res.end(); });

  } else {
    let raw = "";
    upstreamRes.on("data", (c) => (raw += c));
    upstreamRes.on("end",  () => {
      try {
        const inputTokens = (body.messages?.length ?? 1) * 10;
        sendJSON(res, openAIChunksToAnthropic(raw, modelId, inputTokens));
      } catch (err) {
        sendError(res, `Failed to parse upstream response: ${err.message}`, "api_error", 502);
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Anthropic-Version, Anthropic-Beta");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (!isAuthorized(req)) {
    return sendError(res, "Invalid or missing API key", "authentication_error", 401);
  }

  const { pathname } = new URL(req.url, "http://localhost");

  try {
    if (req.method === "GET"  && pathname === "/healthz")              return handleHealth(res);
    if (req.method === "GET"  && pathname === "/v1/models")            return handleModels(res);
    if (req.method === "POST" && pathname === "/v1/messages")          return handleMessages(req, res);
    if (pathname === "/v1/messages/count_tokens")                      return sendJSON(res, { input_tokens: 0 });
    sendError(res, `${req.method} ${pathname} not found`, "not_found_error", 404);
  } catch (err) {
    log.error("Unhandled:", err);
    if (!res.headersSent) sendError(res, err.message, "api_error", 500);
  }
});

process.on("uncaughtException",  (e) => log.error("Uncaught exception:",  e));
process.on("unhandledRejection", (e) => log.error("Unhandled rejection:", e));

server.listen(PORT, () => {
  console.log(`
  🛸  AutoClaw Proxy - Anthropic format  v1.0.0
  ──────────────────────────────────────────────
  Port     : ${PORT}
  Upstream : ${UPSTREAM_BASE}
  Token    : ${TOKEN_FILE}
  Auth key : ${PROXY_KEY}
  Models   : ${MODELS.map((m) => m.id).join(", ")}
  ──────────────────────────────────────────────
  Claude Code CLI (~/.claude/settings.json):
    ANTHROPIC_BASE_URL   -> http://localhost:${PORT}
    ANTHROPIC_AUTH_TOKEN -> ${PROXY_KEY}
  `);

  try {
    getToken();
    console.log("  ✅  Token loaded - ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});
