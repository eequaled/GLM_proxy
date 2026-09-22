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
import { DEFAULT_THROTTLE_RETRIES } from "../lib/core.js";
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

async function againstMock(scenario, home, extraEnv = {}) {
  const { mock, port } = await startTlsMock(scenario);
  const proxy = await startProxy(PORT, {
    HOME: home, USERPROFILE: home,
    UPSTREAM_HOST: "127.0.0.1", UPSTREAM_PORT: String(port),
    LOG_LEVEL: "info",
    ...extraEnv,
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

  // A capacity throttle is retried in-process before the client ever hears
  // about it, because the upstream's own body says "try again shortly" — that is
  // what stops a 30-second-patience harness from dying on a transient wall. So
  // the count is 1 + DEFAULT_THROTTLE_RETRIES: bounded and pinned, never a storm,
  // and the client still ends up with the classified 429 once they are spent.
  const upstreamHits = mock.getRequests().length;
  check("throttle: the throttle is retried, but the retries are bounded",
    upstreamHits === DEFAULT_THROTTLE_RETRIES + 1, String(upstreamHits));

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

  // The negative half of the retry policy, and the more important half: a ban is
  // deterministic, so another attempt only spends time and digs the hole deeper.
  check("ban: a ban is never retried (one attempt, then the verdict)",
    mock.getRequests().length === 1, String(mock.getRequests().length));

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
  // Bounded by the retry budget (≈8–12 s for two waits), not by the 120 s
  // desktop-agent budget this path used to sit through, and comfortably inside a
  // harness's own ~30 s patience.
  check("repeat: it answers inside the retry budget, not a 120 s agent wait",
    elapsed < 30_000, `${elapsed}ms`);
  check("repeat: the retries stay bounded on the second request too",
    mock.getRequests().length - before <= DEFAULT_THROTTLE_RETRIES + 1,
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

  check("throttle+gateway: the upstream is hit once per bounded attempt, no storm",
    mock.getRequests().length === DEFAULT_THROTTLE_RETRIES + 1, String(mock.getRequests().length));

  await stopProxy(proxy);
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- 5. the local desktop-agent fallback is gone, and that is deliberate ----
//
// A cloud failure used to fall back to AutoClaw's own desktop agent over a local
// WebSocket, opening it as role "operator" with operator.write / operator.admin
// scopes and `tool_events`. That is a *second agent with write access to this
// machine*, running whatever prompt the harness sent — a throttled or failing
// cloud call could kick off a full agentic run inside AutoClaw, and in a coding
// session that is indistinguishable from a rogue writer editing your files.
//
// It rarely worked, and when it did the work happened inside AutoClaw instead of
// here. It is deleted; these cases fail if anyone brings it back.
//
// The fallback is gone, so the LOCAL_GATEWAY_PORT env and the .gateway-token
// below are inert today. They stay as a tripwire: if the deleted bridge is ever
// reintroduced it finds a dead port and a fake token, so a test run can never
// wake a real AutoClaw agent on the developer's machine.
{
  const home = makeHome({ gateway: true });
  const { mock, proxy } = await againstMock(
    { status: 500, body: { error: "mock upstream exploded" } },
    home,
    { LOCAL_GATEWAY_PORT: "1" },
  );

  const startedAt = Date.now();
  const res = await ask();
  const elapsed = Date.now() - startedAt;
  const out = proxyOutput(proxy).all || "";

  check("no-fallback: a cloud 500 surfaces as the cloud verdict",
    res.status === 502 && /upstream_failure/.test(res.body),
    `${res.status} ${String(res.body).slice(0, 90)}`);

  check("no-fallback: the desktop agent is never invoked",
    !/via local AutoClaw WebSocket agent/.test(out),
    out.split("\n").filter((l) => /WebSocket agent/.test(l)).join(" | "));

  check("no-fallback: nothing even mentions the local gateway",
    !/local AutoClaw gateway|LOCAL_GATEWAY|gateway-token/i.test(out),
    out.split("\n").filter((l) => /local gateway/i.test(l)).join(" | "));

  // A 5xx is capacity-shaped, so it is retried too — but the whole exchange
  // must stay inside the retry budget. The number that matters is what it is NOT:
  // the 120 s a doomed desktop-agent run used to burn here.
  check("no-fallback: it answers inside the retry budget, not an agent budget",
    elapsed < 30_000, `${elapsed}ms`);

  check("no-fallback: bounded attempts, exactly one client-visible answer",
    mock.getRequests().length === DEFAULT_THROTTLE_RETRIES + 1, String(mock.getRequests().length));

  await stopProxy(proxy);
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// PREFER_LOCAL used to skip the cloud entirely and drive the desktop agent
// instead. It is gone too — and an env var that silently changes nothing is
// worse than one that says it was removed.
{
  const home = makeHome({ gateway: true });
  const { mock, proxy } = await againstMock({}, home, { PREFER_LOCAL: "1" });

  const res = await ask();
  const out = proxyOutput(proxy).all || "";

  check("no-fallback: PREFER_LOCAL=1 still serves from the cloud",
    res.status === 200 && mock.getRequests().length === 1,
    `${res.status} hits=${mock.getRequests().length}`);

  check("no-fallback: and the removal is stated, not silently ignored",
    /PREFER_LOCAL/.test(out) && /removed|no longer|ignored|not supported/i.test(out),
    out.split("\n").filter((l) => /PREFER_LOCAL/.test(l)).join(" | "));

  await stopProxy(proxy);
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
}

summary();
