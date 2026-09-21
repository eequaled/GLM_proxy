// Pen-test p7 — the pacing governor (Requirement 3), the anti-ban core.
//
// Two halves, because the governor has two kinds of truth to prove:
//
//   1. In-process unit cases with an INJECTED clock, so a one-hour sliding
//      window is exercised in microseconds and `Retry-After` can be asserted
//      as an exact number instead of "roughly an hour". State is isolated with
//      a temp STATE_DIR so the real machine's window is never touched.
//   2. One end-to-end case against the TLS mock proving the placement promise:
//      a request over budget answers 429 locally and the upstream socket is
//      NEVER opened (the mock counts hits). That is the property the design
//      hinges on and the only one that cannot be shown in-process.
//
// The account key cases are here rather than in taxonomy.mjs because they are
// the difference between a budget that survives the app's hourly token refresh
// and one that silently resets 24 times a day.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PEN_TEST_PORTS } from "../lib/constants.js";
import { classifyGovernorError } from "../lib/core.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  GOVERNOR_STATE_FILE,
  accountKeyFromToken,
  createPacingGovernor,
  decodeJwtClaims,
} from "../lib/governor.js";
import { check, post, startProxy, startTlsMock, stopProxy, summary } from "./_helpers.mjs";

const HOUR = 60 * 60 * 1000;

// ── helpers ─────────────────────────────────────────────────────────────────

function checkThat(name, fn) {
  try { fn(); check(name, true); }
  catch (e) { check(name, false, e.message); }
}

