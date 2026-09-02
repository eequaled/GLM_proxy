// Unit tests for the shared error taxonomy and credit-tier routing.
// Pure functions only — no network, no spawned proxies.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  classifyUpstreamError,
  classifyLocalAgentError,
  classifyTransportError,
  isTransientNetworkError,
  shouldFallbackToLocal,
  createPermanentFailureCache,
  annotateCreditTiers,
  resolveTierTargets,
  resolveUpstreamModelId,
  translateUpstreamError,
  clampMaxOutput,
  OUTPUT_CAPS,
} from "../lib/core.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

// ── Cloud classifier ────────────────────────────────────────────────────────

check("403 + code 810000 quota body → 402 insufficient_credits", () => {
  const c = classifyUpstreamError(403, '{"code":810000,"message":"GLM-5.3 free quota used up. Subscribe to a membership"}', "zaicoding_glm-5.3");
  assert.equal(c.status, 402);
  assert.equal(c.type, "insufficient_credits");
  assert.equal(c.code, "quota_exhausted");
  assert.equal(c.permanent, true);
});

check("plain 402 → quota", () => {
  const c = classifyUpstreamError(402, "", "m");
  assert.equal(c.status, 402);
  assert.equal(c.permanent, true);
});

check("积分不足 body on any status → quota", () => {
  const c = classifyUpstreamError(400, '{"message":"积分不足"}', "m");
  assert.equal(c.status, 402);
  assert.equal(c.permanent, true);
});

check("401 → authentication_error", () => {
  const c = classifyUpstreamError(401, "", "m");
  assert.equal(c.status, 401);
  assert.equal(c.type, "authentication_error");
  assert.equal(c.permanent, false);
});

check("403 without quota markers → permission_error", () => {
  const c = classifyUpstreamError(403, "nope", "m");
  assert.equal(c.status, 403);
  assert.equal(c.type, "permission_error");
});

check("404 → model_not_found, permanent", () => {
  const c = classifyUpstreamError(404, "", "ghost-model");
  assert.equal(c.status, 404);
  assert.equal(c.code, "model_not_found");
  assert.equal(c.permanent, true);
});

check("429 → rate_limit_error passthrough", () => {
  const c = classifyUpstreamError(429, "", "m");
  assert.equal(c.status, 429);
  assert.equal(c.type, "rate_limit_error");
});

check("400 invalid request → 400 invalid_request_error", () => {
  const c = classifyUpstreamError(400, '{"error":"invalid request"}', "m");
  assert.equal(c.status, 400);
  assert.equal(c.type, "invalid_request_error");
  assert.equal(c.permanent, false);
});

check("upstream 500 → 502 with origin noted", () => {
  const c = classifyUpstreamError(500, "boom", "m");
  assert.equal(c.status, 502);
  assert.match(c.message, /HTTP 500/);
});

// ── Local-agent classifier ──────────────────────────────────────────────────

check("agent FailoverError 403 quota body → 402", () => {
  const c = classifyLocalAgentError(new Error('Gateway agent start failed: {"code":"UNAVAILABLE","message":"FailoverError: HTTP 403: <autoclaw-403-response>{\\"code\\":810000}"}'), "glm");
  assert.equal(c.status, 402);
  assert.equal(c.permanent, true);
});

check("agent FailoverError 402 → 402", () => {
  const c = classifyLocalAgentError(new Error('Gateway agent start failed: FailoverError: 402 status code (no body)'), "deepseek");
  assert.equal(c.status, 402);
  assert.equal(c.permanent, true);
});

check("agent timeout → 504", () => {
  const c = classifyLocalAgentError(new Error("Local gateway execution timeout (120s)"), "m");
  assert.equal(c.status, 504);
  assert.equal(c.code, "local_gateway_timeout");
});

check("missing gateway token → 503", () => {
  const c = classifyLocalAgentError(new Error("Local AutoClaw gateway token not found. Is AutoClaw running?"), "m");
  assert.equal(c.status, 503);
  assert.equal(c.code, "no_local_gateway");
});

// ── Transport classifier ────────────────────────────────────────────────────

check("dead token → 503 no_token", () => {
  const c = classifyTransportError(new Error("Cannot read AutoClaw token from x. Make sure AutoClaw is running"));
  assert.equal(c.status, 503);
  assert.equal(c.code, "no_token");
});

check("upstream timeout → 504", () => {
  const c = classifyTransportError(Object.assign(new Error("Upstream timeout — too slow"), { code: "UPSTREAM_TIMEOUT" }));
  assert.equal(c.status, 504);
  assert.equal(c.code, "upstream_timeout");
});

check("connection reset → 502 connection_failed", () => {
  const c = classifyTransportError(Object.assign(new Error("socket destroyed"), { code: "ECONNRESET" }));
  assert.equal(c.status, 502);
});

