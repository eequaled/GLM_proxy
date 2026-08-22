#!/usr/bin/env node

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promptSelect, promptInput, promptNumber } from "../lib/prompts.js";
import http from "http";
import { getModelCatalog, loadConfig, createTokenLayer, callUpstreamOpenAI, getLocalGatewayToken, COLORS } from "../lib/core.js";

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
    --doctor          Scan AutoClaw's live model catalog and print routing targets
    --test-models     Test all configured models against upstream and show live health
    --help, -h        Show this help message
  `);
  process.exit(0);
}

async function runModelTests() {
  const config = loadConfig({ defaultPort: 18791 });
  const catalog = getModelCatalog(config);

  console.log(`\n  🧪  AutoClaw Model Health Test`);
  console.log(`  ───────────────────────────────────────────`);

  // Spin up a temporary proxy on a test port so requests go through
  // the full pipeline (cloud upstream → local gateway fallback)
  const testPort = 19799;
  const testKey = "model-test-" + Date.now();
  const env = {
    ...process.env,
    PORT: String(testPort),
    HOST: "127.0.0.1",
    PROXY_KEY: testKey,
    LOG_LEVEL: "silent",
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
  console.log(`  Local gateway: ${localToken ? `${COLORS.BLUE}available${COLORS.RESET}` : `${COLORS.GRAY}not found${COLORS.RESET}`}\n`);

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
      if (result.status === 200) {
        let answer = "";
        try { answer = JSON.parse(result.body).choices?.[0]?.message?.content || ""; } catch {}
        const preview = answer.length > 40 ? answer.slice(0, 40) + "…" : answer;
        console.log(`${COLORS.BLUE}✔ working${COLORS.RESET} ${COLORS.GRAY}(${elapsed}ms)${COLORS.RESET} → ${COLORS.GRAY}${preview}${COLORS.RESET}`);
      } else {
        console.log(`${COLORS.RED}✗ failed (${result.status})${COLORS.RESET} ${COLORS.GRAY}(${elapsed}ms)${COLORS.RESET}`);
      }
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.log(`${COLORS.RED}✗ error: ${err.message}${COLORS.RESET} ${COLORS.GRAY}(${elapsed}ms)${COLORS.RESET}`);
    }
  }

  console.log("");
  proxyProc.kill();
  await new Promise((r) => setTimeout(r, 300));
}

function runDoctor() {
  const catalog = getModelCatalog(loadConfig({ defaultPort: 18791 }));
  console.log(`\n  AutoClaw model doctor\n  ───────────────────────────────────────────`);
  console.log(`  Source: ${catalog.source || "built-in fallback"}`);
  console.log(`  Status: ${catalog.fallback ? "runtime catalog unavailable" : "runtime catalog loaded"}\n`);
  catalog.models.forEach((model, index) => {
    const context = model.contextWindow ? `${Math.round(model.contextWindow / 1024)}K context` : "context unknown";
    const output = model.maxTokens ? `${Math.round(model.maxTokens / 1024)}K max output` : "output unknown";
    console.log(`  ${index + 1}. ${model.name} (${model.id}) — ${context}, ${output}`);
  });
  const findModel = (...fragments) => {
    for (const fragment of fragments) {
      const match = catalog.models.find((model) => `${model.name} ${model.id}`.toLowerCase().includes(fragment));
      if (match) return match.id;
    }
    return "zai_auto";
  };
  console.log(`\n  Anthropic routing:`);
  console.log(`  claude-opus-*   → ${findModel("glm-5.3", "glm-5")}`);
  console.log(`  claude-sonnet-* → ${findModel("auto", "glm-5.3", "glm-5")}`);
  console.log(`  claude-haiku-*  → ${findModel("turbo", "deepseek", "auto")}\n`);
}

if (args.includes("--help") || args.includes("-h")) {
  showHelp();
}

if (args.includes("--test-models") || args.includes("--test")) {
  await runModelTests();
  process.exit(0);
}

if (args.includes("--doctor")) {
  runDoctor();
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
      runDoctor();
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
