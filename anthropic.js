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
  { pattern: /opus/i,   target: "zai_auto"            }, // Opus class   - highest capability (was openrouter_glm-5.2, now deprecated)
  { pattern: /sonnet/i, target: "zai_auto"            }, // Sonnet class - smart select
  { pattern: /haiku/i,  target: "zai_glm-5-turbo"    }, // Haiku class  - fastest
];

const DEFAULT_MODEL = "zai_auto";

const MODELS = [
  { id: "zai_auto",           name: "Auto",        contextWindow: 1_048_576, maxTokens: 393_216 },
  { id: "zai_glm-5-turbo",    name: "GLM-5-Turbo", contextWindow: 204_800,   maxTokens: 131_072 },
  // ── DEPRECATED (Z.AI deprecated GLM-5.2 from the AutoClaw app) ───────────────
  // { id: "openrouter_glm-5.2", name: "GLM-5.2",     contextWindow: 1_048_576, maxTokens: 307_200 },
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

const ANTHROPIC_LOG_FILE = path.join(process.cwd(), "proxy_requests_anthropic.json");
const MAX_LOG_ENTRIES     = 50;

function logRequest(entry) {
  try {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(ANTHROPIC_LOG_FILE, "utf-8")); } catch (_) {}
    entries.push(entry);
    if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(-MAX_LOG_ENTRIES);
    fs.writeFileSync(ANTHROPIC_LOG_FILE, JSON.stringify(entries, null, 2));
  } catch (_) { /* silently skip if disk write fails */ }
}

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
 * Properly translates tool_use → tool_calls, tool_result → "tool" role.
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
    const content = msg.content;

    // Simple string content
    if (typeof content === "string") {
      messages.push({ role: msg.role, content });
      continue;
    }

    if (!Array.isArray(content)) continue;

    // Sort blocks: tool_use and text stay with the message, tool_result becomes "tool" role
    const toolResults = [];
    const toolUses = [];
    const textParts = [];

    for (const block of content) {
      if (block.type === "tool_result")      toolResults.push(block);
      else if (block.type === "tool_use")    toolUses.push(block);
      else if (block.type === "text")        textParts.push(block.text);
      else if (block.type === "thinking")    { /* skip */ }
    }

    // tool_result blocks → individual "tool" role messages (must come AFTER the
    // assistant message that contained the tool_use, which is already in `messages`)
    for (const tr of toolResults) {
      let resultText;
      if (typeof tr.content === "string") {
        resultText = tr.content;
      } else if (Array.isArray(tr.content)) {
        resultText = tr.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      } else {
        resultText = JSON.stringify(tr.content);
      }
      messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: resultText });
    }

    // Build the main message
    if (msg.role === "assistant" && toolUses.length > 0) {
      // Assistant message that called tools — include tool_calls
      const msgObj = {
        role: "assistant",
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        })),
      };
      // Only include content if there's actual text — omitting it entirely is
      // safer than null/empty-string for picky upstreams
      if (textParts.length > 0) msgObj.content = textParts.join("\n");
      messages.push(msgObj);
    } else if (textParts.length > 0) {
      // Regular text message
      messages.push({ role: msg.role, content: textParts.join("\n") });
    } else if (toolResults.length === 0 && toolUses.length === 0) {
      // Empty message — shouldn't happen but don't send empty
      messages.push({ role: msg.role, content: "" });
    }
    // If only tool_results: the "tool" messages above are sufficient, skip main msg
  }

  // Convert Anthropic tool definitions → OpenAI format
  const openAITools = body.tools?.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));

  // Convert tool_choice (only send for explicit choices, let "auto" be the default)
  let openAIToolChoice;
  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
      // "any" → "required", "auto" → don't send (it's the default)
      if (body.tool_choice === "any") openAIToolChoice = "required";
      else if (body.tool_choice !== "auto") openAIToolChoice = body.tool_choice;
    } else if (body.tool_choice?.type === "tool") {
      openAIToolChoice = { type: "function", function: { name: body.tool_choice.name } };
    } else if (body.tool_choice?.type === "any") {
      openAIToolChoice = "required";
    }
  }

  const result = {
    model:       modelId,
    messages,
    stream:      true, // always stream upstream
    max_tokens:  body.max_tokens  ?? 4096,
    temperature: body.temperature ?? undefined,
    top_p:       body.top_p       ?? undefined,
    stop:        body.stop_sequences?.length ? body.stop_sequences : undefined,
  };
  if (openAITools?.length)  result.tools = openAITools;
  if (openAIToolChoice)     result.tool_choice = openAIToolChoice;

  return result;
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
  const toolCalls = {}; // index → { id, name, arguments }

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6));
      if (chunk.id)    id    = chunk.id;
      if (chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content)           content   += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      // Accumulate tool calls across chunks
      for (const tc of delta?.tool_calls || []) {
        if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: "", name: "", arguments: "" };
        if (tc.id)                  toolCalls[tc.index].id = tc.id;
        if (tc.function?.name)      toolCalls[tc.index].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr === "length") stopReason = "max_tokens";
      if (fr === "tool_calls") stopReason = "tool_use";
      if (chunk.usage) outputTokens = chunk.usage.completion_tokens ?? 0;
    } catch { /* skip malformed lines */ }
  }

  const contentBlocks = [];
  if (reasoning) contentBlocks.push({ type: "thinking", thinking: reasoning });

  // Emit tool_use blocks (sorted by index)
  const sortedIndices = Object.keys(toolCalls).sort((a, b) => Number(a) - Number(b));
  for (const idx of sortedIndices) {
    const tc = toolCalls[idx];
    let input = {};
    try { input = JSON.parse(tc.arguments); } catch { /* partial JSON */ }
    contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  if (content) contentBlocks.push({ type: "text", text: content });

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
 * Handles streaming tool_calls → Anthropic tool_use content blocks.
 */
function openAIChunkToAnthropicEvents(line, state) {
  if (!line.startsWith("data: ")) return [];

  if (line === "data: [DONE]") {
    const events = [];
    // Close any open tool_use blocks
    for (const idx of Object.keys(state.toolState).sort((a, b) => Number(a) - Number(b))) {
      const ts = state.toolState[idx];
      if (ts.opened && !ts.closed) {
        events.push(fmt("content_block_stop", { type: "content_block_stop", index: ts.blockIdx }));
        ts.closed = true;
      }
    }
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
  const toolCalls = delta.tool_calls        || [];
  const fr        = chunk.choices?.[0]?.finish_reason;

  if (chunk.usage) state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
  if (fr === "length")     state.finishReason = "max_tokens";
  if (fr === "stop")       state.finishReason = "end_turn";
  if (fr === "tool_calls") state.finishReason = "tool_use";

  // ---- Tool calls ----
  for (const tc of toolCalls) {
    const idx = tc.index;
    if (!state.toolState[idx]) {
      state.toolState[idx] = { id: "", name: "", arguments: "", opened: false, closed: false, blockIdx: -1 };
    }
    const ts = state.toolState[idx];
    if (tc.id)                  ts.id = tc.id;
    if (tc.function?.name)      ts.name = tc.function.name;
    if (tc.function?.arguments) ts.arguments += tc.function.arguments;

    // Open the tool_use block once we have the name
    if (ts.name && !ts.opened) {
      // Close any currently open block first
      if (state.blockOpen) {
        events.push(fmt("content_block_stop", { type: "content_block_stop", index: state.blockIndex }));
        state.blockIndex++;
        state.blockOpen = false;
        state.thinkingOpen = false;
        state.textOpen = false;
      }
      ts.blockIdx = state.blockIndex;
      events.push(fmt("content_block_start", {
        type: "content_block_start", index: state.blockIndex,
        content_block: { type: "tool_use", id: ts.id, name: ts.name, input: {} },
      }));
      ts.opened = true;
      state.blockOpen = true;
    }

    // Stream the arguments as input_json_delta
    if (ts.opened && tc.function?.arguments) {
      events.push(fmt("content_block_delta", {
        type: "content_block_delta", index: ts.blockIdx,
        delta: { type: "input_json_delta", partial_json: tc.function.arguments },
      }));
    }
  }

  // ---- Reasoning ----
  if (reasoning && !state.thinkingOpen) {
    if (state.blockOpen) {
      events.push(fmt("content_block_stop", { type: "content_block_stop", index: state.blockIndex }));
      state.blockIndex++;
      state.blockOpen = false;
      state.textOpen = false;
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

  // ---- Text ----
  if (content && !state.textOpen) {
    // Close thinking block if open
    if (state.thinkingOpen) {
      events.push(fmt("content_block_stop", { type: "content_block_stop", index: state.blockIndex }));
      state.blockIndex++;
      state.thinkingOpen = false;
      state.blockOpen = false;
    }
    // Close any open tool_use blocks before starting text
    for (const idx of Object.keys(state.toolState).sort((a, b) => Number(a) - Number(b))) {
      const ts = state.toolState[idx];
      if (ts.opened && !ts.closed) {
        events.push(fmt("content_block_stop", { type: "content_block_stop", index: ts.blockIdx }));
        state.blockIndex++;
        ts.closed = true;
        state.blockOpen = false;
      }
    }
    if (!state.blockOpen) {
      events.push(fmt("content_block_start", {
        type: "content_block_start", index: state.blockIndex,
        content_block: { type: "text", text: "" },
      }));
      state.textOpen  = true;
      state.blockOpen = true;
    }
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
    // The backend ONLY accepts the original 'zai_' prefixed model string.
    // Do NOT strip the 'zai_' prefix — causes 500 "parse response failed".
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
        ...CLIENT_HEADERS,
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

  // Save request details + status to file (not terminal)
  const lastMsg = openAIBody.messages?.[openAIBody.messages.length - 1];
  logRequest({
    timestamp: new Date().toISOString(),
    model: modelId,
    anthropic_model: body.model,
    status: upstreamRes.statusCode,
    last_message: typeof lastMsg?.content === "string"
      ? lastMsg.content.substring(0, 300)
      : JSON.stringify(lastMsg?.content).substring(0, 300),
    message_count: openAIBody.messages?.length || 0,
  });

  if (upstreamRes.statusCode === 401) {
    invalidateToken();
    return sendError(res, "AutoClaw token expired - invalidated cache, retry the request", "authentication_error", 401);
  }

  if (upstreamRes.statusCode >= 400) {
    let errBody = "";
    upstreamRes.on("data", (c) => (errBody += c));
    upstreamRes.on("end",  () => {
      try {
        const parsed = JSON.parse(errBody);
        log.error(`Upstream error ${upstreamRes.statusCode}:`, parsed.error?.message || errBody);
        sendJSON(res, parsed, upstreamRes.statusCode);
      } catch {
        log.error(`Upstream error ${upstreamRes.statusCode}:`, errBody);
        sendError(res, errBody || "Upstream error", "api_error", upstreamRes.statusCode);
      }
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
      toolState: {},
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