check("ECONNRESET counts as transient", () => {
  assert.equal(isTransientNetworkError({ code: "ECONNRESET", message: "" }), true);
  assert.equal(isTransientNetworkError({ code: "UPSTREAM_TIMEOUT", message: "Upstream timeout" }), false);
});

// ── Fallback decision ───────────────────────────────────────────────────────

check("shouldFallbackToLocal truth table", () => {
  assert.equal(shouldFallbackToLocal(200), false);
  assert.equal(shouldFallbackToLocal(400), true);
  assert.equal(shouldFallbackToLocal(402), true);   // parity fix vs old anthropic.js
  assert.equal(shouldFallbackToLocal(404), false);
  assert.equal(shouldFallbackToLocal(429), false);
  assert.equal(shouldFallbackToLocal(500), true);
});

// ── Permanent-failure cache ─────────────────────────────────────────────────

check("cache stores permanent, ignores transient", () => {
  const cache = createPermanentFailureCache();
  cache.mark("a", { permanent: true, status: 402, type: "t", code: "quota_exhausted", message: "x" });
  cache.mark("b", { permanent: false, status: 500, type: "t", code: "upstream_failure", message: "y" });
  assert.ok(cache.get("a"));
  assert.equal(cache.get("b"), null);
});

check("cache entries expire", () => {
  const cache = createPermanentFailureCache(-1); // already stale
  cache.mark("a", { permanent: true, status: 402, type: "t", code: "c", message: "x" });
  assert.equal(cache.get("a"), null);
});

// ── Credit-tier routing ─────────────────────────────────────────────────────

const LIVE_CATALOG = [
  { id: "zai_auto", name: "Auto", contextWindow: 1, maxTokens: 1 },
  { id: "zaicoding_glm-5.3", name: "GLM-5.3", contextWindow: 1, maxTokens: 1 },
  { id: "zai_glm-5-turbo", name: "GLM-5-Turbo", contextWindow: 1, maxTokens: 1 },
  { id: "tdpsk_deepseek-v4-flash-202605", name: "Deepseek-V4-Flash", contextWindow: 1, maxTokens: 1 },
  { id: "tdpsk_deepseek-v4-pro-202606", name: "DeepSeek-V4-Pro", contextWindow: 1, maxTokens: 1 },
];

check("remote tier data wins over heuristics", () => {
  const remote = [
    { id: "zai_auto", creditConsumptionLevel: "Low" },
    { id: "zaicoding_glm-5.3", creditConsumptionLevel: "High" },
    { id: "zai_glm-5-turbo", creditConsumptionLevel: "Medium" },
    { id: "tdpsk_deepseek-v4-flash-202605", creditConsumptionLevel: "Low" },
  ];
  const models = annotateCreditTiers(LIVE_CATALOG, remote);
  assert.equal(models[0].creditLevel, "Low");
  assert.equal(models[1].creditLevel, "High");
  assert.equal(models[2].creditLevel, "Medium");
  assert.equal(models[3].creditLevel, "Low");
  assert.equal(models[4].creditLevel, null); // not in remote config either
});

check("heuristic fallback mirrors app rules (auto→Low, glm53→High, turbo→Medium)", () => {
  const models = annotateCreditTiers(LIVE_CATALOG, null);
  assert.equal(models[0].creditLevel, "Low");
  assert.equal(models[1].creditLevel, "High");
  assert.equal(models[2].creditLevel, "Medium");
});

check("tier targets follow degradation rules (heuristic-only catalog)", () => {
  const models = annotateCreditTiers(LIVE_CATALOG, null);
  const t = resolveTierTargets(models);
  assert.equal(t.opus, "zaicoding_glm-5.3");   // High
  assert.equal(t.sonnet, "zai_glm-5-turbo");   // Medium
  // Flash has no heuristic tier (the app's rules don't cover it either), so
  // the only Low candidate is auto itself → haiku degrades to it.
  assert.equal(t.haiku, "zai_auto");
  assert.equal(t.default, t.sonnet);
});

check("with remote tiers, haiku picks non-auto Low", () => {
  const remote = [
    { id: "zai_auto", creditConsumptionLevel: "Low" },
    { id: "zaicoding_glm-5.3", creditConsumptionLevel: "High" },
    { id: "zai_glm-5-turbo", creditConsumptionLevel: "Medium" },
    { id: "tdpsk_deepseek-v4-flash-202605", creditConsumptionLevel: "Low" },
  ];
  const t = resolveTierTargets(annotateCreditTiers(LIVE_CATALOG, remote));
  assert.equal(t.opus, "zaicoding_glm-5.3");
  assert.equal(t.sonnet, "zai_glm-5-turbo");
  assert.equal(t.haiku, "tdpsk_deepseek-v4-flash-202605");
});

check("haiku prefers a non-auto model inside its tier", () => {
  const t = resolveTierTargets([
    { id: "zai_auto", name: "Auto", creditLevel: "Low" },
    { id: "other_low", name: "OtherLow", creditLevel: "Low" },
    { id: "mid_model", name: "Mid", creditLevel: "Medium" },
  ]);
  assert.equal(t.haiku, "other_low");
});

