# Ban risk and limits

What makes an AutoClaw account get throttled or banned, and what hard limits exist.

The short version: the two failures that most often *look* like a ban are not bans. The free-tier capacity throttle and the out-of-credits wall return the same HTTP status as a real ban (403). A real ban is `410004 账号已被封禁`. What triggers a restriction is unpublished — no client-side number ties request volume, credit spend, or velocity to a ban. That is the honest answer.

Evidence is marked **observed** (found in a file or log on this machine, path given, raw string quoted) or **inferred** (a reading we applied, not something a file states).

## 1. Error vocabulary

| Signal | Meaning | HTTP | Evidence |
| --- | --- | --- | --- |
| `410004 账号已被封禁` | Real account ban. Account-scoped; visible in the desktop app too. | 403 | Observed. `lib/governor.js`: `const BAN_BODY_RE = /410004\|账号已被封禁\|已被封禁/;` |
| `810002` + `"kind":"pay-view"` + "We're experiencing high demand right now. Please try again shortly, or upgrade to a monthly subscription for priority access." | Free-tier **capacity throttle**, not a ban. | 403 | Observed in `~/.openclaw-autoclaw/logs/gateway.log`, wrapped in `<autoclaw-403-response>`, body intact — `rawBodyLength:294`, `rawBodyTruncated:false` |
| `810000` | Out of credits / free quota used up. | 402 | Observed in `lib/core.js`: `/积分不足\|free quota used up\|insufficient credit\|quota\s*(exceed\|used up)\|810000/i` → `402 insufficient_credits` |

The 403 collision is the problem. A client classifying on status alone reports "banned" for a throttle. Separating them is logic the proxy carries itself; the vendor client has no equivalent code path.

## 2. What limits exist

**Gateway-level 429, app-wide quota.** Doc comment in `C:\Program Files\AutoClaw\resources\gateway\openclaw\dist\accounts-FYJk5lxg.js`:

```
*   1. Gateway-level HTTP 429 (app-wide quota; `x-ogw-ratelimit-reset` header)
*   2. Business-level `code` in `error.response.data.code` matching
```

Two layers: a transport-level app-wide quota, and a business-level `code` in the body. The ban and throttle codes are the second layer.

**The reset header's convention.** Sibling handler in `dist/plugin-jQaMOqNl.js`, on the non-prefixed variant:

```js
...Number(res.headers.get("ratelimit-remaining")) === 0)) return +res.headers.get("ratelimit-reset") * 1e3 - Date.now();
```

The `1e3` converts to milliseconds, so the header is epoch **seconds**. Applying that to `x-ogw-ratelimit-reset` is **inferred** — we have never seen the prefixed header live.

**Per-minute windows and `model_cooldown` are real, but unnumbered.** Client's own detector for upstream rate-limit prose, `dist/sanitize-user-facing-text-nFlntUPO.js`:

```js
ORT_WINDOW_RATE_LIMIT_RE = /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm|model_cooldown)\b|请求过于频繁|调用频率|频率限制/i;
```

No number is attached to either anywhere client-side.

## 3. The signing ceiling

`X-Client-Sig` appears in exactly two vendor dist files — `anthropic-BWM73p9N.js` and `openai-completions-Bn-p1dBp.js`, the **cloud completions path** — both carrying:

```js
const AUTOCLAW_CLIENT_SIGN_VERSION = "1.18.1";
const AUTOCLAW_CLIENT_SIGN_KDF_SALT = Buffer.from("WD_CLIENT_SIGN_KDF_SALT", "utf8");
const AUTOCLAW_CLIENT_SIGN_INFO_PRIV = Buffer.from("ed25519_priv", "utf8");
const AUTOCLAW_CLIENT_SIGN_INFO_HANDSHAKE = Buffer.from("getSignKey_hmac", "utf8");
const AUTOCLAW_CLIENT_SIGN_FAILURE_COOLDOWN_MS = 600000;

const reqKek = autoClawClientSignHkdf(target.credential.secret, AUTOCLAW_CLIENT_SIGN_INFO_HANDSHAKE);
const kek    = autoClawClientSignHkdf(target.credential.secret, AUTOCLAW_CLIENT_SIGN_INFO_PRIV);
```

A bundle comment states the switch is a remote flag: `远端总开关(后台 client_common_config.coding_plan_client_sign)由主进程落到`.

Ed25519, derived through HKDF from a **per-credential secret**, version-stamped, gated by a **server-side flag**. A failed signature parks the client for `600000` ms — 10 minutes.

Completions work unsigned today, so the flag is off or unenforced. If it is turned on a proxy cannot cross this: it cannot sign for a credential it does not legitimately hold, and faking one is out of scope (§7). The honest answer then is to pay a provider for API access.

## 4. Device identity

