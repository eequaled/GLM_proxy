// Pen-test p6 — identity freshness (Requirement 1).
//
// The whole point of this suite: the fallback tail of the identity chain used
// to be the compiled-in `1.17.5`, and that staleness is exactly what tripped
// issue #5's false bans. Here we prove the tail is now the LAST OBSERVED app
// identity, that a live JWT can never be snapshotted, and that an operator who
// ends up on the pin is told so loudly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { check, summary, startProxy, stopProxy, proxyOutput } from "./_helpers.mjs";
import { PEN_TEST_PORTS } from "../lib/constants.js";
import { loadConfig, getShapeLayer } from "../lib/core.js";
import { createIdentityLayer, IDENTITY_SNAPSHOT_FILE } from "../lib/identity.js";
import { BANNER_SNAPSHOT_FILE, COMPACTION_MARKER, PINNED_BANNER, extractBannerFrom } from "../lib/shape.js";

const RUNTIME_NAME = "openclaw.runtime.json";

// The runtime entry ALSO carries a live JWT and a per-request model id. Neither
// may ever reach the static header set or the on-disk snapshot.
const SECRET = "Bearer eyJhbGciOiJIUzI1NiJ9.P6-FAKE-JWT-DO-NOT-LEAK";

function runtimePayload(version, extraHeaders = {}) {
  return {
    models: {
      providers: {
        zai: {
          models: [{
            id: "zai_glm-5.3",
            headers: {
              "X-Version": version,
              "X-Tm": "win",
              "X-Product": "autoclaw",
              "X-Channel": "AutoClaw4",
              "X-Lang": "en",
              "X-Client-Type": "pc",
              "X-Authorization": SECRET,
              "X-Request-Model": "glm-5.3",
              ...extraHeaders,
            },
          }],
        },
      },
    },
  };
}

function writeRuntime(home, version, extra) {
  const file = path.join(home, ".openclaw-autoclaw", RUNTIME_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(runtimePayload(version, extra)), "utf8");
  return file;
}

// A fresh fake HOME per case, so discovery never sees this machine's real app.
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glmp-p6-"));
}

// loadConfig() and stateDir() both resolve os.homedir() at call time, so the
// env has to stay swapped for the whole case — configs captured under one home
// must not leak into the next.
//
// OPENCLAW_STATE_DIR is the app's own relocation rule and outranks homedir, so
// it has to be cleared here too: on a machine that sets it (the proxy's own
// users can have it set), a fake HOME alone would leave discovery pointed at the
// real state dir and every isolation case would silently read the real app.
async function withHome(home, fn) {
  const saved = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    PROXY_STATE_DIR: process.env.PROXY_STATE_DIR,
  };
  const restore = (key) => {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.PROXY_STATE_DIR;
  try {
    return await fn();
  } finally {
    restore("HOME");
    restore("USERPROFILE");
    restore("OPENCLAW_STATE_DIR");
    restore("PROXY_STATE_DIR");
  }
}

function captureLog() {
  const warns = [];
  const infos = [];
  return {
    warns,
    infos,
    log: {
      warn: (m) => warns.push(String(m)),
      info: (m) => infos.push(String(m)),
      debug: () => {},
      error: () => {},
      success: () => {},
    },
  };
}

// ---- 1. a live app version overlays the pinned default ---------------------

