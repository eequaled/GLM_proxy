import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getModelCatalog, loadConfig, resolveUpstreamModelId } from "../lib/core.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const key = "catalog-refresh-key";
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaw-catalog-refresh-"));
const runtimeDir = path.join(testHome, ".openclaw-autoclaw");
const runtimeFile = path.join(runtimeDir, "openclaw.runtime.json");
const port = 19000 + Math.floor(Math.random() * 1000);

function writeCatalog(id) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(runtimeFile, JSON.stringify({
    models: { providers: { zai: { models: [{ id, name: id, contextWindow: 1, maxTokens: 1 }] } } },
  }));
}

function currentCatalog() {
  return getModelCatalog({ ...loadConfig({ defaultPort: port }), RUNTIME_CANDIDATES: [runtimeFile] });
}

function request(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body && JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1", port, path: pathname, method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${key}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await request("/v1/models");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("proxy did not start");
}

async function checkProxy(entrypoint, messagePath) {
  writeCatalog("runtime-model-one");
  const proc = spawn("node", [path.join(ROOT, entrypoint)], {
    env: { ...process.env, HOME: testHome, USERPROFILE: testHome, PORT: String(port), HOST: "127.0.0.1", PROXY_KEY: key, LOG_LEVEL: "silent" },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForServer();
    assert.deepEqual(JSON.parse((await request("/v1/models")).body).data.map((model) => model.id), ["runtime-model-one"]);
    writeCatalog("runtime-model-two");
    assert.deepEqual(JSON.parse((await request("/v1/models")).body).data.map((model) => model.id), ["runtime-model-two"]);

    assert.equal(resolveUpstreamModelId(new Set(currentCatalog().models.map((model) => model.id)), "runtime-model-two"), "runtime-model-two");
    const response = await request(messagePath, messagePath === "/v1/messages"
      ? { model: "runtime-model-two", max_tokens: 1, messages: [{ role: "user", content: "test" }] }
      : { model: "runtime-model-two", messages: [{ role: "user", content: "test" }] });
    assert.notEqual(response.status, 400, `current runtime model should not be rejected before upstream: ${response.body}`);
  } finally {
    proc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

try {
  await checkProxy("main.js", "/v1/chat/completions");
  await checkProxy("anthropic.js", "/v1/messages");
  console.log("catalog refresh passed");
} finally {
  fs.rmSync(testHome, { recursive: true, force: true });
}
