/**
 * Response decoding — the A2 decision, decoder half (Requirement 2.8).
 *
 * Why this exists even though the upstream does not compress today
 * ---------------------------------------------------------------
 * A probe against the live upstream (`.dbg/accept-encoding-probe-results.json`,
 * 2026-09-21) showed cloud completions come back uncompressed whether or not
 * `br, gzip, deflate` is advertised. So this is not a performance feature and it
 * is inert on today's wire. It exists because the *current* state is not safe
 * either: a request with no `Accept-Encoding` does not forbid compression —
 * RFC 7231 §5.3.4 says absence implies any content-coding is acceptable — so a
 * compressed response is a case the proxy can already receive and cannot handle.
 *
 * What that would do without this module, in order of how much it hurts:
 *
 *   1. **Misclassify errors.** `collectResponse` buffers the body and the result
 *      feeds `classifyUpstreamError`, the governor's ban/throttle detection and
 *      `logUpstreamErrorBody`. Compressed bytes there parse to nothing, so a real
 *      `410004` ban degrades into a generic `403`, the governor stops
 *      quarantining, and a `810002` throttle stops triggering backoff. That is a
 *      *safety-logic* failure, not a crash — the worst kind, and the same class
 *      of misclassification that issue #5 was about.
 *   2. **Serve garbage.** The streaming path pipes the upstream body straight to
 *      the client as `text/event-stream`; compressed bytes arrive as mojibake
 *      with no `data: [DONE]`.
 *
 * Contract: `decodeStream()` returns the ORIGINAL object untouched when there is
 * nothing to decode, so the ordinary path is byte-for-byte what it was. It only
 * builds a decode chain when the response actually carries a content-coding, and
 * it never passes an unknown coding through as if it were text — that throws a
 * typed error the caller can classify loudly.
 *
 * Zero dependencies: `node:zlib` and `node:stream` only.
 */

import { Transform } from "node:stream";
import zlib from "node:zlib";

// What we can decode. The mirror step (A2 second half) will advertise exactly
// this set, so "advertises only what it can decode" stays true by construction.
export const SUPPORTED_ENCODINGS = Object.freeze(["gzip", "x-gzip", "deflate", "br", "identity"]);

// What the real client (undici `fetch`) puts on the wire. Kept here as the
// single source of truth for both the advert and the decode set.
export const DEFAULT_ACCEPT_ENCODING = "br, gzip, deflate";

export class UnsupportedEncodingError extends Error {
  constructor(encoding) {
    super(`Upstream replied with content-encoding "${encoding}", which this proxy cannot decode`);
    this.name = "UnsupportedEncodingError";
    this.code = "UPSTREAM_ENCODING_UNSUPPORTED";
    this.encoding = encoding;
  }
}

export function encodingTokens(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// `identity` is explicitly "no transformation", and an absent header means the
// same thing for our purposes — both must take the untouched path.
export function isEncoded(value) {
  return encodingTokens(value).some((t) => t !== "identity");
}

/**
 * Decompressor for one coding, or null for `identity`.
 *
 * The deflate case is the one that bites in the wild: servers routinely send
 * *raw* deflate with no zlib wrapper, and `createInflate()` rejects that with
 * `Z_DATA_ERROR`. Rather than guess, sniff the first two bytes for a valid zlib
 * header (RFC 1950: CMF low nibble 8, and CMF/FLG divisible by 31) and pick
 * `createInflate()` or `createInflateRaw()` accordingly. Guessing wrong is a
 * hard failure mid-stream, so the sniff has to happen before any output.
 */
class DeflateSniffer extends Transform {
  constructor() {
    super();
    this._head = Buffer.alloc(0);
    this._decoder = null;
  }

  _transform(chunk, _enc, cb) {
    if (this._decoder) {
      if (this._decoder.write(chunk)) return cb();
      return this._decoder.once("drain", cb);
    }

    this._head = Buffer.concat([this._head, chunk]);
    if (this._head.length < 2) return cb(); // need the header bytes before deciding

    const cmf = this._head[0];
    const flg = this._head[1];
    const looksZlib = (cmf & 0x0f) === 8 && (((cmf << 8) | flg) % 31) === 0;

    this._decoder = looksZlib ? zlib.createInflate() : zlib.createInflateRaw();
    this._decoder.on("error", (err) => this.destroy(err));
    this._decoder.on("data", (out) => this.push(out));
    this._decoder.write(this._head);
    this._head = Buffer.alloc(0);
    return cb();
  }

  _flush(cb) {
    if (!this._decoder) return cb(); // a body too short to even hold a header
    this._decoder.on("end", () => cb());
    this._decoder.end();
  }
}

export function decoderFor(token) {
  switch (token) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "br":
      return zlib.createBrotliDecompress();
    case "deflate":
      return new DeflateSniffer();
    case "identity":
      return null;
    default:
      throw new UnsupportedEncodingError(token);
  }
}

