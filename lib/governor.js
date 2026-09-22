/**
 * Pacing governor — the protective core (Requirement 3).
 *
 * Issue #5 is an account-ban report, and the audit's ranked root causes put
 * *burn velocity* above every fingerprint gap: an unsupervised harness pushed
 * ~8,000 credits through one account in ~2 hours. Identity and transport parity
 * make this proxy look like the real client; the governor is the layer that
 * stops it behaving like a bot, and it is the one layer that protects the
 * account even when the parity layers are all perfect.
 *
 * It is a per-account state machine, not a queue:
 *
 *   normal ──80% of budget──► warning (TUI + log, once per window)
 *   normal ──budget exhausted──► exhausted → local 429 + Retry-After, no socket
 *   normal ──upstream 429 / pay-view throttle──► backoff (exp + jitter)
 *   backoff ──cooldown elapsed──► normal
 *   any ──410004 ban──► quarantined (governor pauses; Task 7 owns the lift)
 *
 * Placement: after request normalization, before the transport. A request the
 * governor refuses must never open an upstream socket — that is the whole
 * promise, and `tests/pen-test-p7.mjs` proves it by counting mock hits.
 *
 * Two deliberate non-obvious choices, both measured rather than assumed:
 *
 *  - **The account key is the JWT `user_id`**, not `sub`. The real token has no
 *    `sub` claim (claims are `user_id, device_id, source_id, guid, is_guest,
 *    power, exp, iat, jti`), so keying on `sub` would have dropped every request
 *    into the hash-the-whole-JWT fallback — and re-keyed the budget on every
 *    rotation. The app force-refreshes hourly and tokens live 24 h, so a key
 *    that drifted per refresh would silently reset the budget up to 24×/day.
 *    That is a bug that looks exactly like the feature working.
 *  - **Requests, not credits, are the enforcement unit.** The audit could not
 *    observe a per-response credit field on the wire. A request count is
 *    measurable and explainable ("300 req/h"); credit *reporting* runs
 *    best-effort off usage metadata and says so when it has nothing.
 *
 * Zero dependencies, never throws on the request path, and every failure mode
 * degrades to passthrough (Requirement 7.3/7.5): an unreadable state file, an
 * undecodable token and a missing clock all fall back rather than block.
 */

import crypto from "node:crypto";
import path from "node:path";

import { defaultClock } from "./clock.js";
import { readJsonSafe, stateDir, writeJsonAtomic } from "./state.js";

export const GOVERNOR_STATE_FILE = "governor.json";
export const GOVERNOR_STATE_VERSION = 1;

// Deliberately low, and documented as a guess (Requirement 3.1). The real
// upstream threshold is unknown; the observed ban envelope is orders of
// magnitude above this, and erring low is the safe direction for a safety net.
export const DEFAULT_BUDGET_REQUESTS_PER_HOUR = 300;

export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_MIN_GAP_MS = 250;
export const WARN_AT_PCT = 80;

// Backoff is exponential with jitter, capped so a long throttle cannot wedge
// the proxy for the rest of the day.
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
export const BACKOFF_JITTER = 0.25;
export const GAP_JITTER = 0.4;

// The free-tier "high demand" throttle is 403 + 810002 with `"kind":"pay-view"`
// — capacity, not a ban. It must engage the backoff, never the quarantine.
const THROTTLE_BODY_RE = /810002|pay-view|high demand|429001|请求频率|too many requests|rate limit/i;
const BAN_BODY_RE = /410004|账号已被封禁|已被封禁/;

// Usage fields the upstream *might* publish one day. Any present numeric field
// turns credit reporting on; until then the governor reports tokens only and
// says credits are unobservable rather than inventing a conversion rate.
const CREDIT_FIELDS = ["credits", "credit_cost", "total_credits", "cost_credits"];

// ============================================================================
// Account keying
// ============================================================================

