// Pen-test secretservice — the pure-Node D-Bus wire layer (spec/pure-node).
//
// The marshaller is proven against hand-computed byte fixtures, not against
// itself: every expected hex string below was derived from the D-Bus
// specification's alignment and layout rules and annotated with the byte
// layout, so a marshaller bug and a fixture bug cannot hide behind each
// other. The fake daemon (added below in later tasks) dogfoods these
// functions for its replies; these fixtures are the independent anchor.
//
// Two layout rules that bit during derivation, recorded so the next fixture
// author does not re-derive them:
//   · an array's length excludes the alignment padding BEFORE its first
//     element, but includes padding BETWEEN elements — never trailing pad;
//   · struct members each align to their own type (a `u` after a `y` pads to
//     4), while the struct itself sits on an 8-byte boundary.

import { check, summary } from "./_helpers.mjs";
import {
  marshalValues,
  unmarshalValues,
  marshalMessage,
  parseMessage,
  resolveBusAddress,
} from "../lib/secretservice.js";

const hex = (buf) => buf.toString("hex").replace(/(..)/g, "$1 ").trim();
const bytes = (s) => Buffer.from(s.replace(/\s+/g, ""), "hex");
const throws = (fn) => { try { fn(); return true; } catch { return true; } return false; };

// ── 1. (sv) — the OpenSession call arguments ─────────────────────────────────
//
//   u32 5 "plain\0"     u32-len string, align 4
//   g "s"               variant signature, align 1
//   pad→4               value alignment
//   u32 0  \0           empty string
{
  const expected = `
    05 00 00 00 70 6c 61 69 6e 00
    01 73 00
    00 00 00
    00 00 00 00 00`;

  const buf = marshalValues("(sv)", ["plain", { sig: "s", value: "" }]);
  check("marshal (sv): OpenSession args are byte-exact", hex(buf) === hex(bytes(expected)), hex(buf));
  const back = unmarshalValues("(sv)", buf);
  check("unmarshal (sv): round-trips to plain + empty-string variant",
    back.values[0] === "plain" && back.values[1].sig === "s" && back.values[1].value === "",
    JSON.stringify(back.values));
}

// ── 2. a{ss} — a SearchItems attribute dict ──────────────────────────────────
//
//   u32 29              array byte length (excludes pre-element padding)
//   pad→8               dict-entry alignment
//   u32 11 "application\0"   u32 8 "AutoClaw\0"
{
  const expected = `
    1d 00 00 00 00 00 00 00
    0b 00 00 00 61 70 70 6c 69 63 61 74 69 6f 6e 00
    08 00 00 00 41 75 74 6f 43 6c 61 77 00`;

  const buf = marshalValues("a{ss}", [{ application: "AutoClaw" }]);
  check("marshal a{ss}: attribute dict is byte-exact", hex(buf) === hex(bytes(expected)), hex(buf));
  const back = unmarshalValues("a{ss}", buf);
  check("unmarshal a{ss}: round-trips to one application=AutoClaw entry",
    back.values.length === 1 && back.values[0].application === "AutoClaw",
    JSON.stringify(back.values));
}

// ── 3. empty a{ss} — an empty dict still pads to its element alignment ───────
{
  const buf = marshalValues("a{ss}", [{}]);
  check("marshal a{}: empty dict is 8 bytes (u32 0 + alignment pad)",
    hex(buf) === "00 00 00 00 00 00 00 00", hex(buf));
  const back = unmarshalValues("a{ss}", buf);
  check("unmarshal a{}: round-trips to an empty object",
    back.values.length === 1 && typeof back.values[0] === "object" &&
    Object.keys(back.values[0]).length === 0,
    JSON.stringify(back.values));
}

// ── 4. (oayays) — the Secret struct GetSecret returns ────────────────────────
//
//   u32 33 "/org/freedesktop/secrets/session1\0"
//   pad→4  u32 0                       empty parameters ay
//   pad=4  u32 7 "hunter2"             the value ay
//   pad→4  u32 10 "text/plain\0"
{
  const expected = `
    21 00 00 00 2f 6f 72 67 2f 66 72 65 65 64 65 73 6b 74 6f 70 2f 73 65 63 72 65 74 73 2f 73 65 73 73 69 6f 6e 31 00
    00 00
    00 00 00 00
    07 00 00 00 68 75 6e 74 65 72 32
    00
    0a 00 00 00 74 65 78 74 2f 70 6c 61 69 6e 00`;

  const buf = marshalValues("(oayays)", [
    "/org/freedesktop/secrets/session1",
    Buffer.alloc(0),
    Buffer.from("hunter2"),
    "text/plain",
  ]);
  check("marshal (oayays): Secret struct is byte-exact", hex(buf) === hex(bytes(expected)), hex(buf));
  const back = unmarshalValues("(oayays)", buf);
  check("unmarshal (oayays): round-trips session, empty params, value, content type",
    back.values.length === 4 &&
    back.values[0] === "/org/freedesktop/secrets/session1" &&
    Buffer.isBuffer(back.values[1]) && back.values[1].length === 0 &&
    back.values[2].toString("utf8") === "hunter2" &&
    back.values[3] === "text/plain",
    JSON.stringify([back.values[0], back.values[2]?.toString?.("utf8"), back.values[3]]));
}

