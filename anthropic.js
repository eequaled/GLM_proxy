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
  callUpstreamAnthropic,
  classifyUpstreamError, classifyTransportError,
  createPermanentFailureCache,
  fetchRemoteModelConfig, annotateCreditTiers, resolveTierTargets,
  getClientHeaders, startIdentityWatch, installShutdownHooks, VERSION,
  getPacingGovernor, classifyGovernorError,
  startConfigHeartbeat, startShapeWatch,
} from "./lib/core.js";
import { globalInFlightQueue } from "./lib/queue.js";

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
// Identity hot-reload + the hourly pinned-identity notice (lib/identity.js).
startIdentityWatch(config, log);
// The request-shape layer: re-read the app's own prompt banner when its bundle
// changes, so an app update needs no proxy restart (lib/shape.js).
startShapeWatch(config, log);
// Ctrl+C / `glmproxy --stop` release the h2 session, the keep-alive sockets and
// the identity watchers instead of leaving them to the OS.
installShutdownHooks(config, log);

// Account pacing governor (Requirement 3) — same one-window-per-account guard
// as openai.js, keyed on the JWT `user_id`. Placed before the transport so a
// refused request never opens an upstream socket.
const governor = getPacingGovernor(config, log, { getToken });

// Upstream `Retry-After` (delay-seconds or an HTTP date) → milliseconds, for
// the governor's bounded backoff.
function retryAfterMsFrom(upstreamRes) {
  const raw = upstreamRes?.headers?.["retry-after"];
  if (raw == null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(String(raw));
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

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

// Companion traffic (Requirement 5): the same 300 s model-config poll the
// desktop app runs. Catalog changes land through the shared remote-catalog
// slot, so a renamed model reaches /v1/models without a restart; the Claude
// alias routing is re-derived here because it is a pure function of the
// catalog. HEARTBEAT_INTERVAL_MS=0 disables the poll.
startConfigHeartbeat(config, log, {
  getToken,
  onCatalog: (models) => {
    try {
      tierTargets = resolveTierTargets(annotateCreditTiers(getModelCatalog(config).models, models));
      log.info(`Credit-tier routing refreshed: opus→${tierTargets.opus} sonnet→${tierTargets.sonnet} haiku→${tierTargets.haiku} default→${tierTargets.default}`);
    } catch (err) {
      log.warn(`Credit-tier refresh failed (${err.message}) — keeping the previous routing`);
    }
  },
});

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
// The converter and the SSE state machine live in lib/anthropic-sse.js so they
// are unit-testable offline (tests/pen-test-p12.mjs) without starting a server.
import {
  anthropicToOpenAI, anthropicStopReason, openAIChunksToAnthropic,
  openAIChunkToAnthropicEvents, fmt,
} from "./lib/anthropic-sse.js";

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

  let cloudEvidence = null;
  let releaseLock = null;
  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      if (typeof releaseLock === "function") {
        releaseLock();
        releaseLock = null;
      }
    }
  };

  try {
    const cachedFailure = permanentFailures.get(modelId);
    if (cachedFailure) {
      log.info(`chat model=${modelId} short-circuited: ${cachedFailure.code} (recently confirmed)`);
      record(cachedFailure.status, { error: cachedFailure.code });
      return sendClassifiedErrorAnthropic(res, cachedFailure);
    }

    // Governor gate — after the cache short-circuit (no upstream call, so no
    // budget spent) and before the cloud call (a refusal must not open a socket).
    await governor.waitForGap();
    const verdict = governor.tryAcquire(null, { diagnostic: config.DIAGNOSTIC_MODE });
    if (!verdict.ok) {
      const cls = classifyGovernorError(verdict);
      log.warn(`Governor refused model=${modelId}: ${cls.code} (${verdict.state}) — ${cls.message}`);
      record(cls.status, { lastMessage: lastMsgForLog(), messageCount: openAIBody.messages?.length || 0, error: cls.code });
      return sendClassifiedErrorAnthropic(res, cls);
    }

    // Upstream limits accounts to 1 concurrent active generation; serialize in-flight requests
    releaseLock = await globalInFlightQueue.acquire();

    // Cloud call with one retry on the flaky 400 "invalid request" hiccup;
    // every >=400 body is buffered + logged (R1). Shared with openai.js.
    const { res: upstreamRes, errBody: upstreamErrBody } = await callUpstreamWithInvalidRequestRetry(
      () => callUpstreamAnthropic(config, getClientHeaders(config), getToken, openAIBody, modelId, null, log),
      modelId, permanentFailures, log,
    );

    const statusCode = upstreamRes.statusCode;

    // Feed the verdict back to the governor (throttle → backoff, ban →
    // quarantine, success → clear) so a capacity throttle is never answered by
    // retrying into it.
    governor.recordUpstreamSignal(null, statusCode, upstreamErrBody || "", {
      retryAfterMs: retryAfterMsFrom(upstreamRes),
    });

    // Rotate token caches BEFORE deciding fallback so the very next request
    // picks up the fresh JWT regardless of who serves this one.
    if (statusCode === 401) invalidateAuth();

    // Failure path only — a 2xx falls through to the success renderer below.
    if (statusCode >= 400) {
      releaseOnce();
      // Classify the verdict the client will see. The classified status is
      // what goes on the wire: a raw 403 meaning "free-tier capacity throttle"
      // (810002) becomes 429 upstream_busy, so a harness backs off instead of
      // retrying into a wall.
      const cls = classifyUpstreamError(statusCode, upstreamErrBody, modelId);
      if (cls.permanent) permanentFailures.mark(modelId, cls);
      log.error(`Upstream error ${statusCode}:`, cls.message, upstreamErrBody ? `Body: ${upstreamErrBody.slice(0, 500)}` : "(empty body)");
      cloudEvidence = { status: statusCode, code: cls.code };

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

    res.on("close", () => {
      if (!res.writableFinished && upstreamRes && !upstreamRes.destroyed) {
        try { upstreamRes.destroy(); } catch (_) {}
      }
      releaseOnce();
    });

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
        releaseOnce();
      });

      upstreamRes.on("error", (err) => {
        log.error("Stream error:", err);
        try { res.end(); } catch (_) {}
        releaseOnce();
      });
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
      } finally {
        releaseOnce();
      }
    });
    upstreamRes.on("error", (err) => {
      log.error("Non-stream upstream error:", err);
      if (!res.headersSent) {
        sendErrorAnthropic(res, `Upstream stream failed: ${err.message}`, "api_error", 502, "upstream_failed");
      } else {
        try { res.end(); } catch (_) {}
      }
      releaseOnce();
    });
  } catch (err) {
    releaseOnce();
    const cls = classifyTransportError(err);
    log.error(`messages model=${body.model} transport failure:`, cls.message);
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
      `Governor : ${config.BUDGET_REQUESTS_PER_HOUR === 0
        ? "off — upstream requests are unmetered"
        : `${config.BUDGET_REQUESTS_PER_HOUR} req/h per account (warn at 80%)`}`,
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