const homeA = makeHome();
await withHome(homeA, async () => {
  const runtimeFile = writeRuntime(homeA, "1.17.8");
  const config = loadConfig({ format: "openai" });
  const { log, warns } = captureLog();
  const layer = createIdentityLayer(config, log);

  const id = layer.getIdentity();
  check("runtime version overlays the pinned default", id.headers["X-Version"] === "1.17.8", id.headers["X-Version"]);
  check("identity source is the runtime file", id.source === "runtime", id.source);
  check("runtime file unchanged since write", fs.existsSync(runtimeFile));
  check("no pinned-identity warning while discovery works",
    !warns.some((w) => /running on pinned identity/.test(w)), warns.join(" | "));

  // ---- 2. the live JWT never enters the header set -------------------------
  check("live JWT is not copied into the static header set", !("X-Authorization" in id.headers));
  check("per-request model header is not copied either", !("X-Request-Model" in id.headers));

  // ---- 3. the snapshot is a whitelisted, credential-free projection --------
  const snapshotFile = path.join(homeA, ".openclaw-autoclaw", "proxy-state", IDENTITY_SNAPSHOT_FILE);
  const snapshotExists = fs.existsSync(snapshotFile);
  check("capture() writes the last-good identity snapshot", snapshotExists, snapshotFile);
  if (snapshotExists) {
    const raw = fs.readFileSync(snapshotFile, "utf8");
    check("snapshot never contains a credential", !raw.includes("SECRET") && !raw.includes("X-Authorization"));
    const parsed = JSON.parse(raw);
    check("snapshot version matches the observation", parsed.version === "1.17.8", parsed.version);
    check("snapshot only carries whitelisted identity keys",
      Object.keys(parsed.headers).every((k) => ["X-Version", "X-Tm", "X-Product", "X-Channel", "X-Lang", "X-Client-Type"].includes(k)),
      Object.keys(parsed.headers).join(","));
  }
});

// ---- 4. snapshot outranks the pin when the app is closed -------------------

await withHome(homeA, async () => {
  fs.rmSync(path.join(homeA, ".openclaw-autoclaw", RUNTIME_NAME), { force: true });
  const config = loadConfig({ format: "openai" });
  const { log, warns } = captureLog();
  const layer = createIdentityLayer(config, log);

  const id = layer.getIdentity();
  check("closed app → snapshot wins over the pinned default", id.source === "snapshot", id.source);
  check("snapshot supplies the last observed version", id.headers["X-Version"] === "1.17.8", id.headers["X-Version"]);
  check("snapshot path emits no pinned warning",
    !warns.some((w) => /running on pinned identity/.test(w)), warns.join(" | "));
});

// ---- 5. nothing readable → pinned, and loud about it ----------------------

await withHome(makeHome(), async () => {
  const config = loadConfig({ format: "openai" });
  const { log, warns } = captureLog();
  const layer = createIdentityLayer(config, log);

  const id = layer.getIdentity();
  check("no app artifacts → pinned default is used", id.headers["X-Version"] === config.CLIENT_HEADERS["X-Version"], id.headers["X-Version"]);
  check("pinned source is reported honestly", id.source === "pinned", id.source);
  check("startup warning tells the operator it is running on pinned identity",
    warns.some((w) => /running on pinned identity/.test(w)), warns.join(" | "));
  check("warning names the fix", warns.some((w) => /GLMP_IDENTITY_VERSION|Run AutoClaw once/.test(w)));
  check("User-Agent is the value the real client actually sends, not an invented product token",
    id.userAgent === "node", id.userAgent);

  // ---- 6. env override wins and says so -----------------------------------
  const homeB = makeHome();
  process.env.GLMP_IDENTITY_VERSION = "9.9.9";
  try {
    const cfgB = loadConfig({ format: "openai" });
    const { log: logB, warns: warnsB } = captureLog();
    const layerB = createIdentityLayer(cfgB, logB);
    const idB = layerB.getIdentity();
    check("GLMP_IDENTITY_VERSION override wins verbatim", idB.headers["X-Version"] === "9.9.9", idB.headers["X-Version"]);
    check("override source is reported", idB.source === "override", idB.source);
    check("override is logged", warnsB.some((w) => /override/i.test(w)), warnsB.join(" | "));
  } finally {
    delete process.env.GLMP_IDENTITY_VERSION;
    void homeB;
  }
});

// ---- 7. hot-reload on file rewrite, without a restart ---------------------

