# GLM Proxy

<p align="center">
  <b>Use your AutoClaw GLM models in any tool that speaks the OpenAI or Anthropic API</b><br>
  <sub>Claude Code, Cursor, Continue, OpenCode, LiteLLM, raw SDKs. Point them here instead.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js >=18">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/npm/v/glmproxy" alt="npm version">
  <img src="https://img.shields.io/npm/dm/glmproxy" alt="npm downloads">
  <img src="https://github.com/eequaled/GLM_proxy/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

<p align="center"><sub>v2.6.0. One CLI, two API formats, zero dependencies.</sub></p>

---

## Quick Start

```bash
npm i -g glmproxy
glmproxy
```

That's it, an interactive menu walks you through format, port, and key. Prefer flags?

```bash
glmproxy --anthropic --port 3001 --key mykey
```

Then point any OpenAI-compatible tool at `http://127.0.0.1:18791/v1`, or any Anthropic-compatible tool at `http://127.0.0.1:18792`. Default key is `mewmew` (see [Integrations](#integrations) below for exact per-tool setup).

**You need:** [AutoClaw](https://autoclaw.z.ai) installed, running, and logged in (Windows/macOS), plus Node.js 18+. The proxy reads auth straight from AutoClaw's local token file, so there's no manual token setup and no API keys to copy.

---

## Integrations

### Claude Code CLI

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:18792",
    "ANTHROPIC_AUTH_TOKEN": "mewmew"
  }
}
```

### OpenCode

```json
{
  "provider": {
    "autoclaw": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AutoClaw",
      "options": {
        "baseURL": "http://localhost:18791/v1",
        "apiKey": "mewmew"
      },
      "models": {
        "zai_auto": { "name": "AutoClaw Auto" },
        "zaicoding_glm-5.3": { "name": "AutoClaw GLM-5.3" },
        "zai_glm-5-turbo": { "name": "AutoClaw GLM-5 Turbo" },
        "tdpsk_deepseek-v4-flash-202605": { "name": "AutoClaw Deepseek-V4-Flash" },
        "tdpsk_deepseek-v4-pro-202606": { "name": "AutoClaw DeepSeek-V4-Pro" }
      }
    }
  }
}
```

### Cursor / Continue / anything OpenAI-compatible

Point it at `http://localhost:18791/v1` with API key `mewmew`. Harnesses that probe for available models pick up the live list from `/v1/models` automatically.

Or add it as a custom model directly in the UI:
- **API Format**: OpenAI Chat Completions
- **URL**: `http://localhost:18791/v1`
- **Model ID**: `zai_auto` (or any model from the table below)
- **API Key**: `mewmew`

### Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:18791/v1", api_key="mewmew")