check("empty tiers degrade to default everywhere", () => {
  const t = resolveTierTargets([{ id: "only_model", name: "x", creditLevel: null }]);
  assert.equal(t.opus, "only_model");
  assert.equal(t.sonnet, "only_model");
  assert.equal(t.haiku, "only_model");
  assert.equal(t.default, "only_model");
});

// ── Model ID mapping (test-contract export) ─────────────────────────────────

check("resolveUpstreamModelId keeps known ids, maps auto, prefixes others", () => {
  const known = new Set(["zai_auto", "zaicoding_glm-5.3"]);
  assert.equal(resolveUpstreamModelId(known, "zai_auto"), "zai_auto");
  assert.equal(resolveUpstreamModelId(known, "auto"), "zai_auto");
  assert.equal(resolveUpstreamModelId(known, "glm-5.3"), "zai_glm-5.3");
});

// ── Fallback model catalog ─────────────────────────────────────────────────

check("fallback catalog ships six models incl glm-5.3-flash", () => {
  const cfg = loadConfig({ format: "openai" });
  assert.ok(Array.isArray(cfg.FALLBACK_MODELS) && cfg.FALLBACK_MODELS.length === 6);
  assert.ok(cfg.FALLBACK_MODELS.some((m) => m.id === "zai_glm-5.3-flash"));
});

check("FALLBACK_MODELS_PATH override is honored", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glmproxy-fb-"));
  fs.writeFileSync(path.join(tmp, "models.json"), JSON.stringify({ models: [{ id: "custom-model", name: "Custom" }] }));
  process.env.FALLBACK_MODELS_PATH = path.join(tmp, "models.json");
  try {
    const cfg = loadConfig({ format: "openai" });
    assert.equal(cfg.FALLBACK_MODELS.length, 1);
    assert.equal(cfg.FALLBACK_MODELS[0].id, "custom-model");
  } finally {
    delete process.env.FALLBACK_MODELS_PATH;
  }
});

check("malformed FALLBACK_MODELS_PATH degrades to built-ins", () => {
  process.env.FALLBACK_MODELS_PATH = "C:/definitely/not/here.json";
  try {
    const cfg = loadConfig({ format: "openai" });
    assert.ok(cfg.FALLBACK_MODELS.length >= 5);
    assert.ok(cfg.FALLBACK_MODELS.every((m) => typeof m.id === "string"));
  } finally {
    delete process.env.FALLBACK_MODELS_PATH;
  }
});

// ── Account ban (403 + code 410004) ─────────────────────────────────────────

check("403 + 410004 banned body → permanent 403 account_banned", () => {
  const c = classifyUpstreamError(403, '{"code":410004,"message":"账号已被封禁"}', "zai_auto");
  assert.equal(c.status, 403);
  assert.equal(c.code, "account_banned");
  assert.equal(c.permanent, true);
  assert.match(c.message, /Account banned/);
});

check("账号已被封禁 translates to English", () => {
  assert.equal(translateUpstreamError("账号已被封禁"), "Account banned by AutoClaw");
});

// ── Max-output clamp (upstream silently swaps to deepseek when exceeded) ─────

check("every GLM model clamps to the real 131072 cap", () => {
  for (const id of ["zaicoding_glm-5.3", "zai_glm-5.3-flash", "zai_glm-5-turbo", "zai_auto"]) {
    assert.equal(clampMaxOutput(id, 393_216), 131_072, `${id} should clamp 393216 → 131072`);
    assert.equal(clampMaxOutput(id, 131_072), 131_072, `${id} at-cap passes through`);
    assert.equal(clampMaxOutput(id, 131_073), 131_072, `${id} one-over clamps`);
  }
});

check("deepseek models keep their 393216 cap", () => {
  for (const id of ["tdpsk_deepseek-v4-flash-202605", "tdpsk_deepseek-v4-pro-202606"]) {
    assert.equal(clampMaxOutput(id, 393_216), 393_216);
    assert.equal(clampMaxOutput(id, 500_000), 393_216);
  }
});

check("unknown models and absent values pass through untouched", () => {
  assert.equal(clampMaxOutput("mystery-model", 500_000), 500_000);
  assert.equal(clampMaxOutput("zai_auto", undefined), undefined);
  assert.equal(clampMaxOutput("zai_auto", null), null);
});

check("catalog claims never exceed the verified output caps", () => {
  const cfg = loadConfig({ format: "openai" });
  for (const m of cfg.FALLBACK_MODELS) {
    if (OUTPUT_CAPS[m.id]) assert.ok(m.maxTokens <= OUTPUT_CAPS[m.id], `${m.id} maxTokens ${m.maxTokens} > cap ${OUTPUT_CAPS[m.id]}`);
  }
});

console.log(`\n  ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
