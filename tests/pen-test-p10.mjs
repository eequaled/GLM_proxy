// Pen-test p10 — compressed upstream bodies (Requirement 2.8, the A2 decision).
//
// Why this suite exists at all, given the upstream does not compress today
// -----------------------------------------------------------------------
// A live probe (`.dbg/accept-encoding-probe-results.json`, 2026-09-21) showed
// cloud completions come back uncompressed whether or not `br, gzip, deflate` is
// advertised. So nothing here fires against the current upstream, and this is
// not a performance suite.
//
// It exists because the *old* state was not safe either. A request with no
// `Accept-Encoding` does not forbid compression — RFC 7231 §5.3.4 says absence
// implies any content-coding is acceptable — so a compressed response was
// already a case the proxy could receive and could not handle. Two things broke
// when it did, and both are asserted below:
//
//   1. Error classification. The body feeds `classifyUpstreamError`, the
//      governor's ban/throttle detection and `logUpstreamErrorBody`. Compressed
//      bytes there parse to nothing, so a real `410004` ban silently degraded
//      into a generic `403`: the governor stopped quarantining a banned account
//      and stopped backing off on a throttle. That is a safety-logic failure,
//      and it is the same class of misclassification issue #5 was about.
//   2. The streaming path piped the body straight to the client, so compressed
//      bytes arrived as mojibake tagged `text/event-stream`.
//
// The invariants worth locking in: the advert mirrors the measured client, every
// advertised coding is genuinely decodable, an unsupported coding fails loudly
// instead of being served as text, and a mid-body failure terminates the client
// stream rather than hanging it.
//
// Everything runs against the local TLS mock — no live upstream, no credits.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PEN_TEST_PORTS } from "../lib/constants.js";
import { check, post, proxyOutput, startProxy, startTlsMock, stopProxy, summary } from "./_helpers.mjs";

const PORT = PEN_TEST_PORTS.p10;

// Same isolation contract as p6/p8/p9: a throwaway HOME carrying only the two
// app artifacts the request path needs. OPENCLAW_STATE_DIR is pinned explicitly
// because it *outranks* homedir in the app's own resolution rule — without it a
// machine that sets the variable would let every case read (and write) the real
// state dir.
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glmp-p10-"));
  const appDir = path.join(dir, ".openclaw-autoclaw");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "request-headers.json"), JSON.stringify({
    headers: { "X-Authorization": "Bearer p10-fake-token" },
  }), "utf8");
  fs.writeFileSync(path.join(appDir, "openclaw.runtime.json"), JSON.stringify({
    models: {
      providers: {
        zai: {
          models: [{
            id: "zai_glm-5.3-flash",
            name: "GLM-5.3-Flash",
            contextWindow: 1_048_576,
            maxTokens: 307_200,
            headers: { "X-Tm": "win", "X-Version": "1.17.8", "X-Client-Type": "pc" },
          }],
        },
      },
    },
  }), "utf8");
  return dir;
}

async function againstMock(scenario, home, env = {}) {
  const { mock, port } = await startTlsMock(scenario);
  const proxy = await startProxy(PORT, {
    HOME: home, USERPROFILE: home,
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw-autoclaw"),
    UPSTREAM_HOST: "127.0.0.1", UPSTREAM_PORT: String(port),
    LOG_LEVEL: "info",
    ...env,
  });
  return { mock, proxy };
}

const ask = (extra = {}, timeoutMs = 20000) => post(PORT, {
  body: { model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }], ...extra },
  timeoutMs,
});

// A decoded SSE body must be readable text: the frames are there and no
// replacement characters leaked in from decoding compressed bytes as UTF-8.
function looksDecoded(body) {
  const text = String(body || "");
  return text.includes("data: ") && text.includes("from mock") && text.includes("data: [DONE]")
    && !text.includes("\uFFFD");
}

