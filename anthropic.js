/**
 * AutoClaw Proxy — Anthropic-format entrypoint.
 *
 * Owns ONLY the endpoint surface and wire format:
 *   POST /v1/messages (+ Anthropic SSE conversion state machine)
 *   GET  /v1/models (Anthropic list shape), /v1/messages/count_tokens stub
 * Claude aliases route by AutoClaw CREDIT TIER (opus→High, sonnet→Medium,
 * haiku→Low) fetched from AutoClaw's remote model-config, degrading to
 * heuristics when unreachable. Direct AutoClaw model IDs pass through.
 *
 * Claude Code CLI setup (~/.claude/settings.json):
 *   {
 *     "env": {
 *       "ANTHROPIC_BASE_URL": "http://localhost:18792",
 *       "ANTHROPIC_AUTH_TOKEN": "mewmew"
 *     }
 *   }
 */

import {
  loadConfig, loadModelCatalog, getModelCatalog, createTokenLayer, createLogger,
  createRateLimiter, createRequestLogger, createJsonlLogger,
  makeHealthHandler, createGatewayServer, printStartupBanner, installProcessGuards,
  sendJSON, sendErrorAnthropic, sendClassifiedErrorAnthropic, resolveClientIp,
  readBody, validateChatPayload, generateId,
  SSE_HEADERS, validateModelField, lastMessagePreview,
  logUpstreamErrorBody, callUpstreamWithInvalidRequestRetry,
  callUpstreamAnthropic, streamLocalGatewayAgent, getLocalGatewayToken,
  classifyUpstreamError, classifyLocalAgentError, classifyTransportError,
  shouldFallbackToLocal, createPermanentFailureCache,
  fetchRemoteModelConfig, annotateCreditTiers, resolveTierTargets,
  getClientHeaders, VERSION,
} from "./lib/core.js";

// Config (per-format log filenames come from `format`)
const config = loadConfig({ format: "anthropic" });
const { log } = createLogger(config.LOG_LEVEL);
const { MODELS } = loadModelCatalog(config);
const { getToken, invalidateToken, startWatch } = createTokenLayer(config, log);
const { rateLimit, startBucketSweep } = createRateLimiter(config.RATE_LIMIT);
const { logRequest } = createRequestLogger(config.REQUEST_LOG_FILE);
const { logJsonl } = createJsonlLogger({ enabled: config.JSONL_LOG, sync: config.JSONL_SYNC, file: config.JSONL_FILE, maxBytes: config.JSONL_MAX_BYTES });

// Remembers models that failed PERMANENTLY (quota exhausted, unknown id) so
// repeat requests fail instantly instead of replaying doomed attempts.
const permanentFailures = createPermanentFailureCache();

function invalidateAuth() {
  invalidateToken();
  permanentFailures.clear();
}

startWatch();
startBucketSweep();

// ─── Credit-tier routing ────────────────────────────────────────────────────
// Heuristic tiers apply immediately (startup never blocks on the network);
// the remote model-config refresh lands in the background and re-computes
// the targets once it arrives.

let tierTargets = resolveTierTargets(annotateCreditTiers(MODELS, null));

async function refreshTiers() {
  let jwt = null;
  try { jwt = getToken(); } catch { return; } // no token yet — heuristics only
  const remote = await fetchRemoteModelConfig(config, jwt);
  if (!remote) return;
  tierTargets = resolveTierTargets(annotateCreditTiers(getModelCatalog(config).models, remote));
  log.info(`Credit-tier routing: opus→${tierTargets.opus} sonnet→${tierTargets.sonnet} haiku→${tierTargets.haiku} default→${tierTargets.default}`);
}
refreshTiers();

// Resolve any Anthropic model name to an AutoClaw model ID:
// exact catalog IDs pass through untouched; claude-* names map by class.
function resolveModel(anthropicModel) {
  if (!anthropicModel) return tierTargets.default;
  const { models } = getModelCatalog(config);
  if (models.some((m) => m.id === anthropicModel)) return anthropicModel;
  const CLASS_MAP = [
    { pattern: /opus/i,   target: tierTargets.opus },
    { pattern: /sonnet/i, target: tierTargets.sonnet },
    { pattern: /haiku/i,  target: tierTargets.haiku },
  ];
  const match = CLASS_MAP.find((c) => c.pattern.test(anthropicModel));
  return match ? match.target : tierTargets.default;
}