`%APPDATA%\AutoClaw\identity\device.json` holds a persistent `deviceId` (64 hex), an **Ed25519 keypair** (public and private PEM) and `createdAtMs`; `user-cache.json` repeats the same `deviceId`. It also appears throughout `account-config-*.js`, `account-selection-*.js`, `accounts-*.js` and `agent-*.js`, and the JWT carries `device_id`.

Identity is device-scoped, not just account-scoped. That is why multi-account-per-device is dubious: the accounts are linkable through one shared hardware identity, and upstream sees the linkage.

## 5. What was not found

A result, not a gap. **No numeric limit was found anywhere client-side.** Not found: requests per hour, requests per day, concurrency cap, credits per hour, ban threshold, risk score, velocity counter, ban counter, any cloud-path cooldown duration, any number tying usage volume to a ban.

Scope: all 4,614 `.js` files under `resources/gateway/openclaw/dist`, the config and state files under `~/.openclaw-autoclaw/` and `%APPDATA%\AutoClaw\`, and an earlier `app.asar` scan artifact.

Why it came up empty: the codes (`410004`, `810002`, `810000`), `pay-view`, `zcode` and `X-Harness-Type` are **absent from the gateway dist entirely**. The threshold logic lives in the Electron main process (`app.asar`, ~310 MB, not opened) or purely server-side — and since the codes are what the client reacts to, server-side is likelier.

## 6. Don't confuse these

| Thing | What it actually is |
| --- | --- |
| `%APPDATA%\AutoClaw\risk-agreement.json` — `{"hasReadRiskAgreement": true, ...}` | First-launch acknowledgement of a risk notice. Product-level confirmation that restriction is a live risk. Not a limit definition; contains no threshold. |
| `频率限制` (42 occurrences in the dist), extension daily quotas, `RATE_LIMIT_DELAY = 60000` | Quotas of **bundled third-party extensions** (QQ bot, Lark, WeCom). Not AutoClaw cloud-path limits. |
| `settings.safety` in `%APPDATA%\AutoClaw\settings.json` — `{"highRiskAction":"ask","cronCreationAction":"ask","defaultDecision":"deny","cronCreationDefaultDecision":"deny"}` | Agent tool-approval policy. Nothing to do with account bans. |

## 7. What this proxy does about it

- **Paces per account.** Sliding hourly request budget keyed on the JWT's `user_id`, so the app's hourly token rotation does not reset it. Default `300` — `lib/governor.js`: `export const DEFAULT_BUDGET_REQUESTS_PER_HOUR = 300;`. A proxy-side number this project chose, **not** an upstream limit and not a guess at one. Warns at 80%; at 100% answers `429 budget_exceeded` locally without touching upstream.
- **Translates a throttle into a 429.** Free-tier `810002` surfaces as `429 upstream_busy`; upstream 429s back off exponentially with jitter. Harnesses understand 429 + `Retry-After`, not a 403 that means "busy".
- **Ban and quota are terminal.** `410004` becomes `403 account_quarantined` (`permanent: true`) and upstream calls pause — retrying cannot lift a ban. Quota exhaustion is not retried or fallen back through, because spending caused it.
- **Explicit non-goals.** No identity rotation, no `deviceId` cycling, no TLS fingerprint spoofing, no signature forgery, no account farming. The proxy paces one honest client identity; it does not manufacture new ones to get around a limit.

## 8. Unknowns, and how to narrow them

| Unknown | How it could be settled |
| --- | --- |
| Where the threshold logic lives | Read `app.asar` (~310 MB, not opened). If nothing is there, it is server-side and unreadable by design. |
| Whether `x-ogw-ratelimit-reset` is epoch seconds | Capture one live gateway 429 and read the header. Currently inferred from the sibling unprefixed handler. |
| Whether the signing flag is on | Read `client_common_config.coding_plan_client_sign` from the remote config the main process fetches, or watch for unsigned cloud completions starting to fail. |
| The actual ban trigger | Not published anywhere we found. Learning it would mean controlled experiments that burn live accounts, which this project will not do. |

Adjacent, and worth stating once: the upstream gates cloud completions on the system prompt. Probe-verified against the live service (four calls, 2×2 of banner × header): banner only 200, banner plus header 200, header only 200, neither 400 `{"message":"invalid request"}`. The client's own `X-Harness-Type: zcode` declaration opens that gate on its own; the proxy's system-prompt banner is a belt to that suspenders.

## 9. Provenance note

Checked **2026-09-22**. Method: static reading of the vendor bundles under `C:\Program Files\AutoClaw\resources\gateway\openclaw\dist` (4,614 `.js` files) for the codes, header names, limiter vocabulary and signing constants; direct reading of the `%APPDATA%` files named above; log inspection of `~/.openclaw-autoclaw/logs/gateway.log`; four live probes for the prompt gate. The search scope is listed in §5.

Everything marked **inferred** is still inferred, and §5 is still absent as of that date. The `dist` filenames carry content hashes, so a new client build renames them — re-check these quotes before trusting them.
