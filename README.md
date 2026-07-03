# AutoClaw Proxy

A lightweight local proxy that exposes AutoClaw's AI models through an OpenAI-compatible API, so you can use them with any tool that supports OpenAI — OpenCode, Cursor, Continue, the Python/JS SDKs, etc.

## How it works

```
Your App           AutoClaw Proxy          AutoClaw Backend
(OpenAI SDK)  ───▶  localhost:18791   ───▶  autoglm-api.autoglm.ai
```

AutoClaw handles authentication automatically. As long as AutoClaw is running and you're logged in, the proxy will work — no manual token setup needed.

## Prerequisites

- [AutoClaw](https://autoclaw.com) installed, running, and logged in
- Node.js 18+

## Usage

```bash
node main.js
```

Optional env vars:

```bash
PORT=3001 PROXY_KEY=mykey LOG_LEVEL=debug node main.js
```

| Variable    | Default  | Description                         |
|-------------|----------|-------------------------------------|
| `PORT`      | `18791`  | Port this proxy listens on          |
| `PROXY_KEY` | `mewmew` | API key clients must send           |
| `LOG_LEVEL` | `info`   | `debug` / `info` / `silent`         |

## API

### `GET /healthz`
Returns token status and upstream info.

### `GET /v1/models`
Lists available models in OpenAI format.

### `POST /v1/chat/completions`
OpenAI-compatible chat completions. Supports both streaming (`stream: true`) and non-streaming.

**Headers:**
```
Authorization: Bearer mewmew
Content-Type: application/json
```

## Models

| ID | Name | Context | Max Output | Notes |
|----|------|---------|------------|-------|
| `zai_auto` | Auto | 1M | 384K | Routes to optimal model (DeepSeek-V4, GLM-5.1, GLM-Air, …) |
| `zai_glm-5-turbo` | GLM-5-Turbo | 200K | 128K | Zhipu AI GLM-5 Turbo |
| `openrouter_glm-5.2` | GLM-5.2 | 1M | 300K | Latest GLM-5.2 via OpenRouter |

All models include `reasoning_content` in responses when the upstream model reasons.

## Using with OpenCode

```json
{
  "providers": {
    "autoclaw": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:18791/v1",
      "apiKey": "mewmew"
    }
  }
}
```

Or add it as a custom model directly in the UI:
- **API Format**: OpenAI Chat Completions
- **URL**: `http://localhost:18791/v1`
- **Model ID**: `zai_auto` (or any model from the table above)
- **API Key**: `mewmew`

## Using with Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:18791/v1", api_key="mewmew")

# Streaming
with client.chat.completions.stream(
    model="zai_auto",
    messages=[{"role": "user", "content": "Hello!"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)

# Non-streaming
response = client.chat.completions.create(
    model="zai_auto",
    messages=[{"role": "user", "content": "What is 2+2?"}],
    stream=False,
)
print(response.choices[0].message.content)
```

## Using with JavaScript

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

## Notes

- Only one AutoClaw account can be active at a time — multi-account pooling isn't supported
- The proxy key (`PROXY_KEY`) is just a local password for this proxy, not your AutoClaw credentials — set it to whatever you want
- If a request fails with 401, the proxy automatically refreshes its auth and you can retry immediately

## License

MIT