// ─── Format conversion (Anthropic <-> OpenAI) ───────────────────────────────

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
    const imageParts = [];

    // Anthropic image block → OpenAI image_url part (AutoClaw's cloud accepts
    // native vision parts on the chat/completions wire; probe-verified 2026-09-04).
    const toOpenAIImage = (block) => {
      const src = block?.source;
      if (src?.type === "base64" && typeof src.data === "string") {
        return { type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } };
      }
      if (src?.type === "url" && typeof src.url === "string") {
        return { type: "image_url", image_url: { url: src.url } };
      }
      return null;
    };

    for (const block of content) {
      if (block.type === "tool_result")      toolResults.push(block);
      else if (block.type === "tool_use")    toolUses.push(block);
      else if (block.type === "text")        textParts.push(block.text);
      else if (block.type === "image")       { const p = toOpenAIImage(block); if (p) imageParts.push(p); }
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
    } else if (imageParts.length > 0 && msg.role !== "assistant") {
      // Multimodal user turn: OpenAI array content with text + image parts.
      const parts = [
        ...textParts.map((t) => ({ type: "text", text: t })),
        ...imageParts,
      ];
      messages.push({ role: msg.role, content: parts });
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

// Map an OpenAI finish_reason onto Anthropic stop_reason vocabulary
function anthropicStopReason(finishReason) {
  return finishReason === "stop" || !finishReason ? "end_turn" : finishReason;
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

// ─── Routes ─────────────────────────────────────────────────────────────────

function handleModels(req, res) {
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
  const clientIp  = resolveClientIp(req);

  // Model identity isn't known until after conversion — keep these above
  // record() so validation failures can still log safely (null = unknown).
  let currentModelId = null;
  let currentAnthropicModel = null;

  // Exactly one observability entry per request (`via` marks cloud vs local).
  let recorded = false;
  function record(status, { lastMessage = null, messageCount = 0, error, via = "cloud", cloud_status, cloud_error } = {}) {
    if (recorded) return;
    recorded = true;
    logRequest({
      timestamp: new Date().toISOString(),
      model: currentModelId, anthropic_model: currentAnthropicModel, status, via,
      last_message: typeof lastMessage === "string"
        ? lastMessage.substring(0, 300)
        : JSON.stringify(lastMessage)?.substring(0, 300) ?? "",
      ...(messageCount ? { message_count: messageCount } : {}),
      ...(error ? { error } : {}),
      ...(cloud_status ? { cloud_status, ...(cloud_error ? { cloud_error } : {}) } : {}),
    });
    logJsonl({ model: currentModelId, status, ip: clientIp, latencyMs: Date.now() - startTime, ...(via !== "cloud" ? { via } : {}), ...(error ? { error } : {}) });
  }

  // (logUpstreamErrorBody lives in lib/core.js — shared with openai.js)

  let body;
  try {
    body = await readBody(req, config.MAX_BODY_BYTES);
  } catch (err) {
    record(err.statusCode || 400, { error: "invalid_request" });
    return sendErrorAnthropic(res, err.message, "invalid_request_error", err.statusCode || 400, "invalid_request");
  }

  const modelFieldError = validateModelField(body);
  if (modelFieldError) {
    record(400, { error: "invalid_request" });
    return sendErrorAnthropic(res, modelFieldError.message, modelFieldError.type, modelFieldError.status, modelFieldError.code);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    record(400, { error: "invalid_request" });
    return sendErrorAnthropic(res, "messages must be a non-empty array", "invalid_request_error", 400, "invalid_messages");
  }

  const modelId    = resolveModel(body.model);
  const stream     = body.stream === true; // Anthropic defaults to non-streaming
  const openAIBody = anthropicToOpenAI(body, modelId);
  const payloadError = validateChatPayload(openAIBody, config.MAX_MESSAGES);
  if (payloadError) {
    record(payloadError.statusCode, { error: "payload_too_large" });
    return sendErrorAnthropic(res, payloadError.message, "invalid_request_error", payloadError.statusCode, "invalid_payload");
  }

  currentModelId = modelId;
  currentAnthropicModel = body.model;
  log.info(`messages model=${body.model} -> ${modelId} stream=${stream}`);

  const lastMsgForLog = () => lastMessagePreview(openAIBody.messages);

  // Local AutoClaw WebSocket agent fallback (same trigger rules as the OpenAI
  // entrypoint — this is what gives Anthropic its 402/403/5xx parity).
  // Set when the cloud upstream rejects the request before fallback runs;
  // consumed by record() so the terminal entry carries the cloud verdict.
  let cloudEvidence = null;
  const tryLocalAgent = () => {
    if (!getLocalGatewayToken()) return Promise.resolve(false);
    log.info(`Executing chat model=${modelId} via local AutoClaw WebSocket agent...`);
    return new Promise((resolve) => {
      let fullContent = "";
      let streamedStart = false;
      const startedAt = Date.now();

      streamLocalGatewayAgent({
        config,
        modelId,
        messages: openAIBody.messages,
        onChunk: ({ delta }) => {
          if (stream) {
            if (!streamedStart) {
              streamedStart = true;
              res.writeHead(200, SSE_HEADERS);
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
              delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null },
              usage: { output_tokens: 0 },
            }));
            res.write(fmt("message_stop", { type: "message_stop" }));
            res.end();
          } else {
            sendJSON(res, {
              id: `msg_${generateId()}`,
              type: "message",
              role: "assistant",
              model: body.model,
              content: [{ type: "text", text: fullContent }],
              stop_reason: anthropicStopReason(finishReason),
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            });
          }
          log.info(`chat model=${modelId} served via local agent (${Date.now() - startedAt}ms)`);
          record(200, {
            lastMessage: fullContent,
            messageCount: openAIBody.messages?.length || 0,
            via: "local",
            ...(cloudEvidence ? { cloud_status: cloudEvidence.status, cloud_error: cloudEvidence.code } : {}),
          });
          resolve(true);
        },
        onError: (err) => {
          log.warn(`Local gateway execution failed: ${err.message}`);
          const cls = classifyLocalAgentError(err, modelId);
          permanentFailures.mark(modelId, cls);
          if (res.headersSent) {
            // Stream already started — close it rather than throwing a
            // second writeHead onto a spent response.
            try { res.end(); } catch (_) {}
            record(cls.status, { error: `${cls.code} (mid-stream)`, via: "local", ...(cloudEvidence ? { cloud_status: cloudEvidence.status, cloud_error: cloudEvidence.code } : {}) });
          } else {
            record(cls.status, { error: cls.code, via: "local", ...(cloudEvidence ? { cloud_status: cloudEvidence.status, cloud_error: cloudEvidence.code } : {}) });
            sendClassifiedErrorAnthropic(res, cls);
          }
          resolve(true);
        },
      });
    });
  };

  try {
    // PREFER_LOCAL=1 fast path — skip doomed cloud attempts entirely.
    if (config.PREFER_LOCAL && getLocalGatewayToken()) {
      if (await tryLocalAgent()) return;
    }

    const cachedFailure = permanentFailures.get(modelId);
    if (cachedFailure) {
      log.info(`chat model=${modelId} short-circuited: ${cachedFailure.code} (recently confirmed)`);
      record(cachedFailure.status, { error: cachedFailure.code });
      return sendClassifiedErrorAnthropic(res, cachedFailure);
    }

    // Cloud call with one retry on the flaky 400 "invalid request" hiccup;
    // every >=400 body is buffered + logged (R1). Shared with openai.js.
    const { res: upstreamRes, errBody: upstreamErrBody } = await callUpstreamWithInvalidRequestRetry(
      () => callUpstreamAnthropic(config, getClientHeaders(config), getToken, openAIBody, modelId),
      modelId, permanentFailures, log,
    );

    const statusCode = upstreamRes.statusCode;

    // Rotate token caches BEFORE deciding fallback so the very next request
    // picks up the fresh JWT regardless of who serves this one.
    if (statusCode === 401) invalidateAuth();

    if (shouldFallbackToLocal(statusCode)) {
      const cls = classifyUpstreamError(statusCode, upstreamErrBody, modelId);
      if (cls.permanent) permanentFailures.mark(modelId, cls);
      log.error(`Upstream error ${statusCode}:`, cls.message);
      cloudEvidence = { status: statusCode, code: cls.code };

      // The desktop gateway shares this AutoClaw account — quota walls stop
      // it too, so don't march known-permanent failures into it.
      if (!cls.permanent || !permanentFailures.get(modelId)) {
        if (await tryLocalAgent()) return;
      } else {
        log.info(`Skipping local fallback for ${modelId}: ${cls.code} is account-wide`);
      }

      record(cls.status, {
        lastMessage: lastMsgForLog(),
        messageCount: openAIBody.messages?.length || 0,
        error: cls.code,
        ...(statusCode !== cls.status ? { cloud_status: statusCode, cloud_error: cls.code } : {}),
      });
      return sendClassifiedErrorAnthropic(res, cls);
    }

    // Success paths
    record(statusCode, { lastMessage: lastMsgForLog(), messageCount: openAIBody.messages?.length || 0 });

    if (stream) {
      res.writeHead(200, SSE_HEADERS);

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
      return;
    }

    // Non-stream: buffer everything into one Anthropic response object.
    let raw = "";
    upstreamRes.on("data", (c) => (raw += c));
    upstreamRes.on("end", () => {
      try {
        const inputTokens = (body.messages?.length ?? 1) * 10; // rough estimate only
        sendJSON(res, openAIChunksToAnthropic(raw, modelId, inputTokens));
      } catch (err) {
        if (!res.headersSent) sendErrorAnthropic(res, `Failed to parse upstream response: ${err.message}`, "api_error", 502, "upstream_parse_failed");
        else { try { res.end(); } catch (_) {} }
      }
    });
  } catch (err) {
    const cls = classifyTransportError(err);
    log.error(`messages model=${body.model} transport failure:`, cls.message);
    if (!res.headersSent && shouldFallbackToLocal(cls.status)) {
      if (await tryLocalAgent()) return;
    }
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    record(cls.status, { lastMessage: lastMsgForLog(), messageCount: openAIBody.messages?.length || 0, error: cls.code });
    return sendClassifiedErrorAnthropic(res, cls);
  }
}

