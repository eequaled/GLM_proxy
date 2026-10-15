/**
 * Secret Service wire client — pure-Node D-Bus (spec/pure-node).
 *
 * Replaces the last foreign-runtime step in the vault chain: the keyring
 * password probe used to shell out to `python3 -c` with an inline D-Bus
 * script. This module speaks the D-Bus wire protocol directly with node
 * built-ins, so Linux vaults unlock on machines without Python and `lib/`
 * holds no subprocess anywhere.
 *
 * The type engine below covers exactly the subset the Secret Service probe
 * marshals or demarshals, and refuses everything else with a named error
 * rather than guessing:
 *
 *   y  byte            u  uint32         b  boolean (as uint32)
 *   s  string          o  object path    g  signature
 *   v  variant         ay byte array     ao object-path array
 *   a{ss} string dict  (…) struct
 *
 * The writer emits little-endian only; parseMessage refuses a big-endian
 * peer outright — every real Linux session bus is little-endian, and a second
 * byte-order code path would be speculation, not parity.
 *
 * Layer isolation (R3.1): this file is one auditable wire layer. The pure
 * type engine carries no socket, clock or environment; the sections that
 * follow it (bus address, SASL, probe) are the only consumers.
 *
 * Zero dependencies: node built-ins only.
 */

import path from "node:path";

// ── Type engine ──────────────────────────────────────────────────────────────

// Natural alignment per type code, per the D-Bus specification. Arrays align
// at 4 (the length prefix); structs and dict entries at 8.
const ALIGN = { y: 1, b: 4, s: 4, o: 4, g: 1, v: 1, u: 4 };

function typeAlign(type) {
  const c = type[0];
  if (c === "a") return 4;
  if (c === "(" || c === "{") return 8;
  const align = ALIGN[c];
  if (!align) throw new Error(`unsupported D-Bus type: ${type}`);
  return align;
}

// Split a signature string into its top-level complete types.
// "aoao" → ["ao", "ao"];  "(sv)" → ["(sv)"];  "a{ss}s" → ["a{ss}", "s"].
function splitSig(sig) {
  const out = [];
  let i = 0;
  while (i < sig.length) {
    const start = i;
    i = skipCompleteType(sig, i);
    out.push(sig.slice(start, i));
  }
  return out;
}

