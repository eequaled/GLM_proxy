/**
 * AutoClaw Proxy - Anthropic format
 *
 * Same as openai.js but speaks the Anthropic Messages API instead of OpenAI.
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
import path from "path";

import {
  loadConfig, loadModelCatalog, getModelCatalog,
  createLogger, createTokenLayer,
  sendJSON, sendErrorAnthropic, readBody, validateChatPayload, isAuthorized, generateId, collectResponse,
  createRateLimiter, clientIpAnthropic,
  createRequestLogger, createJsonlLogger,
  callUpstreamAnthropic, streamLocalGatewayAgent, getLocalGatewayToken,
  getUpstreamErrorMessage, translateUpstreamError,
  BOX_W, boxRow,
} from "./lib/core.js";

// Pin the request/JSONL logs to Anthropic filenames before loadConfig reads env
if (!process.env.REQUEST_LOG_FILE) process.env.REQUEST_LOG_FILE = path.join(process.cwd(), "proxy_requests_anthropic.json");
if (!process.env.JSONL_FILE)       process.env.JSONL_FILE       = path.join(process.cwd(), "proxy_requests_anthropic.jsonl");

// Config
const config = loadConfig({ defaultPort: 18792 });
const { PORT, PROXY_KEY, LOG_LEVEL, RATE_LIMIT } = config;

// Logger
const { log } = createLogger(LOG_LEVEL);

// Model catalog
const { MODELS } = loadModelCatalog(config);

// Resolve model roles dynamically from the loaded catalog
function findByName(fragment) {
  return MODELS.find(m => (m.name + " " + m.id).toLowerCase().includes(fragment.toLowerCase()));
}

function preferredModel(...fragments) {
  for (const fragment of fragments) {
    const match = findByName(fragment);
    if (match) return match.id;
  }
  return "zai_auto";
}

const opusModel   = preferredModel("glm-5.3", "glm-5", "auto");
const sonnetModel = preferredModel("auto", "glm-5.3", "glm-5");
const haikuModel  = preferredModel("turbo", "deepseek", "auto");

const CLASS_MAP = [
  { pattern: /opus/i,   target: opusModel   },
  { pattern: /sonnet/i, target: sonnetModel },
  { pattern: /haiku/i,  target: haikuModel  },
];

const DEFAULT_MODEL = sonnetModel;

// Token layer
const { getToken, invalidateToken, startWatch } = createTokenLayer(config, log);
startWatch();

// Request loggers
const { logRequest } = createRequestLogger(config.REQUEST_LOG_FILE);
const { logJsonl } = createJsonlLogger({
  enabled: config.JSONL_LOG, sync: config.JSONL_SYNC, file: config.JSONL_FILE, maxBytes: config.JSONL_MAX_BYTES,
});

// Rate limiter
const { rateLimit, startBucketSweep } = createRateLimiter(RATE_LIMIT);
startBucketSweep();

// Anthropic error shape alias
const sendError = sendErrorAnthropic;

// Format conversion (Anthropic <-> OpenAI)

// Resolve any Anthropic model name to an AutoClaw model ID.
function resolveModel(anthropicModel) {
  const { models } = getModelCatalog(config);
  if (!anthropicModel) return DEFAULT_MODEL;
  if (models.some((m) => m.id === anthropicModel)) return anthropicModel;
  const match = CLASS_MAP.find((c) => c.pattern.test(anthropicModel));
  return match ? match.target : DEFAULT_MODEL;
}

// Convert an Anthropic Messages request body to OpenAI chat/completions format.
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

    if (typeof content === "string") {
      messages.push({ role: msg.role, content });
      continue;
    }

    if (!Array.isArray(content)) continue;

    const toolResults = [];
    const toolUses = [];
    const textParts = [];

    for (const block of content) {
      if (block.type === "tool_result")      toolResults.push(block);
      else if (block.type === "tool_use")    toolUses.push(block);
      else if (block.type === "text")        textParts.push(block.text);
      else if (block.type === "thinking")    { /* skip */ }
    }

    // tool_result blocks → "tool" role
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
      const msgObj = {
        role: "assistant",
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        })),
      };
      if (textParts.length > 0) msgObj.content = textParts.join("\n");
      messages.push(msgObj);
    } else if (textParts.length > 0) {
      messages.push({ role: msg.role, content: textParts.join("\n") });
    } else if (toolResults.length === 0 && toolUses.length === 0) {
      messages.push({ role: msg.role, content: "" });
    }
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

  let openAIToolChoice;
  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
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
    stream:      true,
    max_tokens:  body.max_tokens  ?? 4096,
    temperature: body.temperature ?? undefined,
    top_p:       body.top_p       ?? undefined,
    stop:        body.stop_sequences?.length ? body.stop_sequences : undefined,
  };
  if (openAITools?.length)  result.tools = openAITools;
  if (openAIToolChoice)     result.tool_choice = openAIToolChoice;

  return result;
}