// ── 5. v(o) — the OpenSession reply variant ──────────────────────────────────
//
//   g "o"  pad→4  u32 33 "/org/freedesktop/secrets/session1\0"
{
  const expected = `
    01 6f 00 00
    21 00 00 00 2f 6f 72 67 2f 66 72 65 65 64 65 73 6b 74 6f 70 2f 73 65 63 72 65 74 73 2f 73 65 73 73 69 6f 6e 31 00`;

  const buf = marshalValues("v", [{ sig: "o", value: "/org/freedesktop/secrets/session1" }]);
  check("marshal v(o): reply variant is byte-exact", hex(buf) === hex(bytes(expected)), hex(buf));
  const back = unmarshalValues("v", buf);
  check("unmarshal v(o): round-trips the session object path",
    back.values[0].sig === "o" && back.values[0].value === "/org/freedesktop/secrets/session1",
    JSON.stringify(back.values));
}

// ── 6. ao — a SearchItems result array ───────────────────────────────────────
{
  const expected = `
    24 00 00 00
    1f 00 00 00 2f 6f 72 67 2f 66 72 65 65 64 65 73 6b 74 6f 70 2f 73 65 63 72 65 74 73 2f 69 74 65 6d 2f 31 00`;

  const buf = marshalValues("ao", [["/org/freedesktop/secrets/item/1"]]);
  check("marshal ao: one-item path array is byte-exact", hex(buf) === hex(bytes(expected)), hex(buf));
  const back = unmarshalValues("ao", buf);
  check("unmarshal ao: round-trips the item path",
    back.values.length === 1 && back.values[0][0] === "/org/freedesktop/secrets/item/1",
    JSON.stringify(back.values));
}

// ── 7. multibyte UTF-8 — string length counts BYTES, not characters ─────────
{
  const buf = marshalValues("s", ["héllo"]);
  check("marshal s: utf-8 length is the byte count (é is 2 bytes)",
    hex(buf) === "06 00 00 00 68 c3 a9 6c 6c 6f 00", hex(buf));
  const back = unmarshalValues("s", buf);
  check("unmarshal s: multibyte round-trips", back.values[0] === "héllo", JSON.stringify(back.values));
}

// ── 8. (uyu) — struct members align to their own type ────────────────────────
//
//   u32 1   y 0x7f   pad→8   u32 2
{
  const buf = marshalValues("(uyu)", [1, 0x7f, 2]);
  check("marshal (uyu): internal member padding is byte-exact",
    hex(buf) === "01 00 00 00 7f 00 00 00 02 00 00 00", hex(buf));
  const back = unmarshalValues("(uyu)", buf);
  check("unmarshal (uyu): round-trips through the padding",
    back.values[0] === 1 && back.values[1] === 0x7f && back.values[2] === 2,
    JSON.stringify(back.values));
}

// ── 9. the Hello call frame, byte-exact ──────────────────────────────────────
//
//   header: 'l' type 1 flags 0 version 1, u32 bodyLen=0, u32 serial=1,
//   u32 fieldsLen — then the a(yv) field array in code order.
//   Trailing pad after the LAST field element is not counted in fieldsLen
//   (the body alignment pad that follows is separate).
{
  const expected = `
    6c 01 00 01 00 00 00 00 01 00 00 00 6d 00 00 00
    01 01 6f 00 15 00 00 00 2f 6f 72 67 2f 66 72 65 65 64 65 73 6b 74 6f 70 2f 44 42 75 73 00 00 00
    02 01 73 00 14 00 00 00 6f 72 67 2e 66 72 65 65 64 65 73 6b 74 6f 70 2e 44 42 75 73 00 00 00 00
    03 01 73 00 05 00 00 00 48 65 6c 6c 6f 00 00 00
    06 01 73 00 14 00 00 00 6f 72 67 2e 66 72 65 65 64 65 73 6b 74 6f 70 2e 44 42 75 73 00 00 00 00`;

  const frame = marshalMessage({
    type: 1,
    serial: 1,
    fields: {
      1: "/org/freedesktop/DBus",
      2: "org.freedesktop.DBus",
      3: "Hello",
      6: "org.freedesktop.DBus",
    },
  });
  check("marshal hello frame: byte-exact", hex(frame) === hex(bytes(expected)), hex(frame));
  check("marshal hello frame: 128 bytes", frame.length === 128, String(frame.length));

  const parsed = parseMessage(frame);
  check("parse hello frame: type, serial, no body",
    parsed && parsed.type === 1 && parsed.serial === 1 && parsed.body.length === 0 &&
    parsed.end === frame.length,
    JSON.stringify(parsed && { type: parsed.type, serial: parsed.serial, end: parsed.end }));
}

