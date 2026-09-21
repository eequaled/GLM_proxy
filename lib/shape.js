/**
 * Shape layer — request-shape parity (Requirement 4).
 *
 * Three jobs, all of them the runtime-discovery pattern applied to the *request
 * body* instead of to headers, catalogs or pacing:
 *
 *   1. **Banner discovery.** The proxy prepends a literal banner to the system
 *      prompt. That literal was a pin with a one-character bug: the app joins
 *      its prompt lines with `"\n"` and puts a *blank line* before `## Tooling`,
 *      while the pin had a single `\n` — a byte-shape mismatch in the exact
 *      string the old code called load-bearing. The app's own prompt builder
 *      ships inside its bundle
 *      (`resources/gateway/openclaw/dist/system-prompt-config-*.js`), so the
 *      banner can be *read* from the installed app instead of guessed, with a
 *      last-good snapshot behind it.
 *
 *   2. **Prompt envelope.** A foreign harness sends a 30 KB system prompt the
 *      app never would. Over the configured envelope the middle is dropped and
 *      marked, head and tail preserved — the shape-normalising half of "parity,
 *      not evasion": make the request look like the app's, without silently
 *      discarding what the model needs at the end of the prompt.
 *
 *   3. **Tool-shape filter.** A blocklist for structural fields a harness emits
 *      and the app does not. The default blocklist is **empty** — the audit saw
 *      tools pass through upstream fine, so the honest default is identity, and
 *      a field only gets dropped after evidence says upstream rejects it.
 *
 * Zero dependencies, never throws, and every rung degrades to the previous
 * behaviour: no discovered banner → snapshot → env → pin; no envelope → no
 * compaction; empty blocklist → tools untouched.
 */

import fs from "node:fs";
import path from "node:path";

import { defaultClock } from "./clock.js";
import { readJsonSafe, stateDir, writeJsonAtomic } from "./state.js";

// The literal the app itself ships. Kept as the last rung and as the anchor the
// extractor looks for, so a reworded app is *discovered*, not mis-parsed.
export const BANNER_ANCHOR = "You are a personal assistant running inside OpenClaw.";

// The pin is the anchor plus the section heading, joined the way the app joins
// its prompt lines. Note the blank line: this is the byte shape the app emits,
// and the byte shape the old pin got wrong.
export const PINNED_BANNER = `${BANNER_ANCHOR}\n\n## Tooling`;

export const BANNER_SNAPSHOT_FILE = "banner.last-good.json";
export const BANNER_WARN_INTERVAL_MS = 60 * 60 * 1000;

// The marker a compacted prompt carries where its middle used to be. Loud on
// purpose: an operator reading the upstream request should see that the proxy,
// not the client, removed those bytes.
export const COMPACTION_MARKER =
  "\n\n[... middle of this prompt was dropped by glmproxy to fit PROMPT_ENVELOPE_KB; " +
  "the head and the end of the prompt are intact ...]\n\n";

/**
 * Pull the banner out of a shipped `system-prompt-config-*.js`.
 *
 * The app builds its prompt as an array of lines joined with `"\n"`, opening
 * with the anchor sentence, an empty line, and the `## Tooling` heading. This
 * reads exactly those literals in order — no regex guessing at the heading's
 * neighbours — and stops at the first literal that is neither a blank line nor
 * `## Tooling`, so a future app version that changes what follows still yields a
 * sane (anchor + heading) banner rather than a mangled one.
 *
 * Returns the joined string, or null when the file doesn't look like the app's
 * prompt builder at all.
 */
export function extractBannerFrom(source) {
  if (typeof source !== "string") return null;

  // Scan the file's quoted literals and find the anchor AS A WHOLE LITERAL.
  //
  // The obvious implementation — locate the anchor's text, slice a window from
  // there, then match literals — is a trap: the anchor sits *inside* its own
  // quotes, so the first quote the pattern sees is the closing one and the anchor
  // is never captured. Discovery then silently degrades to the pin forever, which
  // is precisely the failure this layer exists to prevent, and it fails quietly.
  const literals = [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);

  let anchorOnly = null;
  for (let i = 0; i < literals.length; i++) {
    if (literals[i] !== BANNER_ANCHOR) continue;

    const lines = [literals[i]];
    for (let j = i + 1; j < literals.length; j++) {
      const literal = literals[j];
      if (literal === "") { lines.push(""); continue; }        // the blank line
      if (literal === "## Tooling") { lines.push(literal); break; }
      break;                                                   // something else — stop cleanly
    }
    // Trailing blanks alone are not a banner.
    while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

    // Prefer a match that carries the section heading; a version shipping the
    // anchor without one still yields the anchor alone rather than nothing.
    if (lines.length > 1) return lines.join("\n");
    if (anchorOnly === null) anchorOnly = lines.join("\n");
  }

  return anchorOnly;
}

