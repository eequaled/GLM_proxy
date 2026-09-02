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

## How it works

```
Your App           GLM Proxy                          AutoClaw Backend
(OpenAI SDK)  ───▶ 127.0.0.1:18791 (OpenAI format)  ───▶  autoglm-api.autoglm.ai (cloud)
                   127.0.0.1:18792 (Anthropic format)
                         │  cloud fails
                         ▼
                    AutoClaw desktop agent
                    127.0.0.1:18789 (local WebSocket)
```

AutoClaw handles authentication automatically. When the cloud path fails, requests fall back to AutoClaw's own desktop agent over a local WebSocket. See [Local gateway fallback](#local-gateway-fallback) for details.

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
  ✔ working [cloud 402 → local agent] (38.4s) → PONG 🦞
  ✗ failed (404) (0.9s) → Model ... is not recognized by AutoClaw upstream
```

`[cloud ok]` means the cloud served it. `[cloud NNN → local agent]` means the cloud rejected it (HTTP NNN) and AutoClaw's desktop-agent fallback answered. This uses isolated log files, so it never clobbers your running proxy's records.

</details>

<details>
<summary><h2>Configuration (all flags & env vars)</h2></summary>

| Variable / Flag | Default | Description |
|-----------------|---------|-------------|
| `PORT` / `--port` | `18791` (OpenAI), `18792` (Anthropic) | Port this proxy listens on |
| `HOST` / `--host` | `127.0.0.1` | Bind address |
| `PROXY_KEY` / `--key` | `mewmew` | API key clients must send. Fine for localhost, change it when binding beyond loopback |
| `RATE_LIMIT` / `--rate-limit` | `30` | Max requests per second per client IP |
| `MAX_MESSAGES` / `--max-messages` | unlimited (`0`/unset) | Max message/entity limit in request payload (explicit values: 128, 256, 512, 1024). Leave unlimited if your harness compresses or batches history, raise it if you hit `413 / payload too large` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `silent` |
| `PREFER_LOCAL` | off | Set to `1` to use the local AutoClaw gateway first, skipping cloud attempts |
| `TRUSTED_PROXIES` | empty | Comma-separated IPs whose `X-Forwarded-For` header is trusted for rate limiting |
| `MAX_BODY_BYTES` | `52428800` | Max request body (50 MB) |
| `JSONL_LOG` | off | Write structured JSONL request log when `true` (also on with `LOG_LEVEL=debug`) |
| `JSONL_FILE` | `proxy_requests.jsonl` (Anthropic: `proxy_requests_anthropic.jsonl`) | JSONL output path |
| `JSONL_SYNC` | off | Write JSONL lines synchronously when `true` (flush every line) |
| `JSONL_MAX_BYTES` | `10485760` | Rotate JSONL log when it exceeds this (10 MB) |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Per-attempt upstream budget (idle-based, the vendor allows up to 20 min, raise this for slow thinking models) |
| `GATEWAY_MIN_PROTOCOL` / `GATEWAY_MAX_PROTOCOL` | `3` / `4` | Local-gateway WS protocol range offered on connect (self-heals to the gateway's expected protocol on mismatch) |
| `LOCAL_GATEWAY_HOST` / `LOCAL_GATEWAY_PORT` | `127.0.0.1` / `18789` | Where the AutoClaw desktop gateway is expected |
| `FALLBACK_MODELS_PATH` | empty | Path to an external fallback model catalog JSON (`{"models":[...]}`), defaults to the shipped `lib/fallback-models.json` |
| `AUTOCLAW_SYSTEM_BANNER` | built-in | Override the system-prompt banner injected into cloud requests (keep the `## Tooling` line intact) |
| `--anthropic` | — | Run in Anthropic API format |
| `--openai` | — | Run in OpenAI API format (default) |
| `--limit [n]` | — | Set or clear the max message/entity limit (e.g. `--limit 256`; bare `--limit` prints the current value) |
| `--doctor` | — | Scan AutoClaw's current runtime model catalog and show Anthropic routing |
| `--test-models` / `--test` | — | Live health check: test every catalog model through the full pipeline |
| `--help`, `-h` | — | Show CLI help |

**JSONL request logging.** Set `JSONL_LOG=true` (or `LOG_LEVEL=debug`) to write one JSON line per request:

```json
{"ts":"2026-07-29T03:41:00.000Z","model":"zai_auto","status":200,"ip":"127.0.0.1","latencyMs":423}
```

Alongside the JSONL stream, a compact ring log (`proxy_requests.json`, last 50 entries; path via `REQUEST_LOG_FILE`) records every terminal outcome, including `via: "local"` and the cloud verdict (`cloud_status` / `cloud_error`) when the cloud rejected a request the local agent ended up serving.

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
| AutoClaw token expired | `401` | `token_expired` |
| Model unknown upstream | `404` | `model_not_found` |
| Upstream rate limit | `429` | `rate_limited_by_upstream` |
| Upstream returned garbage or died | `502` | `upstream_failure` |
| AutoClaw not running (no token file) | `503` | `no_token` |
| Upstream timeout (default 2 min, see `UPSTREAM_TIMEOUT_MS`) | `504` | `upstream_timeout` |

Quota errors are remembered for 60s per model, so repeat requests fail instantly instead of replaying doomed cloud and fallback attempts.

</details>

<details>
<summary><h2>Local gateway fallback</h2></summary>

When the cloud upstream fails (and it's not a plain 404/429), the proxy re-runs your prompt through AutoClaw's own desktop agent over a local WebSocket (`127.0.0.1:18789`). Responses served this way are logged with `via: "local"`. It's a full agentic run (slower, tools included) and shares your account's credits, so quota walls stop it too. Set `PREFER_LOCAL=1` to skip the cloud attempt entirely while credits are exhausted.

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

- Only one AutoClaw account can be active at a time, multi-account pooling isn't supported
- `PROXY_KEY` is just a local password for this proxy, not your AutoClaw credentials. Set it to whatever you want. The default `mewmew` is for localhost-only use
- On a 401, the proxy invalidates its cached token and you can retry immediately
- Upstream 400 `"invalid request"` gets one retry after a 2s delay (a known upstream hiccup). Quota/plan errors are never retried
- The cloud upstream requires AutoClaw's app system-prompt banner in every request. The proxy injects it automatically and never duplicates it. In practice it doesn't change much since your harness's own system prompt overrides it anyway
- Max output is clamped to each model's real upstream cap (131K for every GLM model, 393K for DeepSeek). AutoClaw's runtime catalog overstates GLM-5.3's cap (307K), and asking the cloud for more than a model's real cap makes it **silently run a DeepSeek model instead and bill DeepSeek credits** — the proxy clamps so your `zai_glm-5.3` stays GLM-5.3
- The token file is watched for changes, so AutoClaw can rotate auth mid-session without a restart
- AutoClaw's client identity (app version, platform, channel) loads dynamically from its runtime file, same as the model catalog, so an AutoClaw app update is picked up without editing or restarting the proxy
- The fallback model catalog lives in `lib/fallback-models.json` (override with `FALLBACK_MODELS_PATH`). The built-in list is only a last resort when AutoClaw's runtime file is unreadable
- The local-gateway connection self-heals: if the gateway bumps its WS protocol, the proxy reconnects with the expected version automatically
- No dependencies at all. The interactive menu is hand-rolled on Node's built-in `readline`, so there's zero `node_modules` and zero install step

</details>

---

## Special Thanks

<p align="center">
  <img src="./screenshots/jarona.png" alt="Special thanks to Jarona" width="200">
</p>

## License

MIT License + Jarona Rights™ (sorry to keep u waiting)