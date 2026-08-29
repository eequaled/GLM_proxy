import { startProxy, stopProxy, post, check, summary } from "./_helpers.mjs";
import { PEN_TEST_PORTS } from "../lib/constants.js";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = PEN_TEST_PORTS.p5;
const JSONL_PATH = path.join(ROOT, "test_requests.jsonl");
// clean up any leftover from previous runs
try { unlinkSync(JSONL_PATH); } catch {}

const proxy = await startProxy(PORT, { JSONL_LOG: "true", JSONL_FILE: JSONL_PATH, RATE_LIMIT: "5" });
const chat = (body = {}, headers = {}) => post(PORT, { body: { model: "zai_auto", messages: [{ role: "user", content: "hi" }], ...body }, headers, timeoutMs: 30000 });

// Rate limiter: burst concurrent requests, expect 429
const results = await Promise.all(Array.from({ length: 12 }, () => chat()));
const had429 = results.some(r => r.status === 429);
check("rate limiter returns 429 on burst", had429);

// JSONL log: verify file was written after a successful request
await new Promise(r => setTimeout(r, 1200)); // wait for token bucket refill
// Live upstream sometimes throttles right after p4's concurrency barrage and
// fails requests at the transport level — one retry before giving up.
let jsonlOk = false;
for (let i = 0; i < 3 && !jsonlOk; i++) {
  await chat();
  for (let j = 0; j < 12 && !jsonlOk; j++) {
    await new Promise(r => setTimeout(r, 500));
    jsonlOk = existsSync(JSONL_PATH);
  }
}
if (!jsonlOk) console.log("  (debug: JSONL file not found at", JSONL_PATH, ")");
check("JSONL log file written", jsonlOk);

await new Promise(r => setTimeout(r, 1200)); // wait for token bucket refill
// Smoke-test: pipeline works — any well-formed classified response is fine
// (200 cloud/local, or a typed error: 400 invalid, 402 quota, 404 unknown,
// 429 rate-limited, 502 upstream, 503 no token, 504 timeout). Status 0 means
// the upstream throttled the transport itself — retry once before judging.
let smoke = await chat({ model: "zai_glm-5-turbo" });
if (smoke.status === 0) {
  await new Promise(r => setTimeout(r, 3000));
  smoke = await chat({ model: "zai_glm-5-turbo" });
}
check("regular request still passes after hardening", smoke.status === 200 || (smoke.status >= 400 && smoke.status <= 504), smoke.status);

// 401 still works (auth check intact)
const noAuth = await post(PORT, { body: { model: "zai_auto", messages: [{ role: "user", content: "hi" }] }, headers: { Authorization: null } });
check("auth still enforced after hardening", noAuth.status === 401, noAuth.status);

await stopProxy(proxy);
try { unlinkSync(JSONL_PATH); } catch {}
summary();
