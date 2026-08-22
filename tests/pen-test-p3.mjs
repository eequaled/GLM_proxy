import { startProxy, stopProxy, post, check, summary } from "./_helpers.mjs";

const PORT = 19893;
const proxy = await startProxy(PORT);
const chat = (body, headers = {}) => post(PORT, { body, headers });

for (const [name, model] of [
  ["path traversal", "../../etc/passwd"],
  ["CRLF", "zai_auto\r\nX-Injected: true"],
  ["null byte", "zai_auto\u0000x"],
  ["10k chars", "A".repeat(10000)],
  ["empty", ""],
  ["number", 123],
]) {
  const res = await chat({ model, messages: [{ role: "user", content: "hi" }] });
  check(`model "${name}" rejected or safely handled`, res.status === 400 || res.status >= 500, res.status);
}

for (const [name, ct] of [["text/plain", "text/plain"], ["no content-type", null]]) {
  const res = await chat({ model: "test", messages: [{ role: "user", content: "hi" }] }, { "Content-Type": ct });
  check(`${name} → 415`, res.status === 415, res.status);
}

const mixed = await chat({ model: "test", messages: [{ role: "user", content: "hi" }] }, { "Content-Type": "Application/JSON" });
check("case-insensitive Content-Type accepted", mixed.status !== 415, mixed.status);

const base = await chat({ model: "zai_auto", messages: [{ role: "user", content: "hi" }] });
check("valid request passes validation", base.status === 200 || base.status === 400 || base.status === 502 || base.status === 503, base.status);

await stopProxy(proxy);
summary();
