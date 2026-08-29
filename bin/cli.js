#!/usr/bin/env node

import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { promptSelect, promptInput, promptNumber } from "../lib/prompts.js";
import http from "http";
import {
  getModelCatalog, loadConfig, createTokenLayer,
  fetchRemoteModelConfig, annotateCreditTiers, resolveTierTargets,
  getLocalGatewayToken, COLORS,
} from "../lib/core.js";
import { DEFAULT_PORTS, DEFAULT_HOST, DEFAULT_PROXY_KEY, TEST_PROXY_PORT } from "../lib/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const FLAGS = ["--anthropic", "--openai", "--port", "--host", "--key", "--rate-limit", "--max-messages", "--doctor", "--test-models", "--test", "--limit", "--help", "-h"];

// Current effective MAX_MESSAGES env value as a finite number, or Infinity.
function effectiveMaxMessages() {
  const raw = process.env.MAX_MESSAGES;
  if (!raw) return Infinity;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function formatMaxMessages() {
  const n = effectiveMaxMessages();
  return Number.isFinite(n) ? `${n} entries` : "unlimited";
}

function showHelp() {
  console.log(`
    AutoClaw Gateway CLI
  ───────────────────────────────────────────
  Usage:
    npx glmproxy [options]
    glmproxy [options]

  Options:
    --anthropic           Run in Anthropic API format (/v1/messages)
    --openai              Run in OpenAI API format (/v1/chat/completions) [default]
    --port <number>       Port to listen on (default: ${DEFAULT_PORTS.openai} for OpenAI, ${DEFAULT_PORTS.anthropic} for Anthropic)
    --host <ip>           Host to bind (default: ${DEFAULT_HOST})
    --key <string>        Authentication key for clients (default: ${DEFAULT_PROXY_KEY})
    --rate-limit <n>      Max requests per second per IP (default: 30)
    --max-messages <n>    Max message / entity limit (0/unset = unlimited; or 128, 256, 512, 1024)
                          If you have a compression system, leaving this unlimited is preferred.
    --doctor              Live credit-tier scan of AutoClaw's catalog + routing map
    --test-models         Test all configured models against upstream and show live health
    --limit               Set or clear the max entity / messages limit (own menu item)
    --help, -h            Show this help message

  Environment:
    MAX_MESSAGES      Max messages limit per request (0/unset = unlimited; or 128, 256, 512, 1024)
    PREFER_LOCAL=1    Skip cloud attempts when the local AutoClaw gateway is up
    TRUSTED_PROXIES   Comma-separated IPs whose X-Forwarded-For header is trusted
  `);
  process.exit(0);
}

// Cloud-attempt evidence from the isolated test ring: entries are terminal
// outcomes only. A cloud-served success is its own via!=="local" 200; a
// locally-served request that the cloud rejected first carries its verdict
// in cloud_status on that same entry. Scan every entry for this model in
// this run and derive a compact summary.
function deriveCloudStatus(entries) {
  if (entries.some((e) => e.via !== "local" && e.status === 200)) {
    return `cloud ${COLORS.GREEN}ok${COLORS.RESET}`;
  }
  const withEvidence = entries.filter((e) => e.cloud_status != null);
  if (!withEvidence.length) return null;
  return `cloud ${withEvidence[withEvidence.length - 1].cloud_status}`;
}

function readTestRing(filePath, sinceTs) {
  try {
    const entries = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(entries)) return [];
    return entries.filter((e) => {
      const ts = Date.parse(e.timestamp || e.ts || "");
      // Tolerate missing timestamps: the ring is capped at 50 entries and the
      // test log is isolated per-run, so anything without one is still ours.
      return Number.isNaN(ts) ? true : ts >= sinceTs;
    });
  } catch (_) { return []; }
}

