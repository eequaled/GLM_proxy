import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockUpstream } from "./fixtures/mock-upstream.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function startTlsMock(scenario = {}) {
  const mock = createMockUpstream(scenario);
  const port = await mock.start();
  return { mock, port };
}

// Captured stdout/stderr per spawned proxy, so suites can assert on operator-facing
// notices (pinned-identity warnings, budget notices, override logs) that the
// previous `stdio: "ignore"` made unobservable. Keyed by ChildProcess so the
// existing `stopProxy(proc)` signature keeps working unchanged.
const PROXY_OUTPUT = new WeakMap();

// The TLS mock upstream is signed by a committed test CA (tests/fixtures/certs).
// NODE_EXTRA_CA_CERTS is append-only trust, so setting it is additive for every
// suite — live-upstream tests keep verifying against the real chain.
const TEST_CA = path.join(ROOT, "tests", "fixtures", "certs", "cert.pem");

export function startProxy(port, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(ROOT, "openai.js")], {
      env: {
        ...process.env,
        PORT: String(port), HOST: "127.0.0.1", PROXY_KEY: "pen-test-key", LOG_LEVEL: "silent", RATE_LIMIT: "200",
        // Pacing is OFF by default for suites: p1-p5 spawn against the REAL home,
        // so a persisted budget window would accumulate across `npm test` runs
        // and eventually 429 a suite that has nothing to do with pacing. p7 is
        // the governor's own suite and turns both knobs back on explicitly.
        BUDGET_REQUESTS_PER_HOUR: "0", GLMP_MIN_GAP_MS: "0",
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || TEST_CA,
        // Blanked by default so a relocated-state env var on the developer's
        // machine cannot defeat a case that isolates via a fake HOME below.
        // A case that means to exercise relocation sets these explicitly.
        OPENCLAW_STATE_DIR: "", PROXY_STATE_DIR: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const captured = { stdout: "", stderr: "" };
    PROXY_OUTPUT.set(proc, captured);
    // Listeners stay attached (never detached) so the pipes drain continuously.
    proc.stdout?.on("data", (c) => { captured.stdout += c.toString("utf8"); });
    proc.stderr?.on("data", (c) => { captured.stderr += c.toString("utf8"); });
    proc.on("error", reject);
    waitForServer(port, 50).then(() => resolve(proc)).catch(reject);
  });
}

// Read whatever the proxy has printed so far. `all` is the merged stream, which
// is what notice assertions want — the logger writes info to stdout and warns
// to stderr, and which one a notice lands on is an implementation detail.
export function proxyOutput(proc) {
  const c = PROXY_OUTPUT.get(proc);
  if (!c) return { stdout: "", stderr: "", all: "" };
  return { stdout: c.stdout, stderr: c.stderr, all: c.stdout + c.stderr };
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
      // Headers ride along so suites can assert response-level contracts
      // (Retry-After on the governor's 429) without a second HTTP client.
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
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
