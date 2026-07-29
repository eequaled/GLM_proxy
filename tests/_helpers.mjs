import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function startProxy(port, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(ROOT, "main.js")], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PROXY_KEY: "pen-test-key", LOG_LEVEL: "silent", ...env },
      stdio: "ignore",
      windowsHide: true,
    });
    proc.on("error", reject);
    waitForServer(port, 50).then(() => resolve(proc)).catch(reject);
  });
}

export async function stopProxy(proc) {
  if (proc && !proc.killed) proc.kill("SIGTERM");
  await sleep(500);
}

export function post(port, { path = "/v1/chat/completions", body, headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}), "utf8");
    const finalHeaders = {
      "Content-Type": "application/json",
      Authorization: "Bearer pen-test-key",
      "Content-Length": String(bytes.length),
    };
    for (const [k, v] of Object.entries(headers)) {
      if (v === null) delete finalHeaders[k];
      else finalHeaders[k] = v;
    }
    const req = http.request({
      hostname: "127.0.0.1", port, path, method: "POST", headers: finalHeaders, timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    // Resolve on failures too — connection resets are a valid pen-test outcome
    req.on("error", (err) => resolve({ status: 0, body: err.code || err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.write(bytes);
    req.end();
  });
}

let passed = 0;
let failed = 0;

export function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`); }
}

export function summary() {
  console.log(`\n  ${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

async function waitForServer(port, tries) {
  if (tries <= 0) throw new Error(`proxy on :${port} did not start`);
  if (await canConnect(port)) return;
  await sleep(100);
  return waitForServer(port, tries - 1);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