// A zero-dep base64 split of the payload segment. No signature verification:
// we are the sender of this token, and the question being answered is "which
// budget does this belong to", not "is this authentic".
export function decodeJwtClaims(token) {
  try {
    const raw = String(token || "").replace(/^Bearer\s+/i, "").trim();
    const parts = raw.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object") return null;
    return { claims, raw };
  } catch {
    return null;
  }
}

export function accountKeyFromToken(token) {
  const decoded = decodeJwtClaims(token);
  if (!decoded) {
    return { key: "unknown", userId: null, isGuest: null, exp: null, iat: null, lifetimeSeconds: null, source: "no-token" };
  }

  const c = decoded.claims;
  const userId = c.user_id != null && c.user_id !== "" ? String(c.user_id) : null;
  const isGuest = c.is_guest === true || c.is_guest === 1 || c.is_guest === "1";
  const exp = Number.isFinite(Number(c.exp)) && c.exp != null ? Number(c.exp) : null;
  const iat = Number.isFinite(Number(c.iat)) && c.iat != null ? Number(c.iat) : null;

  const base = { userId, isGuest, exp, iat, lifetimeSeconds: exp != null && iat != null ? exp - iat : null };

  // A guest identity and a paid identity are different upstream subjects with
  // different limits — sharing a bucket would under-count the paid account and
  // distort the guest's burn.
  if (userId) {
    return { ...base, key: `${isGuest ? "guest" : "user"}:${userId}`, source: "user_id" };
  }

  const hash = crypto.createHash("sha256").update(decoded.raw).digest("hex").slice(0, 16);
  return { ...base, key: `jwt:${hash}`, source: "jwt-hash" };
}

export function isBanSignal(statusCode, bodyText) {
  return statusCode === 403 && BAN_BODY_RE.test(String(bodyText || ""));
}

export function isThrottleSignal(statusCode, bodyText) {
  const text = String(bodyText || "");
  if (THROTTLE_BODY_RE.test(text)) return true;
  return statusCode === 429;
}

// ============================================================================
// Notices — the operator half of the feature (Requirement 3.3)
// ============================================================================

const NOTICE_W = 56; // mirrors core.js BOX_W so notices match the startup banner