const homeD = makeHome();
await withHome(homeD, async () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const config = loadConfig({ format: "openai" });
  const { log } = captureLog();

  writeRuntime(homeD, "1.17.8");
  const layer = createIdentityLayer(config, log, clock);
  check("hot-reload: initial read", layer.getIdentity().headers["X-Version"] === "1.17.8");

  // Rewrite the app file *while the layer lives* — this is the app-update case.
  writeRuntime(homeD, "1.18.0");
  check("hot-reload: cached inside the TTL window",
    layer.getIdentity().headers["X-Version"] === "1.17.8", layer.getIdentity().headers["X-Version"]);

  now += config.TOKEN_TTL_MS + 1;
  check("hot-reload: new version picked up after the TTL, no restart",
    layer.getIdentity().headers["X-Version"] === "1.18.0", layer.getIdentity().headers["X-Version"]);

  const fresh = layer.freshness();
  check("freshness reports the source and version", fresh.source === "runtime" && fresh.version === "1.18.0", JSON.stringify(fresh));
  check("freshness reports an observation age", typeof fresh.ageMs === "number" && fresh.ageMs >= 0, String(fresh.ageMs));
  check("freshness has no drift before a remote version is known", fresh.knownDrift === null, JSON.stringify(fresh.knownDrift));
});

// ---- 8. a spawned proxy announces a pinned identity at startup ------------

const PORT = PEN_TEST_PORTS.p6;
const homeC = makeHome();
const proxy = await startProxy(PORT, {
  HOME: homeC, USERPROFILE: homeC, LOG_LEVEL: "info",
});
const out = proxyOutput(proxy).all || "";
check("spawned proxy: startup output warns about the pinned identity",
  /running on pinned identity/.test(out), out.slice(0, 400));
await stopProxy(proxy);

// ---- 9. request-shape parity (Requirement 4) ------------------------------
//
// The banner the proxy prepends is now READ from the installed app's own prompt
// builder rather than trusted as a compiled-in string — because the pin had a
// one-character bug in the exact string the old code called load-bearing: the app
// joins its prompt lines with "\n" and puts a *blank line* before "## Tooling",
// while the pin had a single "\n". A byte-shape mismatch in a string the app owns
// is the same rot class as the stale 1.17.5 version, so it gets the same
// treatment: discover, snapshot, and only then pin — and announce the pin.

async function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

// Shaped like the app's own builder: an array of literals joined with "\n",
// opening with the anchor, an empty line, then the section heading.
function writePromptConfigFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "system-prompt-config-abc123.js");
  fs.writeFileSync(file, [
    "const lines = [",
    '  "You are a personal assistant running inside OpenClaw.",',
    '  "",',
    '  "## Tooling",',
    '  "tools go here",',
    '].join("\\n");',
  ].join("\n"), "utf8");
  return file;
}

const CLEAN_SHAPE_ENV = {
  GLMP_GATEWAY_DIST: undefined, AUTOCLAW_SYSTEM_BANNER: undefined,
  PROMPT_ENVELOPE_KB: undefined, TOOL_SHAPE_BLOCKLIST: undefined,
};

// Point discovery at a path that does not exist. The gateway-dist roots come from
// ProgramFiles/LOCALAPPDATA, so unlike the runtime file they are NOT hidden by a
// fake HOME — without this the real install on this machine answers, and the
// snapshot/pin rungs below could never be exercised.
const NO_INSTALL = (home) => ({ ...CLEAN_SHAPE_ENV, GLMP_GATEWAY_DIST: path.join(home, "no-such-autoclaw") });

check("shape: the extractor reads the anchor, the blank line and the heading",
  extractBannerFrom('["You are a personal assistant running inside OpenClaw.", "", "## Tooling"].join("\\n")')
    === PINNED_BANNER, JSON.stringify(PINNED_BANNER));
check("shape: the pinned fallback carries the app's blank line, not a single newline",
  PINNED_BANNER.includes("\n\n## Tooling"), JSON.stringify(PINNED_BANNER));
check("shape: a file without the anchor yields no banner instead of a guess",
  extractBannerFrom("const other = 'nothing to see here';") === null);