function skipCompleteType(sig, i) {
  const c = sig[i];
  if (c === "a") return skipCompleteType(sig, i + 1);
  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    let depth = 0;
    while (i < sig.length) {
      if (sig[i] === c) depth++;
      else if (sig[i] === close) { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    throw new Error(`unterminated ${c} in signature: ${sig}`);
  }
  if (!ALIGN[c] && c !== "a") throw new Error(`unsupported D-Bus type: ${c}`);
  return i + 1;
}

// Marshal against a signature. Values are flat and structural, matching the
// signature left to right: a struct consumes its members inline
// ("(sv)" ← ["plain", { sig: "s", value: "" }]), while arrays, dicts and
// variants are each one opaque value ("ao" ← [paths], "a{ss}" ← [{k: v}],
// "v" ← [{ sig, value }]). Variant values are { sig, value } objects; byte
// arrays are Buffers.
export function marshalValues(sig, values) {
  if (!Array.isArray(values)) throw new Error("marshalValues expects an array of values");
  let buf = Buffer.alloc(256);
  let offset = 0;

  const ensure = (n) => {
    if (offset + n <= buf.length) return;
    let size = buf.length;
    while (size < offset + n) size *= 2;
    const next = Buffer.alloc(size);
    buf.copy(next, 0, 0, offset);
    buf = next;
  };
  const pad = (n) => {
    const p = (n - (offset % n)) % n;
    if (p) { ensure(p); buf.fill(0, offset, offset + p); offset += p; }
  };

  const writeStringBody = (str) => {
    const body = Buffer.from(String(str) + "\0", "utf8");
    pad(4); ensure(4 + body.length);
    buf.writeUInt32LE(body.length - 1, offset); offset += 4;
    body.copy(buf, offset); offset += body.length;
  };

  const writeValue = (type, value) => {
    const c = type[0];
    if (c === "y") { pad(1); ensure(1); buf.writeUInt8(value & 0xff, offset); offset += 1; return; }
    if (c === "u") { pad(4); ensure(4); buf.writeUInt32LE(value >>> 0, offset); offset += 4; return; }
    if (c === "b") { pad(4); ensure(4); buf.writeUInt32LE(value ? 1 : 0, offset); offset += 4; return; }
    if (c === "s" || c === "o") { writeStringBody(value); return; }
    if (c === "g") {
      const body = Buffer.from(String(value) + "\0", "ascii");
      if (body.length > 256) throw new Error("signature longer than 255 bytes");
      pad(1); ensure(body.length + 1);
      buf.writeUInt8(body.length - 1, offset); offset += 1;
      body.copy(buf, offset); offset += body.length;
      return;
    }
    if (c === "v") {
      if (!value || typeof value !== "object" || typeof value.sig !== "string") {
        throw new Error("variant value must be { sig, value }");
      }
      writeValue("g", value.sig);
      writeValue(value.sig, value.value);
      return;
    }
    if (c === "a") {
      const elem = type.slice(1);
      if (elem === "y" && Buffer.isBuffer(value)) {
        // Byte arrays arrive as Buffers: length prefix + raw bytes, no padding.
        pad(4); ensure(4 + value.length);
        const lenPos = offset; offset += 4;
        value.copy(buf, offset); offset += value.length;
        buf.writeUInt32LE(value.length, lenPos);
        return;
      }
      let items;
      if (elem === "{ss}") {
        const objs = Array.isArray(value) ? value : [value];
        items = objs.flatMap((o) => Object.entries(o));
      } else {
        if (!Array.isArray(value)) throw new Error(`array value for ${type} must be an array`);
        items = value;
      }
      pad(4); ensure(4);
      const lenPos = offset; offset += 4;
      pad(typeAlign(elem));
      const dataStart = offset;
      for (const item of items) writeValue(elem, item);
      buf.writeUInt32LE(offset - dataStart, lenPos);
      return;
    }
    if (c === "(" || c === "{") {
      const members = splitSig(type.slice(1, -1));
      if (c === "(" && !Array.isArray(value)) throw new Error("struct value must be an array of member values");
      if (c === "{" && (!Array.isArray(value) || value.length !== 2)) {
        throw new Error("dict entry value must be a [key, value] pair");
      }
      if (members.length !== value.length) {
        throw new Error(`value count does not match ${type}`);
      }
      pad(8);
      members.forEach((t, i) => writeValue(t, value[i]));
      return;
    }
    throw new Error(`unsupported D-Bus type: ${type}`);
  };

  // Top-level dispatch: a struct's members arrive flattened, so it consumes
  // as many values as it has members; every other type consumes exactly one.
  let vi = 0;
  const take = (n) => {
    if (vi + n > values.length) throw new Error(`signature ${sig} expects more values`);
    const slice = values.slice(vi, vi + n);
    vi += n;
    return slice;
  };
  for (const type of splitSig(sig)) {
    if (type[0] === "(") {
      const members = splitSig(type.slice(1, -1));
      writeValue(type, take(members.length));
    } else {
      writeValue(type, take(1)[0]);
    }
  }
  if (vi !== values.length) throw new Error(`signature ${sig} got ${values.length} values, expected ${vi}`);
  return buf.slice(0, offset);
}

// Demarshal from a buffer. Throws narrow, named errors on truncated or
// malformed input — callers (parseMessage, the probe) catch and classify.
export function unmarshalValues(sig, buffer, startOffset = 0) {
  let offset = startOffset;

  const take = (n) => {
    if (offset + n > buffer.length) throw new Error("truncated D-Bus payload");
  };
  const align = (n) => { offset += (n - (offset % n)) % n; };

  const readValue = (type) => {
    const c = type[0];
    if (c === "y") { take(1); return buffer.readUInt8(offset++); }
    if (c === "u" || c === "b") {
      align(4); take(4);
      const v = buffer.readUInt32LE(offset); offset += 4;
      return c === "b" ? v !== 0 : v;
    }
    if (c === "s" || c === "o") {
      align(4); take(4);
      const len = buffer.readUInt32LE(offset); offset += 4;
      take(len + 1);
      const str = buffer.slice(offset, offset + len).toString("utf8");
      offset += len + 1;
      return str;
    }
    if (c === "g") {
      take(1);
      const len = buffer.readUInt8(offset); offset += 1;
      take(len + 1);
      const str = buffer.slice(offset, offset + len).toString("ascii");
      offset += len + 1;
      return str;
    }
    if (c === "v") {
      const inner = readValue("g");
      return { sig: inner, value: readValue(inner) };
    }
    if (c === "a") {
      const elem = type.slice(1);
      align(4); take(4);
      const len = buffer.readUInt32LE(offset); offset += 4;
      align(typeAlign(elem));
      const end = offset + len;
      if (end > buffer.length) throw new Error("array length overruns the payload");
      if (elem === "{ss}") {
        const obj = {};
        while (offset < end) {
          const [key, value] = readValue(elem);
          obj[key] = value;
        }
        if (offset !== end) throw new Error("array element overrun");
        return obj;
      }
      if (elem === "y") {
        // Byte arrays come back as Buffers — the Secret struct's params/value.
        take(len);
        const out = Buffer.from(buffer.slice(offset, offset + len));
        offset += len;
        return out;
      }
      const arr = [];
      while (offset < end) arr.push(readValue(elem));
      if (offset !== end) throw new Error("array element overrun");
      return arr;
    }
    if (c === "(" || c === "{") {
      align(8);
      return splitSig(type.slice(1, -1)).map((t) => readValue(t));
    }
    throw new Error(`unsupported D-Bus type: ${type}`);
  };

  // Top-level assembly mirrors marshalValues: a struct's members come back
  // flattened, every other type is one value.
  const values = [];
  for (const type of splitSig(sig)) {
    const v = readValue(type);
    if (type[0] === "(") values.push(...v);
    else values.push(v);
  }
  return { values, offset };
}

// ── Message framing ──────────────────────────────────────────────────────────
//
// Header: 'l', type, flags, version 1, u32 body length, u32 serial, then the
// a(yv) header-field array. The body follows at the next 8-byte boundary.
// Fields are written in code order so frames are deterministic.

const FIELD_TYPES = { 1: "o", 2: "s", 3: "s", 4: "s", 5: "u", 6: "s", 7: "s", 8: "g" };

export function marshalMessage({ type, flags = 0, serial, fields = {}, signature = null, body = null }) {
  const codes = Object.keys(fields).map(Number).sort((a, b) => a - b);
  for (const code of codes) {
    if (!FIELD_TYPES[code]) throw new Error(`unknown D-Bus header field: ${code}`);
  }
  if (body && !signature) throw new Error("a message with a body needs a signature");

  let buf = Buffer.alloc(256);
  let offset = 0;
  const ensure = (n) => {
    if (offset + n <= buf.length) return;
    let size = buf.length;
    while (size < offset + n) size *= 2;
    const next = Buffer.alloc(size);
    buf.copy(next, 0, 0, offset);
    buf = next;
  };
  const pad = (n) => {
    const p = (n - (offset % n)) % n;
    if (p) { ensure(p); buf.fill(0, offset, offset + p); offset += p; }
  };

  ensure(4);
  buf[0] = 0x6c; buf[1] = type; buf[2] = flags; buf[3] = 1;
  offset = 4;
  const bodyLenPos = offset; offset += 4;
  ensure(4); buf.writeUInt32LE(serial >>> 0, offset); offset += 4;
  const fieldsLenPos = offset; offset += 4;
  const dataStart = offset;

  for (const code of codes) {
    pad(8);
    ensure(1); buf.writeUInt8(code, offset); offset += 1;
    // field variant: signature + value, using the fixed per-code type
    const fsig = FIELD_TYPES[code];
    ensure(3); buf.writeUInt8(1, offset); buf.write(fsig, offset + 1, "ascii"); buf.writeUInt8(0, offset + 2);
    offset += 3;
    const v = fields[code];
    if (fsig === "u") {
      pad(4); ensure(4); buf.writeUInt32LE(v >>> 0, offset); offset += 4;
    } else if (fsig === "g") {
      ensure(1); buf.writeUInt8(String(v).length, offset); offset += 1;
      const b = Buffer.from(String(v) + "\0", "ascii");
      ensure(b.length); b.copy(buf, offset); offset += b.length;
    } else {
      const b = Buffer.from(String(v) + "\0", "utf8");
      pad(4); ensure(4 + b.length);
      buf.writeUInt32LE(b.length - 1, offset); offset += 4;
      b.copy(buf, offset); offset += b.length;
    }
  }
  buf.writeUInt32LE(offset - dataStart, fieldsLenPos);

  pad(8);
  if (body) {
    ensure(body.length);
    body.copy(buf, offset); offset += body.length;
  }
  buf.writeUInt32LE(body ? body.length : 0, bodyLenPos);
  return buf.slice(0, offset);
}

// Parse one message from the start of a buffer. Returns
// { type, flags, serial, replySerial, errorName, sender, signature, body, end }
// where `end` is the offset just past this message (a socket stream holds the
// next one there), or null on anything unparseable. Never throws: the probe
// classifies a null as protocol_error, and a null cannot crash a request.
export function parseMessage(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
    if (buffer[0] !== 0x6c) return null; // little-endian only; 'B' peers unsupported by design
    const type = buffer[1];
    const flags = buffer[2];
    if (buffer[3] !== 1) return null;
    const bodyLength = buffer.readUInt32LE(4);
    const serial = buffer.readUInt32LE(8);
    const fieldsLength = buffer.readUInt32LE(12);
    if (16 + fieldsLength > buffer.length) return null;

    let replySerial = null;
    let errorName = null;
    let sender = null;
    let signature = null;

    let o = 16;
    const fieldsEnd = 16 + fieldsLength;
    while (o < fieldsEnd) {
      o += (8 - (o % 8)) % 8;
      if (o >= fieldsEnd) return null; // padding ran into the boundary: malformed
      const code = buffer.readUInt8(o); o += 1;
      const sigLen = buffer.readUInt8(o); o += 1;
      if (o + sigLen + 1 > fieldsEnd) return null;
      const fsig = buffer.slice(o, o + sigLen).toString("ascii"); o += sigLen + 1;
      let value;
      if (fsig === "y") {
        value = buffer.readUInt8(o); o += 1;
      } else if (fsig === "u") {
        o += (4 - (o % 4)) % 4;
        value = buffer.readUInt32LE(o); o += 4;
      } else if (fsig === "g") {
        const l = buffer.readUInt8(o); o += 1;
        value = buffer.slice(o, o + l).toString("ascii"); o += l + 1;
      } else if (fsig === "s" || fsig === "o") {
        o += (4 - (o % 4)) % 4;
        const l = buffer.readUInt32LE(o); o += 4;
        value = buffer.slice(o, o + l).toString("utf8"); o += l + 1;
      } else {
        return null; // a header variant outside the legal set: refuse, don't guess
      }
      if (code === 4) errorName = value;
      else if (code === 5) replySerial = value;
      else if (code === 7) sender = value;
      else if (code === 8) signature = value;
    }
    o = 16 + fieldsLength;
    o += (8 - (o % 8)) % 8;
    if (o + bodyLength > buffer.length) return null;
    const body = buffer.slice(o, o + bodyLength);

    return { type, flags, serial, replySerial, errorName, sender, signature, body, end: o + bodyLength };
  } catch {
    return null;
  }
}