// Server

const server = createGatewayServer({
  config, log, rateLimit,
  sendError: sendErrorAnthropic,
  routes: [
    { method: "GET",  path: "/healthz",                     handler: makeHealthHandler(config, getToken) },
    { method: "GET",  path: "/v1/models",                   handler: handleModels },
    { method: "POST", path: "/v1/messages",                 handler: handleMessages },
    // Claude Code probes token counts pre-flight; we don't tokenize locally,
    // so report zero rather than 404-ing the whole session handshake.
    { path: "/v1/messages/count_tokens", handler: (req, res) => sendJSON(res, { input_tokens: 0 }) },
  ],
});

installProcessGuards(log);

server.listen(config.PORT, config.HOST, () => {
  printStartupBanner({
    title: `🛸  AUTOCLAW GATEWAY PROXY (Anthropic Format v${VERSION})`,
    rows: [
      `Host     : ${config.HOST}`,
      `Port     : ${config.PORT}`,
      `Auth Key : ${config.PROXY_KEY}`,
      `Rate Lim : ${config.RATE_LIMIT} req/s per IP`,
      `Max Msgs : ${Number.isFinite(config.MAX_MESSAGES) ? `${config.MAX_MESSAGES} entries` : "unlimited"}`,
      `Models   : ${MODELS.map(m => m.id).join(", ")}`,
      "",
      "Claude Code CLI Base URL:",
      `http://${config.HOST}:${config.PORT}`,
      `Routing  : opus→${tierTargets.opus} sonnet→${tierTargets.sonnet} haiku→${tierTargets.haiku}`,
    ],
  });

  try {
    getToken();
    console.log("  ✅  Token loaded - ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});