// Buffer all OpenAI SSE chunks and assemble a single Anthropic response object.
function openAIChunksToAnthropic(raw, modelId, inputTokens) {
  let content = "", reasoning = "";
  let id = `msg_${generateId()}`;
  let model = modelId;
  let outputTokens = 0;
  let stopReason = "end_turn";
  const toolCalls = {};

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6));
      if (chunk.id)    id    = chunk.id;
      if (chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content)           content   += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
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

// Convert a single OpenAI SSE line to one or more Anthropic SSE event strings.
function openAIChunkToAnthropicEvents(line, state) {
  if (!line.startsWith("data: ")) return [];

  if (line === "data: [DONE]") {
    const events = [];
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

  // Tool calls
  for (const tc of toolCalls) {
    const idx = tc.index;
    if (!state.toolState[idx]) {
      state.toolState[idx] = { id: "", name: "", arguments: "", opened: false, closed: false, blockIdx: -1 };
    }
    const ts = state.toolState[idx];
    if (tc.id)                  ts.id = tc.id;
    if (tc.function?.name)      ts.name = tc.function.name;
    if (tc.function?.arguments) ts.arguments += tc.function.arguments;

    if (ts.name && !ts.opened) {
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

    if (ts.opened && tc.function?.arguments) {
      events.push(fmt("content_block_delta", {
        type: "content_block_delta", index: ts.blockIdx,
        delta: { type: "input_json_delta", partial_json: tc.function.arguments },
      }));
    }
  }

  // Reasoning
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

  // Text
  if (content && !state.textOpen) {
    if (state.thinkingOpen) {
      events.push(fmt("content_block_stop", { type: "content_block_stop", index: state.blockIndex }));
      state.blockIndex++;
      state.thinkingOpen = false;
      state.blockOpen = false;
    }
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

// Route handlers

function handleHealth(res) {
  let tokenOk = true, tokenError = null;
  try   { getToken(); }
  catch (e) { tokenOk = false; tokenError = e.message; }
  sendJSON(res, {
    ok: tokenOk, status: tokenOk ? "live" : "no_token",
    upstream: config.UPSTREAM_BASE, port: PORT,
    ...(tokenError ? { error: tokenError } : {}),
  });
}

function handleModels(res) {
  const { models } = getModelCatalog(config);
  const data = models.map((m) => ({
    type:         "model",
    id:           m.id,
    display_name: m.name,
    created_at:   new Date().toISOString(),
  }));
  sendJSON(res, {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id:  data[data.length - 1]?.id ?? null,
  });
}

async function handleMessages(req, res) {
  const startTime = Date.now();
  let body;
  try {
    body = await readBody(req, config.MAX_BODY_BYTES);
  } catch (err) {
    const status = err.statusCode || 400;
    return sendError(res, err.message, "invalid_request", status);
  }

  if (!body.model || typeof body.model !== "string" || body.model.length > 256 || body.model.includes("..") || /[\r\n\0]/.test(body.model)) {
    return sendError(res, "model must be a valid non-empty string (max 256 chars)", "invalid_request", 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, "messages must be a non-empty array", "invalid_request", 400);
  }

  const modelId    = resolveModel(body.model);
  const stream     = body.stream === true;
  const openAIBody = anthropicToOpenAI(body, modelId);
  const payloadError = validateChatPayload(openAIBody);
  if (payloadError) {
    return sendError(res, payloadError.message, "invalid_request", payloadError.statusCode);
  }

  log.info(`messages model=${body.model} -> ${modelId} stream=${stream}`);

  let upstreamRes;
  let upstreamErrBody = "";
  try {
    upstreamRes = await callUpstreamAnthropic(config.CLIENT_HEADERS, getToken, openAIBody, modelId);
    // Retry once on transient 400 "invalid request" before trying fallbacks
    if (upstreamRes.statusCode === 400) {
      upstreamErrBody = await collectResponse(upstreamRes);
      if (upstreamErrBody.includes('"invalid request"')) {
        log.info("Upstream 400 invalid request — retrying once");
        await new Promise(r => setTimeout(r, 2000));
        upstreamRes = await callUpstreamAnthropic(config.CLIENT_HEADERS, getToken, openAIBody, modelId);
        if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 400) {
          upstreamErrBody = "";
        } else {
          upstreamErrBody = await collectResponse(upstreamRes);
        }
      }
    } else if (upstreamRes.statusCode === 401) {
      upstreamErrBody = await collectResponse(upstreamRes);
    }

    if ((upstreamRes.statusCode === 400 || upstreamRes.statusCode === 401) && upstreamErrBody) {
      if (getLocalGatewayToken()) {
        log.info(`Anthropic upstream ${upstreamRes.statusCode} — executing via local AutoClaw WebSocket agent...`);
        return new Promise((resolve) => {
          let fullContent = "";
          let streamedStart = false;

          streamLocalGatewayAgent({
            modelId,
            messages: openAIBody.messages,
            onChunk: ({ delta }) => {
              if (stream) {
                if (!streamedStart) {
                  streamedStart = true;
                  res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                  });
                  res.write(fmt("message_start", {
                    type: "message_start",
                    message: {
                      id: `msg_${generateId()}`, type: "message", role: "assistant",
                      model: body.model, content: [], stop_reason: null, stop_sequence: null,
                      usage: { input_tokens: 0, output_tokens: 0 },
                    },
                  }));
                  res.write(fmt("content_block_start", {
                    type: "content_block_start", index: 0,
                    content_block: { type: "text", text: "" },
                  }));
                }
                res.write(fmt("content_block_delta", {
                  type: "content_block_delta", index: 0,
                  delta: { type: "text_delta", text: delta },
                }));
              } else {
                fullContent += delta;
              }
            },
            onEnd: ({ finishReason }) => {
              if (stream) {
                res.write(fmt("content_block_stop", { type: "content_block_stop", index: 0 }));
                res.write(fmt("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: finishReason === "stop" ? "end_turn" : finishReason, stop_sequence: null },
                  usage: { output_tokens: 0 },
                }));
                res.write(fmt("message_stop", { type: "message_stop" }));
                res.end();
                resolve();
              } else {
                sendJSON(res, {
                  id: `msg_${generateId()}`,
                  type: "message",
                  role: "assistant",
                  model: body.model,
                  content: [{ type: "text", text: fullContent }],
                  stop_reason: finishReason === "stop" ? "end_turn" : finishReason,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                });
                resolve();
              }
            },
            onError: (err) => {
              log.warn(`Local gateway execution failed: ${err.message}`);
              sendError(res, getUpstreamErrorMessage(upstreamErrBody || err.message), "api_error", upstreamRes.statusCode);
              resolve();
            }
          });
        });
      }
    }
  } catch (err) {
    const status = err.message.includes("Cannot read AutoClaw token") ? 503 : 502;
    logJsonl({ model: modelId, status, ip: clientIpAnthropic(req), latencyMs: Date.now() - startTime, error: "upstream_error" });
    return sendError(res, translateUpstreamError(err.message), "api_error", status);
  }

  log.debug(`upstream status=${upstreamRes.statusCode}`);

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

  logJsonl({ model: modelId, status: upstreamRes.statusCode, ip: clientIpAnthropic(req), latencyMs: Date.now() - startTime });

  if (upstreamRes.statusCode === 401) {
    invalidateToken();
    return sendError(res, "AutoClaw token expired - invalidated cache, retry the request", "authentication_error", 401);
  }

  if (upstreamRes.statusCode >= 400) {
    const errBody = upstreamErrBody || await collectResponse(upstreamRes);
    const message = getUpstreamErrorMessage(errBody);
    log.error(`Upstream error ${upstreamRes.statusCode}:`, message);
    sendError(res, message, "api_error", upstreamRes.statusCode);
    return;
  }

  if (stream) {
    res.writeHead(200, {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    });

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

// Server

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Anthropic-Version, Anthropic-Beta");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (!rateLimit(clientIpAnthropic(req))) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }));
    return;
  }

  if (!isAuthorized(req, PROXY_KEY)) {
    return sendError(res, "Invalid or missing API key", "authentication_error", 401);
  }

  const { pathname } = new URL(req.url, "http://localhost");

  try {
    if (req.method === "GET"  && pathname === "/healthz")              return handleHealth(res);
    if (req.method === "GET"  && pathname === "/v1/models")            return handleModels(res);
    if (req.method === "POST" && pathname === "/v1/messages")         return handleMessages(req, res);
    if (pathname === "/v1/messages/count_tokens")                     return sendJSON(res, { input_tokens: 0 });
    sendError(res, `${req.method} ${pathname} not found`, "not_found_error", 404);
  } catch (err) {
    log.error("Unhandled:", err);
    if (!res.headersSent) sendError(res, err.message, "api_error", 500);
  }
});

process.on("uncaughtException",  (e) => log.error("Uncaught exception:",  e));
process.on("unhandledRejection", (e) => log.error("Unhandled rejection:", e));

const HOST = process.env.HOST || "127.0.0.1";

server.listen(PORT, HOST, () => {
  console.log(`
  ┌${"─".repeat(BOX_W + 2)}┐
  ${boxRow("🛸  AUTOCLAW GATEWAY PROXY (Anthropic Format v2.0.0)")}
  ├${"─".repeat(BOX_W + 2)}┤
  ${boxRow(`Host     : ${HOST}`)}
  ${boxRow(`Port     : ${PORT}`)}
  ${boxRow(`Auth Key : ${PROXY_KEY}`)}
  ${boxRow(`Rate Lim : ${RATE_LIMIT} req/s per IP`)}
  ${boxRow(`Models   : ${MODELS.map(m => m.id).join(", ")}`)}
  ├${"─".repeat(BOX_W + 2)}┤
  ${boxRow("Claude Code CLI Base URL:")}
  ${boxRow(`http://${HOST}:${PORT}`)}
  └${"─".repeat(BOX_W + 2)}┘
  `);

  try {
    getToken();
    console.log("  ✅  Token loaded - ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});
