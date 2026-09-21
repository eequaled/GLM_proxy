import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Returns the path to the proxy state directory, creating it lazily if needed.
// Cross-platform: derives from os.homedir() (Requirement 7.2).
export function stateDir(config) {
  // Follow the app's own rule (and loadConfig's STATE_DIR key) so a relocated
  // AutoClaw state dir carries the proxy's state along with it instead of
  // stranding it in the default location.
  const appState = (process.env.OPENCLAW_STATE_DIR || "").trim()
    || path.join(os.homedir(), ".openclaw-autoclaw");
  const dir = config?.STATE_DIR || process.env.PROXY_STATE_DIR || path.join(appState, "proxy-state");
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {
    // If directory creation fails (e.g. read-only filesystem), return the path anyway;
    // subsequent read/write functions will handle missing files gracefully.
  }
  return dir;
}

// Reads and parses a JSON file safely.
// If the file is missing or corrupt, logs one warning (if corrupt) and returns fallback.
// Never throws (Requirement 7.5).
export function readJsonSafe(file, fallback = null, log = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const content = fs.readFileSync(file, "utf8");
    return JSON.parse(content);
  } catch (err) {
    if (log && typeof log.warn === "function") {
      log.warn(`Corrupt or unreadable state file ${file} (${err.message}) — using fallback`);
    } else {
      console.warn(`[state] Corrupt or unreadable state file ${file} (${err.message}) — using fallback`);
    }
    return fallback;
  }
}

// Writes an object to a file atomically via temp-file + rename.
// Follows the JSONL rotation crash-safety precedent.
export function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  const content = JSON.stringify(obj, null, 2);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}
