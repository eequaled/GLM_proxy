#!/usr/bin/env node

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promptSelect, promptInput, promptNumber } from "../lib/prompts.js";
import { getModelCatalog, loadConfig } from "../lib/core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const FLAGS = ["--anthropic", "--openai", "--port", "--host", "--key", "--rate-limit", "--doctor", "--help", "-h"];

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
    --help, -h        Show this help message
  `);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  showHelp();
}

if (args.includes("--doctor")) {
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
  const format = await promptSelect({
    message: "API format:",
    choices: [
      { name: "OpenAI", value: "openai" },
      { name: "Anthropic", value: "anthropic" },
    ],
    default: "openai",
  });
  isAnthropic = format === "anthropic";

  const defaultPort = format === "anthropic" ? 18792 : 18791;
  const port = await promptNumber({ message: "Port:", default: defaultPort });
  const host = await promptInput({ message: "Host:", default: "127.0.0.1" });
  const key = await promptInput({ message: "Auth key:", default: "mewmew" });

  process.env.PORT = String(port);
  process.env.HOST = host;
  process.env.PROXY_KEY = key;
}

const targetFile = isAnthropic
  ? path.join(__dirname, "..", "anthropic.js")
  : path.join(__dirname, "..", "main.js");

// Windows dynamic imports need a file:// URL, not a raw drive-letter path
await import(pathToFileURL(targetFile).href);
