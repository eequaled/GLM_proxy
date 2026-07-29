#!/usr/bin/env node

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

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
    --help, -h        Show this help message
  `);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  showHelp();
}

const isAnthropic = args.includes("--anthropic");
const portIdx = args.indexOf("--port");
const keyIdx = args.indexOf("--key");
const hostIdx = args.indexOf("--host");

if (portIdx !== -1 && args[portIdx + 1]) {
  process.env.PORT = args[portIdx + 1];
}
if (keyIdx !== -1 && args[keyIdx + 1]) {
  process.env.PROXY_KEY = args[keyIdx + 1];
}
if (hostIdx !== -1 && args[hostIdx + 1]) {
  process.env.HOST = args[hostIdx + 1];
}

const targetFile = isAnthropic
  ? path.join(__dirname, "..", "anthropic.js")
  : path.join(__dirname, "..", "main.js");

await import(targetFile);
