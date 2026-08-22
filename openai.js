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
 *   node openai.js
 *   PORT=3001 node openai.js
 *
 * OpenCode / any OpenAI-compatible client:
 *   baseURL : http://localhost:18791/v1
 *   apiKey  : (value of PROXY_KEY env, default "mewmew")
 */

import http from "http";
import {
  loadConfig, loadModelCatalog, getModelCatalog, createTokenLayer, createLogger,
  sendJSON, sendErrorOpenAI, readBody, validateChatPayload, isAuthorized, generateId,
  collectResponse, createRateLimiter, clientIpOpenAI,
  createRequestLogger, createJsonlLogger, callUpstreamOpenAI,
  streamLocalGatewayAgent, getLocalGatewayToken, getUpstreamErrorMessage, translateUpstreamError,
  BOX_W, boxRow,
} from "./lib/core.js";

// Config
const config = loadConfig({ defaultPort: 18791 });
const { log } = createLogger(config.LOG_LEVEL);
const { MODELS, KNOWN_IDS } = loadModelCatalog(config);
const { getToken, invalidateToken, startWatch } = createTokenLayer(config, log);
const { rateLimit, startBucketSweep } = createRateLimiter(config.RATE_LIMIT);
const { logRequest } = createRequestLogger(config.REQUEST_LOG_FILE);
const { logJsonl } = createJsonlLogger({ enabled: config.JSONL_LOG, sync: config.JSONL_SYNC, file: config.JSONL_FILE, maxBytes: config.JSONL_MAX_BYTES });

startWatch();
startBucketSweep();

// Alias so all existing call sites stay unchanged
const sendError = sendErrorOpenAI;

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

// Routes

function handleHealth(res) {
  let tokenOk = true, tokenError = null;
  try   { getToken(); }
  catch (e) { tokenOk = false; tokenError = e.message; }

  sendJSON(res, {
    ok:       tokenOk,
    status:   tokenOk ? "live" : "no_token",
    upstream: config.UPSTREAM_BASE,
    port:     config.PORT,
    ...(tokenError ? { error: tokenError } : {}),
  });
}