async function runModelTests() {
  const config = loadConfig({ format: "openai" });
  const catalog = getModelCatalog(config);

  console.log(`\n  🧪  AutoClaw Model Health Test`);
  console.log(`  ───────────────────────────────────────────`);

  // Spin up a temporary proxy on a test port so requests go through
  // the full pipeline (cloud upstream → local gateway fallback).
  const testPort = TEST_PROXY_PORT;
  const testKey = "model-test-" + Date.now();

  // Isolated log files: without these, the spawned child's read-modify-write
  // on the shared ring log clobbers entries written by your running proxies
  // (observed: whole batches of results vanishing mid-run).
  const testEnvLog = path.join(process.cwd(), "proxy_requests_test.json");
  const testEnvJsonl = path.join(process.cwd(), "proxy_requests_test.jsonl");

  const env = {
    ...process.env,
    PORT: String(testPort),
    HOST: "127.0.0.1",
    PROXY_KEY: testKey,
    LOG_LEVEL: "silent",
    REQUEST_LOG_FILE: testEnvLog,
    JSONL_FILE: testEnvJsonl,
  };

  const { spawn } = await import("child_process");
  const proxyProc = spawn("node", [path.join(__dirname, "..", "openai.js")], {
    env,
    stdio: "ignore",
    windowsHide: true,
  });

  // Wait for the test proxy to accept connections
  const ready = await new Promise((resolve) => {
    let tries = 0;
    const interval = setInterval(() => {
      const probe = http.get({ hostname: "127.0.0.1", port: testPort, path: "/healthz" }, (res) => {
        res.resume();
        clearInterval(interval);
        resolve(true);
      });
      probe.on("error", () => {
        if (++tries > 50) { clearInterval(interval); resolve(false); }
      });
    }, 100);
  });

  if (!ready) {
    console.log(`  ${COLORS.RED}✗ Could not start test proxy${COLORS.RESET}\n`);
    proxyProc.kill();
    return;
  }

  const localToken = getLocalGatewayToken();
  console.log(`  Local gateway: ${localToken ? `${COLORS.BLUE}available${COLORS.RESET}` : `${COLORS.GRAY}not found${COLORS.RESET}`}`);

  // Fallback-served requests are invisible in terminal output otherwise —
  // point the operator at the isolated log for per-request attribution.
  console.log(`  Request log  : ${path.basename(testEnvLog)}\n`);

  // Cloud-evidence baseline: only entries written from this run onward count.
  const runStart = Date.now() - 1000;

  for (const model of catalog.models) {
    process.stdout.write(`  Testing ${COLORS.CYAN}${model.name}${COLORS.RESET} (${model.id})... `);
    const startTime = Date.now();

    try {
      const result = await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: "Reply with only the word PONG" }],
          stream: false,
        });
        const req = http.request({
          hostname: "127.0.0.1",
          port: testPort,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testKey}`,
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 120000,
        }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.write(body);
        req.end();
      });

      const elapsed = Date.now() - startTime;
      // Give the proxy a beat to flush its ring write before we read it back
      await new Promise((r) => setTimeout(r, 150));
      const cloudStatus = deriveCloudStatus(
        readTestRing(testEnvLog, runStart).filter((e) => e.model === model.id),
      );
      if (result.status === 200) {
        let answer = "";
        let servedBy = "";
        try {
          const parsed = JSON.parse(result.body);
          answer = parsed.choices?.[0]?.message?.content || "";
          // Attribution: responses assembled by the local-agent fallback carry
          // zero usage counters — cloud answers report real token usage.
          servedBy = parsed.usage?.prompt_tokens === 0 && parsed.usage?.completion_tokens === 0
            ? ` ${COLORS.MAGENTA}[${cloudStatus ?? "cloud n/a"} → local agent]${COLORS.RESET}`
            : cloudStatus ? ` ${COLORS.GRAY}[${cloudStatus}]${COLORS.RESET}` : "";
        } catch {}
        const preview = answer.length > 40 ? answer.slice(0, 40) + "…" : answer;
        console.log(`${COLORS.BLUE}✔ working${COLORS.RESET}${servedBy} ${COLORS.GRAY}(${elapsed}ms) → ${preview}${COLORS.RESET}`);
      } else {
        let detail = "";
        try { detail = JSON.parse(result.body).error?.message || ""; } catch {}
        console.log(`${COLORS.RED}✗ failed (${result.status})${COLORS.RESET} ${COLORS.GRAY}(${elapsed}ms)${detail ? ` → ${detail}` : ""}`);
      }
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.log(`${COLORS.RED}✗ error: ${err.message}${COLORS.RESET} ${COLORS.GRAY}(${elapsed}ms)${COLORS.RESET}`);
    }
  }

  console.log(`\n  ${COLORS.GRAY}Legend: [cloud NNN → local agent] = cloud rejected the request (HTTP NNN), the desktop-app fallback served it instead.${COLORS.RESET}`);
  console.log("");
  proxyProc.kill();
  await new Promise((r) => setTimeout(r, 300));
}

// Live credit-tier doctor: remote model-config → runtime catalog → built-in
// fallback, routed through the SAME annotate/resolve pair the Anthropic
// entrypoint uses. No duplicated fragment matching here anymore.
async function runDoctor() {
  const config = loadConfig({ format: "openai" });
  const catalog = getModelCatalog(config);

  console.log(`\n  AutoClaw model doctor`);
  console.log(`  ───────────────────────────────────────────`);

  let source = catalog.source ? path.basename(catalog.source) : "built-in fallback";
  let status = catalog.fallback ? "runtime catalog unavailable" : "runtime catalog loaded";

  // Read the JWT straight from AutoClaw's token file (silent — the doctor
  // must work even while the desktop app is closed).
  let jwt = null;
  try {
    const tokenLayer = createTokenLayer(config, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, success: () => {} });
    jwt = tokenLayer.loadToken();
  } catch (_) {}

  const remoteModels = await fetchRemoteModelConfig(config, jwt);
  if (remoteModels) {
    source = "remote model-config";
    status = `live credit-tier data (${remoteModels.length} models)`;
  } else if (jwt) {
    status += " · remote fetch failed — heuristic tiers apply";
  } else {
    status += " · no AutoClaw token — heuristic tiers apply";
  }

  const models = annotateCreditTiers(catalog.models, remoteModels);
  const targets = resolveTierTargets(models);

  console.log(`  Source: ${source}`);
  console.log(`  Status: ${status}\n`);

  models.forEach((model, index) => {
    const context = model.contextWindow ? `${Math.round(model.contextWindow / 1024)}K context` : "context unknown";
    const output = model.maxTokens ? `${Math.round(model.maxTokens / 1024)}K max output` : "output unknown";
    const tier = model.creditLevel ? `${model.creditLevel} credit` : "tier unknown";
    console.log(`  ${index + 1}. ${model.name} (${model.id}) — ${tier}, ${context}, ${output}`);
  });

  console.log(`\n  Claude alias routing (by credit tier):`);
  console.log(`  claude-opus-*   → ${targets.opus ?? "?"}`);
  console.log(`  claude-sonnet-* → ${targets.sonnet ?? "?"}`);
  console.log(`  claude-haiku-*  → ${targets.haiku ?? "?"}`);
  console.log(`  unknown model   → ${targets.default ?? "?"}\n`);
}

if (args.includes("--help") || args.includes("-h")) {
  showHelp();
}

if (args.includes("--test-models") || args.includes("--test")) {
  await runModelTests();
  process.exit(0);
}

if (args.includes("--doctor")) {
  await runDoctor();
  process.exit(0);
}

// --limit: set or clear the max entity / messages limit, then exit.
if (args.includes("--limit")) {
  const limitIdx = args.indexOf("--limit");
  const value = args[limitIdx + 1];
  if (value && /^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    process.env.MAX_MESSAGES = n > 0 ? String(n) : "";
  }
  console.log(`\n  Max messages: ${process.env.MAX_MESSAGES ? `${process.env.MAX_MESSAGES} entries` : `${COLORS.GREEN}unlimited${COLORS.RESET}`}`);
  console.log(`  ${COLORS.GRAY}(If you have a compression system, leaving this unlimited is preferred.)${COLORS.RESET}\n`);
  process.exit(0);
}

// Flag parsing
let isAnthropic = args.includes("--anthropic");
const portIdx = args.indexOf("--port");
const keyIdx = args.indexOf("--key");
const hostIdx = args.indexOf("--host");
const rateLimitIdx = args.indexOf("--rate-limit");
const maxMessagesIdx = args.indexOf("--max-messages");

if (portIdx !== -1 && args[portIdx + 1]) {
  process.env.PORT = args[portIdx + 1];
}
if (keyIdx !== -1 && args[keyIdx + 1]) {
  process.env.PROXY_KEY = args[keyIdx + 1];
}
if (hostIdx !== -1 && args[hostIdx + 1]) {
  process.env.HOST = args[hostIdx + 1];
}
if (rateLimitIdx !== -1 && args[rateLimitIdx + 1]) {
  process.env.RATE_LIMIT = args[rateLimitIdx + 1];
}
if (maxMessagesIdx !== -1 && args[maxMessagesIdx + 1]) {
  const n = parseInt(args[maxMessagesIdx + 1], 10);
  process.env.MAX_MESSAGES = n > 0 ? String(n) : "";
}

const hasFlags = FLAGS.some((f) => args.includes(f));

// Menu (only on a real TTY with no flags)
if (!hasFlags && process.stdin.isTTY) {
  for (;;) {
    const action = await promptSelect({
      message: "Choose action:",
      choices: [
        { name: "Start OpenAI Gateway (/v1/chat/completions)", value: "start_openai" },
        { name: "Start Anthropic Gateway (/v1/messages)", value: "start_anthropic" },
        { name: "Set Max Messages Limit (default: unlimited)", value: "limit" },
        { name: "Run Model Doctor (View catalog & routing)", value: "doctor" },
        { name: "Test Models (Live proxy health check)", value: "test_models" },
      ],
      default: "start_openai",
    });

    if (action === "doctor") {
      await runDoctor();
      const next = await promptSelect({
        message: "Next action:",
        choices: [
          { name: "Test all models now", value: "test" },
          { name: "Back to main menu", value: "back" },
        ],
        default: "test",
      });
      if (next === "test") {
        await runModelTests();
      }
      continue;
    }

    if (action === "test_models") {
      await runModelTests();
      continue;
    }

    if (action === "limit") {
      const current = Number.isFinite(config_maxMessages())
        ? `${config_maxMessages()} entries`
        : `${COLORS.GREEN}unlimited${COLORS.RESET}`;
      const entityLimit = await promptSelect({
        message: "Max entity / messages limit:",
        hint: `  ${COLORS.GRAY}current: ${current} — a compression system makes unlimited preferred${COLORS.RESET}`,
        choices: [
          { name: "Unlimited (default)", value: "unlimited" },
          { name: "128", value: "128" },
          { name: "256", value: "256" },
          { name: "512", value: "512" },
          { name: "1024", value: "1024" },
        ],
        default: "unlimited",
      });
      process.env.MAX_MESSAGES = entityLimit === "unlimited" ? "" : entityLimit;
      console.log(`  ${COLORS.GRAY}(If you have a compression system, leaving this unlimited is preferred.)${COLORS.RESET}\n`);
      continue;
    }

    isAnthropic = action === "start_anthropic";
    const defaultPort = DEFAULT_PORTS[isAnthropic ? "anthropic" : "openai"];
    const port = await promptNumber({ message: "Port:", default: defaultPort });
    const host = await promptInput({ message: "Host:", default: "127.0.0.1" });
    const key = await promptInput({ message: "Auth key:", default: "mewmew" });

    process.env.PORT = String(port);
    process.env.HOST = host;
    process.env.PROXY_KEY = key;
    break;
  }
}

const targetFile = isAnthropic
  ? path.join(__dirname, "..", "anthropic.js")
  : path.join(__dirname, "..", "openai.js");

// Windows dynamic imports need a file:// URL, not a raw drive-letter path
await import(pathToFileURL(targetFile).href);