/**
 * Wrap an upstream response so its body arrives decoded.
 *
 * Returns the input unchanged when there is nothing to decode — the caller keeps
 * the identical object, `.headers` included, so code that inspects the response
 * (the governor's `Retry-After` read, the entrypoints' `statusCode` check) is
 * unaffected. When a coding IS present we hand back the last decoder in the
 * chain, with the status/headers copied across and the now-meaningless
 * `content-encoding` / `content-length` / `transfer-encoding` removed, because a
 * decoded body must not claim to be encoded and its length has changed.
 *
 * Codings are applied by the server in the order listed and must be undone in
 * reverse (RFC 9110 §8.4).
 */
export function decodeStream(res, { log = null } = {}) {
  const header = res?.headers?.["content-encoding"];
  if (!isEncoded(header)) return res;

  const tokens = encodingTokens(header).filter((t) => t !== "identity");

  // Throws UnsupportedEncodingError before we touch the body — a coding we do not
  // know must fail loudly, never reach the client as if it were text.
  const decoders = [...tokens].reverse().map(decoderFor);
  const last = decoders[decoders.length - 1];

  // `pipe` forwards data and end but NEVER errors. A source-side failure — the
  // upstream resetting mid-body, a truncated member — would therefore leave the
  // decoder, and so the client, waiting for an end that never arrives. Forward
  // it explicitly through every decoder in the chain.
  res.on("error", (err) => {
    for (const d of decoders) { try { d.destroy(err); } catch (_) { /* already gone */ } }
  });

  let stream = res;
  for (let i = 0; i < decoders.length; i++) {
    const decoder = decoders[i];
    stream = stream.pipe(decoder);
    // A failure in an intermediate decoder must reach the consumer too, rather
    // than leaving it waiting on a stream that will never end.
    if (i < decoders.length - 1) decoder.on("error", (err) => last.destroy(err));
  }

  last.statusCode = res.statusCode;
  last.headers = { ...res.headers };
  delete last.headers["content-encoding"];
  delete last.headers["content-length"];
  delete last.headers["transfer-encoding"];
  if (res.httpVersion) last.httpVersion = res.httpVersion;

  try { log?.info?.(`upstream: decoding ${tokens.join(", ")} response body`); } catch (_) {}

  return last;
}

/** Buffered equivalent, for bodies read whole rather than streamed. */
export function decodeBuffer(buf, contentEncoding) {
  if (!isEncoded(contentEncoding)) return buf;
  let out = buf;
  for (const token of encodingTokens(contentEncoding).filter((t) => t !== "identity").reverse()) {
    switch (token) {
      case "gzip":
      case "x-gzip":
        out = zlib.gunzipSync(out);
        break;
      case "br":
        out = zlib.brotliDecompressSync(out);
        break;
      case "deflate": {
        // Same ambiguity as the stream case, resolved by trying the wrapped form
        // first: raw deflate is the fallback, not the assumption.
        try { out = zlib.inflateSync(out); }
        catch (_) { out = zlib.inflateRawSync(out); }
        break;
      }
      default:
        throw new UnsupportedEncodingError(token);
    }
  }
  return out;
}