// Discovered from the installed app's dist directory.
{
  const home = makeHome();
  await withHome(home, async () => {
    const dist = path.join(home, "resources", "gateway", "openclaw", "dist");
    writePromptConfigFixture(dist);
    await withEnv({ ...CLEAN_SHAPE_ENV, GLMP_GATEWAY_DIST: dist }, async () => {
      const config = loadConfig({ format: "openai" });
      const cap = captureLog();

      // Pre-seed a *stale* snapshot. A live install must outrank it — discovery
      // first, last-good copy second — so the order is asserted, not assumed.
      const state = path.join(home, ".openclaw-autoclaw", "proxy-state");
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, BANNER_SNAPSHOT_FILE), JSON.stringify({
        banner: "You are a personal assistant running inside OpenClaw.\n\n## Tooling\n\nSTALE-SNAPSHOT",
        observedAt: new Date(Date.now() - 86_400_000).toISOString(), source: "gateway",
      }), "utf8");

      const layer = getShapeLayer(config, cap.log);
      const banner = layer.getBanner();

      check("shape: the banner is discovered from the installed app, not the pin",
        banner.source === "gateway", banner.source);
      check("shape: a live install outranks the last-good snapshot",
        banner.text === PINNED_BANNER && !banner.text.includes("STALE-SNAPSHOT"), JSON.stringify(banner.text));
      check("shape: the discovered banner is the app's own byte shape",
        banner.text === PINNED_BANNER, JSON.stringify(banner.text));
      check("shape: a discovered banner is snapshotted for a later closed app",
        fs.existsSync(layer.snapshotPath()), layer.snapshotPath());

      // The point of the whole layer: the resolved banner is what goes out.
      const injected = layer.injectBanner([{ role: "user", content: "hi" }]);
      check("shape: injection prepends the resolved banner to a bannerless request",
        injected[0].role === "system" && injected[0].content === PINNED_BANNER
        && injected[1].content === "hi", JSON.stringify(injected));

      const already = layer.injectBanner([
        { role: "system", content: `${PINNED_BANNER}\n\nbe helpful` },
        { role: "user", content: "hi" },
      ]);
      check("shape: a banner the client already sent is never duplicated",
        already.length === 2 && already[0].content === `${PINNED_BANNER}\n\nbe helpful`,
        JSON.stringify(already));
    });
  });
}

// Closed app: the snapshot stands in for the install.
{
  const home = makeHome();
  await withHome(home, async () => {
    const state = path.join(home, ".openclaw-autoclaw", "proxy-state");
    fs.mkdirSync(state, { recursive: true });
    const remembered = "You are a personal assistant running inside OpenClaw.\n\n## Tooling\n\nobserved from a real install";
    fs.writeFileSync(path.join(state, BANNER_SNAPSHOT_FILE), JSON.stringify({
      banner: remembered, file: "C:/AutoClaw/resources/gateway/openclaw/dist/system-prompt-config-abc.js",
      observedAt: new Date().toISOString(), source: "gateway",
    }), "utf8");

    await withEnv(NO_INSTALL(home), async () => {
      const config = loadConfig({ format: "openai" });
      const cap = captureLog();
      const layer = getShapeLayer(config, cap.log);
      check("shape: with no install, the last observed banner wins over the pin",
        layer.getBanner().source === "snapshot", layer.getBanner().source);
      check("shape: the snapshot's banner is used verbatim",
        layer.getBanner().text === remembered, JSON.stringify(layer.getBanner().text));
    });
  });
}

// Nothing at all: the pin, announced.
{
  const home = makeHome();
  await withHome(home, async () => {
    await withEnv(NO_INSTALL(home), async () => {
      const config = loadConfig({ format: "openai" });
      const cap = captureLog();
      const layer = getShapeLayer(config, cap.log);
      check("shape: with nothing discoverable the pin is used",
        layer.getBanner().source === "pinned" && layer.getBanner().text === PINNED_BANNER,
        layer.getBanner().source);
      check("shape: running on the pin is announced, not silent",
        cap.warns.some((w) => /pinned system-prompt banner/.test(w)), cap.warns.join(" | "));
    });
  });
}