function capturingLog() {
  const lines = [];
  return {
    lines,
    log: {
      info: (m) => lines.push(String(m)),
      warn: (m) => lines.push(String(m)),
      error: (m) => lines.push(String(m)),
      debug: () => {},
    },
    text: () => lines.join("\n"),
  };
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glmp-p7-state-"));
}

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const jwtFor = (claims) => `Bearer ${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;

// The measured claim set (2026-09-21): user_id, device_id, source_id, guid,
// is_guest, power, exp, iat, jti — and deliberately NO `sub`.
const REAL_CLAIMS = {
  user_id: 90210, device_id: "dev-1", source_id: "src-1", guid: "guid-1",
  is_guest: false, power: 1, exp: 1_700_086_400, iat: 1_700_000_000, jti: "jti-1",
};

function makeGovernor({ budget = 3, gap = 0, clock = fakeClock(), stateDir = tempStateDir(), getToken = null, sleep = null } = {}) {
  const cap = capturingLog();
  const notices = [];
  const governor = createPacingGovernor(
    { BUDGET_REQUESTS_PER_HOUR: budget, MIN_GAP_MS: gap, STATE_DIR: stateDir },
    cap.log,
    clock,
    {
      getToken,
      sleep: sleep || (async () => {}),
      onNotice: (n) => notices.push(n),
    },
  );
  return { governor, cap, notices, clock, stateDir };
}

// ── 1. account keying (R3.7, R3.10) ─────────────────────────────────────────

checkThat("key: the account key is the JWT user_id claim", () => {
  const k = accountKeyFromToken(jwtFor(REAL_CLAIMS));
  assert.equal(k.key, "user:90210");
  assert.equal(k.userId, "90210");
  assert.equal(k.source, "user_id");
  assert.equal(k.isGuest, false);
});

checkThat("key: a guest token gets its own bucket, not the real one's", () => {
  const real = accountKeyFromToken(jwtFor(REAL_CLAIMS));
  const guest = accountKeyFromToken(jwtFor({ ...REAL_CLAIMS, is_guest: true }));
  assert.equal(guest.key, "guest:90210");
  assert.notEqual(guest.key, real.key);
});

checkThat("key: hourly rotation (new jti/iat/exp) does not change the key", () => {
  const before = accountKeyFromToken(jwtFor(REAL_CLAIMS));
  const after = accountKeyFromToken(jwtFor({ ...REAL_CLAIMS, jti: "jti-2", iat: 1_700_003_600, exp: 1_700_090_000 }));
  assert.equal(after.key, before.key);
});

checkThat("key: without user_id it falls back to a stable hash of the whole JWT", () => {
  const noId = { device_id: "d", is_guest: false, exp: 1_700_086_400 };
  const a = accountKeyFromToken(jwtFor(noId));
  const b = accountKeyFromToken(jwtFor(noId));
  const other = accountKeyFromToken(jwtFor({ ...noId, device_id: "other" }));
  assert.match(a.key, /^jwt:[0-9a-f]{16}$/);
  assert.equal(a.source, "jwt-hash");
  assert.equal(b.key, a.key);
  assert.notEqual(other.key, a.key);
});

checkThat("key: a garbage token never throws and lands in one bucket", () => {
  assert.equal(accountKeyFromToken("Bearer not-a-jwt").key, "unknown");
  assert.equal(accountKeyFromToken("").key, "unknown");
  assert.equal(accountKeyFromToken(null).key, "unknown");
  assert.equal(decodeJwtClaims("Bearer .."), null);
});

checkThat("key: the raw token never appears in the reported account info", () => {
  const token = jwtFor(REAL_CLAIMS);
  const { governor } = makeGovernor({ getToken: () => token });
  const info = governor.accountInfo();
  assert.equal(info.userId, "90210");
  assert.equal(info.exp, REAL_CLAIMS.exp);
  assert.equal(info.lifetimeSeconds, REAL_CLAIMS.exp - REAL_CLAIMS.iat);
  assert.ok(!JSON.stringify(info).includes(token.replace("Bearer ", "")), "token leaked into account info");
});

// ── 2. the hourly budget (R3.1, R3.2) ───────────────────────────────────────

checkThat("budget: requests 1..n pass, n+1 is refused with the exact window slide", () => {
  const clock = fakeClock();
  const { governor } = makeGovernor({ budget: 3, clock });
  const key = "user:1";

  for (let i = 0; i < 3; i++) {
    const v = governor.tryAcquire(key);
    assert.equal(v.ok, true, `request ${i + 1} should pass`);
    clock.advance(1000);
  }

  const denied = governor.tryAcquire(key);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "budget_exceeded");
  assert.equal(denied.state, "exhausted");
  // The oldest request was 3000ms ago, so the window slides in exactly HOUR-3000.
  assert.equal(denied.retryAfterMs, HOUR - 3000);
  assert.equal(denied.burn.windowRequests, 3);
  assert.equal(denied.burn.pctBudget, 100);
});

checkThat("budget: the window recovers once an hour has slid past", () => {
  const clock = fakeClock();
  const { governor } = makeGovernor({ budget: 2, clock });
  const key = "user:2";

  governor.tryAcquire(key);
  governor.tryAcquire(key);
  assert.equal(governor.tryAcquire(key).ok, false);

  clock.advance(HOUR - 1);
  assert.equal(governor.tryAcquire(key).ok, false, "still inside the window");

  clock.advance(2);
  const v = governor.tryAcquire(key);
  assert.equal(v.ok, true, "the first request aged out, so a slot is free");
  assert.equal(v.burn.windowRequests, 1);
});

checkThat("budget: two accounts behind one proxy have independent budgets", () => {
  const { governor } = makeGovernor({ budget: 2 });
  governor.tryAcquire("user:a");
  governor.tryAcquire("user:a");
  assert.equal(governor.tryAcquire("user:a").ok, false);
  assert.equal(governor.tryAcquire("user:b").ok, true, "a second account is not the first account's problem");
  assert.equal(governor.state("user:b").windowRequests, 1);
  assert.equal(governor.state("user:a").windowRequests, 2);
});

checkThat("budget: a guest token does not share the real account's budget", () => {
  const { governor } = makeGovernor({ budget: 1 });
  assert.equal(governor.tryAcquire("user:90210").ok, true);
  assert.equal(governor.tryAcquire("user:90210").ok, false);
  assert.equal(governor.tryAcquire("guest:90210").ok, true, "guest bucket must be separate");
});

checkThat("budget: 0 disables enforcement entirely and says so", () => {
  const cap = capturingLog();
  const governor = createPacingGovernor(
    { BUDGET_REQUESTS_PER_HOUR: 0, MIN_GAP_MS: 0, STATE_DIR: tempStateDir() },
    cap.log, fakeClock(), { onNotice: () => {} },
  );
  for (let i = 0; i < 20; i++) assert.equal(governor.tryAcquire("user:x").ok, true);
  assert.equal(governor.state("user:x").budget, 0);
  assert.equal(governor.state("user:x").pctBudget, null);
  assert.match(cap.text(), /disabled/i);
});

// ── 3. the 80% notice (R3.3) ────────────────────────────────────────────────

checkThat("notice: crossing 80% warns once, in the log and as a TUI notice", () => {
  const { governor, cap, notices } = makeGovernor({ budget: 10 });
  const key = "user:3";

  for (let i = 0; i < 7; i++) governor.tryAcquire(key);
  assert.equal(notices.length, 0, "no notice below the threshold");

  governor.tryAcquire(key); // the 8th = 80%
  assert.equal(notices.length, 1);
  assert.match(notices[0].lines.join("\n"), /budget/i);
  assert.match(cap.text(), /80%/);

  governor.tryAcquire(key);
  governor.tryAcquire(key);
  assert.equal(notices.length, 1, "the notice fires once per window, not per request");
});

// ── 4. diagnostics exemption (R3.9) ─────────────────────────────────────────

checkThat("diagnostics: --doctor/--test-models sweeps bypass the budget but are counted", () => {
  const { governor } = makeGovernor({ budget: 3 });
  const key = "user:4";

  for (let i = 0; i < 3; i++) { assert.equal(governor.tryAcquire(key).ok, true); }

  for (let i = 0; i < 5; i++) {
    const v = governor.tryAcquire(key, { diagnostic: true });
    assert.equal(v.ok, true, "a health sweep is never starved by the budget");
    assert.equal(v.diagnostic, true);
  }

  assert.equal(governor.state(key).diagnosticRequests, 5);
  assert.equal(governor.state(key).windowRequests, 3, "diagnostics do not consume the budget");
  assert.equal(governor.tryAcquire(key).ok, false, "real traffic is still held to the budget");
});

// ── 5. upstream backoff (R3.4) ──────────────────────────────────────────────

checkThat("backoff: a 429 engages a bounded backoff instead of forwarding again", () => {
  const clock = fakeClock();
  const { governor, notices, cap } = makeGovernor({ budget: 100, clock });
  const key = "user:5";
  assert.equal(governor.tryAcquire(key).ok, true);

  governor.recordUpstreamSignal(key, 429, '{"code":429001,"message":"Rate limit exceeded"}');

  const held = governor.tryAcquire(key);
  assert.equal(held.ok, false);
  assert.equal(held.reason, "upstream_backoff");
  assert.equal(held.state, "backoff");
  assert.ok(held.retryAfterMs >= BACKOFF_BASE_MS * 0.7, `too short: ${held.retryAfterMs}`);
  assert.ok(held.retryAfterMs <= BACKOFF_BASE_MS * 1.35, `jitter out of bounds: ${held.retryAfterMs}`);
  assert.match(cap.text(), /backoff/i);
  assert.equal(notices.length, 1);

  clock.advance(held.retryAfterMs + 1);
  assert.equal(governor.tryAcquire(key).ok, true, "after the cooldown the proxy tries again");
});

checkThat("backoff: it grows exponentially across consecutive throttles and caps out", () => {
  const clock = fakeClock();
  const { governor } = makeGovernor({ budget: 100, clock });
  const key = "user:6";
  const waits = [];

  for (let i = 0; i < 8; i++) {
    governor.recordUpstreamSignal(key, 429, "throttled");
    const v = governor.tryAcquire(key);
    waits.push(v.retryAfterMs);
    clock.advance(v.retryAfterMs + 1);
  }

  assert.ok(waits[1] > waits[0], `not growing: ${waits.join(", ")}`);
  assert.ok(waits[3] > waits[1], `not growing fast enough: ${waits.join(", ")}`);
  assert.ok(waits[7] <= BACKOFF_MAX_MS * 1.35, `above the cap: ${waits[7]}`);
});

checkThat("backoff: a success clears it immediately", () => {
  const { governor } = makeGovernor({ budget: 100 });
  const key = "user:7";
  governor.recordUpstreamSignal(key, 429, "throttled");
  assert.equal(governor.tryAcquire(key).ok, false);
  governor.recordUpstreamSignal(key, 200, "");
  assert.equal(governor.tryAcquire(key).ok, true);
});

checkThat("backoff: upstream Retry-After is honoured but bounded by the cap", () => {
  const clock = fakeClock();
  const { governor } = makeGovernor({ budget: 100, clock });
  const key = "user:8";

  governor.recordUpstreamSignal(key, 429, "throttled", { retryAfterMs: 30_000 });
  const v = governor.tryAcquire(key);
  assert.equal(v.ok, false);
  assert.ok(v.retryAfterMs >= 30_000 * 0.7 && v.retryAfterMs <= 30_000 * 1.35, `got ${v.retryAfterMs}`);

  const { governor: g2 } = makeGovernor({ budget: 100, clock: fakeClock() });
  g2.recordUpstreamSignal("user:9", 429, "throttled", { retryAfterMs: 10 * 60_000 });
  const capped = g2.tryAcquire("user:9");
  assert.ok(capped.retryAfterMs <= BACKOFF_MAX_MS * 1.35, `cap not applied: ${capped.retryAfterMs}`);
});

checkThat("backoff: the free-tier pay-view throttle counts as a throttle signal", () => {
  const { governor } = makeGovernor({ budget: 100 });
  const key = "user:10";
  governor.recordUpstreamSignal(key, 403, JSON.stringify({
    action: { kind: "pay-view" }, code: 810002,
    message: "We're experiencing high demand right now.",
  }));
  const v = governor.tryAcquire(key);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "upstream_backoff", "810002 high-demand is capacity, not a ban");
});

checkThat("backoff: a ban quarantines the account instead of throttling it", () => {
  const { governor } = makeGovernor({ budget: 100 });
  const key = "user:11";
  governor.recordUpstreamSignal(key, 403, '{"code":410004,"message":"账号已被封禁"}');
  const v = governor.tryAcquire(key);
  assert.equal(v.ok, false);
  assert.equal(v.state, "quarantined");
  assert.equal(v.reason, "account_quarantined");
  governor.liftQuarantine(key);
  assert.equal(governor.tryAcquire(key).ok, true);
});

// ── 6. dispatch gaps (R3.6) ─────────────────────────────────────────────────

checkThat("gap: back-to-back dispatches wait out the gap without reordering", async () => {
  const slept = [];
  const clock = fakeClock();
  const { governor } = makeGovernor({
    budget: 100, gap: 250, clock,
    sleep: async (ms) => { slept.push(ms); },
  });
  const key = "user:12";

  const first = await governor.waitForGap(key);
  const waits = await Promise.all([1, 2, 3].map(() => governor.waitForGap(key)));

  assert.equal(first, 0, "nothing to wait for on the first dispatch");
  assert.equal(waits.length, 3, `expected three reservations, got ${JSON.stringify(waits)}`);
  for (const w of waits) assert.ok(w > 0, `expected a wait, got ${w}`);

  // Each reservation is spaced one jittered gap after the previous one, so the
  // *increments* are what must sit inside the 250 ms ±40% band — the waits
  // themselves accumulate (250, 500, 750) because that is what a FIFO pacer
  // has to do to keep arrival order.
  const increments = waits.map((w, i) => Math.round(w - (i === 0 ? 0 : waits[i - 1])));
  for (const inc of increments) {
    assert.ok(inc >= 250 * 0.6, `below the jitter floor: ${inc}`);
    assert.ok(inc <= 250 * 1.4, `above the jitter ceiling: ${inc}`);
  }
  // FIFO: the reserved dispatch times must be strictly increasing.
  const ordered = [...waits].sort((a, b) => a - b);
  assert.deepEqual(waits, ordered, "arrival order was not preserved");
});

checkThat("gap: 0 disables the pacing delay", async () => {
  const { governor } = makeGovernor({ budget: 100, gap: 0 });
  assert.equal(await governor.waitForGap("user:13"), 0);
  assert.equal(await governor.waitForGap("user:13"), 0);
});

// ── 7. persistence across a restart (R3.5) ──────────────────────────────────

checkThat("persistence: a restart keeps the current window honest", () => {
  const stateDir = tempStateDir();
  const clock = fakeClock();
  const first = makeGovernor({ budget: 3, clock, stateDir });
  const key = "user:14";

  first.governor.tryAcquire(key);
  first.governor.tryAcquire(key);
  first.governor.tryAcquire(key);
  assert.ok(fs.existsSync(path.join(stateDir, GOVERNOR_STATE_FILE)), "no state file was written");

  // Same clock, same state dir → a fresh process must not hand out a fresh budget.
  const second = makeGovernor({ budget: 3, clock, stateDir });
  assert.equal(second.governor.state(key).windowRequests, 3);
  const denied = second.governor.tryAcquire(key);
  assert.equal(denied.ok, false, "the restart forgot the window and re-opened the budget");
  assert.equal(denied.reason, "budget_exceeded");

  // An hour later the persisted window has slid, not vanished.
  clock.advance(HOUR + 1);
  assert.equal(second.governor.tryAcquire(key).ok, true);
});

checkThat("persistence: a corrupt state file degrades instead of throwing", () => {
  const stateDir = tempStateDir();
  fs.writeFileSync(path.join(stateDir, GOVERNOR_STATE_FILE), "{ not json at all", "utf8");
  const { governor } = makeGovernor({ budget: 3, stateDir });
  assert.equal(governor.tryAcquire("user:15").ok, true);
});

// ── 8. error taxonomy rows (R3.2) ───────────────────────────────────────────

checkThat("taxonomy: budget_exceeded is a 429 the client is told to retry after", () => {
  const cls = classifyGovernorError({ reason: "budget_exceeded", retryAfterMs: 60_000, burn: { windowRequests: 300, pctBudget: 100 }, budget: 300 });
  assert.equal(cls.status, 429);
  assert.equal(cls.type, "rate_limit_error");
  assert.equal(cls.code, "budget_exceeded");
  assert.equal(cls.permanent, false);
  assert.equal(cls.retryAfterSeconds, 60);
  assert.match(cls.message, /300/);
  assert.match(cls.message, /BUDGET_REQUESTS_PER_HOUR/);
});

checkThat("taxonomy: the other two governor verdicts keep their own shape", () => {
  const backoff = classifyGovernorError({ reason: "upstream_backoff", retryAfterMs: 5000 });
  assert.equal(backoff.status, 429);
  assert.equal(backoff.code, "upstream_backoff");
  assert.equal(backoff.retryAfterSeconds, 5);

  const quarantined = classifyGovernorError({ reason: "account_quarantined" });
  assert.equal(quarantined.status, 403);
  assert.equal(quarantined.code, "account_quarantined");
  assert.equal(quarantined.permanent, true);
});

// ── 9. end-to-end: over budget never opens an upstream socket (R3.2) ────────

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glmp-p7-home-"));
  const appDir = path.join(home, ".openclaw-autoclaw");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "request-headers.json"), JSON.stringify({
    headers: { "X-Authorization": jwtFor(REAL_CLAIMS) },
  }), "utf8");
  fs.writeFileSync(path.join(appDir, "openclaw.runtime.json"), JSON.stringify({
    models: { providers: { zai: { models: [{ id: "zai_glm-5.3-flash", name: "GLM-5.3-Flash", headers: { "X-Version": "1.18.5" } }] } } },
  }), "utf8");

  const { mock, port } = await startTlsMock({});
  const proxy = await startProxy(PEN_TEST_PORTS.p7, {
    HOME: home, USERPROFILE: home,
    UPSTREAM_HOST: "127.0.0.1", UPSTREAM_PORT: String(port),
    BUDGET_REQUESTS_PER_HOUR: "2", GLMP_MIN_GAP_MS: "0",
  });

  const ask = () => post(PEN_TEST_PORTS.p7, {
    body: { model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
    timeoutMs: 20000,
  });

  const first = await ask();
  const second = await ask();
  check("e2e: the first two requests inside the budget succeed", first.status === 200 && second.status === 200,
    `${first.status}, ${second.status}`);

  const hitsBefore = mock.getRequests().length;
  const third = await ask();

  check("e2e: the request over budget is refused locally with 429", third.status === 429, third.status);

  let code = null;
  try { code = JSON.parse(third.body)?.error?.code; } catch { /* asserted via status */ }
  check("e2e: it is classified as budget_exceeded, not as an upstream failure", code === "budget_exceeded", code);

  const retryAfter = third.headers?.["retry-after"];
  check("e2e: it carries a Retry-After header", typeof retryAfter === "string" && Number(retryAfter) > 0, String(retryAfter));

  check("e2e: the upstream socket is never opened for the refused request",
    mock.getRequests().length === hitsBefore, `${mock.getRequests().length - hitsBefore} extra upstream hit(s)`);

  await stopProxy(proxy);
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
}

summary();