// Self-contained rather than imported from core.js: the lib/ layers depend only
// on state.js/clock.js so core.js stays the single integrator, and a cycle here
// would be invisible until it broke at load time.
function boxed(title, rows) {
  const fit = (s) => {
    const t = String(s);
    return t.length > NOTICE_W ? `${t.slice(0, NOTICE_W - 1)}…` : t;
  };
  const row = (s) => {
    const t = fit(s);
    return `│ ${t}${" ".repeat(Math.max(0, NOTICE_W - t.length))} │`;
  };
  const rule = "─".repeat(NOTICE_W + 2);
  return [
    `┌${rule}┐`,
    row(title),
    `├${rule}┤`,
    ...rows.map(row),
    `└${rule}┘`,
  ];
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeBudget(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_BUDGET_REQUESTS_PER_HOUR;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BUDGET_REQUESTS_PER_HOUR;
  if (n <= 0) return 0; // the `0` / unset convention: explicitly off
  return Math.floor(n);
}

function dayKeyOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// ============================================================================
// The governor
// ============================================================================

export function createPacingGovernor(config = {}, log = null, clock = defaultClock, deps = {}) {
  const { getToken = null, sleep = realSleep, onNotice = null } = deps;

  const logInfo = (m) => { if (log && typeof log.info === "function") log.info(m); };
  const logWarn = (m) => {
    if (log && typeof log.warn === "function") log.warn(m);
    else console.warn(m);
  };

  const windowMs = Number.isFinite(config.WINDOW_MS) && config.WINDOW_MS > 0 ? config.WINDOW_MS : DEFAULT_WINDOW_MS;
  const minGapMs = Number.isFinite(config.MIN_GAP_MS) && config.MIN_GAP_MS >= 0 ? config.MIN_GAP_MS : DEFAULT_MIN_GAP_MS;
  const persist = config.GOVERNOR_PERSIST !== false;
  let budget = normalizeBudget(config.BUDGET_REQUESTS_PER_HOUR);

  const accounts = new Map();
  let _saveWarned = false;

  const warnAt = () => (budget > 0 ? Math.ceil((budget * WARN_AT_PCT) / 100) : Infinity);
  const stateFile = () => path.join(stateDir(config), GOVERNOR_STATE_FILE);

  function account(key) {
    let a = accounts.get(key);
    if (!a) {
      a = {
        key,
        timestamps: [],
        warned: false,
        exhaustedNotified: false,
        backoffLevel: 0,
        backoffUntil: 0,
        quarantined: false,
        day: dayKeyOf(clock.now()),
        estimatedTokens: 0,
        estimatedCredits: 0,
        creditsObservable: false,
        diagnosticRequests: 0,
        localRequests: 0,
        lastDispatchAt: 0,
      };
      accounts.set(key, a);
    }
    return a;
  }

  // ---- window bookkeeping ------------------------------------------------

  function prune(a, now) {
    const cutoff = now - windowMs;
    while (a.timestamps.length && a.timestamps[0] <= cutoff) a.timestamps.shift();

    // Re-arm both one-shot notices once the window has genuinely slid back
    // below their thresholds, so a long session warns once per window instead
    // of exactly once per process.
    if (budget > 0) {
      if (a.timestamps.length < warnAt()) a.warned = false;
      if (a.timestamps.length < budget) a.exhaustedNotified = false;
    }

    const today = dayKeyOf(now);
    if (a.day !== today) {
      a.day = today;
      a.estimatedTokens = 0;
      a.estimatedCredits = 0;
    }
  }

  function pctBudget(a) {
    if (budget <= 0) return null;
    return Math.min(100, Math.round((a.timestamps.length / budget) * 1000) / 10);
  }

  function burn(a) {
    return {
      windowRequests: a.timestamps.length,
      pctBudget: pctBudget(a),
      budget,
      estimatedTokens: a.estimatedTokens,
      estimatedCredits: a.creditsObservable ? a.estimatedCredits : null,
    };
  }

  function resolveState(a, now) {
    if (a.quarantined) return "quarantined";
    if (now < a.backoffUntil) return "backoff";
    if (budget > 0 && a.timestamps.length >= budget) return "exhausted";
    if (budget > 0 && a.timestamps.length >= warnAt()) return "warning";
    return "normal";
  }

  // ---- notices -----------------------------------------------------------

  function emit(notice) {
    if (typeof onNotice === "function") {
      try { onNotice(notice); } catch { /* a notice must never break the request */ }
      return;
    }
    for (const line of boxed(notice.title, notice.lines)) console.warn(`  ${line}`);
  }

  function noticeBurn(a, pct) {
    const lines = [
      `Hourly upstream budget is ${pct}% spent for this account.`,
      `${a.timestamps.length}/${budget} requests used in the last hour.`,
      "The proxy will refuse requests at 100% and answer 429.",
      "Set BUDGET_REQUESTS_PER_HOUR=0 to disable the governor.",
    ];
    emit({ kind: "budget-warning", title: "⚠️  AUTOCLAW ACCOUNT PACING GOVERNOR", lines });
    logWarn(
      `governor: 80% of the hourly upstream budget is spent (${a.timestamps.length}/${budget} requests for ${a.key}) — ` +
      `this is the guard against burning the account into a ban. BUDGET_REQUESTS_PER_HOUR=0 disables it.`
    );
  }

  function noticeExhausted(a, retryAfterMs) {
    const secs = Math.ceil(retryAfterMs / 1000);
    const lines = [
      `Hourly budget exhausted: ${a.timestamps.length}/${budget} requests.`,
      `New upstream requests are refused for ~${secs}s.`,
      "Nothing was sent upstream, so no credits were spent.",
      "Set BUDGET_REQUESTS_PER_HOUR=0 to disable the governor.",
    ];
    emit({ kind: "budget-exhausted", title: "🛑  AUTOCLAW ACCOUNT PACING GOVERNOR", lines });
    logWarn(`governor: account budget exhausted for ${a.key} — ${a.timestamps.length}/${budget} requests this hour; refusing upstream calls for ~${secs}s`);
  }

  function noticeBackoff(a, delayMs, statusCode) {
    const secs = Math.ceil(delayMs / 1000);
    const lines = [
      `Upstream is throttling this account (HTTP ${statusCode}).`,
      `Backing off for ~${secs}s (attempt ${a.backoffLevel}).`,
      "No request will be forwarded until the cooldown elapses.",
    ];
    emit({ kind: "upstream-backoff", title: "⏳  AUTOCLAW ACCOUNT PACING GOVERNOR", lines });
    logWarn(`governor: upstream backoff engaged for ${a.key} — HTTP ${statusCode}, attempt ${a.backoffLevel}, retrying in ~${secs}s`);
  }

  function noticeBan(a) {
    const lines = [
      `AutoClaw banned this account (code 410004).`,
      "Upstream calls are paused until the ban is lifted.",
      "A ban is permanent for the account — do not keep retrying.",
    ];
    emit({ kind: "account-banned", title: "⛔  AUTOCLAW ACCOUNT BANNED", lines });
    logWarn(`governor: account ${a.key} is banned upstream (410004) — upstream calls paused`);
  }

  // ---- persistence -------------------------------------------------------

  function load() {
    if (!persist || budget === 0) return;
    const data = readJsonSafe(stateFile(), null, log);
    const now = clock.now();
    for (const [key, saved] of Object.entries(data?.accounts || {})) {
      if (!saved || typeof saved !== "object") continue;
      const a = account(key);
      a.timestamps = Array.isArray(saved.timestamps)
        ? saved.timestamps.filter((t) => Number.isFinite(t) && t > now - windowMs).sort((x, y) => x - y)
        : [];
      a.estimatedTokens = Number.isFinite(saved.estimatedTokens) ? saved.estimatedTokens : 0;
      a.estimatedCredits = Number.isFinite(saved.estimatedCredits) ? saved.estimatedCredits : 0;
      a.creditsObservable = saved.creditsObservable === true;
      a.day = typeof saved.day === "string" ? saved.day : dayKeyOf(now);
      a.quarantined = saved.quarantined === true;
      a.backoffLevel = Number.isFinite(saved.backoffLevel) ? saved.backoffLevel : 0;
      a.backoffUntil = Number.isFinite(saved.backoffUntil) ? saved.backoffUntil : 0;
      prune(a, now);
    }
  }

  // Written on every state change: the file is a few hundred bytes, and a
  // restart that hands out a fresh budget is exactly the failure this prevents.
  // A disabled governor (budget 0) never writes: an "off" that still meters is
  // how a test suite poisoned the operator's real window while believing it
  // had pacing disabled.
  function save() {
    if (!persist || budget === 0) return;
    try {
      const out = {};
      for (const [key, a] of accounts) {
        out[key] = {
          timestamps: a.timestamps,
          estimatedTokens: a.estimatedTokens,
          estimatedCredits: a.estimatedCredits,
          creditsObservable: a.creditsObservable,
          day: a.day,
          backoffLevel: a.backoffLevel,
          backoffUntil: a.backoffUntil,
          quarantined: a.quarantined,
        };
      }
      writeJsonAtomic(stateFile(), { version: GOVERNOR_STATE_VERSION, savedAt: new Date(clock.now()).toISOString(), accounts: out });
    } catch (err) {
      if (!_saveWarned) {
        _saveWarned = true;
        logWarn(`governor: could not persist ${GOVERNOR_STATE_FILE} (${err.message}) — the budget window will reset on restart`);
      }
    }
  }

  // ---- public surface ----------------------------------------------------

  function currentKey() {
    try {
      const token = typeof getToken === "function" ? getToken() : null;
      return accountKeyFromToken(token).key;
    } catch {
      // No token file yet / app not logged in: the request will fail on its own
      // terms (503 no_token) and must not be blocked by a budget.
      return "unknown";
    }
  }

  function tryAcquire(accountKey = null, { diagnostic = false } = {}) {
    const now = clock.now();
    const key = accountKey || currentKey();
    const a = account(key);
    prune(a, now);

    // Operator-initiated health sweeps are exempt from the budget they exist to
    // protect, but still counted — a doctor run should never be able to starve
    // real traffic, nor hide that it happened.
    if (diagnostic) {
      if (budget > 0) {
        a.diagnosticRequests++;
        save();
      }
      return { ok: true, diagnostic: true, state: resolveState(a, now), burn: burn(a) };
    }

    if (a.quarantined) {
      return { ok: false, state: "quarantined", reason: "account_quarantined", retryAfterMs: null, burn: burn(a) };
    }

    if (now < a.backoffUntil) {
      return { ok: false, state: "backoff", reason: "upstream_backoff", retryAfterMs: a.backoffUntil - now, burn: burn(a) };
    }

    if (budget > 0 && a.timestamps.length >= budget) {
      const retryAfterMs = Math.max(0, a.timestamps[0] + windowMs - now);
      if (!a.exhaustedNotified) {
        a.exhaustedNotified = true;
        noticeExhausted(a, retryAfterMs);
      }
      return { ok: false, state: "exhausted", reason: "budget_exceeded", retryAfterMs, burn: burn(a) };
    }

    // Off means off: an unmetered request is also an unrecorded one. The next
    // two reflexes (backoff, quarantine) still apply with the governor off —
    // they answer upstream's own signals, not our budget.
    if (budget === 0) {
      return { ok: true, state: resolveState(a, now), burn: burn(a) };
    }

    a.timestamps.push(now);
    const pct = pctBudget(a);
    if (budget > 0 && a.timestamps.length >= warnAt() && !a.warned) {
      a.warned = true;
      noticeBurn(a, pct);
    }
    save();
    return { ok: true, state: resolveState(a, now), burn: burn(a) };
  }

  function recordUpstreamSignal(accountKey = null, statusCode = 0, bodyText = "", { retryAfterMs = null } = {}) {
    const now = clock.now();
    const key = accountKey || currentKey();
    const a = account(key);
    prune(a, now);

    if (isBanSignal(statusCode, bodyText)) {
      const wasQuarantined = a.quarantined;
      a.quarantined = true;
      a.backoffUntil = 0;
      a.backoffLevel = 0;
      if (!wasQuarantined) noticeBan(a);
      save();
      return { state: "quarantined", reason: "account_quarantined", retryAfterMs: null };
    }

    if (statusCode > 0 && statusCode < 400) {
      a.backoffLevel = 0;
      a.backoffUntil = 0;
      save();
      return { state: resolveState(a, now), retryAfterMs: 0 };
    }

    if (isThrottleSignal(statusCode, bodyText)) {
      a.backoffLevel = Math.min(a.backoffLevel + 1, 10);
      const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (a.backoffLevel - 1));
      // Upstream's own Retry-After is the authority on its congestion, but it
      // cannot be allowed to wedge the proxy for the rest of the day.
      const target = Math.min(BACKOFF_MAX_MS, Math.max(exponential, Number.isFinite(retryAfterMs) ? retryAfterMs : 0));
      const delay = Math.round(target * (1 + (Math.random() * 2 - 1) * BACKOFF_JITTER));
      a.backoffUntil = now + delay;
      noticeBackoff(a, delay, statusCode);
      save();
      return { state: "backoff", reason: "upstream_backoff", retryAfterMs: delay };
    }

    // Anything else (a plain 403, a 402, a 500) is not a pacing signal: the
    // taxonomy owns those verdicts and the governor stays out of the way.
    return { state: resolveState(a, now), retryAfterMs: 0 };
  }

  function recordUsage(accountKey = null, usage = null) {
    if (!usage || typeof usage !== "object") return;
    const key = accountKey || currentKey();
    const a = account(key);
    prune(a, clock.now());

    const total = Number(usage.total_tokens);
    const tokens = Number.isFinite(total)
      ? total
      : (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
    if (Number.isFinite(tokens) && tokens > 0) a.estimatedTokens += tokens;

    for (const field of CREDIT_FIELDS) {
      const n = Number(usage[field]);
      if (Number.isFinite(n) && n > 0) {
        a.estimatedCredits += n;
        a.creditsObservable = true;
      }
    }
    save();
  }

  function noteLocal(accountKey = null) {
    const a = account(accountKey || currentKey());
    a.localRequests++;
  }

  function liftQuarantine(accountKey = null) {
    const key = accountKey || currentKey();
    const a = account(key);
    if (!a.quarantined) return false;
    a.quarantined = false;
    a.backoffLevel = 0;
    a.backoffUntil = 0;
    logInfo(`governor: quarantine lifted for ${key} — upstream calls resume`);
    save();
    return true;
  }

  // The FIFO-preserving dispatch gap: reserve the slot before awaiting, so
  // concurrent callers keep their arrival order. Enough to break the robotic
  // sub-10 ms bursts the audit measured, not enough to feel like latency.
  async function waitForGap(accountKey = null) {
    if (!minGapMs) return 0;
    const now = clock.now();
    const a = account(accountKey || currentKey());
    const gap = minGapMs * (1 + (Math.random() * 2 - 1) * GAP_JITTER);
    const wait = Math.max(0, Math.round(a.lastDispatchAt + gap - now));
    a.lastDispatchAt = now + wait;
    if (wait <= 0) return 0;
    await sleep(wait);
    return wait;
  }

  function state(accountKey = null) {
    const now = clock.now();
    const key = accountKey || currentKey();
    const a = account(key);
    prune(a, now);
    return {
      key,
      state: resolveState(a, now),
      budget,
      windowRequests: a.timestamps.length,
      pctBudget: pctBudget(a),
      nextWindowAt: a.timestamps.length ? a.timestamps[0] + windowMs : null,
      retryAfterMs: now < a.backoffUntil ? a.backoffUntil - now : 0,
      backoffLevel: a.backoffLevel,
      diagnosticRequests: a.diagnosticRequests,
      localRequests: a.localRequests,
      estimatedTokens: a.estimatedTokens,
      estimatedCredits: a.creditsObservable ? a.estimatedCredits : null,
      creditsObservable: a.creditsObservable,
    };
  }

  // What `--doctor` prints. Decoded claims only — never the token itself.
  function accountInfo(accountKey = null) {
    let token = null;
    try { token = typeof getToken === "function" ? getToken() : null; } catch { /* no token */ }
    const decoded = accountKeyFromToken(token);
    const key = accountKey || decoded.key;
    return {
      key,
      userId: decoded.userId,
      isGuest: decoded.isGuest,
      source: decoded.source,
      exp: decoded.exp,
      iat: decoded.iat,
      lifetimeSeconds: decoded.lifetimeSeconds,
      ...state(key),
    };
  }

  function setBudget(n) {
    budget = normalizeBudget(n);
    if (budget === 0) logWarn("governor: disabled (BUDGET_REQUESTS_PER_HOUR=0) — upstream requests are unmetered");
    else logInfo(`governor: ${budget} upstream requests per hour per account`);
    save();
    return budget;
  }

  function stop() {
    save();
  }

  load();
  if (budget === 0) logWarn("governor: disabled (BUDGET_REQUESTS_PER_HOUR=0) — upstream requests are unmetered");
  else logInfo(`governor: ${budget} upstream requests/hour per account; min gap ${minGapMs}ms`);
  if (minGapMs === 0) logInfo("governor: dispatch gap disabled (GLMP_MIN_GAP_MS=0)");

  return {
    accountKeyFromToken,
    currentKey,
    tryAcquire,
    recordUpstreamSignal,
    recordUsage,
    noteLocal,
    liftQuarantine,
    waitForGap,
    state,
    accountInfo,
    setBudget,
    stop,
  };
}