async function withCase(scenario, env, fn) {
  const home = makeHome();
  const { mock, proxy } = await againstMock(scenario, home, env);
  // Read whatever the proxy has printed — the decode path announces itself
  // there, which is how these cases prove it was actually taken.
  const log = () => proxyOutput(proxy).all || "";
  try {
    await fn({ mock, proxy, log });
  } finally {
    await stopProxy(proxy);
    await mock.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---- 1. the advert on the wire (A2, request half) --------------------------

await withCase({}, {}, async ({ mock }) => {
  await ask();
  const headers = mock.getLastRequest()?.headers || {};
  check("advert: the request carries the coding set the real client sends",
    headers["accept-encoding"] === "br, gzip, deflate", headers["accept-encoding"]);
});

await withCase({}, { GLMP_ACCEPT_ENCODING: "" }, async ({ mock }) => {
  const res = await ask();
  const headers = mock.getLastRequest()?.headers || {};
  check("advert: GLMP_ACCEPT_ENCODING= omits the header entirely (the pre-A2 behavior)",
    headers["accept-encoding"] === undefined, headers["accept-encoding"]);
  check("advert: and the request still works without it", res.status === 200, res.status);
});

// ---- 2. every advertised coding actually decodes (stream mode) -------------

for (const coding of ["gzip", "br", "deflate", "deflate-raw"]) {
  await withCase({ encode: coding }, {}, async ({ log }) => {
    const res = await ask();
    check(`decode ${coding}: the proxy took the decode path (it logged doing so)`,
      /upstream: decoding .* response body/.test(log()),
      log().split("\n").filter((l) => /decoding/.test(l)).join(" | "));
    check(`decode ${coding}: the client receives plain SSE text, not mojibake`,
      res.status === 200 && looksDecoded(res.body), `${res.status} ${String(res.body).slice(0, 140)}`);
    check(`decode ${coding}: the downstream response does not claim to be encoded`,
      res.headers?.["content-encoding"] === undefined, res.headers?.["content-encoding"]);
  });
}

// Raw deflate is the case that bites in the wild: no zlib wrapper, so
// `createInflate()` alone rejects it with Z_DATA_ERROR. The sniffer in
// lib/decode.js has to have picked the raw inflater for the two cases above to
// have passed at all — this one pins the wire shape that produces it.
await withCase({ encode: "deflate-raw" }, {}, async ({ mock }) => {
  await ask();
  const wire = mock.getLastRequest()?.headers?.["accept-encoding"];
  check("decode deflate-raw: it is advertised as plain `deflate`, as any server would send it",
    wire === "br, gzip, deflate", wire);
});

// ---- 3. the same coding on the buffered (non-stream) path ------------------

await withCase({ encode: "gzip" }, {}, async () => {
  const res = await ask({ stream: false });
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* asserted below */ }
  check("decode gzip (non-stream): the buffered body assembles into a completion",
    res.status === 200 && parsed?.choices?.[0]?.message?.content === "Hello from mock",
    `${res.status} ${String(res.body).slice(0, 160)}`);
});

// ---- 4. compressed ERROR bodies keep their verdict (the safety half) -------

await withCase({ ban: true, encode: "gzip" }, {}, async () => {
  const res = await ask();
  let code = null;
  try { code = JSON.parse(res.body)?.error?.code; } catch { /* asserted via status */ }
  check("compressed ban: still classified as the permanent account_banned",
    res.status === 403 && code === "account_banned", `${res.status} ${code}`);
  check("compressed ban: the body really was decoded (the Chinese payload translated)",
    !/账号/.test(String(res.body)) && /banned/i.test(String(res.body)), String(res.body).slice(0, 160));
});

await withCase({ payview: true, encode: "gzip" }, {}, async () => {
  const res = await ask();
  let code = null;
  try { code = JSON.parse(res.body)?.error?.code; } catch { /* asserted via status */ }
  check("compressed pay-view: still the 429 throttle, not a generic 403",
    res.status === 429 && code === "upstream_busy", `${res.status} ${code}`);
});

// ---- 5. an undecodable coding fails loudly, never as text ------------------

await withCase({ encode: "zstd" }, {}, async () => {
  const res = await ask();
  let code = null;
  try { code = JSON.parse(res.body)?.error?.code; } catch { /* asserted below */ }
  check("unknown coding: a named failure rather than bytes served as text/event-stream",
    code === "upstream_encoding_unsupported", `${res.status} ${code}`);
  check("unknown coding: no fake SSE reaches the client",
    !String(res.body).includes("data: [DONE]"), String(res.body).slice(0, 140));
});

// ---- 6. a body that dies mid-stream terminates instead of hanging ----------
// `pipe()` forwards data and end but NEVER errors, so without an explicit error
// relay a reset mid-body leaves the decoder — and the client — waiting for an
// end that never arrives. The client's own 15 s timeout is the tell.

await withCase({ encode: "gzip", truncateEncoded: true }, {}, async ({ mock, log }) => {
  const startedAt = Date.now();
  const res = await ask({}, 15000);
  const elapsed = Date.now() - startedAt;

  check("truncated: the client is not left hanging for its own timeout",
    res.status !== 0 && elapsed < 15000, `${res.status} after ${elapsed}ms`);
  check("truncated: the proxy reports the failure instead of truncating silently",
    /stream failed|aborted|ECONNRESET|decode/i.test(log()), res.status);

  // The failure must not have taken the process with it.
  mock.setScenario({ truncateEncoded: false });
  const after = await ask();
  check("truncated: the proxy still serves the next request (no unhandled error killed it)",
    after.status === 200 && looksDecoded(after.body), `${after.status} ${String(after.body).slice(0, 140)}`);
});

// ---- 7. the uncompressed path is untouched ---------------------------------

await withCase({}, {}, async ({ log }) => {
  const res = await ask();
  check("plain: an uncompressed response is passed through as before",
    res.status === 200 && looksDecoded(res.body), res.status);
  check("plain: and nothing claims an encoding it never had",
    res.headers?.["content-encoding"] === undefined, res.headers?.["content-encoding"]);
  check("plain: the decode path stays dark — no decode line, so the hot path is unchanged",
    !/upstream: decoding/.test(log()));
});

summary();
