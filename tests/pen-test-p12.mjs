// Pen-test p12 — the Anthropic <-> OpenAI wire conversion (offline).
//
// Why this suite exists: the SSE state machine in lib/anthropic-sse.js used to
// emit TWO `content_block_stop` events for a single `content_block_start` on a
// tool-only turn (the end-of-stream sweep re-closed a block the tool loop had
// already closed). Nothing offline covered the converter, so a real Claude Code
// client was the first thing to see the unbalanced stream. These cases are pure
// functions — no server, no network, no credits.

import { check, summary } from "./_helpers.mjs";
import {
  anthropicToOpenAI, anthropicStopReason, openAIChunksToAnthropic,
  openAIChunkToAnthropicEvents,
} from "../lib/anthropic-sse.js";

const sse = (obj) => `data: ${JSON.stringify(obj)}`;

// Drive the streaming state machine over a list of upstream lines and return
// every Anthropic event it emits, in order.
function drive(lines) {
  const state = {
    blockIndex: 0, blockOpen: false,
    thinkingOpen: false, textOpen: false,
    outputTokens: 0, finishReason: "end_turn",
    toolState: {},
  };
  const events = [];
  for (const line of lines) for (const e of openAIChunkToAnthropicEvents(line, state)) events.push(e);
  for (const e of openAIChunkToAnthropicEvents("data: [DONE]", state)) events.push(e);
  // The raw fmt() output is "event: X\ndata: {...}\n\n"; parse it back so the
  // assertions read like the client sees them.
  return events.map((raw) => {
    const event = /^event: (.+)$/m.exec(raw)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(raw)[1]);
    return { event, data };
  });
}

// Every content_block_start must be closed by exactly one content_block_stop at
// the same index, and the start must come first. That is the whole invariant.
function blockBalance(events) {
  const starts = events.filter((e) => e.event === "content_block_start");
  const stops = events.filter((e) => e.event === "content_block_stop");
  const problems = [];
  if (starts.length !== stops.length) problems.push(`${starts.length} starts vs ${stops.length} stops`);
  for (const s of starts) {
    const idx = s.data.index;
    const closing = stops.filter((e) => e.data.index === idx);
    if (closing.length !== 1) problems.push(`index ${idx} closed ${closing.length}×`);
    const order = events.findIndex((e) => e.event === "content_block_start" && e.data.index === idx)
      < events.findIndex((e) => e.event === "content_block_stop" && e.data.index === idx);
    if (!order) problems.push(`index ${idx} stop before start`);
  }
  return { ok: problems.length === 0, starts, stops, problems };
}

const tc = (index, delta) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...delta }] } }] });
const text = (t) => ({ choices: [{ index: 0, delta: { content: t } }] });
const reasoning = (t) => ({ choices: [{ index: 0, delta: { reasoning_content: t } }] });
const finish = (fr, usage) => ({ choices: [{ index: 0, delta: {}, finish_reason: fr }], ...(usage ? { usage } : {}) });

// ── 1. The regression: a tool-only turn (no text, no thinking) ───────────────
{
  const events = drive([
    sse({ choices: [{ index: 0, delta: { role: "assistant" } }] }),
    sse(tc(0, { id: "call_1", type: "function", function: { name: "Read", arguments: "" } })),
    sse(tc(0, { function: { arguments: '{"file' } })),
    sse(tc(0, { function: { arguments: '_path":"/tmp/hello.txt"}' } })),
    sse(finish("tool_calls", { completion_tokens: 12 })),
  ]);
  const b = blockBalance(events);
  check("p12: a tool-only turn has balanced content blocks", b.ok, b.problems.join("; "));
  check("p12: the tool block is the only block opened", b.starts.length === 1
    && b.starts[0].data.content_block.type === "tool_use", JSON.stringify(b.starts.map((s) => s.data.content_block.type)));
  check("p12: the tool block carries the accumulated arguments as JSON",
    events.filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json).join("") === '{"file_path":"/tmp/hello.txt"}',
    JSON.stringify(events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta)));
  const md = events.find((e) => e.event === "message_delta");
  check("p12: finish_reason tool_calls maps to stop_reason tool_use",
    md?.data?.delta?.stop_reason === "tool_use", JSON.stringify(md?.data));
  check("p12: the stream still ends with message_stop",
    events[events.length - 1]?.event === "message_stop", events[events.length - 1]?.event);
}