with client.chat.completions.stream(
    model="zai_auto",
    messages=[{"role": "user", "content": "Hello!"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### JavaScript

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:18791/v1",
  apiKey:  "mewmew",
});

const stream = await client.chat.completions.create({
  model:    "zai_auto",
  messages: [{ role: "user", content: "Hello!" }],
  stream:   true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

---

## Why this exists

AutoClaw gives you Zhipu's GLM models (GLM-5.3, GLM-5-Turbo, GLM-5.3-Flash, plus DeepSeek), but locks them inside its own desktop app. This proxy speaks OpenAI and Anthropic API dialects on one side and AutoClaw's native protocol on the other, so any tool built for those APIs can drive AutoClaw's models. The model list is pulled live from AutoClaw's runtime config, so anything AutoClaw adds or removes shows up without a proxy restart.

It also paces itself: a sliding hourly request budget per account keeps a runaway harness from burning your account into a ban. See [Account safety](#account-safety).

-# ⚠️ <u>**A ban is not a throttle, and this proxy cannot undo one.**</u> `403` + `410004` is a real, permanent ban; `403` + `810002` "high demand" is only a capacity throttle, and the proxy retries that for you. Details: [error handling](#error-handling) · [ban risk](#ban-risk-and-what-changed-since) · [full write-up](BAN-RISK-AND-LIMITS.md)

## How it works

```
Your App           GLM Proxy                          AutoClaw Backend
(OpenAI SDK)  ───▶ 127.0.0.1:18791 (OpenAI format)  ───▶  autoglm-api.autoglm.ai (cloud)
                   127.0.0.1:18792 (Anthropic format)
                         │  cloud is the only
                         ▼  route (throttles
              AutoClaw cloud   are retried here)
              autoglm-api.autoglm.ai
```

AutoClaw handles authentication automatically. The cloud is the only route: if it answers a capacity throttle, the proxy waits and retries in-process so a transient wall does not kill your harness session. See [Throttle retries](#throttle-retries-and-why-there-is-no-fallback) for details.

<p align="center">
  <i>AutoClaw running as your background service, that's the whole "auth" story</i>
  <br>
  <img src="./screenshots/autoclaw-background.png" alt="AutoClaw running as background service" width="700">
</p>

<p align="center">
  <i>the proxy in action (ignore claude code here)</i>
  <br>
  <img src="./screenshots/image.png" alt="Proxy terminal showing successful operation" width="700">
</p>

## Current available models in autoclaw

| ID | Name | Context | Max Output | Notes |
|----|------|---------|------------|-------|
| `zai_auto` | Auto | 1M | 131K | Routes to AutoClaw's optimal model (GLM-5.3-Flash today) |
| `zaicoding_glm-5.3` | GLM-5.3 | 1M | 131K | Latest GLM coding model |
| `zai_glm-5-turbo` | GLM-5-Turbo | 200K | 131K | Zhipu AI GLM-5 Turbo |
| `zai_glm-5.3-flash` | GLM-5.3-Flash ("OX-alpha") | 1M | 131K | Now a regular catalog model, served straight through the cloud path |
| `tdpsk_deepseek-v4-flash-202605` | Deepseek-V4-Flash | 1M | 393K | Fast DeepSeek model |
| `tdpsk_deepseek-v4-pro-202606` | DeepSeek-V4-Pro | 1M | 393K | Deep reasoning model |

> GLM 5.3 flash new in the proxy!!!!! ox alpha the goat

The catalog is re-read from AutoClaw's `openclaw.runtime.json` on every `/v1/models` call, with a built-in fallback if that file isn't readable. Run `glmproxy --doctor` to inspect the current catalog after an AutoClaw update. Claude model names sent to the Anthropic proxy are mapped automatically:

| Claude model | Routes to |
|---|---|
| `claude-opus-*` | First available GLM-5.3 / GLM-5 model |
| `claude-sonnet-*` | `zai_auto` (or next available GLM-5 model) |
| `claude-haiku-*` | `zai_glm-5-turbo` (or DeepSeek / Auto fallback) |

---

<details>
<summary><h2>CLI reference</h2></summary>

Running `glmproxy` with no flags on a real terminal opens an interactive menu: arrow keys to move, Enter to pick. Choose format, port, host, and auth key, or run **Model Doctor** / **Test Models** without starting a proxy. Ctrl+C quits cleanly and restores your terminal. Without a TTY (piped stdin, CI), the CLI skips the menu and starts the OpenAI format on port 18791 using your env vars or defaults.

| Format | Flag | Default port | Use with |
|--------|------|--------------|----------|
| OpenAI (`/v1/chat/completions`) | `--openai` (default) | `18791` | OpenCode, Cursor, Continue, LiteLLM, Python/JS SDKs |
| Anthropic (`/v1/messages`) | `--anthropic` | `18792` | Claude Code CLI, Anthropic SDK |

Config can also come from env vars. The CLI leaves existing ones alone:

```bash
PORT=3001 PROXY_KEY=mykey RATE_LIMIT=50 glmproxy
```

**Direct entry points**, if you'd rather skip the CLI entirely:

```bash
node openai.js      # OpenAI format, port 18791
node anthropic.js   # Anthropic format, port 18792
```

They read the same env vars and respect `HOST`, `PORT`, `PROXY_KEY`, `RATE_LIMIT`, etc.

**npm commands:**

| Command | What it does |
|---------|--------------|
| `npm start` | Launch the interactive CLI (`node bin/cli.js`) |
| `npm run anthropic` | Start the Anthropic proxy directly (`node anthropic.js`), bypassing the menu |
| `npm test` | Run the pen-test suite, error-taxonomy tests, and the runtime-catalog refresh test |

Dev usage from a checkout: `npm start` or `node bin/cli.js`.

**Model doctor** scans AutoClaw's live model catalog with credit tiers and prints the Claude alias routing map:

```bash
glmproxy --doctor
```

Anthropic routing follows credit tiers: opus goes to High, sonnet to Medium, haiku to Low. UI display names can differ from API ids (e.g. the API's `zaicoding_glm-5.3` shows as "GLM-5.2" in AutoClaw's UI).

**Model health test** spawns a throwaway proxy and fires a minimal prompt at every catalog model:

```bash
glmproxy --test-models
```

```
  ✔ working [cloud ok] (1.2s) → PONG
  ✔ working [cloud 403] (11.3s) → PONG 🦞
  ✗ failed (404) (0.9s) → Model ... is not recognized by AutoClaw upstream
```

`[cloud ok]` means the first attempt succeeded. `[cloud NNN]` means a first attempt returned HTTP NNN — a capacity throttle or a 5xx — and the proxy retried in-process before answering. That 11.3s is the retry budget, not a fallback. This uses isolated log files, so it never clobbers your running proxy's records.

</details>

<details>
<summary><h2>Configuration (all flags & env vars)</h2></summary>

| Variable / Flag | Default | Description |
|-----------------|---------|-------------|
| `PORT` / `--port` | `18791` (OpenAI), `18792` (Anthropic) | Port this proxy listens on |
| `HOST` / `--host` | `127.0.0.1` | Bind address |
| `PROXY_KEY` / `--key` | `mewmew` | API key clients must send. Fine for localhost, change it when binding beyond loopback |
| `RATE_LIMIT` / `--rate-limit` | `30` | Max requests per second per client IP |
| `BUDGET_REQUESTS_PER_HOUR` | `300` | **Anti-ban pacing.** Upstream requests per hour **per AutoClaw account** — keyed on the JWT's `user_id`, so the app's hourly token rotation does not reset it. Warns at 80%, answers `429 budget_exceeded` at 100% without touching upstream. `0` disables. See [Account safety](#account-safety) |
| `GLMP_MIN_GAP_MS` | `250` | Minimum gap between upstream calls, jittered ±40% with arrival order preserved. Breaks robotic sub-10 ms bursts without feeling like latency. `0` disables |
| `GOVERNOR_PERSIST` | on | Set to `0` to stop carrying the pacing window across restarts. On by default: a crash should not hand the account a fresh hourly budget |
| `MAX_MESSAGES` / `--max-messages` | unlimited (`0`/unset) | Max message/entity limit in request payload (explicit values: 128, 256, 512, 1024). Leave unlimited if your harness compresses or batches history, raise it if you hit `413 / payload too large` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `silent` |
| `PREFER_LOCAL` | removed | The local desktop-agent fallback is gone (see [Throttle retries](#throttle-retries-and-why-there-is-no-fallback)). Setting `PREFER_LOCAL=1` is a stated no-op that logs a notice; the cloud is the only route |
| `TRUSTED_PROXIES` | empty | Comma-separated IPs whose `X-Forwarded-For` header is trusted for rate limiting |
| `MAX_BODY_BYTES` | `52428800` | Max request body (50 MB) |
| `MAX_MESSAGE_TEXT_BYTES` | `262144` | Max per-message TEXT size (256 KB; base64 image data is not counted as text) |
| `MAX_TOTAL_MESSAGE_TEXT_BYTES` | `1048576` | Max combined message text (1 MB) |
| `MAX_IMAGE_BYTES` | `20971520` | Max decoded size per image attachment (20 MB) |
| `JSONL_LOG` | off | Write structured JSONL request log when `true` (also on with `LOG_LEVEL=debug`) |
| `JSONL_FILE` | `proxy_requests.jsonl` (Anthropic: `proxy_requests_anthropic.jsonl`) | JSONL output path |
| `JSONL_SYNC` | off | Write JSONL lines synchronously when `true` (flush every line) |
| `JSONL_MAX_BYTES` | `10485760` | Rotate JSONL log when it exceeds this (10 MB) |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Per-attempt upstream budget (idle-based, the vendor allows up to 20 min, raise this for slow thinking models) |
| `GLMP_THROTTLE_RETRY_MS` | `4000` | Base wait before retrying a capacity throttle (the free tier's `810002` "high demand", or a plain upstream 429), jittered ±20% and growing 1.5× per attempt |
| `GLMP_THROTTLE_RETRIES` | `2` | Retry count for capacity throttles. `0` turns retrying off. Bans and quota walls are never retried — those are deterministic |
| `FALLBACK_MODELS_PATH` | empty | Path to an external fallback model catalog JSON (`{"models":[...]}`), defaults to the shipped `lib/fallback-models.json` |
| `AUTOCLAW_SYSTEM_BANNER` | discovered (fallback: the app's own literal) | Override the system-prompt banner injected into cloud requests. The banner is now **discovered from your installed app** (`resources/gateway/openclaw/dist/system-prompt-config-*.js`), cached to `proxy-state/banner.last-good.json`, and only falls back to a compiled-in literal when nothing is discoverable — because the old pin had a one-character bug (a single `\n` where the app emits a blank line before `## Tooling`). Discovery outranks the pin; this env var outranks discovery, so set it only to patch a reworded prompt without a release |
| `PROMPT_ENVELOPE_KB` | off (`0`) | Cap the **system** message at this many KB before forwarding. A foreign harness sends a 30 KB system prompt the app never would; over the envelope the proxy drops the middle and inserts a visible marker, keeping the head (banner, framing) and the tail (the actual current request). Only the system message is touched — your conversation history is never truncated. Off by default: compaction changes the prompt you asked for, so it is opt-in |
| `TOOL_SHAPE_BLOCKLIST` | empty | Comma-separated structural fields to drop from each tool entry before forwarding (e.g. `strict,cache_control`). Empty by default on purpose — tools were observed passing upstream unchanged, so a drop is only added once there is evidence upstream rejects the field. Every drop is logged |
| `GLMP_GATEWAY_DIST` | auto-detected | Where the installed app's prompt builder lives. Auto-detected from the platform install roots (`%ProgramFiles%\AutoClaw`, `%LOCALAPPDATA%\Programs\AutoClaw`, `/Applications/AutoClaw.app/Contents/Resources`, `/opt/AutoClaw`). Set it to point discovery at another install, or at a fixture copy in tests |
| `GLMP_IDENTITY_VERSION` | discovered (fallback `1.18.5`) | Pin the client `X-Version` the proxy sends. Normally discovered from your installed app and cached in `~/.openclaw-autoclaw/proxy-state/identity.last-good.json`, so a closed app still reports the last observed version instead of a stale pin. Set this only to override discovery (e.g. while the app is mid-update); the proxy logs when an override is active |
| `GLMP_USER_AGENT` | `node` (measured) | Override the upstream `User-Agent` header. The real client sends **`node`** — undici's stack default — because it publishes no UA of its own; a product-token UA would be a *more* distinctive signal than the truth, so this default is the faithful one |
| `GLMP_ACCEPT` | `*/*` (measured) | Override the upstream `Accept` header. The app sets this to `*/*` |
| `GLMP_HARNESS_TYPE` | `zcode` (measured) | The harness declaration the upstream's **system-prompt allowlist** actually accepts. The app sends `X-Harness-Type: zcode` + `x_trace_id: autoclaw-desktop` on every model-proxy request (verbatim comment in the shipped bundle: *"Exempts zcode requests from api-proxy's system-prompt allowlist check"*), and it is probe-verified to satisfy that gate **on its own** — without it the upstream answers `400 invalid request` unless the prompt carries the banner. Set to empty to send no declaration |
| `HEARTBEAT_INTERVAL_MS` | `300000` (measured) | Companion-traffic cadence: the proxy polls AutoClaw's model config on the same 300 s interval the desktop app does (measured from the app's own `interval=300s` poll log). Keeps `/v1/models` and the Claude alias routing fresh without a restart, feeds the identity drift report, and doubles as the cheap ban-lift probe — a `200` on a `GET`, never a completion. `0` disables it |
| `--anthropic` | — | Run in Anthropic API format |
| `--openai` | — | Run in OpenAI API format (default) |
| `--limit [n]` | — | Set or clear the max message/entity limit (e.g. `--limit 256`; bare `--limit` prints the current value) |
| `--budget [n]` | — | Set or clear the hourly account budget (e.g. `--budget 600`; bare `--budget` prints the current value, `--budget 0` disables pacing) |
| `--doctor` | — | Scan AutoClaw's current runtime model catalog and show Anthropic routing |
| `--test-models` / `--test` | — | Live health check: test every catalog model through the full pipeline |
| `--stop` | — | Kill any other running glmproxy instances (npm-global or `bin/cli.js` starts) and exit |
| `--help`, `-h` | — | Show CLI help |

**JSONL request logging.** Set `JSONL_LOG=true` (or `LOG_LEVEL=debug`) to write one JSON line per request:

```json
{"ts":"2026-07-29T03:41:00.000Z","model":"zai_auto","status":200,"ip":"127.0.0.1","latencyMs":423}
```

Alongside the JSONL stream, a compact ring log (`proxy_requests.json`, last 50 entries; path via `REQUEST_LOG_FILE`) records every terminal outcome, including the raw upstream status when the first attempt was not a plain 200 (`cloud_status`) and the classified error code.

</details>

<details>
<summary><h2>API reference</h2></summary>

### `GET /healthz`

```json
{
  "ok": true,
  "status": "live",
  "upstream": "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw",
  "port": 18791
}
```

### `GET /v1/models`

Lists available models in OpenAI format (OpenAI proxy) or Anthropic format (Anthropic proxy). Re-read from AutoClaw's runtime file on every call, so no restart is needed when AutoClaw's model list changes.

### `POST /v1/chat/completions` (OpenAI proxy)

Supports streaming (`stream: true`) and non-streaming.

```
Authorization: Bearer mewmew
Content-Type: application/json
```

### `POST /v1/messages` (Anthropic proxy)

Anthropic-compatible Messages API. Supports both streaming and non-streaming. See the models table above for Claude → GLM routing.

### Error handling

Every failure maps to a semantically correct status with a machine-readable `code`:

| Situation | HTTP | `code` |
|-----------|------|--------|
| Bad client input (bad JSON / oversized / wrong Content-Type) | `400` / `413` / `415` | `invalid_request` |
| Model out of credits or free quota (upstream 402/403/810000) | `402` | `quota_exhausted` |
| Free-tier capacity throttle, "high demand" (upstream 403/810002) | `429` | `upstream_busy` |
| Hourly account budget reached (`BUDGET_REQUESTS_PER_HOUR`) | `429` + `Retry-After` | `budget_exceeded` |
| Upstream is throttling this account — proxy is backing off | `429` + `Retry-After` | `upstream_backoff` |
| Account banned upstream (403/410004) | `403` | `account_quarantined` |
| AutoClaw token expired | `401` | `token_expired` |
| Model unknown upstream | `404` | `model_not_found` |
| Upstream rate limit | `429` | `rate_limited_by_upstream` |
| Upstream returned garbage or died | `502` | `upstream_failure` |
| AutoClaw not running (no token file) | `503` | `no_token` |
| Upstream timeout (default 2 min, see `UPSTREAM_TIMEOUT_MS`) | `504` | `upstream_timeout` |

Quota errors are remembered for 60s per model, so repeat requests fail instantly instead of replaying doomed attempts.

A capacity throttle (`upstream_busy`, a plain upstream `429`, or a `5xx`) is retried in place before your client sees it: two attempts, about 4 s then about 6 s, jittered. A ban, a quota wall and a bad request are never retried, because another attempt spends time and changes nothing. See [Throttle retries](#throttle-retries-and-why-there-is-no-fallback).

</details>

<details>
<summary><h2>Account safety</h2></summary>

**Read this before pointing an autonomous harness at this proxy.**

AutoClaw bans accounts for *velocity*, not for using an API. The ban reports that
motivated this feature all look the same: an unsupervised agent loop pushing
thousands of credits per hour through one account, then `403` + `410004`
("account banned"). The account is gone, and no amount of header fidelity brings
it back.

So the proxy paces itself by default. It keeps a **sliding one-hour request
budget per AutoClaw account**, keyed on the `user_id` claim inside your JWT —
not on the token string (the app rotates the token hourly, and a key that drifted
per rotation would quietly reset the budget up to 24 times a day), and not on
your IP (one account behind many IPs is still one account).

| What happens | What you see |
|---|---|
| You cross 80% of the hourly budget | A terminal notice + a log warning, once per window |
| You reach 100% | `429` `budget_exceeded` with a `Retry-After` header. **Nothing is sent upstream** — no credits are spent |
| Upstream throttles you (429, or the free-tier "high demand" `810002`) | The proxy waits a few seconds and sends the same call again, twice. If the wall holds you get `429` `upstream_busy`, and the governor backs off |
| Upstream says `410004` (banned) | `403` `account_quarantined`. Upstream calls stop, and the ban is never retried. Nothing on this side can undo it: the proxy resumes only if the account starts answering again |

Defaults, and what they mean:

```bash
BUDGET_REQUESTS_PER_HOUR=300   # the default. A guess, deliberately low.
GLMP_MIN_GAP_MS=250            # break robotic bursts, stay imperceptible
BUDGET_REQUESTS_PER_HOUR=0     # disable pacing entirely (you are on your own)
```

**300 requests/hour is a documented guess, not a measured threshold.** The
upstream does not publish its ban trigger and this project will not pretend to
know it. 300/h sits far below any plausible interactive envelope (a human on a
coding harness makes single-digit requests per minute in bursts) while staying
above casual chat, and erring low is the only safe direction for a safety net.
If your workflow legitimately needs more, raise it — `glmproxy --budget 600` or
the env var — but raise it on purpose rather than by accident.

`glmproxy --doctor` shows the current burst, the governor state, which account
the budget is keyed to, and when your token expires. `glmproxy --test-models`
and `--doctor` sweeps are exempt from the budget (counted separately) so a
health check can never be blocked by the pacing — or push your account over the
edge the pacing exists to protect.

What this deliberately does **not** do: rotate identities, randomize TLS
fingerprints, pool other people's accounts, or create accounts. Those are
evasion, not parity, and they turn "using my own account carefully" into
"defrauding a service". Pacing is the honest fix; the rest of this proxy's
parity work is about looking like the client it is, not like a different client.

**Why pooling several of your own accounts doesn't work either.** It sounds like
a bigger budget, but the device identity belongs to the machine, not to the
account: `identity\device.json` holds one `deviceId` and one Ed25519 keypair,
created once and never rotated per account, and AutoClaw keeps exactly one token
file (`request-headers.json`) — signing in as someone else replaces it. So every
account you capture here reports the *same* device id, and an automatic switch to
the second account seconds after the first is banned reads as one device routing
around a ban rather than as resilience. The honest answer for more throughput is
a second provider (kimi-proxy, arena2api, a local Ollama) or paying for one
account.

Where the numbers come from, and what happened before pacing existed:
[BAN-RISK-AND-LIMITS.md](BAN-RISK-AND-LIMITS.md), the longer write-up with the
evidence.

</details>

<details>
<summary><h2>Ban risk, and what changed since</h2></summary>

Issue #5 is a ban report. One user burned 8,000+ AutoClaw credits in about two
hours of continuous unattended harness use and was banned — in the desktop app
too, so the ban is account-scoped, not proxy-specific. A second user reported
the same shape.

Burn velocity is the cause, ranked above any fingerprint issue. A harness loop
with no account-level ceiling pushed thousands of requests through one account.

Three upstream errors get confused, and they mean different things:

| Signal | What it actually is |
|---|---|
| `410004 账号已被封禁`, HTTP `403` | A real account ban. Permanent for that account, and no proxy can undo it |
| `810002` with `"kind":"pay-view"` and "high demand… upgrade to a monthly subscription for priority access", also HTTP `403` | **Not** a ban. Free-tier capacity throttling. The account is fine and retrying later works |
| `810000` / HTTP `402` | Out of credits or free quota |

Both the ban and the throttle arrive as HTTP `403`, which is exactly why the two
get conflated.

Hardened on master since, all of it currently unreleased:

- The desktop-agent fallback is gone. On any cloud failure it re-ran your prompt inside AutoClaw as a full agentic session with tool access, so a throttled call could start a second agent editing the same files you were. A failed run also reached your client as a hard API error, or spent the full 120 s timeout first. One measured session lost about 26 minutes out of 50 to it.
- A quarantine is no longer a one-way door. The proxy polls the model-config endpoint every 5 minutes anyway, and a `200` from it proves the account answers again — so a ban that upstream later lifts (or a false positive) clears itself instead of waiting for someone to delete a state file. It costs a `GET`, never a completion.
- `--doctor` prints the token window too: `24h token — expires in 45m; re-capture it while the app is logged in`. A token file that has quietly died used to read like an account problem, because upstream answers `401` for both.
- A throttle maps to `429 upstream_busy` instead of a generic `403`, so a harness backs off instead of retrying into a wall. Throttle responses also trigger a bounded exponential backoff with jitter instead of an immediate retry.
- An unknown-model `400` used to hang for ~30 s on doomed retries before giving up. It is a clean `404` in about half a second now.
- Per-account pacing is the other half of this, and it is documented under [Account safety](#account-safety).

What is still unknown, and said plainly:

- The upstream may impose per-minute limits and short per-model cooldowns, not only hourly ones.
- The client can be required to sign its requests with a device-bound key that a proxy cannot reproduce. If the service turns that on, this proxy stops working, and paying a provider for API access is the honest answer.

Fuller detail: [BAN-RISK-AND-LIMITS.md](BAN-RISK-AND-LIMITS.md), the longer
write-up with the evidence.

</details>

<details>
<summary><h2>Throttle retries (and why there is no fallback)</h2></summary>


When the upstream answers a **capacity throttle** — the free tier's `403` + `810002`
"high demand… upgrade to a monthly subscription for priority access" — the proxy does
not hand that straight to your harness. It waits a few seconds and tries again: two
retries, jittered, about 4 s then about 6 s. The upstream's own body says "try again
shortly", and for a sustained throttle this turns a session-killing error into a brief
pause. If the wall is still there after both retries you get a clean `429` with a
`Retry-After`, so your harness can back off on its own terms. `GLMP_THROTTLE_RETRY_MS`
tunes the base wait, `GLMP_THROTTLE_RETRIES` the count (`0` turns retrying off).

A **ban** (`410004`) or a **quota wall** is never retried. Those are deterministic, so
another attempt only spends time and digs the hole deeper.

There used to be a second route. On a cloud failure the proxy re-ran your prompt inside
AutoClaw's desktop agent over a local WebSocket, as a full agentic session with tool
access, so a throttled call could start a second agent editing the same files you were.
It rarely worked, and when it did the work happened inside AutoClaw instead of here. It is
deleted. `PREFER_LOCAL`, the switch that drove it, logs a notice and changes nothing.
Why it went, with the measurements, is in [Ban risk, and what changed since](#ban-risk-and-what-changed-since).

</details>

<details>
<summary><h2>Self-hosting behind a reverse proxy</h2></summary>

The proxy binds to `127.0.0.1` by default. To run it on a server and expose it with TLS, bind to all interfaces and put a reverse proxy in front:

```bash
glmproxy --host 0.0.0.0 --port 18791 --key change-me
```

**Caddy** (automatic HTTPS):

```caddy
glm.example.com {
    reverse_proxy 127.0.0.1:18791
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name glm.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:18791;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_set_header Connection "";   # keep streaming (SSE) working
    }
}
```

Rate limiting keys off the client IP. When proxied, pass `X-Forwarded-For` and list the proxy's address in `TRUSTED_PROXIES` so the real client IP is used, otherwise every client shares one bucket:

```bash
TRUSTED_PROXIES=127.0.0.1 glmproxy --host 0.0.0.0
```

> The proxy needs a logged-in AutoClaw account running on the same machine (it reads the local token file), so a public endpoint is effectively a shared account. Only expose it to people you trust.

</details>

<details>
<summary><h2>Good to know</h2></summary>

- Only one AutoClaw account can be active at a time, multi-account pooling isn't supported — [Account safety](#account-safety) explains why it wouldn't help anyway
- `PROXY_KEY` is just a local password for this proxy, not your AutoClaw credentials. Set it to whatever you want. The default `mewmew` is for localhost-only use
- On a 401, the proxy invalidates its cached token and you can retry immediately
- Upstream 400 `"invalid request"` gets one retry after a 2s delay (a known upstream hiccup). Quota/plan errors are never retried
- The cloud upstream requires AutoClaw's app system-prompt banner in every request. The proxy injects it automatically and never duplicates it. In practice it doesn't change much since your harness's own system prompt overrides it anyway
- Max output is clamped to each model's real upstream cap (131K for every GLM model, 393K for DeepSeek). AutoClaw's runtime catalog overstates GLM-5.3's cap (307K), and asking the cloud for more than a model's real cap makes it **silently run a DeepSeek model instead and bill DeepSeek credits** — the proxy clamps so your `zai_glm-5.3` stays GLM-5.3
- Images pass through natively: pasted/attached images (`image_url` data URLs, Anthropic `image` blocks) reach vision-capable models (e.g. `zai_glm-5.3-flash`) as real image parts — the model sees them directly, no OCR bridge. Text-only models reject them upstream and the request falls back to the desktop agent, mirroring AutoClaw's own gating
- The token file is watched for changes, so AutoClaw can rotate auth mid-session without a restart
- AutoClaw's client identity (app version, platform, channel) loads dynamically from its runtime file, same as the model catalog, so an AutoClaw app update is picked up without editing or restarting the proxy
- The fallback model catalog lives in `lib/fallback-models.json` (override with `FALLBACK_MODELS_PATH`). The built-in list is only a last resort when AutoClaw's runtime file is unreadable
- A capacity throttle is retried in-process (two attempts, about 4 s then 6 s) so a transient "high demand" wall does not stop your harness. A ban or a quota wall is never retried
- No dependencies at all. The interactive menu is hand-rolled on Node's built-in `readline`, so there's zero `node_modules` and zero install step

</details>

---

## Special Thanks

<p align="center">
  <img src="./screenshots/jarona.png" alt="Special thanks to Jarona" width="200">
</p>

## License

MIT License + Jarona Rights™ (sorry to keep u waiting)