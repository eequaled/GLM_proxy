/**
 * Config heartbeat — companion traffic + self-heal (Requirement 5).
 *
 * The real AutoClaw app does not only send completions: it polls its own model
 * config every 300 s (`startModelConfigPolling` in the shipped bundle logs
 * `Starting model config polling (interval=300s)`; four consecutive
 * `remote_config.refresh.model_config_applied` log entries land at
 * 298.8 / 300.0 / 299.9 s). A proxy that only ever emits completions is a
 * traffic *mix* anomaly, and it is also the reason the catalog can only be
 * refreshed by restarting it.
 *
 * This module turns the existing one-shot `fetchRemoteModelConfig` into that
 * same companion cadence, with three jobs:
 *
 *   1. keep the catalog fresh without a restart (Requirement 5.2),
 *   2. keep the identity layer's drift report fed (Requirement 5.5), and
 *   3. act as the cheap **ban-lift probe** (Requirement 6.2): a 200 from a GET
 *      costs nothing and proves the account works again, which is a far better
 *      detector than spending a completion to find out.
 *
 * Zero dependencies, no imports from core (the caller injects `fetchConfig`),
 * never throws, and every failure degrades to "the catalog is the one we
 * already had" — a dead heartbeat is a degraded proxy, never a dead one.
 */

import { defaultClock } from "./clock.js";

// 300 s, measured from the app (NOT the dev build's 120 s).
export const DEFAULT_INTERVAL_MS = 300_000;
// Failure backoff is capped here so a long outage cannot push the next probe
// days away.
export const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000;
// Cadence jitter, so two proxies started together never poll in lockstep.
export const JITTER_RATIO = 0.2;
// In backoff/quarantine the heartbeat keeps probing but slows right down
// (Requirement 5.4): recovery detection must not violate the cool-down.
export const PAUSED_STRETCH = 4;

/**
 * Canonical serialization for fingerprinting only — object keys sorted
 * recursively so a JSON key reorder is not mistaken for a config change.
 * Never used for wire bytes.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Fingerprint the model list. Sorted by id first, so an upstream that reorders
 * its catalog without changing it does not look like a change (that reorder
 * would otherwise rebuild routing and log a spurious diff).
 */
export function fingerprintModels(models) {
  const list = (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.id === "string")
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  return stableStringify(list);
}

/**
 * One-line, human-readable diff between two catalogs. The app logs
 * `Model config changed: [old] -> [new]`; we log the same *event* with the
 * detail an operator actually needs (which ids moved).
 */
export function describeModelChange(previousModels, nextModels) {
  const prev = new Map((Array.isArray(previousModels) ? previousModels : []).map((m) => [m.id, m]));
  const next = new Map((Array.isArray(nextModels) ? nextModels : []).map((m) => [m.id, m]));

  const added = [...next.keys()].filter((id) => !prev.has(id));
  const removed = [...prev.keys()].filter((id) => !next.has(id));
  const changed = [...next.keys()].filter((id) => {
    if (!prev.has(id)) return false;
    return stableStringify(prev.get(id)) !== stableStringify(next.get(id));
  });

  const parts = [];
  if (added.length) parts.push(`+${added.join(", +")}`);
  if (removed.length) parts.push(`-${removed.join(", -")}`);
  if (changed.length) parts.push(`updated ${changed.join(", ")}`);
  if (!parts.length) parts.push("reordered only");
  return `${parts.join("; ")} (${next.size} models)`;
}

/**
 * @param {object} config  loadConfig() output (reads HEARTBEAT_INTERVAL_MS)
 * @param {object} log
 * @param {object} deps
 *   clock        { now() } — injectable for deterministic pen tests
 *   setTimer     (fn, ms) => handle  (default setTimeout; unref'd when possible)
 *   clearTimer   (handle) => void
 *   random       () => number in [0,1) — jitter source, injectable
 *   fetchConfig  async () => models[] | null   (the caller owns the token+wire)
 *   onCatalog    (models, info) => void        (apply the new catalog)
 *   isPaused     () => boolean                 (governor backoff / quarantined)
 */