// ── 2. Text-only ────────────────────────────────────────────────────────────
{
  const events = drive([sse(text("Hel")), sse(text("lo")), sse(finish("stop", { completion_tokens: 2 }))]);
  const b = blockBalance(events);
  check("p12: a text-only turn is balanced", b.ok, b.problems.join("; "));
  const out = events.filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
    .map((e) => e.data.delta.text).join("");
  check("p12: text deltas concatenate to the full message", out === "Hello", JSON.stringify(out));
  check("p12: a stop finish maps to stop_reason end_turn",
    events.find((e) => e.event === "message_delta")?.data?.delta?.stop_reason === "end_turn");
}

// ── 3. Thinking -> text (the reasoning block must close before text opens) ──
{
  const events = drive([sse(reasoning("thinking...")), sse(text("answer")), sse(finish("stop"))]);
  const b = blockBalance(events);
  check("p12: a thinking->text turn is balanced", b.ok, b.problems.join("; "));
  const kinds = b.starts.map((s) => s.data.content_block.type);
  check("p12: thinking and text are separate blocks in order",
    kinds[0] === "thinking" && kinds[1] === "text", kinds.join(","));
}

// ── 4. Thinking -> tool (regression class: a tool opened after thinking) ────
{
  const events = drive([
    sse(reasoning("let me check")),
    sse(tc(0, { id: "call_9", type: "function", function: { name: "Bash", arguments: "{}" } })),
    sse(finish("tool_calls")),
  ]);
  const b = blockBalance(events);
  check("p12: a thinking->tool turn is balanced", b.ok, b.problems.join("; "));
  check("p12: thinking closes before the tool block starts",
    b.starts.map((s) => s.data.content_block.type).join(",") === "thinking,tool_use",
    b.starts.map((s) => s.data.content_block.type).join(","));
}

// ── 5. Two tools in one stream get distinct, balanced indices ───────────────
{
  const events = drive([
    sse(tc(0, { id: "call_a", type: "function", function: { name: "Read", arguments: "{}" } })),
    sse(tc(1, { id: "call_b", type: "function", function: { name: "Bash", arguments: "{}" } })),
    sse(finish("tool_calls")),
  ]);
  const b = blockBalance(events);
  check("p12: two tool calls get two balanced blocks", b.ok && b.starts.length === 2, b.problems.join("; ") || `${b.starts.length} starts`);
  check("p12: the two tool blocks have distinct indices",
    new Set(b.starts.map((s) => s.data.index)).size === 2, JSON.stringify(b.starts.map((s) => s.data.index)));
}

// ── 6. Tool -> text (the tool must close before text opens) ─────────────────
{
  const events = drive([
    sse(tc(0, { id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } })),
    sse(text("done")),
    sse(finish("stop")),
  ]);
  const b = blockBalance(events);
  check("p12: a tool->text turn is balanced", b.ok, b.problems.join("; "));
}

// ── 7. A bare [DONE] with nothing open emits no stray block events ──────────
{
  const events = drive([sse({ choices: [{ index: 0, delta: { role: "assistant" } }] })]);
  check("p12: an empty stream emits no content_block_start/stop",
    events.every((e) => e.event === "message_delta" || e.event === "message_stop"),
    JSON.stringify(events.map((e) => e.event)));
}