// The env override outranks discovery, exactly like the identity layer's.
{
  const home = makeHome();
  await withHome(home, async () => {
    const dist = path.join(home, "resources", "gateway", "openclaw", "dist");
    writePromptConfigFixture(dist);
    await withEnv({ ...CLEAN_SHAPE_ENV, GLMP_GATEWAY_DIST: dist, AUTOCLAW_SYSTEM_BANNER: "OVERRIDE-BANNER" }, async () => {
      const config = loadConfig({ format: "openai" });
      const cap = captureLog();
      const layer = getShapeLayer(config, cap.log);
      check("shape: the env override outranks a discovered banner",
        layer.getBanner().source === "override" && layer.getBanner().text === "OVERRIDE-BANNER",
        JSON.stringify(layer.getBanner()));
      check("shape: an override is announced",
        cap.infos.some((i) => /override active/.test(i)), cap.infos.join(" | "));
    });
  });
}

// Envelope compaction: opt-in, byte-bounded, head and tail preserved.
{
  const home = makeHome();
  await withHome(home, async () => {
    const long = `HEAD-MARKER\n${"x".repeat(4096)}\nTAIL-MARKER`;
    const messages = [{ role: "system", content: long }, { role: "user", content: "hi" }];

    await withEnv({ ...NO_INSTALL(home), PROMPT_ENVELOPE_KB: "1" }, async () => {
      const config = loadConfig({ format: "openai" });
      const cap = captureLog();
      const layer = getShapeLayer(config, cap.log);
      const out = layer.apply(messages, []);

      const bytes = Buffer.byteLength(out.messages[0].content, "utf8");
      check("shape: an over-envelope system prompt is compacted to the envelope",
        out.compacted === true && bytes <= 1024, `${bytes} bytes`);
      check("shape: compaction marks the cut instead of hiding it",
        out.messages[0].content.includes(COMPACTION_MARKER), out.messages[0].content.slice(0, 120));
      check("shape: the end of the prompt survives compaction (the current request lives there)",
        out.messages[0].content.trimEnd().endsWith("TAIL-MARKER"), out.messages[0].content.slice(-60));
      check("shape: the banner head survives compaction",
        out.messages[0].content.includes(PINNED_BANNER), out.messages[0].content.slice(0, 120));
      check("shape: compaction is pure — the client's own body is not mutated",
        messages[0].content === long && messages[1].content === "hi", String(messages[0].content.length));
      check("shape: the compaction is logged",
        cap.warns.some((w) => /compacted to the 1KB envelope/.test(w)), cap.warns.join(" | "));
    });

    await withEnv(NO_INSTALL(home), async () => {
      const config = loadConfig({ format: "openai" });
      const layer = getShapeLayer(config, captureLog().log);
      const out = layer.apply(messages, []);
      check("shape: the envelope is off by default — a client's prompt is left alone",
        out.compacted === false && out.messages[0].content === `${PINNED_BANNER}\n\n${long}`,
        String(Buffer.byteLength(out.messages[0].content, "utf8")));
    });
  });
}

// Tool-shape filter: identity by default, explicit when a field is listed.
{
  const home = makeHome();
  await withHome(home, async () => {
    const tools = [{ type: "function", function: { name: "f" }, strict: true }];

    await withEnv(NO_INSTALL(home), async () => {
      const config = loadConfig({ format: "openai" });
      const out = getShapeLayer(config, captureLog().log).apply([{ role: "user", content: "hi" }], tools);
      check("shape: tools pass through untouched by default (empty blocklist = identity)",
        out.tools.length === 1 && out.tools[0].strict === true, JSON.stringify(out.tools));
    });

    await withEnv({ ...NO_INSTALL(home), TOOL_SHAPE_BLOCKLIST: "strict" }, async () => {
      const config = loadConfig({ format: "openai" });
      const cap = captureLog();
      const out = getShapeLayer(config, cap.log).apply([{ role: "user", content: "hi" }], tools);
      check("shape: a blocklisted tool field is dropped",
        out.tools[0].strict === undefined && out.tools[0].function.name === "f"
        && out.droppedToolFields.includes("strict"), JSON.stringify(out.tools));
      check("shape: a dropped tool field is logged, never silent",
        cap.infos.some((i) => /dropped tool field/.test(i)), cap.infos.join(" | "));
    });
  });
}

summary();
