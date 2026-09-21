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
import { loadConfig } from "../lib/core.js";
import { createIdentityLayer, IDENTITY_SNAPSHOT_FILE } from "../lib/identity.js";

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
async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
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
  check("derived User-Agent tracks the version instead of being frozen",
    id.userAgent === `AutoClaw/${config.CLIENT_HEADERS["X-Version"]} (win)`, id.userAgent);

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

await withHome(makeHome(), async () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const config = loadConfig({ format: "openai" });
  const { log } = captureLog();

  writeRuntime(path.dirname(path.dirname(path.join(config.RUNTIME_CANDIDATES[0]))), "1.17.8");
  const layer = createIdentityLayer(config, log, clock);
  check("hot-reload: initial read", layer.getIdentity().headers["X-Version"] === "1.17.8");

  // Rewrite the app file *while the layer lives* — this is the app-update case.
  writeRuntime(path.dirname(path.dirname(config.RUNTIME_CANDIDATES[0])), "1.18.0");
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

summary();
