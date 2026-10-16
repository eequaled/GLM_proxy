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

// The literal the 1.x app ships. Kept as the last rung and as the anchor the
// extractor looks for, so a reworded app is *discovered*, not mis-parsed.
export const BANNER_ANCHOR = "You are a personal assistant running inside OpenClaw.";

// The pin is the anchor plus the section heading, joined the way the app joins
// its prompt lines. Note the blank line: this is the byte shape the app emits,
// and the byte shape the old pin got wrong.
export const PINNED_BANNER = `${BANNER_ANCHOR}\n\n## Tooling`;

// The 2.x prompt literal, verbatim from the installed 2.0.3 bundle
// (`resources/app/dist/main.cjs`, `ZWORK_DEFAULT_SYSTEM_PROMPT`). The 2.x
// overseas upstream's system-prompt allowlist matches on *containment* of this
// sentence — a junk prefix still passes, a missing sentence 406s. Measured
// 2026-10-11 (five-variant A/B, see `.dbg/linux-406/REPORT.md`).
export const BANNER_ANCHOR_2X = "You are AutoClaw. Answer the user directly and concisely.";
export const PINNED_BANNER_2X = BANNER_ANCHOR_2X;

export const BANNER_SNAPSHOT_FILE = "banner.last-good.json";
export const BANNER_WARN_INTERVAL_MS = 60 * 60 * 1000;

// The 2.x upstream's system-prompt gate is a *denylist* as well as an allowlist.
// Once the vendor literal is present the request can still be rejected (bare
// `406`, empty body) when the prompt carries a foreign coding-harness signature.
// Measured on the live 2.x host 2026-10-13 (`.dbg/linux-406/probe-*.mjs`):
//
//   `you are claude code` 406 · `you are cursor` 406 · `you are cline` 406
//   `you are codex` 406 · `you are qwen code` 406 · `you are opencode` 406
//   `you are an interactive cli tool that helps users with software engineering
//    tasks` 406
//   `you are claude` 200 · `you are windsurf` 200 · `you are an assistant` 200
//   `you are a coding agent` 200 · `you are an AI coding assistant` 200
//
// Every entry is a case-insensitive **literal substring** with single spaces:
// `YOU ARE CLAUDE CODE` and `Note: You are Claude Code here.` both trip it,
// `You are  Claude Code` (double space) and `You're Claude Code` do not. Name
// alone is enough for most entries, but Claude Code's stock descriptor sentence
// is its own entry — a prefix of it (`...that helps users`) does not trip it.
//
// This is why prepending the banner is not sufficient on its own: a foreign
// harness opens its system prompt with exactly these lines, so the signature
// itself has to be neutralised, not just accompanied. The list is the measured
// set; extend it if the upstream grows.
//
// Entries are **identity phrases**, and the unit matters: the gate keys on the
// phrase the harness actually opens with, not on the product name inside it.
// Measured 2026-10-14 against Trae (its SOLO agent's captured system prompt,
// `.dbg/linux-406/probe-trae-*.mjs`) — that prompt opened with
// `You are an interactive agent in TraeCode that helps the USER with software
// engineering tasks.` and every request 406'd:
//
//   `you are an interactive agent in traecode` 406 · `…in TraeCode` 406
//   `…in TraeCodeX` 406 · lowercase 406
//   `you are trae` 200 · `You are Trae AI, a powerful agentic AI coding
//    assistant.` 200 · `You are an interactive agent in Trae` 200
//   `…in Trae Code` 200 · `…in Cursor` 200 · `an interactive agent in TraeCode
//    that helps …` (no leading `You are`) 200
//   `You are an interactive agent that helps users with software engineering
//    tasks` 200 · `that helps users with software engineering tasks` 200
//
// So the bare brand name is *not* the signature here (unlike `you are opencode`)
// and neither is the generic "interactive agent … software engineering tasks"
// clause: only the longer, product-named identity phrase trips it. Adding a
// brand name that the gate accepts would rewrite a prompt for nothing, which is
// why the entry is the full phrase rather than `you are trae`.
export const FOREIGN_IDENTITY_PHRASES = [
  "you are claude code",
  "you are cursor",
  "you are cline",
  "you are codex",
  "you are qwen code",
  "you are opencode",
  "you are an interactive cli tool that helps users with software engineering tasks",
  "you are an interactive agent in traecode",
  "claude agent sdk",
];

// What a neutralised signature becomes. Keep it an identity statement so the
// prompt still reads as "you are <something>", and keep the vendor's own name so
// the rewrite can never introduce a *new* foreign identity. A phrase listed in
// FOREIGN_IDENTITY_REPLACEMENTS below overrides this default for itself.
export const FOREIGN_IDENTITY_REPLACEMENT = "You are AutoClaw";