// ── 8. A malformed upstream line is skipped, not fatal ─────────────────────
{
  const events = drive(["{not json", sse(text("ok")), "data: {broken", sse(finish("stop"))]);
  const b = blockBalance(events);
  check("p12: a malformed line is skipped without breaking the stream",
    b.ok && events.some((e) => e.event === "message_stop"), b.problems.join("; "));
}

// ── 9. Non-stream assembly ─────────────────────────────────────────────────
{
  const raw = [
    sse({ id: "chatcmpl-1", model: "glm-5.3", choices: [{ index: 0, delta: { role: "assistant" } }] }),
    sse({ id: "chatcmpl-1", model: "glm-5.3", choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] }),
    sse({ id: "chatcmpl-1", model: "glm-5.3", choices: [{ index: 0, delta: { content: "Hi" } }] }),
    sse(tc(0, { id: "call_1", type: "function", function: { name: "Read" } })),
    sse(tc(0, { function: { arguments: '{"file_path":"/a"}' } })),
    sse({ id: "chatcmpl-1", model: "glm-5.3", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { completion_tokens: 9 } }),
    "data: [DONE]",
  ].join("\n");
  const msg = openAIChunksToAnthropic(raw, "glm-5.3", 42);
  const types = msg.content.map((b) => b.type);
  check("p12: non-stream assembles thinking, tool_use and text blocks",
    types.join(",") === "thinking,tool_use,text", types.join(","));
  const toolBlock = msg.content.find((b) => b.type === "tool_use");
  check("p12: the non-stream tool_use carries a parsed input object",
    toolBlock?.input?.file_path === "/a" && toolBlock?.name === "Read", JSON.stringify(toolBlock));
  check("p12: the non-stream response is a well-formed Anthropic message",
    msg.type === "message" && msg.role === "assistant" && msg.model === "glm-5.3", JSON.stringify(msg).slice(0, 120));
  check("p12: non-stream usage is carried through",
    msg.usage.input_tokens === 42 && msg.usage.output_tokens === 9, JSON.stringify(msg.usage));
  check("p12: a tool_calls finish maps to stop_reason tool_use", msg.stop_reason === "tool_use", msg.stop_reason);
}

// ── 10. Request conversion: system, tool_use/tool_result and tools ─────────
{
  const body = {
    system: [{ type: "text", text: "sys" }],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [
        { type: "text", text: "reading" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "data" }] },
    ],
    tools: [{ name: "Read", description: "d", input_schema: { type: "object", properties: {} } }],
  };
  const out = anthropicToOpenAI(body, "glm-5.3");
  check("p12: the system array becomes one system message",
    out.messages[0].role === "system" && out.messages[0].content === "sys", JSON.stringify(out.messages[0]));
  const asst = out.messages.find((m) => m.role === "assistant");
  check("p12: an assistant tool_use becomes an OpenAI tool_calls entry",
    asst?.tool_calls?.[0]?.id === "toolu_1" && asst?.tool_calls?.[0]?.function?.name === "Read"
    && asst.content === "reading", JSON.stringify(asst));
  const toolMsg = out.messages.find((m) => m.role === "tool");
  check("p12: a tool_result becomes a tool message keyed by tool_use_id",
    toolMsg?.tool_call_id === "toolu_1" && toolMsg?.content === "data", JSON.stringify(toolMsg));
  check("p12: tools map to the OpenAI function shape",
    out.tools?.[0]?.type === "function" && out.tools[0].function.name === "Read"
    && out.tools[0].function.parameters.type === "object", JSON.stringify(out.tools));
  check("p12: the converted request always streams", out.stream === true);
}

// ── 11. anthropicStopReason vocabulary ─────────────────────────────────────
{
  check("p12: stop/empty finish reasons map to end_turn",
    anthropicStopReason("stop") === "end_turn" && anthropicStopReason(undefined) === "end_turn");
  check("p12: any other finish reason passes through",
    anthropicStopReason("length") === "length" && anthropicStopReason("tool_calls") === "tool_calls");
}

summary();