export function createConfigHeartbeat(config, log = null, deps = {}) {
  const clock = deps.clock || defaultClock;
  const setTimer = deps.setTimer || ((fn, ms) => {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === "function") t.unref();
    return t;
  });
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
  const random = deps.random || Math.random;
  const fetchConfig = deps.fetchConfig || (async () => null);
  const onCatalog = deps.onCatalog || (() => {});
  const isPaused = deps.isPaused || (() => false);

  const configured = config?.HEARTBEAT_INTERVAL_MS;
  const intervalMs = Number.isFinite(configured) && configured > 0
    ? configured
    : (configured === 0 ? 0 : DEFAULT_INTERVAL_MS);

  const info = (msg) => { try { log?.info?.(msg); } catch (_) {} };
  const debug = (msg) => { try { log?.debug?.(msg); } catch (_) {} };
  const warn = (msg) => { try { log?.warn?.(msg); } catch (_) {} };

  let _running = false;
  let _timer = null;
  let _lastPollAt = null;
  let _lastChangeAt = null;
  let _consecutiveFailures = 0;
  let _lastFingerprint = null;
  let _lastModels = null;
  let _lastError = null;
  let _polls = 0;

  // Base delay for the *next* probe: the configured cadence, doubled per
  // consecutive failure up to the cap, stretched ×4 while the account is in
  // backoff or quarantined (Requirement 5.4), then jittered.
  function nextDelayMs() {
    let base = intervalMs;
    if (_consecutiveFailures > 0) {
      const grown = intervalMs * Math.pow(2, _consecutiveFailures);
      base = Math.min(grown, MAX_BACKOFF_MS);
    }
    if (isPaused()) base = Math.min(base * PAUSED_STRETCH, MAX_BACKOFF_MS);
    const span = base * JITTER_RATIO;
    const jittered = base - span + random() * span * 2;
    return Math.max(1, Math.round(jittered));
  }

  function schedule() {
    if (!_running || intervalMs === 0) return;
    if (_timer) { clearTimer(_timer); _timer = null; }
    const delay = nextDelayMs();
    _timer = setTimer(() => { _timer = null; void tick(); }, delay);
  }

  function noteFailure(err) {
    _consecutiveFailures++;
    _lastError = err ? String(err.message || err) : null;
    const next = nextDelayMs();
    warn(
      `heartbeat: model-config poll failed (${_lastError || "no payload"}) — ` +
      `keeping the last-good catalog, retrying in ${Math.round(next / 1000)}s ` +
      `(failure ${_consecutiveFailures})`
    );
  }

  async function tick() {
    if (!_running) return;
    _lastPollAt = clock.now();
    _polls++;
    try {
      const models = await fetchConfig();
      if (!Array.isArray(models) || models.length === 0) {
        noteFailure(null);
        schedule();
        return;
      }

      const fingerprint = fingerprintModels(models);
      const isFirst = _lastFingerprint === null;
      const changed = isFirst || fingerprint !== _lastFingerprint;

      if (changed) {
        // One line, the app's own event name, with the operator-useful detail.
        info(`Model config changed: ${describeModelChange(_lastModels, models)}`);
        const previous = _lastModels;
        _lastFingerprint = fingerprint;
        _lastModels = models;
        _lastChangeAt = clock.now();
        try { onCatalog(models, { previous, first: isFirst }); }
        catch (err) { warn(`heartbeat: applying the new catalog failed (${err.message}) — ignored`); }
      } else {
        // The app content-hashes too and logs a skip; one line at debug so a
        // healthy proxy is silent at info level.
        debug(`heartbeat: model config unchanged (fingerprint=${fingerprint.slice(0, 12)}…) — skipped`);
      }

      _consecutiveFailures = 0;
      _lastError = null;
      schedule();
    } catch (err) {
      noteFailure(err);
      schedule();
    }
  }

  function start() {
    if (_running || intervalMs === 0) return;
    _running = true;
    info(`heartbeat: polling model config every ${Math.round(intervalMs / 1000)}s (mirrors the app)`);
    schedule();
  }

  function stop() {
    _running = false;
    if (_timer) { clearTimer(_timer); _timer = null; }
  }

  function status() {
    return {
      running: _running,
      intervalMs,
      polls: _polls,
      lastPollAt: _lastPollAt,
      lastChangeAt: _lastChangeAt,
      consecutiveFailures: _consecutiveFailures,
      lastError: _lastError,
      modelCount: _lastModels ? _lastModels.length : null,
    };
  }

  return {
    start,
    stop,
    status,
    // Exposed for tests and for a one-shot probe (the ban-lift check): drive a
    // poll without waiting for the timer.
    pollNow: tick,
    // The last remote payload, so the catalog reader can prefer it when the
    // app's runtime file is unavailable.
    lastModels: () => _lastModels,
    nextDelayMs,
  };
}