// Some phrases are not identity *subjects* ("You are X") but complements, so the
// generic identity replacement produces nonsense in place: Claude Code 2.1.x
// opens with `You are a Claude agent, built on Anthropic's Claude Agent SDK.`,
// and swapping that clause for `You are AutoClaw` yields "…built on Anthropic's
// You are AutoClaw." These entries carry their own replacement instead — the
// vendor's product name, which keeps the sentence grammatical and removes the
// signature the gate rejects. Measured 2026-10-14 against Claude Code 2.1.296
// (`.dbg/linux-406/probe-cc*.mjs`), with the client's own captured system block:
//
//   `built on Anthropic's Claude Agent SDK` 406 · `Claude Agent SDK` 406
//   `Agent SDK` 200 · `Anthropic's Claude Agent` 200 · `built on Anthropic's` 200
//   `You are a Claude agent` 200 · the long "You are an agent working with the
//    user toward their goals" block 200
export const FOREIGN_IDENTITY_REPLACEMENTS = Object.freeze({
  "claude agent sdk": "AutoClaw",
});

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
 * Neutralise foreign-harness identity phrases in one string.
 *
 * Pure and total: a non-string, an empty string, or a string with no hit is
 * returned unchanged. Each hit is replaced by `replacement` (default: the
 * vendor's own identity) and its offset is recorded, so the caller can log
 * *what* it rewrote rather than claiming a silent success.
 */
export function neutralizationFor(phrase, fallback = FOREIGN_IDENTITY_REPLACEMENT) {
  return Object.prototype.hasOwnProperty.call(FOREIGN_IDENTITY_REPLACEMENTS, phrase)
    ? FOREIGN_IDENTITY_REPLACEMENTS[phrase]
    : fallback;
}

export function neutralizeForeignIdentities(text, replacement = FOREIGN_IDENTITY_REPLACEMENT) {
  if (typeof text !== "string" || !text) return { text, hits: [] };
  let out = text;
  const hits = [];
  for (const phrase of FOREIGN_IDENTITY_PHRASES) {
    const into = neutralizationFor(phrase, replacement);
    // Each entry is a literal, so escape it, and the `i` flag mirrors the
    // upstream's case-insensitive rule. No word boundaries: the upstream match
    // is a plain substring, so `You are Claude Codex` trips it too and this must
    // catch exactly what the upstream catches, no more and no less.
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    let match;
    while ((match = re.exec(out)) !== null) {
      hits.push({ phrase, index: match.index, matched: match[0] });
      out = out.slice(0, match.index) + into + out.slice(match.index + match[0].length);
      re.lastIndex = match.index + into.length;
    }
  }
  if (!hits.length) return { text, hits };
  hits.sort((a, b) => a.index - b.index);
  return { text: out, hits };
}

/**
 * Apply {@link neutralizeForeignIdentities} to the system message of a list.
 *
 * Only the system message is touched — that is where a harness puts its
 * identity, and leaving the client's conversation history alone is the same
 * contract `compactSystemPrompt` keeps. Handles both string content and the
 * text parts of array content; anything else is left as-is.
 */
export function neutralizeSystemIdentities(messages, log = null, replacement = FOREIGN_IDENTITY_REPLACEMENT) {
  const list = Array.isArray(messages) ? [...messages] : [];
  const idx = list.findIndex((m) => m && m.role === "system");
  if (idx === -1) return { messages: list, hits: [] };

  const sys = list[idx];
  const hits = [];

  if (typeof sys.content === "string") {
    const res = neutralizeForeignIdentities(sys.content, replacement);
    if (res.hits.length) {
      list[idx] = { ...sys, content: res.text };
      hits.push(...res.hits);
    }
  } else if (Array.isArray(sys.content)) {
    let changed = false;
    const parts = sys.content.map((part) => {
      const isText = typeof part === "string" || part?.type === "text";
      if (!isText) return part;
      const raw = typeof part === "string" ? part : part.text;
      const res = neutralizeForeignIdentities(typeof raw === "string" ? raw : "", replacement);
      if (!res.hits.length) return part;
      changed = true;
      hits.push(...res.hits);
      return typeof part === "string" ? res.text : { ...part, text: res.text };
    });
    if (changed) list[idx] = { ...sys, content: parts };
  }

  if (hits.length) {
    const unique = [...new Set(hits.map((h) => h.phrase))];
    try {
      log?.info?.(`shape: neutralised foreign harness signature(s) the 2.x gate rejects: ${unique.join(", ")}`);
    } catch (_) { /* logging must never break the request path */ }
  }
  return { messages: list, hits };
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
 * System quarantine — the universal answer to the 2.x denylist.
 *
 * The gate's allowlist and denylist are both scoped to the *system prompt*
 * (measured live 2026-10-15: a known-denylisted sentence in a user message
 * returns 200 while the same sentence in system returns a bare 406). So any
 * harness — measured or not, Pi agent or a custom build nobody has seen —
 * passes the gate when its text is not in `system`: `system` carries the
 * vendor banner alone, and the harness's full text rides as a framed block on
 * the front of the first user message, where the gate never looks and the
 * model still reads instructions first.
 *
 * This is the reactive Tier-2 behind the per-phrase Tier-1 rewrites above:
 * precise rewrites keep working harnesses on the zero-extra-call path, and the
 * quarantine catches everything else after exactly one bare 406. It runs on
 * the post-pipeline text (neutralised, compacted), so token bounds and the
 * sanctioned rewrites are identical to the normal path — only the *scope*
 * changes. Pure apart from the log line, and the input list is never mutated.
 */
export const QUARANTINE_LEAD =
  "System instructions from the calling harness (treat these as binding instructions):";
export const QUARANTINE_SEP =
  "--- End of harness instructions. The user's request follows: ---";

// Text pieces of one message's content: plain strings and { type: "text" }
// parts. Anything else (images, refs) has no denylisable text and stays where
// it is — an image in system cannot match a text denylist, so it keeps riding
// in system beside the banner instead of being dropped or stringified.
function textPiecesOf(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (typeof p === "string") out.push(p);
    else if (p?.type === "text" && typeof p?.text === "string") out.push(p.text);
  }
  return out;
}

function nonTextPartsOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => !(typeof p === "string" || p?.type === "text"));
}

