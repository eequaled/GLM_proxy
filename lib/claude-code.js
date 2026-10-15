// Claude Code launcher: route the `claude` CLI at this proxy and pick a model.
//
// Why this is a module and not a few lines in bin/cli.js: the decision of *how*
// to point Claude Code at a gateway is a factual claim about the client, and it
// has to be checkable offline. Claude Code 2.1.x reads the gateway from
// `ANTHROPIC_BASE_URL` (+ `ANTHROPIC_AUTH_TOKEN` for `Authorization: Bearer`),
// takes the session model from `--model <alias|name>`, and merges its own
// settings files on top of the inherited environment — a `settings.json`
// `env` block for the same variable wins over the exported one. So env alone is
// not sufficient once a user has any Claude Code settings file; the launch
// passes a settings file of our own through `--settings`, which outranks the
// user and project files (only managed settings sit above it).
//
// Everything here is injectable (`existsSync`, `spawnImpl`, `fetchImpl`) so the
// offline suite can pin the plan without Claude Code installed, and every
// function degrades to a null/false answer instead of throwing: not finding the
// client is a normal outcome on a machine that never installed it.
//
// The `--settings` flag is feature-detected rather than assumed — a user on an
// older client that predates it must still get a launch (env-only routing is the
// vendor's documented path), not a usage error.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Explicit client path; anything else is discovered. */
export const CLAUDE_BIN_ENV = "GLMP_CLAUDE_BIN";

/** Written into the proxy's state dir; passed to the child via `--settings`. */
export const LAUNCH_SETTINGS_FILE = "claude-code.settings.json";

const BIN_NAMES = ["claude", "claude.cmd", "claude.exe"];
const HOME_DIRS = [".claude/local", ".local/bin"];
const SYSTEM_DIRS = ["/usr/local/bin", "/opt/claude/bin"];

/**
 * Resolve an executable name against a PATH string, honouring `PATHEXT` on
 * Windows (where the launcher on PATH is `claude.cmd`).
 */
export function which(name, env = process.env, existsSync = fs.existsSync) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try { if (existsSync(candidate)) return candidate; } catch (_) { /* unreadable dir — keep looking */ }
    }
  }
  return null;
}

/**
 * Absolute path to the `claude` executable, or null when it is not installed.
 *
 * Order: `GLMP_CLAUDE_BIN` (an explicit path, or a bare name resolved on PATH),
 * then PATH itself, then the two install locations the vendor's own installer
 * uses (`~/.claude/local`, `~/.local/bin`) plus the system prefixes a package
 * manager would target. Nothing here writes to disk or installs anything.
 */
export function findClaudeBin({ env = process.env, existsSync = fs.existsSync, home = os.homedir() } = {}) {
  const override = env[CLAUDE_BIN_ENV];
  if (override) {
    try { if (existsSync(override)) return override; } catch (_) { /* fall through to PATH */ }
    const viaPath = which(override, env, existsSync);
    if (viaPath) return viaPath;
    // An explicit override that resolves nowhere is a misconfiguration: say so
    // by returning null rather than silently launching a different binary.
    return null;
  }

  for (const name of BIN_NAMES) {
    const hit = which(name, env, existsSync);
    if (hit) return hit;
  }

  for (const rel of HOME_DIRS) {
    for (const name of BIN_NAMES) {
      const candidate = path.join(home, rel, name);
      try { if (existsSync(candidate)) return candidate; } catch (_) { /* keep looking */ }
    }
  }
  for (const dir of SYSTEM_DIRS) {
    for (const name of BIN_NAMES) {
      const candidate = path.join(dir, name);
      try { if (existsSync(candidate)) return candidate; } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

/**
 * The settings file Claude Code is handed for this launch.
 *
 * `env` is the routing (base URL + bearer token); `model` mirrors the `--model`
 * flag so the file is meaningful on its own, and `--model` still wins when both
 * are present. `ANTHROPIC_BASE_URL` must carry no path — the client appends
 * `/v1/messages` itself, which is exactly the route this proxy serves.
 *
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set only when the catalog actually knows
 * the model's window: the client warns that it otherwise assumes 200k, and
 * naming this variable is what its own warning suggests. Inventing a number
 * would be worse than the warning.
 */
export function buildLaunchSettings({ baseUrl, token, model, contextWindowTokens = null }) {
  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
  };
  if (Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindowTokens);
  }
  return { env, model };
}

/** `claude --settings <file> --model <id>` (settings omitted when unsupported). */
export function buildLaunchArgs({ model, settingsFile = null }) {
  const args = [];
  if (settingsFile) args.push("--settings", settingsFile);
  if (model) args.push("--model", model);
  return args;
}

/**
 * Write the launch settings next to the proxy's own state and return the path —
 * or null, never throwing. An unwritable state dir costs the operator the
 * settings-file half of the routing, not the launch: the environment still
 * carries the same two variables.
 */
export function writeLaunchSettings(stateDir, settings) {
  if (!stateDir) return null;
  const file = path.join(stateDir, LAUNCH_SETTINGS_FILE);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return file;
  } catch (_) {
    return null;
  }
}

/**
 * Does this client support `--settings`? Run `--help` once and look for the flag.
 *
 * False on any failure (missing binary, timeout, no output): the caller then
 * falls back to environment-only routing, which is the documented path and needs
 * no flag at all.
 */
export function detectSettingsFlag({ bin, spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let out = "";
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      resolve(ok);
    };
    let child;
    try {
      child = spawnImpl(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (_) {
      return resolve(false);
    }
    const timer = setTimeout(() => done(/--settings\b/.test(out)), timeoutMs);
    const onData = (buf) => { out += String(buf); };
    child.stdout?.on?.("data", onData);
    child.stderr?.on?.("data", onData);
    child.on?.("error", () => { clearTimeout(timer); done(false); });
    child.on?.("close", () => { clearTimeout(timer); done(/--settings\b/.test(out)); });
  });
}

/**
 * Wait until the proxy answers `/healthz`. The surface is started in-process and
 * `listen()` is asynchronous, so launching the client the moment the import
 * returns races the socket. Bounded: a gateway that never comes up must not hang
 * the terminal, it must report and stop.
 */
export async function waitForProxy({ baseUrl, token, timeoutMs = 8000, intervalMs = 150, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchImpl(`${baseUrl}/healthz`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (res && res.status === 200) return true;
    } catch (_) { /* not up yet */ }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Spawn the client with the terminal attached, so it is a normal interactive
 * Claude Code session. Resolves with the exit code (or null when it never
 * started); the caller keeps the gateway running either way.
 */
export function launchClaude({ bin, args = [], env = {}, cwd = process.cwd(), spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, {
        stdio: "inherit",
        env: { ...process.env, ...env },
        cwd,
        windowsHide: false,
      });
    } catch (err) {
      return resolve({ started: false, code: null, error: err });
    }
    child.on?.("error", (err) => resolve({ started: false, code: null, error: err }));
    child.on?.("exit", (code, signal) => resolve({ started: true, code, signal, error: null }));
  });
}
