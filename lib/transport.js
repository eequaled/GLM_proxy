/**
 * Upstream transport (Requirement 2) — the wire-format application of the
 * runtime-discovery pattern.
 *
 * The proxy already mirrors the app's *identity* (X-Version, X-* headers) and
 * its *catalog* (model ids). What it never mirrored was the transport itself:
 * the audit's wire capture showed requests going out with no `User-Agent`, no
 * `Accept`, no cookie handling, over HTTP/1.1, against an upstream that sits
 * behind Alibaba Cloud WAF (the `acw_tc` Set-Cookie is the tell). A real
 * Electron/undici client always sends a UA and an Accept, keeps the WAF's
 * cookie for session affinity, and talks h2 when the edge offers it.
 *
 * Design stance (see spec/design.md §2): parity, not evasion. We send one
 * faithful set of headers derived from the operator's own installed app, keep
 * exactly the cookies the server hands us, and never advertise something we
 * cannot decode (`Accept-Encoding` stays absent so response processing is
 * unchanged).
 *
 * Layer isolation: every failure here degrades to today's behavior — an h2
 * session that cannot be established falls back to the existing h1 keep-alive
 * agent for that request with a single dim log event, and a broken cookie jar
 * just means the request goes out cookie-less (first-touch), which is itself a
 * legal client state.
 *
 * Zero dependencies: `node:http2`, `node:https`, `node:path` only.
 */

import crypto from "node:crypto";
import https from "node:https";
import http2 from "node:http2";
import path from "node:path";

import { readJsonSafe, stateDir, writeJsonAtomic } from "./state.js";

export const COOKIES_FILE = "cookies.json";

// RFC 7540 §8.1.2.2 — connection-specific headers are illegal on HTTP/2. The
// h1 path keeps today's exact casing; only the h2 path routes through here.
const FORBIDDEN_H2_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
]);

// Lowercase every name (RFC 7540 §8.1.2) and drop the forbidden ones. One
// helper for both entrypoints so no call site has to think about it.
export function toH2Headers(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const name = String(key).toLowerCase();
    if (FORBIDDEN_H2_HEADERS.has(name)) continue;
    out[name] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return out;
}

