import fs from "node:fs";
import http2 from "node:http2";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY = path.join(DIR, "certs", "key.pem");
const DEFAULT_CERT = path.join(DIR, "certs", "cert.pem");

// The SSE body a plain 200 streams, as one string. The compressed path needs the
// whole payload before it can encode it, so the same text has to exist as a
// value rather than only as a sequence of res.write() calls.
function sseText(scenario) {
  const id = "chatcmpl-mock-123";
  const model = "zai_glm-5.3-flash";
  return [
    `data: ${JSON.stringify({ id, model, choices: [{ delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
    `data: ${JSON.stringify({ id, model, choices: [{ delta: { content: " from mock" } }] })}\n\n`,
    `data: ${JSON.stringify({ id, model, choices: [{ delta: {}, finish_reason: "stop" }], usage: scenario.usage || { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

/**
 * Encode a body the way a real intermediary would.
 *
 * `deflate-raw` models the servers that send RFC 1951 deflate with no RFC 1950
 * zlib wrapper — the ambiguity lib/decode.js sniffs for, and the case a naive
 * decoder fails mid-stream on. An unknown token is deliberately passed through
 * verbatim so a scenario can prove the proxy fails loudly instead of serving
 * the bytes to the client as if they were text.
 */
export function compressBody(text, encoding) {
  const buf = Buffer.from(text, "utf8");
  switch (encoding) {
    case "gzip": return zlib.gzipSync(buf);
    case "br": return zlib.brotliCompressSync(buf);
    case "deflate": return zlib.deflateSync(buf);
    case "deflate-raw": return zlib.deflateRawSync(buf);
    default: return buf;
  }
}

// `deflate-raw` is still advertised as plain `deflate`: no server says "raw".
function encodingHeader(encoding) {
  return encoding === "deflate-raw" ? "deflate" : encoding;
}

export function createMockUpstream(initialScenario = {}) {
  let scenario = { ...initialScenario };
  const requests = [];
  let connectionCount = 0;

  const key = fs.readFileSync(scenario.keyPath || DEFAULT_KEY);
  const cert = fs.readFileSync(scenario.certPath || DEFAULT_CERT);

  const serverOptions = {
    key,
    cert,
    allowHTTP1: true,
  };

  // `alpn: "h1-only"` must model a genuinely HTTP/1.1-only edge. Node's http2
  // secure server computes its own ALPN list from `allowHTTP1`, so an
  // `ALPNProtocols: ["http/1.1"]` override does NOT stop it negotiating h2 —
  // which would make an "h1-only" scenario silently test nothing. A plain https
  // server is the honest simulation, and it exercises the transport's real
  // fallback path instead of a case that never occurs.
  const h1Only = scenario.alpn === "h1-only";
  if (!h1Only) {
    serverOptions.ALPNProtocols = ["h2", "http/1.1"];
  }

  const server = h1Only
    ? https.createServer({ key, cert })
    : http2.createSecureServer(serverOptions);

  server.on("secureConnection", () => {
    connectionCount++;
  });

  server.on("request", async (req, res) => {
    let rawBody = "";
    req.on("data", (chunk) => {
      rawBody += chunk;
    });

    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: rawBody,
        httpVersion: req.httpVersion,
        time: Date.now(),
      };
      requests.push(record);

      // Handle scenario override or default routing
      const url = req.url || "/";

      // Every mocked response funnels through here, so a scenario can ask for
      // its body to be compressed without any other case changing shape.
      const sendBody = (status, headers, bodyText) => {
        if (!scenario.encode) {
          res.writeHead(status, headers);
          res.end(bodyText);
          return;
        }
        const encoded = compressBody(bodyText, scenario.encode);
        res.writeHead(status, {
          ...headers,
          "content-encoding": encodingHeader(scenario.encode),
          vary: "accept-encoding",
        });
        if (scenario.truncateEncoded) {
          // Half a member, then the socket dies — the case that hangs a
          // consumer with no error listener on the decode chain.
          res.write(encoded.subarray(0, Math.max(1, Math.floor(encoded.length / 2))));
          setTimeout(() => { try { res.socket.destroy(); } catch (_) { /* already gone */ } }, 20);
          return;
        }
        res.end(encoded);
      };

      // Remote model config endpoint
      if (url.includes("/autoclaw-model-config")) {
        res.writeHead(scenario.modelConfigStatus || 200, {
          "content-type": "application/json",
          ...(scenario.cookie ? { "set-cookie": scenario.cookie } : {}),
        });
        const models = scenario.models || [
          { id: "zai_glm-5.3-flash", name: "GLM-5.3-Flash", model_tier: "Low", max_output: 131072 },
          { id: "zai_glm-5.3", name: "GLM-5.3", model_tier: "High", max_output: 131072 },
        ];
        res.end(JSON.stringify({ models, client_version: scenario.advertisedVersion || "1.17.8" }));
        return;
      }

      // Free-tier capacity throttle: 403 + 810002 with "kind":"pay-view". The
      // account is fine; the free tier is busy. Measured live 2026-09-21.
      if (scenario.payview) {
        sendBody(403, { "content-type": "application/json" }, JSON.stringify({
          action: { kind: "pay-view" },
          code: 810002,
          image_url: "https://example.invalid/high-demand.png",
          message: "We're experiencing high demand right now. Please try again shortly, or upgrade to a monthly subscription for priority access.",
        }));
        return;
      }

      // Ban scenario
      if (scenario.ban || scenario.status === 403) {
        sendBody(403, {
          "content-type": "application/json",
          ...(scenario.cookie ? { "set-cookie": scenario.cookie } : {}),
        }, JSON.stringify({ code: 410004, message: "账号已被封禁" }));
        return;
      }

      // Throttling 429 scenario
      if (scenario.throttle || scenario.status === 429) {
        sendBody(429, {
          "content-type": "application/json",
          "retry-after": String(scenario.retryAfter || "2"),
          ...(scenario.cookie ? { "set-cookie": scenario.cookie } : {}),
        }, JSON.stringify({ code: 429001, message: "Rate limit exceeded" }));
        return;
      }

      // Custom status / response
      const status = scenario.status || 200;
      const headers = {
        "content-type": scenario.sse !== false ? "text/event-stream" : "application/json",
        ...(scenario.cookie ? { "set-cookie": scenario.cookie } : {}),
        ...(scenario.headers || {}),
      };

      if (scenario.sse !== false && status === 200 && !scenario.encode) {
        // Stream standard completion SSE chunks, incrementally, exactly as the
        // real upstream does (uncompressed = the ordinary path).
        res.writeHead(status, headers);
        for (const piece of sseText(scenario).split("\n\n").slice(0, -1)) res.write(`${piece}\n\n`);
        res.end();
      } else {
        const bodyContent = scenario.sse !== false && status === 200
          ? sseText(scenario)
          : (typeof scenario.body === "object" ? JSON.stringify(scenario.body) : (scenario.body || "OK"));
        sendBody(status, headers, bodyContent);
      }
    });
  });

  return {
    server,
    start: () => new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        resolve(port);
      });
      server.on("error", reject);
    }),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
    }),
    getRequests: () => [...requests],
    getLastRequest: () => requests[requests.length - 1] || null,
    getConnectionCount: () => connectionCount,
    setScenario: (newScenario) => {
      scenario = { ...scenario, ...newScenario };
    },
    clearRequests: () => {
      requests.length = 0;
    },
  };
}