function handleModels(res) {
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
  let body;
  try {
    body = await readBody(req, config.MAX_BODY_BYTES);
  } catch (err) {
    const status = err.statusCode || 400;
    logJsonl({ model: null, status, ip: clientIpOpenAI(req), latencyMs: Date.now() - startTime, error: "invalid_request" });
    return sendError(res, err.message, "invalid_request", status);
  }
  // Input validation
  if (!body.model || typeof body.model !== "string" || body.model.length > 256 || body.model.includes("..") || /[\r\n\0]/.test(body.model)) {
    logJsonl({ model: null, status: 400, ip: clientIpOpenAI(req), latencyMs: Date.now() - startTime, error: "invalid_request" });
    return sendError(res, "model must be a valid non-empty string (max 256 chars)", "invalid_request", 400);
  }
  const payloadError = validateChatPayload(body);
  if (payloadError) {
    logJsonl({ model: body.model, status: payloadError.statusCode, ip: clientIpOpenAI(req), latencyMs: Date.now() - startTime, error: "invalid_request" });
    return sendError(res, payloadError.message, "invalid_request", payloadError.statusCode);
  }
  const modelId = body.model;
  const stream  = body.stream !== false; // default true
  const { models } = getModelCatalog(config);
  const knownIds = new Set(models.map((m) => m.id));

  log.info(`chat model=${modelId} stream=${stream}`);

  let upstreamRes;
  let upstreamErrBody = "";

  const tryLocalAgent = () => {
    if (!getLocalGatewayToken()) return false;
    log.info(`Executing chat model=${modelId} via local AutoClaw WebSocket agent...`);
    return new Promise((resolve) => {
      let fullContent = "";
      let streamedHeader = false;

      streamLocalGatewayAgent({
        modelId,
        messages: body.messages,
        onChunk: ({ delta }) => {
          if (stream) {
            if (!streamedHeader) {
              streamedHeader = true;
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
              });
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
            resolve(true);
          } else {
            sendJSON(res, {
              id: `chatcmpl-${generateId()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, message: { role: "assistant", content: fullContent }, finish_reason: finishReason || "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
            resolve(true);
          }
        },
        onError: (err) => {
          log.warn(`Local gateway execution failed: ${err.message}`);
          sendError(res, getUpstreamErrorMessage(upstreamErrBody || err.message), "api_error", 502);
          resolve(true);
        }
      });
    });
  };

  try {
    upstreamRes = await callUpstreamOpenAI(knownIds, config.CLIENT_HEADERS, getToken, body, modelId, log);
    if (upstreamRes.statusCode === 400) {
      upstreamErrBody = await collectResponse(upstreamRes);
      if (upstreamErrBody.includes('"invalid request"')) {
        log.info("Upstream 400 invalid request — retrying once");
        await new Promise(r => setTimeout(r, 2000));
        upstreamRes = await callUpstreamOpenAI(knownIds, config.CLIENT_HEADERS, getToken, body, modelId, log);
        if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 400) {
          upstreamErrBody = "";
        } else {
          upstreamErrBody = await collectResponse(upstreamRes);
        }
      }
    } else if (upstreamRes.statusCode === 401) {
      upstreamErrBody = await collectResponse(upstreamRes);
    }

    if (upstreamRes.statusCode >= 400 && upstreamRes.statusCode !== 404 && upstreamRes.statusCode !== 429) {
      if (!upstreamErrBody) upstreamErrBody = await collectResponse(upstreamRes);
      if (await tryLocalAgent()) return;
    }
  } catch (err) {
    if (await tryLocalAgent()) return;
    const status  = err.message.includes("Cannot read AutoClaw token") ? 503 : 502;
    const errType = status === 503 ? "service_unavailable" : "upstream_error";
    const message = translateUpstreamError(err.message);
    logJsonl({ model: modelId, status, ip: clientIpOpenAI(req), latencyMs: Date.now() - startTime, error: errType });
    return sendError(res, message, errType, status);
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

  logJsonl({ model: modelId, status: upstreamRes.statusCode, ip: clientIpOpenAI(req), latencyMs: Date.now() - startTime });

  // 401 → invalidate cached token so next request gets a fresh one
  if (upstreamRes.statusCode === 401) {
    invalidateToken();
    return sendError(res,
      "AutoClaw token expired — invalidated cache, retry the request",
      "authentication_error", 401
    );
  }

  // Normalize upstream failures to the OpenAI error shape and translate known messages.
  if (upstreamRes.statusCode >= 400) {
    const errBody = upstreamErrBody || await collectResponse(upstreamRes);
    const message = getUpstreamErrorMessage(errBody);
    log.error(`Upstream error ${upstreamRes.statusCode}:`, message);
    sendError(res, message, "api_error", upstreamRes.statusCode);
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

// Server

const server = http.createServer(async (req, res) => {
  // CORS — allow all origins so any local tool can talk to this proxy
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const clientIp = clientIpOpenAI(req);
  if (!isAuthorized(req, config.PROXY_KEY)) {
    logJsonl({ model: null, status: 401, ip: clientIp, latencyMs: 0, error: "auth" });
    return sendError(res, "Invalid or missing API key", "authentication_error", 401);
  }

  if (!rateLimit(clientIp)) {
    logJsonl({ model: null, status: 429, ip: clientIp, latencyMs: 0, error: "rate_limit" });
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }));
    return;
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

server.listen(config.PORT, HOST, () => {
  console.log(`
  ┌${"─".repeat(BOX_W + 2)}┐
  ${boxRow("🛸  AUTOCLAW GATEWAY PROXY (OpenAI Format v2.0.0)")}
  ├${"─".repeat(BOX_W + 2)}┤
  ${boxRow(`Host     : ${HOST}`)}
  ${boxRow(`Port     : ${config.PORT}`)}
  ${boxRow(`Auth Key : ${config.PROXY_KEY}`)}
  ${boxRow(`Rate Lim : ${config.RATE_LIMIT} req/s per IP`)}
  ${boxRow(`Models   : ${MODELS.map(m => m.id).join(", ")}`)}
  ├${"─".repeat(BOX_W + 2)}┤
  ${boxRow("OpenCode / OpenAI SDK Base URL:")}
  ${boxRow(`http://${HOST}:${config.PORT}/v1`)}
  └${"─".repeat(BOX_W + 2)}┘
  `);

  try {
    getToken();
    console.log("  ✅  Token loaded — ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});