// Deliberately dumb cookie parsing: name=value plus the two expiry attributes
// that matter. The upstream is one origin with one simple WAF cookie
// (`acw_tc`); a dumb jar cannot surprise us, and RFC 6265 edge cases (domain
// matching, third-party policy, SameSite) have no bearing here.
export function parseSetCookie(header) {
  const parts = String(header).split(";");
  const pair = parts[0] || "";
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  let expiresAt = null;
  for (const attr of parts.slice(1)) {
    const eqIdx = attr.indexOf("=");
    const key = (eqIdx === -1 ? attr : attr.slice(0, eqIdx)).trim().toLowerCase();
    const val = eqIdx === -1 ? "" : attr.slice(eqIdx + 1).trim();
    if (key === "max-age") {
      const secs = parseInt(val, 10);
      if (Number.isFinite(secs)) expiresAt = Date.now() + secs * 1000;
    } else if (key === "expires") {
      const parsed = Date.parse(val);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }
  return { name, value, expiresAt };
}

function loadJar(file, log) {
  const data = readJsonSafe(file, null, log);
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data;
}

/**
 * createUpstreamTransport(config, log, identityLayer, { isTransient })
 *
 * `identityLayer` supplies the User-Agent / Accept values (Requirement 2.1's
 * discovery chain). `isTransient` is injected rather than imported so this
 * module never has to import `core.js` (which imports it) — one direction of
 * dependency, no cycle.
 */
export function createUpstreamTransport(config, log = null, identityLayer = null, { isTransient = null } = {}) {
  const host = config?.UPSTREAM_HOST || "autoglm-api.autoglm.ai";
  const port = config?.UPSTREAM_PORT || 443;
  const origin = `https://${host}${port === 443 ? "" : ":" + port}`;

  // h2 ships behind a one-release gate (design §Compatibility): the capability,
  // its ALPN fallback and its pen-tests land now; the default flips once the
  // transport is soak-tested against the real WAF.
  const h2Requested = process.env.GLMP_TRANSPORT_H2 === "1";

  const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });
  const cookiePath = path.join(stateDir(config), COOKIES_FILE);

  const transient = typeof isTransient === "function" ? isTransient : () => false;
  const warn = (msg) => { if (log && typeof log.warn === "function") log.warn(msg); else console.warn(msg); };
  const debug = (msg) => { if (log && typeof log.debug === "function") log.debug(msg); };

  let jar = loadJar(cookiePath, log);
  let session = null;
  let lastFallbackAt = null;
  let fallbackLogged = false;
  let protocol = "h1.1";

  // ---- cookie jar --------------------------------------------------------

  function cookiesFor() {
    const entry = jar[origin];
    if (!entry || !entry.cookie) return null;
    if (entry.expiresAt && Date.now() >= entry.expiresAt) {
      delete jar[origin];
      return null;
    }
    return entry.cookie;
  }

  function absorbCookies(resHeaders) {
    const raw = resHeaders && resHeaders["set-cookie"];
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : [String(raw)];
    let changed = false;
    for (const header of list) {
      const parsed = parseSetCookie(header);
      if (!parsed) continue;
      const cookie = `${parsed.name}=${parsed.value}`;
      const current = jar[origin];
      if (!current || current.cookie !== cookie || current.expiresAt !== parsed.expiresAt) {
        jar[origin] = { cookie, expiresAt: parsed.expiresAt };
        changed = true;
      }
    }
    if (changed) {
      try { writeJsonAtomic(cookiePath, jar); }
      catch (err) { warn(`transport: could not persist the cookie jar (${err.message}) — continuing`); }
    }
  }

  // ---- header composition ------------------------------------------------
  // Standard transport headers first, then the per-request set (identity X-*,
  // auth, content-*), which wins on collision.
  //
  // `Accept-Encoding` IS advertised now (Requirement 2.8, the A2 decision): the
  // measured client sends `br, gzip, deflate` automatically via undici `fetch`,
  // and `lib/decode.js` can decode exactly that set and no more — so the advert
  // is true rather than aspirational, and it removes the one-header deviation
  // that made this client's request look hand-rolled. Set `GLMP_ACCEPT_ENCODING`
  // to `""` to omit the header entirely (the pre-A2 behavior).
  function standardHeaders() {
    const headers = {};
    const identity = identityLayer && typeof identityLayer.getIdentity === "function"
      ? identityLayer.getIdentity()
      : null;
    if (identity && identity.userAgent) headers["User-Agent"] = identity.userAgent;
    if (identity && identity.accept) headers["Accept"] = identity.accept;
    if (identity && identity.acceptEncoding) headers["Accept-Encoding"] = identity.acceptEncoding;
    const cookie = cookiesFor();
    if (cookie) headers["Cookie"] = cookie;
    return headers;
  }

  // ---- HTTP/1.1 path (today's exact behavior, plus UA/Accept/cookie) ------

  function attemptH1(options, payload) {
    return new Promise((resolve, reject) => {
      const req = https.request({ ...options, agent }, resolve);
      req.on("timeout", () => {
        req.destroy();
        reject(Object.assign(
          new Error("Upstream timeout — AutoClaw backend did not respond within 2 minutes"),
          { code: "UPSTREAM_TIMEOUT" }
        ));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  // ---- HTTP/2 path (gated) ----------------------------------------------

  function dropSession(reason) {
    if (session) { try { session.destroy(); } catch (_) { /* already gone */ } session = null; }
    lastFallbackAt = Date.now();
    if (!fallbackLogged) {
      fallbackLogged = true;
      debug(`transport: http/2 session unavailable (${reason}) — using http/1.1`);
    }
  }

  function getSession() {
    if (session && !session.closed && !session.destroyed) return session;
    const s = http2.connect(origin);
    s.on("error", (err) => { if (session === s) dropSession(err.code || err.message); });
    s.on("goaway", () => { if (session === s) dropSession("goaway"); });
    s.on("close", () => { if (session === s) session = null; });
    session = s;
    protocol = "h2";
    return s;
  }

  function attemptH2({ path: reqPath, payload, timeoutMs }, headers) {
    return new Promise((resolve, reject) => {
      let s;
      try { s = getSession(); } catch (err) { reject(err); return; }

      const req = s.request({ ":method": "POST", ":path": reqPath, ":authority": host, ...toH2Headers(headers) });
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { req.destroy(); } catch (_) { /* already gone */ }
        reject(err);
      };

      req.setTimeout(timeoutMs || 120000, () => {
        fail(Object.assign(
          new Error("Upstream timeout — AutoClaw backend did not respond within 2 minutes"),
          { code: "UPSTREAM_TIMEOUT" }
        ));
      });
      req.on("error", fail);
      req.on("response", (h) => {
        if (settled) return;
        settled = true;
        absorbCookies(h);
        // Shape the h2 stream like the IncomingMessage the request path already
        // consumes: same statusCode / headers fields, same readable surface.
        req.statusCode = Number(h[":status"] || 0);
        req.headers = h;
        resolve(req);
      });

      req.write(payload);
      req.end();
    });
  }

  // ---- public surface ----------------------------------------------------

  async function request({ path: reqPath, payload, headers = {}, timeoutMs = 120000 } = {}) {
    const merged = { ...standardHeaders(), ...headers };

    if (h2Requested) {
      try {
        return { res: await attemptH2({ path: reqPath, payload, timeoutMs }, merged) };
      } catch (err) {
        dropSession(err.code || err.message);
        // Fall through to h1 for this request — the client-visible outcome
        // must not change (Requirement 2.5).
      }
    }

    const options = {
      hostname: host,
      port,
      path: reqPath,
      method: "POST",
      headers: merged,
      timeout: timeoutMs,
    };

    try {
      const res = await attemptH1(options, payload);
      absorbCookies(res.headers);
      return { res };
    } catch (err) {
      if (transient(err)) {
        warn(`Transient upstream network error (${err.code || err.message}) — retrying once`);
        await new Promise((r) => setTimeout(r, 250));
        const res = await attemptH1(options, payload);
        absorbCookies(res.headers);
        return { res };
      }
      throw err;
    }
  }

  function sessionState() {
    return {
      protocol: h2Requested ? protocol : "h1.1",
      h2: h2Requested,
      cookies: Object.keys(jar).length,
      lastFallbackAt,
    };
  }

  function close() {
    if (session) {
      try { session.close(); } catch (_) { try { session.destroy(); } catch (_) { /* already gone */ } }
      session = null;
    }
    try { agent.destroy(); } catch (_) { /* already gone */ }
  }

  return { request, sessionState, close };
}
