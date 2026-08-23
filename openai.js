/**
 * AutoClaw Proxy — OpenAI-format entrypoint.
 *
 * Owns ONLY the endpoint surface and wire format:
 *   POST /v1/chat/completions (+ OpenAI SSE passthrough / non-stream assembly)
 *   GET  /v1/models (OpenAI list shape)
 * All shared machinery — config, tokens, catalog, upstream calls, the local
 * WebSocket fallback, error classification, logging, server bootstrap — lives
 * in lib/core.js.
 *
 * How auth works: AutoClaw keeps a fresh JWT at
 * ~/.openclaw-autoclaw/request-headers.json, auto-refreshed whenever it
 * rotates. We read that file on startup and re-read every TOKEN_TTL_MS —
 * zero manual auth setup required.
 *
 * Usage:
 *   node openai.js
 *   PORT=3001 PREFER_LOCAL=1 node openai.js
 *
 * OpenCode / any OpenAI-compatible client:
 *   baseURL : http://localhost:18791/v1
 *   apiKey  : (value of PROXY_KEY env, default "mewmew")
 */

import {
  loadConfig, loadModelCatalog, getModelCatalog, createTokenLayer, createLogger,
  createRateLimiter, createRequestLogger, createJsonlLogger,
  makeHealthHandler, createGatewayServer, printStartupBanner, installProcessGuards,
  sendJSON, sendErrorOpenAI, sendClassifiedErrorOpenAI, resolveClientIp,
  readBody, validateChatPayload, generateId,
  SSE_HEADERS, validateModelField, lastMessagePreview,
  logUpstreamErrorBody, callUpstreamWithInvalidRequestRetry,
  callUpstreamOpenAI, streamLocalGatewayAgent, getLocalGatewayToken,
  classifyUpstreamError, classifyLocalAgentError, classifyTransportError,
  shouldFallbackToLocal, createPermanentFailureCache,
} from "./lib/core.js";

// Config
const config = loadConfig({ defaultPort: 18791, format: "openai" });
const { log } = createLogger(config.LOG_LEVEL);
const { MODELS } = loadModelCatalog(config);
const { getToken, invalidateToken, startWatch } = createTokenLayer(config, log);
const { rateLimit, startBucketSweep } = createRateLimiter(config.RATE_LIMIT);
const { logRequest } = createRequestLogger(config.REQUEST_LOG_FILE);
const { logJsonl } = createJsonlLogger({ enabled: config.JSONL_LOG, sync: config.JSONL_SYNC, file: config.JSONL_FILE, maxBytes: config.JSONL_MAX_BYTES });

// Remembers models that failed PERMANENTLY (quota exhausted, unknown id) so
// repeat requests fail instantly instead of replaying doomed attempts.
const permanentFailures = createPermanentFailureCache();

// A rotated token can also mean un-quota'd state changed — drop both caches.
function invalidateAuth() {
  invalidateToken();
  permanentFailures.clear();
}

startWatch();
startBucketSweep();

// SSE buffering (OpenAI-specific: assemble streamed chunks into a single response)
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
          .map((idx) => ({
            id: toolCalls[idx].id,
            type: "function",
            function: { name: toolCalls[idx].name, arguments: toolCalls[idx].arguments },
          }));

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

// Routes

