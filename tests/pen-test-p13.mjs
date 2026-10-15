// Pen-test p13 — the Claude Code launcher (offline).
//
// Why this suite exists: the CLI's Anthropic option now offers to launch the
// real client, and the *decisions* that make that launch work are facts about
// Claude Code — how the gateway is declared (ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN), that the model rides on `--model`, that a settings.json
// `env` block outranks the inherited environment (so the launch passes its own
// file through `--settings`, feature-detected), and that the client's own
// warning recommends CLAUDE_CODE_MAX_CONTEXT_TOKENS for the window it otherwise
// assumes to be 200k. A machine without Claude Code must still get a clean
// "not found" answer rather than a crash.
//
// Everything here is pure or injected: no client binary, no spawn, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, summary } from "./_helpers.mjs";
import {
  CLAUDE_BIN_ENV, LAUNCH_SETTINGS_FILE,
  which, findClaudeBin, buildLaunchSettings, buildLaunchArgs,
  writeLaunchSettings, detectSettingsFlag, waitForProxy, launchClaude,
} from "../lib/claude-code.js";

const existsIn = (set) => (p) => set.has(p);
const fakeEnv = (PATH, extra = {}) => ({ PATH, PATHEXT: ".COM;.EXE;.BAT;.CMD", ...extra });

// The library resolves candidates with the host's own path primitives — and on
// Windows appends PATHEXT, so the file `which()` reports is `claude.EXE`, not
// `claude`. The fixtures are therefore built the same way: a suite that
// hard-codes POSIX paths and `:` separators would only prove itself on POSIX
// hosts, which is exactly where the launcher is least likely to be used.
const IS_WIN = process.platform === "win32";
const CLIENT_FILE = IS_WIN ? "claude.EXE" : "claude";
const ROOT = path.resolve(path.sep, "glmp-p13");
const at = (...parts) => path.join(ROOT, ...parts);

// ── 1. discovery ───────────────────────────────────────────────────────────
{
  const usrBin = at("usr", "bin");
  const usrLocalBin = at("usr", "local", "bin");

  const env = fakeEnv([usrBin, usrLocalBin].join(path.delimiter));
  const found = findClaudeBin({ env, existsSync: existsIn(new Set([path.join(usrLocalBin, CLIENT_FILE)])) });
  check("p13: claude is found on PATH", found === path.join(usrLocalBin, CLIENT_FILE), String(found));

  const missing = findClaudeBin({
    env, existsSync: existsIn(new Set([path.join(usrLocalBin, "other")])), home: at("home", "nobody"),
  });
  check("p13: an absent client yields null, never a throw", missing === null, String(missing));

  const overridePath = at("opt", "x", "claude");
  const override = findClaudeBin({
    env: fakeEnv(usrBin, { [CLAUDE_BIN_ENV]: overridePath }),
    existsSync: existsIn(new Set([overridePath, path.join(usrBin, CLIENT_FILE)])),
  });
  check("p13: GLMP_CLAUDE_BIN wins over PATH", override === overridePath, String(override));

  const overrideByName = findClaudeBin({
    env: fakeEnv(usrBin, { [CLAUDE_BIN_ENV]: "claude" }),
    existsSync: existsIn(new Set([path.join(usrBin, CLIENT_FILE)])),
  });
  check("p13: a bare GLMP_CLAUDE_BIN name resolves on PATH",
    overrideByName === path.join(usrBin, CLIENT_FILE), String(overrideByName));

  const badOverride = findClaudeBin({
    env: fakeEnv(usrBin, { [CLAUDE_BIN_ENV]: at("nope", "claude") }),
    existsSync: existsIn(new Set([path.join(usrBin, CLIENT_FILE)])),
  });
  check("p13: a broken override is not silently replaced by another binary",
    badOverride === null, String(badOverride));

  // The vendor-dir leg checks the bin names directly (no PATHEXT), so the
  // extensionless name is the right fixture on every platform here.
  const homeDir = at("home", "u");
  const vendorBin = path.join(homeDir, ".claude", "local", "claude");
  const viaVendorDir = findClaudeBin({
    env: fakeEnv(""),
    existsSync: existsIn(new Set([vendorBin])),
    home: homeDir,
  });
  check("p13: the vendor's own install location is checked", viaVendorDir === vendorBin, String(viaVendorDir));

  const aDir = at("a");
  const bDir = at("b");
  const symlinkSafe = which("claude", fakeEnv([aDir, "", bDir].join(path.delimiter)), existsIn(new Set([path.join(bDir, CLIENT_FILE)])));
  check("p13: which() skips empty PATH entries and returns the first hit",
    symlinkSafe === path.join(bDir, CLIENT_FILE), String(symlinkSafe));
}

