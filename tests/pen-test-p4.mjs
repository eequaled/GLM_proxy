import { startProxy, stopProxy, post, check, summary } from "./_helpers.mjs";
import { PEN_TEST_PORTS } from "../lib/constants.js";

const PORT = PEN_TEST_PORTS.p4;
const proxy = await startProxy(PORT, { MAX_BODY_BYTES: String(1024 * 1024) });
const ok = (r) => r.status === 400 || r.status === 413;

const bigMsg = { model: "test", messages: Array.from({ length: 100000 }, (_, i) => ({ role: "user", content: `m${i}` })) };
const r1 = await post(PORT, { body: bigMsg, timeoutMs: 20000 });
check("100k messages rejected", ok(r1), r1.status);

let inner = "x";
for (let i = 0; i < 12000; i++) inner = `[${inner}]`;
const r2 = await post(PORT, { body: `{"model":"test","messages":[{"role":"user","content":${inner}}]}` });
check("deep nesting rejected", ok(r2), r2.status);

const small = { model: "test", messages: [{ role: "user", content: "ping" }] };
const settled = await Promise.allSettled(Array.from({ length: 100 }, () => post(PORT, { body: small })));
check("100 concurrent handled", settled.filter((s) => s.status === "fulfilled").length > 0);

const r4 = await post(PORT, { body: { model: "test", messages: [{ role: "user", content: "x".repeat(900000) }] }, timeoutMs: 20000 });
check("large string bounded", ok(r4) || r4.status >= 500, r4.status);

const r5 = await post(PORT, { body: { model: "test", messages: [{ role: "user", content: "tools" }], tools: Array.from({ length: 500 }, (_, i) => ({ type: "function", function: { name: `t${i}`, parameters: {} } })) } });
check("500 tools handled", ok(r5) || r5.status >= 500, r5.status);

await stopProxy(proxy);
summary();