function handleModels(req, res) {
  const { models } = getModelCatalog(config);
  sendJSON(res, {
    object: "list",
    data:   models.map((m) => ({
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
  const clientIp  = resolveClientIp(req);

  // Exactly one observability entry per request, written at the terminal
  // outcome — cloud-served AND local-agent-served alike (`via` marks which).
  // Optional cloud_status/cloud_error carry the rejected cloud attempt's
  // evidence when fallback ended up serving the request.
  let recorded = false;
  function record(status, { model = null, lastMessage = null, messageCount = 0, error, via = "cloud", cloud_status, cloud_error } = {}) {
    if (recorded) return;
    recorded = true;
    if (model) {
      logRequest({
        timestamp: new Date().toISOString(),
        model, status, via,
        last_message: typeof lastMessage === "string"
          ? lastMessage.substring(0, 300)
          : JSON.stringify(lastMessage)?.substring(0, 300) ?? "",
        ...(messageCount ? { message_count: messageCount } : {}),
        ...(error ? { error } : {}),
        ...(cloud_status ? { cloud_status, ...(cloud_error ? { cloud_error } : {}) } : {}),
      });
    }
    logJsonl({ model, status, ip: clientIp, latencyMs: Date.now() - startTime, ...(via !== "cloud" ? { via } : {}), ...(error ? { error } : {}) });
  }

  // R1: never let an upstream rejection pass without its body on record —
  // (logUpstreamErrorBody lives in lib/core.js — shared with anthropic.js)

  let body;
  try {
    body = await readBody(req, config.MAX_BODY_BYTES);
  } catch (err) {
    record(err.statusCode || 400, { error: "invalid_request" });
    return sendErrorOpenAI(res, err.message, "invalid_request_error", err.statusCode || 400, "invalid_request");
  }

  // Input validation — model field first (it drives everything downstream)
  const modelFieldError = validateModelField(body);
  if (modelFieldError) {
    record(400, { error: "invalid_request" });
    return sendErrorOpenAI(res, modelFieldError.message, modelFieldError.type, modelFieldError.status, modelFieldError.code);
  }
  const payloadError = validateChatPayload(body);
  if (payloadError) {
    record(payloadError.statusCode, { model: body.model, error: "payload_too_large" });
    return sendErrorOpenAI(res, payloadError.message, "invalid_request_error", payloadError.statusCode, "invalid_payload");
  }

  const modelId = body.model;
  const stream  = body.stream !== false; // default true
  const { models } = getModelCatalog(config);
  const knownIds = new Set(models.map((m) => m.id));

  log.info(`chat model=${modelId} stream=${stream}`);

  const lastMsgForLog = () => lastMessagePreview(body.messages);

  // Cloud-attempt evidence (status + classifier code) set when the cloud
  // rejected this request before fallback ran; consumed by record() so the
  // terminal ring entry carries the full story.
  let cloudEvidence = null;

  // Local AutoClaw WebSocket agent fallback. Returns true when the response
  // was fully handled here (success OR terminal error), false when the local
  // gateway is simply unavailable.
  const tryLocalAgent = () => {
    if (!getLocalGatewayToken()) return Promise.resolve(false);
    log.info(`Executing chat model=${modelId} via local AutoClaw WebSocket agent...`);
    return new Promise((resolve) => {
      let fullContent = "";
      let streamedHeader = false;
      const startedAt = Date.now();

      streamLocalGatewayAgent({
        modelId,
        messages: body.messages,
        onChunk: ({ delta }) => {
          if (stream) {
            if (!streamedHeader) {
              streamedHeader = true;
              res.writeHead(200, SSE_HEADERS);
            }
            const chunk = JSON.stringify({
              id: `chatcmpl-${generateId()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, delta: { role: "assistant", content: delta }, finish_reason: null }],
            });
            res.write(`data: ${chunk}\n\n`);
          } else {
            fullContent += delta;
          }
        },
        onEnd: ({ finishReason }) => {
          if (stream) {
            const finalChunk = JSON.stringify({
              id: `chatcmpl-${generateId()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }],
            });
            res.end(`data: ${finalChunk}\n\ndata: [DONE]\n\n`);
          } else {
            sendJSON(res, {
              id: `chatcmpl-${generateId()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, message: { role: "assistant", content: fullContent }, finish_reason: finishReason || "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
          }
          log.info(`chat model=${modelId} served via local agent (${Date.now() - startedAt}ms)`);
          record(200, {
            model: modelId, lastMessage: fullContent, messageCount: body.messages?.length || 0, via: "local",
            ...(cloudEvidence ? { cloud_status: cloudEvidence.status, cloud_error: cloudEvidence.code } : {}),
          });
          resolve(true);
        },
        onError: (err) => {
          log.warn(`Local gateway execution failed: ${err.message}`);
          const cls = classifyLocalAgentError(err, modelId);
          permanentFailures.mark(modelId, cls);
          if (res.headersSent) {
            // SSE already went out with 200 — a JSON 502 cannot follow.
            // Terminate the stream instead of throwing ERR_HTTP_HEADERS_SENT.
            try { res.end(); } catch (_) {}
            record(cls.status, { model: modelId, error: `${cls.code} (mid-stream)`, via: "local", ...(cloudEvidence ? { cloud_status: cloudEvidence.status, cloud_error: cloudEvidence.code } : {}) });
          } else {
            record(cls.status, {
              model: modelId, error: cls.code, via: "local",
              ...(cloudEvidence ? { cloud_status: cloudEvidence.status, cloud_error: cloudEvidence.code } : {}),
            });
            sendClassifiedErrorOpenAI(res, cls);
          }
          resolve(true);
        },
      });
    });
  };

  // Terminal success handling shared by first-attempt and retried responses.
  async function respondSuccess(successRes) {
    record(successRes.statusCode, { model: modelId, lastMessage: lastMsgForLog(), messageCount: body.messages?.length || 0 });
    log.debug(`← upstream status=${successRes.statusCode}`);

    if (stream) {
      res.writeHead(200, SSE_HEADERS);
      successRes.pipe(res);
      return;
    }

    // Non-stream: buffer SSE, assemble full response object
    try {
      sendJSON(res, await bufferSSE(successRes, modelId));
    } catch (err) {
      if (!res.headersSent) sendErrorOpenAI(res, err.message, "api_error", 502, "upstream_parse_failed");
      else { try { res.end(); } catch (_) {} }
    }
  }

  try {
    // PREFER_LOCAL=1: skip the cloud attempt entirely when the desktop
    // gateway is up — saves doomed round-trips while credits are exhausted.
    if (config.PREFER_LOCAL && getLocalGatewayToken()) {
      if (await tryLocalAgent()) return;
    }

    // Known-permanent failure within the TTL → answer instantly, identically.
    const cachedFailure = permanentFailures.get(modelId);
    if (cachedFailure) {
      log.info(`chat model=${modelId} short-circuited: ${cachedFailure.code} (recently confirmed)`);
      record(cachedFailure.status, { model: modelId, error: cachedFailure.code });
      return sendClassifiedErrorOpenAI(res, cachedFailure);
    }

    // Cloud call with one retry on the flaky 400 "invalid request" hiccup;
    // every >=400 body is buffered + logged (R1). Shared with anthropic.js.
    const { res: upstreamRes, errBody: upstreamErrBody } = await callUpstreamWithInvalidRequestRetry(
      () => callUpstreamOpenAI(knownIds, config.CLIENT_HEADERS, getToken, body, modelId, log),
      modelId, permanentFailures, log,
    );

    const effectiveStatus = upstreamRes.statusCode;

    if (effectiveStatus < 400) return respondSuccess(upstreamRes);

    // Rotate-out token caches BEFORE deciding fallback so the very next
    // request picks up the fresh JWT regardless of who serves this one.
    if (effectiveStatus === 401) invalidateAuth();

    if (shouldFallbackToLocal(effectiveStatus)) {
      const cls = classifyUpstreamError(effectiveStatus, upstreamErrBody, modelId);
      if (cls.permanent) permanentFailures.mark(modelId, cls);
      log.error(`Upstream error ${effectiveStatus}:`, cls.message);
      cloudEvidence = { status: effectiveStatus, code: cls.code };

      // The desktop gateway shares this AutoClaw account — a quota/plan wall
      // stops it too, so don't march a known-permanent failure into it.
      if (!cls.permanent || !permanentFailures.get(modelId)) {
        if (await tryLocalAgent()) return;
      } else {
        log.info(`Skipping local fallback for ${modelId}: ${cls.code} is account-wide`);
      }

      record(cls.status, {
        model: modelId, lastMessage: lastMsgForLog(), messageCount: body.messages?.length || 0,
        error: cls.code,
        // cloud evidence rides along on the terminal entry — the test CLI
        // renders [cloud NNN → local agent] from these fields
        ...(effectiveStatus !== cls.status ? { cloud_status: effectiveStatus, cloud_error: cls.code } : {}),
      });
      return sendClassifiedErrorOpenAI(res, cls);
    }

    return respondSuccess(upstreamRes);
  } catch (err) {
    // Transport-level failure (no HTTP response at all): dead token, connect
    // reset, upstream timeout…
    const cls = classifyTransportError(err);
    log.error(`chat model=${modelId} transport failure:`, cls.message);
    if (!res.headersSent && shouldFallbackToLocal(cls.status)) {
      if (await tryLocalAgent()) return;
    }
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    record(cls.status, { model: modelId, lastMessage: lastMsgForLog(), messageCount: body.messages?.length || 0, error: cls.code });
    return sendClassifiedErrorOpenAI(res, cls);
  }
}

// Server

const server = createGatewayServer({
  config, log, rateLimit,
  sendError: sendErrorOpenAI,
  routes: [
    { method: "GET",  path: "/healthz",             handler: makeHealthHandler(config, getToken) },
    { method: "GET",  path: "/v1/models",           handler: handleModels },
    { method: "POST", path: "/v1/chat/completions", handler: handleChatCompletions },
  ],
});

installProcessGuards(log);

const HOST = process.env.HOST || "127.0.0.1";

server.listen(config.PORT, HOST, () => {
  printStartupBanner({
    title: "🛸  AUTOCLAW GATEWAY PROXY (OpenAI Format v2.0.0)",
    rows: [
      `Host     : ${HOST}`,
      `Port     : ${config.PORT}`,
      `Auth Key : ${config.PROXY_KEY}`,
      `Rate Lim : ${config.RATE_LIMIT} req/s per IP`,
      `Models   : ${MODELS.map(m => m.id).join(", ")}`,
      "",
      "OpenCode / OpenAI SDK Base URL:",
      `http://${HOST}:${config.PORT}/v1`,
    ],
  });

  try {
    getToken();
    console.log("  ✅  Token loaded — ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});