// Newest `system-prompt-config-*.js` in a dist directory, or null.
function newestPromptConfigIn(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return null; }
  let best = null;
  for (const name of entries) {
    if (!/^system-prompt-config-.*\.js$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: stat.mtimeMs };
    } catch (_) { /* unreadable entry — skip */ }
  }
  return best;
}

// Slice a string to at most `maxBytes` UTF-8 bytes without splitting a code point.
function safeSlice(text, maxBytes, fromEnd = false) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let sliced = fromEnd ? buf.subarray(buf.length - maxBytes) : buf.subarray(0, maxBytes);
  let out = sliced.toString("utf8");
  // A split code point becomes U+FFFD at the cut edge; drop those few bytes.
  if (out.includes("\uFFFD")) {
    const cleanFrom = fromEnd ? out.replace(/^\uFFFD+/, "") : out.replace(/\uFFFD+$/, "");
    out = cleanFrom;
  }
  return out;
}

/**
 * Suffix-preserving compaction of one string to a byte envelope.
 *
 * Head and tail kept, middle dropped, marker inserted. The head is favoured by
 * a small margin because the head is where the banner and the tool/identity
 * framing live; the tail still gets the larger share because the tail is where
 * the *actual current request* lives, and losing that is what makes a compaction
 * silently useless.
 */
export function compactString(text, envelopeBytes, marker = COMPACTION_MARKER) {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (!Number.isFinite(envelopeBytes) || envelopeBytes <= 0 || originalBytes <= envelopeBytes) {
    return { text, originalBytes, finalBytes: originalBytes, droppedBytes: 0, compacted: false };
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  // Envelope too small to hold the marker plus anything meaningful — leave the
  // text alone rather than produce a prompt made entirely of marker.
  if (envelopeBytes <= markerBytes + 64) {
    return { text, originalBytes, finalBytes: originalBytes, droppedBytes: 0, compacted: false };
  }
  const keep = envelopeBytes - markerBytes;
  const headBytes = Math.floor(keep * 0.4);
  const tailBytes = keep - headBytes;

  const head = safeSlice(text, headBytes);
  const tail = safeSlice(text, tailBytes, true);
  const out = `${head}${marker}${tail}`;
  return {
    text: out,
    originalBytes,
    finalBytes: Buffer.byteLength(out, "utf8"),
    droppedBytes: originalBytes - Buffer.byteLength(out, "utf8"),
    compacted: true,
  };
}

/**
 * Apply the envelope to a message list. Only the system message is compacted:
 * it is the harness-injected prompt this layer exists for, and a client's own
 * conversation history is none of the proxy's business to truncate.
 *
 * Pure — the input list and its messages are never mutated, which is what lets
 * the entrypoint log the original request while forwarding the compacted one.
 */
export function compactSystemPrompt(messages, envelopeBytes, log = null) {
  const list = Array.isArray(messages) ? messages : [];
  const idx = list.findIndex((m) => m && m.role === "system");
  if (idx === -1) return { messages: list, compacted: false, droppedBytes: 0, originalBytes: 0, finalBytes: 0 };

  const sys = list[idx];
  const raw = typeof sys.content === "string" ? sys.content : null;
  if (raw === null) return { messages: list, compacted: false, droppedBytes: 0, originalBytes: 0, finalBytes: 0 };

  const result = compactString(raw, envelopeBytes);
  if (!result.compacted) return { messages: list, compacted: false, droppedBytes: 0, originalBytes: result.originalBytes, finalBytes: result.finalBytes };

  const next = [...list];
  next[idx] = { ...sys, content: result.text };
  try {
    log?.warn?.(
      `shape: system prompt compacted to the ${Math.round(envelopeBytes / 1024)}KB envelope ` +
      `(${Math.round(result.droppedBytes / 1024)}KB dropped, head and tail kept)`
    );
  } catch (_) { /* logging must never break the request path */ }
  return { messages: next, compacted: true, droppedBytes: result.droppedBytes, originalBytes: result.originalBytes, finalBytes: result.finalBytes };
}

/**
 * Drop blocklisted structural fields from each tool entry.
 *
 * Identity by default (empty blocklist): the audit observed tools reaching the
 * upstream unchanged, so inventing a drop would be guessing. When a field is
 * listed, it is removed and the removal is logged once per request — a silent
 * drop would be exactly the kind of unexplained shape change this layer exists
 * to prevent.
 */
export function filterToolShapes(tools, blocklist, log = null) {
  const list = Array.isArray(tools) ? tools : [];
  const fields = (Array.isArray(blocklist) ? blocklist : []).filter((f) => typeof f === "string" && f);
  if (!fields.length || !list.length) return { tools: list, dropped: [] };

  const dropped = [];
  const out = list.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const hits = fields.filter((f) => Object.prototype.hasOwnProperty.call(tool, f));
    if (!hits.length) return tool;
    const clone = { ...tool };
    for (const f of hits) { delete clone[f]; dropped.push(f); }
    return clone;
  });

  if (dropped.length) {
    const unique = [...new Set(dropped)];
    try { log?.info?.(`shape: dropped tool field(s) not in the app's shape: ${unique.join(", ")}`); } catch (_) {}
  }
  return { tools: out, dropped };
}

