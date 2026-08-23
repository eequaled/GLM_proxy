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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const FLAGS = ["--anthropic", "--openai", "--port", "--host", "--key", "--rate-limit", "--doctor", "--test-models", "--test", "--help", "-h"];

function showHelp() {
  console.log(`
  🛸  AutoClaw Gateway CLI
  ───────────────────────────────────────────
  Usage:
    npx autoclaw-gateway [options]
    autoclaw-gateway [options]

  Options:
    --anthropic       Run in Anthropic API format (/v1/messages)
    --openai          Run in OpenAI API format (/v1/chat/completions) [default]
    --port <number>   Port to listen on (default: 18791 for OpenAI, 18792 for Anthropic)
    --host <ip>       Host to bind (default: 127.0.0.1)
    --key <string>    Authentication key for clients (default: mewmew)
    --rate-limit <n>  Max requests per second per IP (default: 30)
    --doctor          Live credit-tier scan of AutoClaw's catalog + routing map
    --test-models     Test all configured models against upstream and show live health
    --help, -h        Show this help message

  Environment:
    PREFER_LOCAL=1    Skip cloud attempts when the local AutoClaw gateway is up
    TRUSTED_PROXIES   Comma-separated IPs whose X-Forwarded-For header is trusted
  `);
  process.exit(0);
}

// Cloud-attempt evidence from the isolated test ring: entries are terminal
// outcomes only, so a cloud rejection shows up as the final record of an
// otherwise local-served request. Scan every entry for this model in this run
// and derive a compact summary — last non-local status, "cloud ok" if any
// non-local 200 exists, or nothing at all when no cloud evidence was written.
function deriveCloudStatus(entries) {
  const relevant = entries.filter((e) => e.via !== "local");
  if (!relevant.length) return null;
  if (relevant.some((e) => e.status === 200)) return `cloud ${COLORS.GREEN}ok${COLORS.RESET}`;
  const last = relevant[relevant.length - 1];
  return `cloud ${last.status}`;
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
  const config = loadConfig({ defaultPort: 18791 });
  const catalog = getModelCatalog(config);

  console.log(`\n  🧪  AutoClaw Model Health Test`);
  console.log(`  ───────────────────────────────────────────`);

  // Spin up a temporary proxy on a test port so requests go through
  // the full pipeline (cloud upstream → local gateway fallback).
  const testPort = 19799;
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
  const config = loadConfig({ defaultPort: 18791 });
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

// Flag parsing
let isAnthropic = args.includes("--anthropic");
const portIdx = args.indexOf("--port");
const keyIdx = args.indexOf("--key");
const hostIdx = args.indexOf("--host");

const rateLimitIdx = args.indexOf("--rate-limit");

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

const hasFlags = FLAGS.some((f) => args.includes(f));

// Menu (only on a real TTY with no flags)
if (!hasFlags && process.stdin.isTTY) {
  for (;;) {
    const action = await promptSelect({
      message: "Choose action:",
      choices: [
        { name: "Start OpenAI Gateway (/v1/chat/completions)", value: "start_openai" },
        { name: "Start Anthropic Gateway (/v1/messages)", value: "start_anthropic" },
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

    isAnthropic = action === "start_anthropic";
    const defaultPort = isAnthropic ? 18792 : 18791;
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
