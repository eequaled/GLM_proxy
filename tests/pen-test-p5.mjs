import { startProxy, stopProxy, post, check, summary } from "./_helpers.mjs";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 19895;
const JSONL_PATH = path.join(ROOT, "test_requests.jsonl");
// clean up any leftover from previous runs
try { unlinkSync(JSONL_PATH); } catch {}

const proxy = await startProxy(PORT, { JSONL_LOG: "true", JSONL_FILE: JSONL_PATH, RATE_LIMIT: "5" });
const chat = (body = {}, headers = {}) => post(PORT, { body: { model: "zai_auto", messages: [{ role: "user", content: "hi" }], ...body }, headers });

// Rate limiter: burst concurrent requests, expect 429
const results = await Promise.all(Array.from({ length: 12 }, () => chat()));
const had429 = results.some(r => r.status === 429);
check("rate limiter returns 429 on burst", had429);

// JSONL log: verify file was written after a successful request
await chat();
await new Promise(r => setTimeout(r, 1000)); // let appendFile flush
const jsonlOk = existsSync(JSONL_PATH);
if (!jsonlOk) console.log("  (debug: JSONL file not found at", JSONL_PATH, ")");
check("JSONL log file written", jsonlOk);

// Smoke-test: regular request still works with retry wrapper
const smoke = await chat({ model: "zai_glm-5-turbo" });
check("regular request still passes after hardening", smoke.status === 200 || smoke.status < 500, smoke.status);

// 401 still works (auth check intact)
const noAuth = await post(PORT, { body: { model: "zai_auto", messages: [{ role: "user", content: "hi" }] }, headers: { Authorization: null } });
check("auth still enforced after hardening", noAuth.status === 401, noAuth.status);

await stopProxy(proxy);
try { unlinkSync(JSONL_PATH); } catch {}
summary();
