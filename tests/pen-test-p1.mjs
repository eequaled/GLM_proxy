import { startProxy, stopProxy, post, check, summary } from "./_helpers.mjs";
import { PEN_TEST_PORTS } from "../lib/constants.js";

const PORT = PEN_TEST_PORTS.p1;
const proxy = await startProxy(PORT, { MAX_BODY_BYTES: String(64 * 1024) });
const chat = (body, headers = {}) => post(PORT, { body, headers });
const valid = { model: "test", messages: [{ role: "user", content: "hi" }] };

check("BOM-prefixed JSON does not crash", (await chat("\uFEFF" + JSON.stringify(valid))).status !== 500);

for (const [name, raw] of [
  ["trailing comma", '{"model":"x","messages":[{"role":"user","content":"hi"},]}'],
  ["unquoted key", "{model:'x'}"],
  ["truncated", '{"model":"x","messages":['],
]) {
  const res = await chat(raw);
  check(`${name} → 400`, res.status === 400, res.status);
}

const res = await chat({ model: "test", messages: [{ role: "user", content: "x".repeat(128 * 1024) }] });
check("oversized body → 413", res.status === 413, res.status);

const poll = await chat({ ...valid, __proto__: { polluted: true } });
check("proto pollution safe", poll.status !== 500);

let inner = "x";
for (let i = 0; i < 12000; i++) inner = `[${inner}]`;
const deep = await chat(`{"model":"test","messages":[{"role":"user","content":${inner}}]}`);
check("deep nesting rejected", deep.status === 400 || deep.status === 413, deep.status);

await stopProxy(proxy);
summary();