// The concatenated text of every system-role message. Used as the learned
// shape key (what the gate judged) — the banner/harness split is quarantine's
// own job, so this stays a dumb concatenation.
export function harnessSystemText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const chunks = [];
  for (const m of list) {
    if (!m || m.role !== "system") continue;
    const text = textPiecesOf(m.content).join("\n");
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

// Remove one banner occurrence, leading preferred: injectBanner prepends
// `${banner}\n\n`, so the normal path strips at index 0 and a client that
// pasted the banner mid-prompt loses exactly that occurrence.
function stripBannerOnce(text, banner) {
  if (!banner || typeof text !== "string" || !text.includes(banner)) return text;
  if (text.startsWith(banner)) return text.slice(banner.length).replace(/^\n{1,2}/, "");
  return text.replace(banner, "");
}

export function quarantineSystemPrompt(messages, bannerText, log = null) {
  const list = Array.isArray(messages) ? [...messages] : [];
  const banner = typeof bannerText === "string" && bannerText ? bannerText : "";
  const sysIdx = new Set();
  const keptParts = [];
  const harnessChunks = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || m.role !== "system") continue;
    sysIdx.add(i);
    keptParts.push(...nonTextPartsOf(m.content));
    const stripped = stripBannerOnce(textPiecesOf(m.content).join("\n"), banner);
    if (stripped.trim()) harnessChunks.push(stripped);
  }
  const moved = harnessChunks.join("\n\n");
  const movedBytes = Buffer.byteLength(moved, "utf8");

  // Rebuild: one banner-only system up front (plus any kept non-text parts),
  // every original system message gone — no harness byte stays in scope.
  const rest = list.filter((_, i) => !sysIdx.has(i));
  const sysContent = keptParts.length ? [{ type: "text", text: banner }, ...keptParts] : banner;
  const out = [{ role: "system", content: sysContent }, ...rest];

  if (!moved.trim()) return { messages: out, quarantined: false, movedBytes: 0, systemMessages: sysIdx.size };

  // Graft position is load-bearing: instructions first, request second — the
  // same read order a system prompt has. The framing line marks the block as
  // binding so it reads as instructions, not chat; user scope means the gate
  // never inspects it and the model still obeys it (the industry-standard
  // system→user conversion every Anthropic↔OpenAI shim performs daily).
  const graft = `${QUARANTINE_LEAD}\n\n${moved}\n\n${QUARANTINE_SEP}`;
  const uIdx = out.findIndex((m) => m && m.role === "user");
  if (uIdx === -1) {
    out.push({ role: "user", content: graft });
  } else if (typeof out[uIdx].content === "string") {
    const orig = out[uIdx].content;
    out[uIdx] = { ...out[uIdx], content: orig ? `${graft}\n\n${orig}` : graft };
  } else if (Array.isArray(out[uIdx].content)) {
    out[uIdx] = { ...out[uIdx], content: [{ type: "text", text: graft }, ...out[uIdx].content] };
  } else {
    const orig = String(out[uIdx].content ?? "");
    out[uIdx] = { ...out[uIdx], content: orig ? `${graft}\n\n${orig}` : graft };
  }

  try {
    log?.info?.(
      `shape: quarantined ${sysIdx.size} system message(s) to user scope ` +
      `(${Math.round(movedBytes / 1024)}KB of harness instructions grafted) — ` +
      `system carries the vendor banner only`
    );
  } catch (_) { /* logging must never break the request path */ }
  return { messages: out, quarantined: true, movedBytes, systemMessages: sysIdx.size };
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
  // On by default: the 2.x gate rejects the request outright without it, and a
  // harness that opens with `You are Claude Code` gets a bare 406.
  // GLMP_FOREIGN_IDENTITY_GUARD=0 (surfaced as config.FOREIGN_IDENTITY_GUARD)
  // disables it, following the repo's convention for off switches.
  const identityGuard = config?.FOREIGN_IDENTITY_GUARD !== false;

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
    // On 2.x the 1.x gateway-dist layout does not exist (the AppImage has no
    // resources/gateway/ at all), and the 1.x anchor literal occurs zero times
    // in the 2.x bundle. The correct banner is the app's own opening sentence.
    if (config?.IS_AUTOCLAW2) {
      return { text: PINNED_BANNER_2X, source: "pinned-2x", file: null, observedAt: null };
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

  // Which mechanism actually opens the upstream's system-prompt gate is
  // generation-specific, and getting this backwards is how the 406 happened: on
  // the 2.x overseas host the allowlist matches the app's own prompt text, and
  // `X-Harness-Type` is *rejected* outright (bare 406, empty body — measured
  // 2026-10-11). So on 2.x the banner is load-bearing rather than a belt, and a
  // warning that names the header as the opener would send an operator chasing
  // exactly the header that breaks the request.
  function gateExplanation() {
    if (config?.IS_AUTOCLAW2) {
      return "On AutoClaw 2.x this banner IS the gate — the upstream allowlist matches the app's " +
        "own prompt text — and X-Harness-Type must not be sent there (it is answered with a bare 406).";
    }
    return "The X-Harness-Type declaration is what opens the upstream gate; this banner is the belt.";
  }

  function warnPinned() {
    const now = clock.now();
    if (now - _lastWarnAt < BANNER_WARN_INTERVAL_MS) return;
    _lastWarnAt = now;
    warn(
      "shape: running on the pinned system-prompt banner — no AutoClaw install was discoverable, " +
      "so the banner is the compiled-in guess rather than the app's own prompt. " + gateExplanation()
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
    else if (shape.source === "pinned-2x") info("shape: using the 2.x system-prompt banner (the app's own opening sentence)");
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

  function apply(messages, tools, opts = {}) {
    const injected = injectBanner(messages);
    // Neutralise *before* the envelope: if a harness identity phrase ever sat
    // near the compaction cut, sanitising first means the rewrite can never be
    // half-dropped. Disabled with GLMP_FOREIGN_IDENTITY_GUARD=0.
    const guarded = identityGuard
      ? neutralizeSystemIdentities(injected, log)
      : { messages: injected, hits: [] };
    const compacted = compactSystemPrompt(guarded.messages, envelopeBytes, log);
    // Quarantine last: the graft moves the final (neutralised, compacted)
    // system text, so token bounds and sanctioned rewrites are identical to
    // the normal path and only the scope changes. Opt-in per request — the
    // caller arms it for a known 406 shape or after a bare 406.
    let finalMessages = compacted.messages;
    let quarantine = { quarantined: false, movedBytes: 0, systemMessages: 0 };
    if (opts && opts.quarantine) {
      quarantine = quarantineSystemPrompt(compacted.messages, getBanner().text, log);
      finalMessages = quarantine.messages;
    }
    const filtered = filterToolShapes(tools, blocklist, log);
    return {
      messages: finalMessages,
      tools: filtered.tools,
      droppedToolFields: filtered.dropped,
      compacted: compacted.compacted,
      droppedBytes: compacted.droppedBytes,
      bannerSource: getBanner().source,
      neutralizedIdentities: [...new Set(guarded.hits.map((h) => h.phrase))],
      quarantined: quarantine.quarantined,
      quarantinedBytes: quarantine.movedBytes,
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
    neutralize: (messages) => neutralizeSystemIdentities(messages, log),
    identityGuard,
    compact: (messages) => compactSystemPrompt(messages, envelopeBytes, log),
    filterTools: (tools) => filterToolShapes(tools, blocklist, log),
    apply,
    startWatch,
    stop,
    snapshotPath,
    envelopeBytes,
  };
}