// ── Bus address ──────────────────────────────────────────────────────────────

// A D-Bus address is a `;`-separated list of candidates, each `transport:key=value,…`.
// Only the two same-host unix transports are usable here, and the first
// candidate that names one wins. `tcp:` is skipped rather than guessed at: this
// probe only ever talks to the local session bus, and connecting to an address
// the environment merely mentions is how a probe starts reaching the wrong peer.
//
// The path is POSIX regardless of the host running the parser — a bus socket is
// a POSIX path by definition — so `path.posix` is used deliberately, and a
// `resolveBusAddress` unit case stays meaningful on a Windows dev box.
const BUS_UNIX_RE = /unix:(path|abstract)=([^,;]+)/;

/**
 * Resolve the session-bus address for the *caller's* env (injected, never read
 * from `process.env` behind the caller's back). Returns `{ kind, target }` where
 * kind is `"path"` or `"abstract"`, or null.
 *
 *   DBUS_SESSION_BUS_ADDRESS → first usable unix candidate (tcp-only ⇒ null,
 *                              *not* a silent XDG fallback: the env var is a
 *                              deliberate statement about where the bus is)
 *   $XDG_RUNTIME_DIR/bus     → when the env var is absent or empty
 *   neither                  → null
 */
export function resolveBusAddress(env = process.env) {
  const raw = typeof env?.DBUS_SESSION_BUS_ADDRESS === "string" ? env.DBUS_SESSION_BUS_ADDRESS.trim() : "";
  if (raw) {
    for (const candidate of raw.split(";")) {
      const match = BUS_UNIX_RE.exec(candidate);
      if (match) return { kind: match[1], target: match[2] };
    }
    return null;
  }

  const xdg = typeof env?.XDG_RUNTIME_DIR === "string" ? env.XDG_RUNTIME_DIR.trim() : "";
  if (xdg) return { kind: "path", target: path.posix.join(xdg, "bus") };
  return null;
}