/**
 * @param {object} config  loadConfig() output
 * @param {object} log
 * @param {object} clock   { now() } — injectable for deterministic pen tests
 */
export function createShapeLayer(config, log = null, clock = defaultClock) {
  const ttl = config?.TOKEN_TTL_MS || 5 * 60 * 1000;
  const envelopeBytes = Math.round((config?.PROMPT_ENVELOPE_KB || 0) * 1024);
  const blocklist = config?.TOOL_SHAPE_BLOCKLIST || [];

  let _banner = null;
  let _bannerAt = 0;
  let _lastWarnAt = 0;
  let _watchFile = null;
  let _watchTimer = null;

  const info = (m) => { try { log?.info?.(m); } catch (_) {} };
  const warn = (m) => { try { log?.warn?.(m); } catch (_) {} };

  const snapshotPath = () => path.join(stateDir(config), BANNER_SNAPSHOT_FILE);

  // ---- discovery ---------------------------------------------------------

  function fromGatewayDist() {
    for (const dir of config?.GATEWAY_DIST_CANDIDATES || []) {
      const found = newestPromptConfigIn(dir);
      if (!found) continue;
      try {
        const banner = extractBannerFrom(fs.readFileSync(found.file, "utf8"));
        if (banner && banner.includes(BANNER_ANCHOR)) {
          return { text: banner, source: "gateway", file: found.file, observedAt: clock.now() };
        }
      } catch (_) { /* unreadable/corrupt — try the next candidate */ }
    }
    return null;
  }

  function fromSnapshot() {
    const snap = readJsonSafe(snapshotPath(), null, log);
    if (!snap || typeof snap !== "object") return null;
    const text = typeof snap.banner === "string" ? snap.banner : null;
    if (!text || !text.includes(BANNER_ANCHOR)) return null;
    const observedAt = Date.parse(snap.observedAt);
    return {
      text,
      source: "snapshot",
      file: typeof snap.file === "string" ? snap.file : null,
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
    };
  }

  function resolve() {
    const envOverride = process.env.AUTOCLAW_SYSTEM_BANNER;
    if (typeof envOverride === "string" && envOverride.trim()) {
      return { text: envOverride, source: "override", file: null, observedAt: null };
    }
    const discovered = fromGatewayDist() || fromSnapshot() || null;
    if (discovered) return discovered;
    return { text: PINNED_BANNER, source: "pinned", file: null, observedAt: null };
  }

  function capture(shape) {
    if (!shape || shape.source !== "gateway") return;
    try {
      writeJsonAtomic(snapshotPath(), {
        banner: shape.text,
        file: shape.file,
        observedAt: new Date(clock.now()).toISOString(),
        source: "gateway",
      });
    } catch (err) {
      warn(`shape: could not write the banner snapshot (${err.message}) — continuing`);
    }
  }

  function warnPinned() {
    const now = clock.now();
    if (now - _lastWarnAt < BANNER_WARN_INTERVAL_MS) return;
    _lastWarnAt = now;
    warn(
      "shape: running on the pinned system-prompt banner — no AutoClaw install was discoverable, " +
      "so the banner is the compiled-in guess rather than the app's own prompt. " +
      "The X-Harness-Type declaration is what opens the upstream gate; this banner is the belt."
    );
  }

  // ---- public surface ----------------------------------------------------

  function getBanner() {
    const now = clock.now();
    if (_banner && now - _bannerAt < ttl) return _banner;
    const shape = resolve();
    _banner = shape;
    _bannerAt = now;
    if (shape.source === "gateway") capture(shape);
    else if (shape.source === "pinned") warnPinned();
    else if (shape.source === "override") info("shape: AUTOCLAW_SYSTEM_BANNER override active — banner discovery is disabled while it is set");
    return shape;
  }

  function freshness() {
    const shape = getBanner();
    return {
      source: shape.source,
      banner: shape.text,
      file: shape.file,
      ageMs: shape.observedAt != null ? clock.now() - shape.observedAt : null,
      pinned: PINNED_BANNER,
      envelopeKb: envelopeBytes ? Math.round(envelopeBytes / 1024) : 0,
      blocklist: [...blocklist],
    };
  }

  // Prepend the *resolved* banner, never duplicating one the client already sent.
  function injectBanner(messages) {
    const banner = getBanner().text;
    const list = Array.isArray(messages) ? [...messages] : [];
    const idx = list.findIndex((m) => m && m.role === "system");
    if (idx === -1) {
      list.unshift({ role: "system", content: banner });
      return list;
    }
    const sys = list[idx];
    if (typeof sys.content === "string") {
      if (!sys.content.includes(banner)) list[idx] = { ...sys, content: `${banner}\n\n${sys.content}` };
      return list;
    }
    if (Array.isArray(sys.content)) {
      const hasBanner = sys.content.some((p) =>
        typeof p === "string" ? p.includes(banner)
          : p?.type === "text" && typeof p?.text === "string" && p.text.includes(banner));
      if (!hasBanner) list[idx] = { ...sys, content: [{ type: "text", text: banner }, ...sys.content] };
      return list;
    }
    const text = String(sys.content ?? "");
    if (!text.includes(banner)) list[idx] = { ...sys, content: `${banner}\n\n${text}` };
    return list;
  }

  function apply(messages, tools) {
    const injected = injectBanner(messages);
    const compacted = compactSystemPrompt(injected, envelopeBytes, log);
    const filtered = filterToolShapes(tools, blocklist, log);
    return {
      messages: compacted.messages,
      tools: filtered.tools,
      droppedToolFields: filtered.dropped,
      compacted: compacted.compacted,
      droppedBytes: compacted.droppedBytes,
      bannerSource: getBanner().source,
    };
  }

  // Re-read on the hourly cadence so an app update is picked up without a
  // restart; hot-reload on file change is the token-layer precedent.
  function startWatch() {
    if (_watchFile || _watchTimer) return;
    const dir = (config?.GATEWAY_DIST_CANDIDATES || [])[0];
    if (dir) {
      try {
        fs.watchFile(dir, { interval: 5000 }, () => { _banner = null; _bannerAt = 0; });
        _watchFile = dir;
      } catch (_) { /* unwatchable — the TTL re-read still applies */ }
    }
  }

  function stop() {
    if (_watchFile) { try { fs.unwatchFile(_watchFile); } catch (_) {} _watchFile = null; }
    if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
  }

  return {
    getBanner,
    freshness,
    injectBanner,
    compact: (messages) => compactSystemPrompt(messages, envelopeBytes, log),
    filterTools: (tools) => filterToolShapes(tools, blocklist, log),
    apply,
    startWatch,
    stop,
    snapshotPath,
    envelopeBytes,
  };
}
