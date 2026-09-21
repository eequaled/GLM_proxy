// Pen-test p8 — transport parity (Requirement 2).
//
// Everything here runs against the local TLS mock (tests/fixtures/mock-upstream.mjs),
// never the live cloud: wire-format behaviour must be provable deterministically
// and without spending a single credit. The audit's live capture showed the
// proxy sending no User-Agent, no Accept, no cookie handling, over HTTP/1.1 —
// this suite is what stops that from regressing, and what proves the h2 path
// (gated off by default) actually negotiates and reuses a session.
//
// Isolation: each case gets a throwaway HOME with its own auto-claw artifacts,
// so the identity overlay, the token and the cookie jar are all local to the
// case and the real machine's app state is never read or written.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PEN_TEST_PORTS } from "../lib/constants.js";
import { check, post, proxyOutput, startProxy, startTlsMock, stopProxy, summary } from "./_helpers.mjs";

const PORT = PEN_TEST_PORTS.p8;
const VERSION = "1.17.8";

// A throwaway HOME carrying exactly the two artifacts the request path needs:
// a token (or the cloud branch 503s before it ever reaches the mock) and a
// runtime file whose per-model headers carry the live client version.
function makeHome({ version = VERSION, token = "Bearer p8-fake-token" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glmp-p8-"));
  const appDir = path.join(dir, ".openclaw-autoclaw");
  fs.mkdirSync(appDir, { recursive: true });

  fs.writeFileSync(path.join(appDir, "request-headers.json"), JSON.stringify({
    headers: { "X-Authorization": token },
  }), "utf8");

  const model = {
    id: "zai_glm-5.3-flash",
    name: "GLM-5.3-Flash",
    contextWindow: 1_048_576,
    maxTokens: 307_200,
    headers: {
      "X-Tm": "win",
      "X-Version": version,
      "X-Product": "autoclaw",
      "X-Channel": "AutoClaw4",
      "X-Lang": "en",
      "X-Client-Type": "pc",
    },
  };
  fs.writeFileSync(path.join(appDir, "openclaw.runtime.json"), JSON.stringify({
    models: { providers: { zai: { models: [model] } } },
  }), "utf8");

  return dir;
}

// Spawn a proxy whose cloud branch points at the TLS mock.
async function startAgainstMock(port, mockPort, home, env = {}) {
  return startProxy(port, {
    HOME: home, USERPROFILE: home,
    UPSTREAM_HOST: "127.0.0.1",
    UPSTREAM_PORT: String(mockPort),
    LOG_LEVEL: "debug",
    ...env,
  });
}

const chat = (port, body = {}) => post(port, {
  body: { model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }], ...body },
  timeoutMs: 30000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. headers on the wire: UA + Accept + identity overlay, no encoding ----

const mockA = await startTlsMock({ cookie: "acw_tc=p8-token-1; Path=/; Max-Age=1800" });
const homeA = makeHome();
const proxyA = await startAgainstMock(PORT, mockA.port, homeA);

const first = await chat(PORT);
check("h1: request through the mock succeeds", first.status === 200, `${first.status} ${String(first.body).slice(0, 120)}`);

const h1Headers = mockA.mock.getLastRequest()?.headers || {};
check("h1: sends the User-Agent the real client sends (undici stack default, not an invented token)",
  h1Headers["user-agent"] === "node", h1Headers["user-agent"]);
check("h1: sends the Accept the app sets (`*/*`)", h1Headers["accept"] === "*/*", h1Headers["accept"]);
check("h1: identity overlay reaches the wire (X-Version from the app runtime file)",
  h1Headers["x-version"] === VERSION, h1Headers["x-version"]);
// The upstream's system-prompt allowlist accepts this declaration on its own
// (probe-verified 2026-09-21), which is what keeps the pinned banner from being
// a single point of failure. If it ever stops being sent, the watermark is
// load-bearing again — that is a regression worth failing on.
check("h1: declares the harness the app declares, so the prompt gate opens on its own",
  h1Headers["x-harness-type"] === "zcode" && h1Headers["x_trace_id"] === "autoclaw-desktop",
  `${h1Headers["x-harness-type"]} / ${h1Headers["x_trace_id"]}`);
check("h1: never advertises an encoding it cannot decode",
  !h1Headers["accept-encoding"] || h1Headers["accept-encoding"] === "identity",
  h1Headers["accept-encoding"]);
check("h1: first touch carries no cookie (no jar yet)", !h1Headers["cookie"], h1Headers["cookie"]);

// ---- 2. WAF cookie: stored from Set-Cookie and echoed afterwards ------------

await sleep(150);
const second = await chat(PORT);
check("h1: second request still succeeds", second.status === 200, second.status);
check("h1: echoes the upstream's acw_tc cookie on the next request",
  /acw_tc=p8-token-1/.test(mockA.mock.getLastRequest()?.headers?.cookie || ""),
  mockA.mock.getLastRequest()?.headers?.cookie);

await stopProxy(proxyA);
await mockA.mock.close();
fs.rmSync(homeA, { recursive: true, force: true });

// ---- 3. an expired cookie is dropped, not replayed -------------------------

const mockB = await startTlsMock({ cookie: "acw_tc=p8-token-1; Path=/; Max-Age=-1" });
const homeB = makeHome();
const proxyB = await startAgainstMock(PORT, mockB.port, homeB);

await chat(PORT);
await sleep(150);
await chat(PORT);
check("h1: an expired cookie is not replayed (first-touch state is legal)",
  !mockB.mock.getLastRequest()?.headers?.cookie, mockB.mock.getLastRequest()?.headers?.cookie);

await stopProxy(proxyB);
await mockB.mock.close();
fs.rmSync(homeB, { recursive: true, force: true });

// ---- 4. h2 is gated off by default (today's behaviour is the default) ------

const mockC = await startTlsMock({});
const homeC = makeHome();
const proxyC = await startAgainstMock(PORT, mockC.port, homeC);

await chat(PORT);
check("default: h2 stays behind its gate — the request goes out as HTTP/1.1",
  mockC.mock.getLastRequest()?.httpVersion === "1.1", mockC.mock.getLastRequest()?.httpVersion);

await stopProxy(proxyC);
await mockC.mock.close();
fs.rmSync(homeC, { recursive: true, force: true });

// ---- 5. h2 when enabled: negotiated, reused, header-hygienic --------------

const mockD = await startTlsMock({});
const homeD = makeHome();
const proxyD = await startAgainstMock(PORT, mockD.port, homeD, { GLMP_TRANSPORT_H2: "1" });

const h2a = await chat(PORT);
const h2b = await chat(PORT);
check("h2: request succeeds over the h2 session", h2a.status === 200, `${h2a.status} ${String(h2a.body).slice(0, 120)}`);
check("h2: arrives as HTTP/2", mockD.mock.getLastRequest()?.httpVersion === "2.0", mockD.mock.getLastRequest()?.httpVersion);
check("h2: the session is reused across requests (one TCP+TLS connection)",
  mockD.mock.getConnectionCount() === 1, String(mockD.mock.getConnectionCount()));

const h2Headers = mockD.mock.getLastRequest()?.headers || {};
check("h2: every header name is lowercase (RFC 7540 §8.1.2)",
  Object.keys(h2Headers).every((k) => k === k.toLowerCase()), Object.keys(h2Headers).join(","));
check("h2: hop-by-hop headers are never sent (RFC 7540 §8.1.2.2)",
  !("connection" in h2Headers) && !("keep-alive" in h2Headers) && !("host" in h2Headers),
  ["connection", "keep-alive", "host"].filter((k) => k in h2Headers).join(","));
check("h2: identity headers still ride along", h2Headers["x-version"] === VERSION, h2Headers["x-version"]);
check("h2: no Accept-Encoding advertised either", !h2Headers["accept-encoding"], h2Headers["accept-encoding"]);
check("h2: the client-visible response is unchanged", h2b.status === 200, h2b.status);

await stopProxy(proxyD);
await mockD.mock.close();
fs.rmSync(homeD, { recursive: true, force: true });

// ---- 6. h1-only upstream: transparent fallback, bounded, logged once -------

const mockE = await startTlsMock({ alpn: "h1-only" });
const homeE = makeHome();
const proxyE = await startAgainstMock(PORT, mockE.port, homeE, { GLMP_TRANSPORT_H2: "1" });

const startedAt = Date.now();
const fallback = await chat(PORT);
const fallbackMs = Date.now() - startedAt;
check("h1-only upstream: the request still completes via HTTP/1.1", fallback.status === 200, `${fallback.status} ${String(fallback.body).slice(0, 120)}`);
check("h1-only upstream: it arrives over HTTP/1.1", mockE.mock.getLastRequest()?.httpVersion === "1.1", mockE.mock.getLastRequest()?.httpVersion);
check("h1-only upstream: the fallback is bounded, not a full request-timeout wait (<15s)",
  fallbackMs < 15_000, `${fallbackMs}ms`);

const fallbackLog = proxyOutput(proxyE).all || "";
const dimEvents = (fallbackLog.match(/http\/2 session unavailable/g) || []).length;
check("h1-only upstream: exactly one dim transport event is logged", dimEvents === 1, `count=${dimEvents}`);

await stopProxy(proxyE);
await mockE.mock.close();
fs.rmSync(homeE, { recursive: true, force: true });

summary();