// ── 2. the launch plan ─────────────────────────────────────────────────────
{
  const settings = buildLaunchSettings({
    baseUrl: "http://127.0.0.1:18792",
    token: "mewmew",
    model: "zai_auto",
    contextWindowTokens: 1048576,
  });
  check("p13: routing is ANTHROPIC_BASE_URL plus a bearer token", 
    settings.env.ANTHROPIC_BASE_URL === "http://127.0.0.1:18792" && settings.env.ANTHROPIC_AUTH_TOKEN === "mewmew",
    JSON.stringify(settings.env));
  check("p13: the base URL carries no path (the client appends /v1/messages)",
    !/\/v1|\/messages/.test(settings.env.ANTHROPIC_BASE_URL), settings.env.ANTHROPIC_BASE_URL);
  check("p13: the model is mirrored into the settings file", settings.model === "zai_auto", settings.model);
  check("p13: a known catalog window is declared as a string",
    settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === "1048576", JSON.stringify(settings.env));

  const noWindow = buildLaunchSettings({ baseUrl: "http://h:1", token: "k", model: "m" });
  check("p13: an unknown window is omitted rather than invented",
    !("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in noWindow.env), JSON.stringify(noWindow.env));

  check("p13: the model rides on --model, after --settings",
    JSON.stringify(buildLaunchArgs({ model: "zai_auto", settingsFile: "/s.json" }))
      === JSON.stringify(["--settings", "/s.json", "--model", "zai_auto"]),
    JSON.stringify(buildLaunchArgs({ model: "zai_auto", settingsFile: "/s.json" })));
  check("p13: without a settings file the launch is model-only",
    JSON.stringify(buildLaunchArgs({ model: "zai_auto" })) === JSON.stringify(["--model", "zai_auto"]),
    JSON.stringify(buildLaunchArgs({ model: "zai_auto" })));
}

// ── 3. the settings file on disk ───────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glmp-p13-"));
  const settings = buildLaunchSettings({ baseUrl: "http://127.0.0.1:18792", token: "k", model: "zai_auto", contextWindowTokens: 1 });
  const file = writeLaunchSettings(dir, settings);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  check("p13: the settings file lands in the state dir under a known name",
    file === path.join(dir, LAUNCH_SETTINGS_FILE) && written.env.ANTHROPIC_BASE_URL === "http://127.0.0.1:18792",
    String(file));
  check("p13: the file is the shape Claude Code documents (env block + model)",
    typeof written.env === "object" && written.model === "zai_auto", JSON.stringify(written));
  check("p13: no other key leaks into a file the client merges",
    Object.keys(written).sort().join(",") === "env,model", Object.keys(written).join(","));

  // A state dir that cannot be created costs the settings half, not the launch.
  // The blocker is a *file* in the parent slot, so mkdir fails with ENOTDIR
  // immediately on every platform (/proc is not a reliable unwritable path: on
  // this machine mkdirSync under it spins in the kernel instead of failing).
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "not a directory\n");
  check("p13: an uncreatable state dir returns null instead of throwing",
    writeLaunchSettings(path.join(blocker, "state"), settings) === null,
    String(writeLaunchSettings(path.join(blocker, "state"), settings)));
  check("p13: no state dir at all is still null, not a crash",
    writeLaunchSettings("", settings) === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 4. --settings is feature-detected, not assumed ─────────────────────────
{
  const fakeSpawn = (stdout) => (_bin, _args) => {
    const child = {
      stdout: { on: (ev, fn) => { if (ev === "data") setTimeout(() => fn(Buffer.from(stdout)), 0); } },
      stderr: { on: () => {} },
      on: (ev, fn) => { if (ev === "close") setTimeout(() => fn(0), 5); },
      kill: () => {},
    };
    return child;
  };
  const supported = await detectSettingsFlag({ bin: "/x/claude", spawnImpl: fakeSpawn("Options:\n  --settings <file>  load settings\n") });
  check("p13: a client that lists --settings is detected", supported === true, String(supported));

  const old = await detectSettingsFlag({ bin: "/x/claude", spawnImpl: fakeSpawn("Usage: claude [options]\n  --model <model>\n") });
  check("p13: a client without the flag is detected as unsupported", old === false, String(old));

  const broken = await detectSettingsFlag({ bin: "/x/claude", spawnImpl: () => { throw new Error("ENOENT"); } });
  check("p13: a client that cannot be spawned is treated as unsupported", broken === false, String(broken));
  check("p13: no binary means no detection spawn at all", (await detectSettingsFlag({ bin: null })) === false);
}

// ── 5. readiness and spawn degradation ─────────────────────────────────────
{
  let calls = 0;
  const flaky = async () => { calls++; return calls < 3 ? { status: 503 } : { status: 200 }; };
  const ready = await waitForProxy({ baseUrl: "http://127.0.0.1:1", token: "k", fetchImpl: flaky, intervalMs: 1 });
  check("p13: readiness polls until /healthz answers 200", ready === true && calls === 3, `${ready} after ${calls} attempts`);

  const never = await waitForProxy({
    baseUrl: "http://127.0.0.1:1", token: "k", intervalMs: 1, timeoutMs: 30,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  check("p13: an unreachable gateway gives up instead of hanging", never === false, String(never));

  const sent = {};
  const spawnImpl = (bin, args, opts) => {
    Object.assign(sent, { bin, args, opts });
    return { on: (ev, fn) => { if (ev === "exit") setTimeout(() => fn(0, null), 0); }, stdout: null, stderr: null, kill: () => {} };
  };
  const res = await launchClaude({ bin: "/x/claude", args: ["--model", "m"], env: { ANTHROPIC_BASE_URL: "http://p" }, spawnImpl });
  check("p13: the client is spawned with the terminal attached",
    sent.opts.stdio === "inherit" && sent.bin === "/x/claude", JSON.stringify(sent.opts.stdio));
  // Windows environment blocks keep their own key casing (the real key is often
  // `Path`), and the spread copies the real key — so the inherited value is read
  // tolerantly rather than asserting Node's case-insensitive alias into
  // existence. The anchor is a variable that exists on both hosts, so this can
  // fail when the inherit half regresses instead of passing on an undefined.
  const anchor = IS_WIN ? "USERPROFILE" : "HOME";
  const inheritedPath = process.env.PATH ?? process.env.Path;
  const childPath = sent.opts.env.PATH ?? sent.opts.env.Path;
  check("p13: the routing env reaches the child alongside the inherited one",
    sent.opts.env.ANTHROPIC_BASE_URL === "http://p"
      && childPath !== undefined && childPath === inheritedPath
      && process.env[anchor] !== undefined && sent.opts.env[anchor] === process.env[anchor],
    JSON.stringify({ path: childPath, [anchor]: sent.opts.env[anchor] }));
  check("p13: a clean exit is reported as started", res.started === true && res.code === 0, JSON.stringify(res));

  const missing = await launchClaude({ bin: "/nope/claude", spawnImpl: () => { throw new Error("spawn ENOENT"); } });
  check("p13: a client that cannot be spawned reports instead of throwing",
    missing.started === false && /ENOENT/.test(missing.error.message), JSON.stringify(missing.error?.message));
}

summary();