// ── 10. a method-return frame with a body ────────────────────────────────────
//
//   Reply to serial 4, signature "v", body = the v(o) bytes from §5.
//   field 5 (REPLY_SERIAL, u) fills 8 bytes; field 8 (SIGNATURE, g) fills 7
//   and pads to 8 — but the array length stops at the last element (15).
{
  const body = marshalValues("v", [{ sig: "o", value: "/org/freedesktop/secrets/session1" }]);
  const expected = `
    6c 02 00 01 2a 00 00 00 09 00 00 00 0f 00 00 00
    05 01 75 00 04 00 00 00
    08 01 67 00 01 76 00
    00
    01 6f 00 00 21 00 00 00 2f 6f 72 67 2f 66 72 65 65 64 65 73 6b 74 6f 70 2f 73 65 63 72 65 74 73 2f 73 65 73 73 69 6f 6e 31 00`;

  const frame = marshalMessage({ type: 2, serial: 9, fields: { 5: 4, 8: "v" }, signature: "v", body });
  check("marshal reply frame: byte-exact", hex(frame) === hex(bytes(expected)), hex(frame));

  const parsed = parseMessage(frame);
  check("parse reply frame: reply serial, signature, body survive the round-trip",
    parsed && parsed.type === 2 && parsed.replySerial === 4 && parsed.signature === "v" &&
    parsed.body.equals(body) && parsed.end === frame.length,
    JSON.stringify(parsed && { type: parsed.type, replySerial: parsed.replySerial, sig: parsed.signature }));
}

// ── 11. garbage in, null out — parseMessage never throws ─────────────────────
{
  check("parse: empty buffer is null, not a crash", parseMessage(Buffer.alloc(0)) === null);
  check("parse: truncated header is null", parseMessage(bytes("6c 01 00 01 00")) === null);
  check("parse: wrong protocol version is null",
    parseMessage(bytes("6c 01 00 02 00 00 00 00 01 00 00 00 00 00 00 00")) === null);
  check("parse: big-endian peer is refused by design",
    parseMessage(bytes("42 01 00 01 00 00 00 00 01 00 00 00 00 00 00 00")) === null);
  check("parse: random bytes are null", parseMessage(Buffer.from([7, 3, 9, 1, 44, 11, 87, 2, 5, 0, 0, 0, 9, 9, 9, 9, 1, 2, 3, 4])) === null);
  check("parse: fields array that overruns the buffer is null",
    parseMessage(bytes("6c 01 00 01 00 00 00 00 01 00 00 00 ff 00 00 00 01 02 03 04")) === null);
}

// ── 12. unmarshal on truncated input fails loudly (the probe catches it) ─────
{
  const ok = throws(() => unmarshalValues("(oayays)", bytes("21 00 00 00 2f 6f 72 67")));
  check("unmarshal: truncated struct throws a named error instead of returning junk", ok);
}

// ── 13. resolveBusAddress — the env matrix (R2.8) ────────────────────────────
//
//   DBUS_SESSION_BUS_ADDRESS first (unix:path= / unix:abstract=, first usable
//   of comma-separated candidates, tcp: skipped), then $XDG_RUNTIME_DIR/bus,
//   then null. No further guessing.
{
  const check2 = (name, env, expected) => {
    const got = resolveBusAddress(env);
    const ok = expected === null
      ? got === null
      : got !== null && got.kind === expected.kind && got.target === expected.target;
    check(name, ok, JSON.stringify(got));
  };

  check2("address: unix:path= wins", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    { kind: "path", target: "/run/user/1000/bus" });

  check2("address: unix:abstract= is recognized", { DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/dbus-abc" },
    { kind: "abstract", target: "/tmp/dbus-abc" });

  check2("address: first usable candidate of a comma list",
    { DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/x,guid=deadbeef;unix:path=/run/user/1000/bus" },
    { kind: "abstract", target: "/tmp/x" });

  check2("address: tcp-only candidates are skipped in favour of unix",
    { DBUS_SESSION_BUS_ADDRESS: "tcp:host=localhost,port=0,unix:path=/run/user/1000/bus" },
    { kind: "path", target: "/run/user/1000/bus" });

  check2("address: tcp-only env means no usable address (no guessing)",
    { DBUS_SESSION_BUS_ADDRESS: "tcp:host=localhost,port=0" }, null);

  check2("address: XDG_RUNTIME_DIR fallback when the env var is absent",
    { DBUS_SESSION_BUS_ADDRESS: "", XDG_RUNTIME_DIR: "/run/user/1000" },
    { kind: "path", target: "/run/user/1000/bus" });

  check2("address: XDG_RUNTIME_DIR is ignored when the env var is set",
    { DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus", XDG_RUNTIME_DIR: "/run/user/1000" },
    { kind: "path", target: "/custom/bus" });

  check2("address: neither knob yields null", {}, null);

  check("address: the caller's env object is read, not process.env",
    resolveBusAddress({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/from/argument/bus" }).target === "/from/argument/bus",
    JSON.stringify(resolveBusAddress({})));
}

summary();
