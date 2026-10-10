/**
 * TLS Impersonation Bridge client (Requirement: Linux Alibaba Cloud WAF bypass)
 *
 * Spawns and manages a local bridge process (`lib/bridge.py`) running curl_cffi
 * with Chrome TLS impersonation so egress requests match AutoClaw's Electron fingerprint.
 */

import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__dirname, "bridge.py");

let _bridgeProcess = null;
let _bridgePort = null;
let _bridgeReadyPromise = null;
let _bridgeStartupFailed = false;

export function isBridgeAvailable() {
  if (process.env.GLMP_USE_BRIDGE === "0") return false;
  if (_bridgeStartupFailed) return false;
  return process.env.GLMP_USE_BRIDGE === "1";
}

export async function ensureBridge(config, log = null) {
  if (_bridgeStartupFailed) {
    throw new Error("TLS bridge unavailable (startup previously failed)");
  }
  if (_bridgePort) return _bridgePort;
  if (_bridgeReadyPromise) return _bridgeReadyPromise;

  _bridgeReadyPromise = new Promise((resolve, reject) => {
    try {
      const child = spawn("python3", [BRIDGE_SCRIPT], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env },
      });

      _bridgeProcess = child;

      let portFound = false;
      let buf = "";

      const onData = (data) => {
        buf += data.toString("utf8");
        const match = buf.match(/BRIDGE_READY_PORT=(\d+)/);
        if (match) {
          portFound = true;
          _bridgePort = parseInt(match[1], 10);
          child.stdout.removeListener("data", onData);
          log?.info?.(`TLS bridge running on 127.0.0.1:${_bridgePort}`);
          resolve(_bridgePort);
        }
      };

      child.stdout.on("data", onData);

      child.on("error", (err) => {
        if (!portFound) {
          _bridgeStartupFailed = true;
          _bridgeReadyPromise = null;
          reject(new Error(`Failed to start TLS bridge: ${err.message}`));
        }
      });

      child.on("exit", (code) => {
        _bridgeProcess = null;
        _bridgePort = null;
        _bridgeReadyPromise = null;
        if (!portFound) {
          _bridgeStartupFailed = true;
          reject(new Error(`TLS bridge exited prematurely with code ${code}`));
        }
      });

      const cleanup = () => {
        if (_bridgeProcess) {
          try {
            _bridgeProcess.stdin.end();
            _bridgeProcess.kill("SIGTERM");
          } catch (_) {}
          _bridgeProcess = null;
        }
      };

      process.once("exit", cleanup);
      process.once("SIGINT", cleanup);
      process.once("SIGTERM", cleanup);

      // 10 second timeout for startup
      setTimeout(() => {
        if (!portFound) {
          cleanup();
          _bridgeStartupFailed = true;
          _bridgeReadyPromise = null;
          reject(new Error("Timeout waiting for TLS bridge to start"));
        }
      }, 10000);
    } catch (err) {
      _bridgeStartupFailed = true;
      _bridgeReadyPromise = null;
      reject(err);
    }
  });

  return _bridgeReadyPromise;
}

export async function forwardViaBridge({ url, headers, data, stream = false, timeout = 120000 }, log = null) {
  const port = await ensureBridge(null, log);

  const payload = JSON.stringify({
    url,
    headers,
    data,
    stream,
    timeout: Math.round(timeout / 1000),
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout,
    }, (res) => {
      resolve(res);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(Object.assign(
        new Error("Upstream timeout via bridge — AutoClaw backend did not respond within budget"),
        { code: "UPSTREAM_TIMEOUT" }
      ));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
