// Pen-test p9 — upstream verdicts and degradation (Requirements 6, 7.3).
//
// Every case runs against the local TLS mock, so the verdict→client-visible
// behaviour is deterministic and costs no credits. The point of this suite is
// the pairing: what the client sees, AND what the proxy does *not* do next.
//
// The negative assertions are the important ones. A live session measured on
// 2026-09-21 showed what happens without them: each free-tier throttle (403 +
// 810002 "high demand") fell into the local AutoClaw WS agent, which re-issues
// the same cloud call and failed identically — 13 of 15 attempts burned the full
// 120 s budget while the harness had already timed out and retried. Bans and
// throttles must both be terminal for the fallback decision, for different
// reasons (permanent vs. shared-account capacity).
//
// Task 8 extends this file into the full fault-injection matrix (corrupt state
// files, unreadable runtime file, unconnectable session, 500-ing config endpoint).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PEN_TEST_PORTS } from "../lib/constants.js";
import { check, post, proxyOutput, startProxy, startTlsMock, stopProxy, summary } from "./_helpers.mjs";

const PORT = PEN_TEST_PORTS.p9;

// Same isolation contract as p6/p8: a throwaway HOME holding just the two app
// artifacts the request path needs, so the real machine's state is never read.
function makeHome({ gateway = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glmp-p9-"));
  const appDir = path.join(dir, ".openclaw-autoclaw");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "request-headers.json"), JSON.stringify({
    headers: { "X-Authorization": "Bearer p9-fake-token" },
  }), "utf8");
  // A gateway token makes the desktop-agent fallback *look available*, which is
  // what the operator's machine looks like and what the mock otherwise hides:
  // with no token, tryLocalAgent() returns false before it logs anything, so a
  // fallback that should never have run stays invisible to the assertion.
  if (gateway) fs.writeFileSync(path.join(appDir, ".gateway-token"), "p9-fake-gateway-token", "utf8");
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

async function againstMock(scenario, home) {
  const { mock, port } = await startTlsMock(scenario);
  const proxy = await startProxy(PORT, {
    HOME: home, USERPROFILE: home,
    UPSTREAM_HOST: "127.0.0.1", UPSTREAM_PORT: String(port),
    LOG_LEVEL: "info",
  });
  return { mock, proxy };
}

const ask = () => post(PORT, {
  body: { model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
  timeoutMs: 20000,
});

// ---- 1. free-tier throttle: 429 to the client, and no doomed local run ------

{
  const home = makeHome();
  const { mock, proxy } = await againstMock({ payview: true }, home);

  const res = await ask();
  check("throttle: the client sees a 429, not the upstream's raw 403", res.status === 429, res.status);

  let code = null;
  try { code = JSON.parse(res.body)?.error?.code; } catch { /* body shape asserted below */ }
  check("throttle: classified as upstream_busy so harnesses back off", code === "upstream_busy", code);

  const out = proxyOutput(proxy).all || "";
  check("throttle: the local agent is never invoked",
    !/via local AutoClaw WebSocket agent/.test(out),
    out.split("\n").filter((l) => /local AutoClaw WebSocket agent/.test(l)).join(" | "));
  check("throttle: no 120 s local timeout is waited out",
    !/Local gateway execution timeout/.test(out));

  const upstreamHits = mock.getRequests().length;
  check("throttle: the request reached the upstream exactly once (no retry storm)",
    upstreamHits === 1, String(upstreamHits));

  await stopProxy(proxy);
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- 2. account ban: the classified verdict, and no local run either -------

{
  const home = makeHome();
  const { mock, proxy } = await againstMock({ ban: true }, home);

  const res = await ask();
  check("ban: the client sees the permanent 403 classification", res.status === 403, res.status);

  let err = null;
  try { err = JSON.parse(res.body)?.error; } catch { /* asserted via status */ }
  check("ban: code is account_banned", err?.code === "account_banned", err?.code);
  check("ban: the message is translated, not the raw Chinese payload",
    typeof err?.message === "string" && !/账号/.test(err.message), err?.message);

  const out = proxyOutput(proxy).all || "";
  check("ban: the local agent is never invoked — the same account feeds it",
    !/via local AutoClaw WebSocket agent/.test(out));

  await stopProxy(proxy);
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- 3. the verdict is repeated instantly, not re-litigated ----------------

{
  const home = makeHome();
  const { mock, proxy } = await againstMock({ payview: true }, home);

  await ask();
  const before = mock.getRequests().length;
  const startedAt = Date.now();
  const second = await ask();
  const elapsed = Date.now() - startedAt;

  check("repeat: a second throttled request answers 429 as well", second.status === 429, second.status);
  check("repeat: it does not sit through a 403 attempt plus a local-agent wait",
    elapsed < 10_000, `${elapsed}ms`);
  check("repeat: the upstream is not hammered on the retry", mock.getRequests().length - before <= 1,
    String(mock.getRequests().length - before));

  await stopProxy(proxy);
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- 4. a throttle is terminal for the fallback even with a gateway present --
//
// The fallback gate used to be decided on the RAW upstream status, so a 403 that
// means "free-tier capacity throttle" (810002 pay-view) classified to 429 for the
// client but still marched into the desktop agent — which re-issues the same
// cloud call against the same account and fails identically. Measured live
// 2026-09-22: ~4 s wasted per occurrence, ~26 minutes across one operator
// session. The mock alone cannot catch it, because with no running AutoClaw the
// fallback short-circuits before logging anything; a gateway token makes the
// agent available, which is exactly the operator's situation.
{
  const home = makeHome({ gateway: true });
  const { mock, proxy } = await againstMock({ payview: true }, home);

  const res = await ask();
  check("throttle+gateway: the client still gets a 429 upstream_busy", res.status === 429, res.status);

  let code = null;
  try { code = JSON.parse(res.body)?.error?.code; } catch { /* asserted via status */ }
  check("throttle+gateway: classified upstream_busy, not a local-gateway failure",
    code === "upstream_busy", code);

  const out = proxyOutput(proxy).all || "";
  check("throttle+gateway: the local agent is never even attempted",
    !/via local AutoClaw WebSocket agent/.test(out),
    out.split("\n").filter((l) => /local AutoClaw WebSocket agent/.test(l)).join(" | "));

  check("throttle+gateway: the upstream is still hit exactly once",
    mock.getRequests().length === 1, String(mock.getRequests().length));

  await stopProxy(proxy);
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
}

summary();
