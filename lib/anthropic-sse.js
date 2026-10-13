/**
 * Anthropic <-> OpenAI wire conversion for the /v1/messages entrypoint.
 *
 * Extracted from anthropic.js so the conversion is unit-testable without
 * standing up the server: the SSE state machine below is exactly where an
 * unbalanced stream once shipped — a tool-only turn emitted two
 * `content_block_stop` events for a single `content_block_start`, which a real
 * Claude Code client parses as a protocol error. tests/pen-test-p12.mjs pins
 * the balance invariant.
 *
 * Pure and zero-dependency apart from `generateId`; a malformed upstream line
 * is skipped rather than throwing, so one bad chunk cannot kill a stream.
 */
import { generateId } from "./core.js";

// ─── Format conversion (Anthropic <-> OpenAI) ───────────────────────────────

// Convert an Anthropic Messages request body to OpenAI chat/completions format.
export function anthropicToOpenAI(body, modelId) {
  const messages = [];

  // System prompt
  if (body.system) {
    const text = typeof body.system === "string"
      ? body.system
      : (Array.isArray(body.system)
          ? body.system.map((b) => typeof b === "string" ? b : (b.type === "text" ? b.text : (b.text || ""))).filter(Boolean).join("\n")
          : "");
    if (text) messages.push({ role: "system", content: text });
  }

  // Convert messages
  for (const msg of body.messages || []) {
    const content = msg.content;

    if (typeof content === "string") {
      messages.push({ role: msg.role, content });
      continue;
    }

    if (!Array.isArray(content)) continue;

    const toolResults = [];
    const toolUses = [];
    const textParts = [];
    const imageParts = [];

    // Anthropic image block → OpenAI image_url part (AutoClaw's cloud accepts
    // native vision parts on the chat/completions wire; probe-verified 2026-09-04).
    const toOpenAIImage = (block) => {
      const src = block?.source;
      if (src?.type === "base64" && typeof src.data === "string") {
        return { type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } };
      }
      if (src?.type === "url" && typeof src.url === "string") {
        return { type: "image_url", image_url: { url: src.url } };
      }
      return null;
    };

    for (const block of content) {
      if (block.type === "tool_result")      toolResults.push(block);
      else if (block.type === "tool_use")    toolUses.push(block);
      else if (block.type === "text")        textParts.push(block.text);
      else if (block.type === "image")       { const p = toOpenAIImage(block); if (p) imageParts.push(p); }
      else if (block.type === "thinking")    { /* skip */ }
    }

    // tool_result blocks → "tool" role
    for (const tr of toolResults) {
      let resultText;
      if (typeof tr.content === "string") {
        resultText = tr.content;
      } else if (Array.isArray(tr.content)) {
        resultText = tr.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      } else {
        resultText = JSON.stringify(tr.content);
      }
      messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: resultText });
    }

    // Build the main message
    if (msg.role === "assistant" && toolUses.length > 0) {
      const msgObj = {
        role: "assistant",
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        })),
      };
      if (textParts.length > 0) msgObj.content = textParts.join("\n");
      messages.push(msgObj);
    } else if (imageParts.length > 0 && msg.role !== "assistant") {
      // Multimodal user turn: OpenAI array content with text + image parts.
      const parts = [
        ...textParts.map((t) => ({ type: "text", text: t })),
        ...imageParts,
      ];
      messages.push({ role: msg.role, content: parts });
    } else if (textParts.length > 0) {
      messages.push({ role: msg.role, content: textParts.join("\n") });
    } else if (toolResults.length === 0 && toolUses.length === 0) {
      messages.push({ role: msg.role, content: "" });
    }
  }

  // Convert Anthropic tool definitions → OpenAI format
  const openAITools = body.tools?.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));

  let openAIToolChoice;
  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
      if (body.tool_choice === "any") openAIToolChoice = "required";
      else if (body.tool_choice !== "auto") openAIToolChoice = body.tool_choice;
    } else if (body.tool_choice?.type === "tool") {
      openAIToolChoice = { type: "function", function: { name: body.tool_choice.name } };
    } else if (body.tool_choice?.type === "any") {
      openAIToolChoice = "required";
    }
  }

  const result = {
    model:       modelId,
    messages,
    stream:      true,
    max_tokens:  body.max_tokens  ?? 4096,
    temperature: body.temperature ?? undefined,
    top_p:       body.top_p       ?? undefined,
    stop:        body.stop_sequences?.length ? body.stop_sequences : undefined,
  };
  if (openAITools?.length)  result.tools = openAITools;
  if (openAIToolChoice)     result.tool_choice = openAIToolChoice;

  return result;
}

// Map an OpenAI finish_reason onto Anthropic stop_reason vocabulary
export function anthropicStopReason(finishReason) {
  return finishReason === "stop" || !finishReason ? "end_turn" : finishReason;
}

// Buffer all OpenAI SSE chunks and assemble a single Anthropic response object.
export function openAIChunksToAnthropic(raw, modelId, inputTokens) {
  let content = "", reasoning = "";
  let id = `msg_${generateId()}`;
  let model = modelId;
  let outputTokens = 0;
  let stopReason = "end_turn";
  const toolCalls = {};

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6));
      if (chunk.id)    id    = chunk.id;
      if (chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content)           content   += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      for (const tc of delta?.tool_calls || []) {
        if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: "", name: "", arguments: "" };
        if (tc.id)                  toolCalls[tc.index].id = tc.id;
        if (tc.function?.name)      toolCalls[tc.index].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr === "length") stopReason = "max_tokens";
      if (fr === "tool_calls") stopReason = "tool_use";
      if (chunk.usage) outputTokens = chunk.usage.completion_tokens ?? 0;
    } catch { /* skip malformed lines */ }
  }

  const contentBlocks = [];
  if (reasoning) contentBlocks.push({ type: "thinking", thinking: reasoning });

  const sortedIndices = Object.keys(toolCalls).sort((a, b) => Number(a) - Number(b));
  for (const idx of sortedIndices) {
    const tc = toolCalls[idx];
    let input = {};
    try { input = JSON.parse(tc.arguments); } catch { /* partial JSON */ }
    contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  if (content) contentBlocks.push({ type: "text", text: content });

  return {
    id,
    type:          "message",
    role:          "assistant",
    model,
    content:       contentBlocks,
    stop_reason:   stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:  inputTokens ?? 0,
      output_tokens: outputTokens,
    },
  };
}

// Convert a single OpenAI SSE line to one or more Anthropic SSE event strings.
export function openAIChunkToAnthropicEvents(line, state) {
  if (!line.startsWith("data: ")) return [];

  if (line === "data: [DONE]") {
    const events = [];
    // Close the currently-open block exactly once. If it is a tool block this
    // also marks that tool closed, so the sweep below cannot re-close it — the
    // double-stop that produced an unbalanced stream for a tool-only turn.
    closeOpenBlock(events, state);
    // Any tool block still open (one that was never the current block).
    for (const idx of Object.keys(state.toolState).sort((a, b) => Number(a) - Number(b))) {
      const ts = state.toolState[idx];
      if (ts.opened && !ts.closed) {
        events.push(fmt("content_block_stop", { type: "content_block_stop", index: ts.blockIdx }));
        ts.closed = true;
      }
    }
    events.push(fmt("message_delta", {
      type:  "message_delta",
      delta: { stop_reason: state.finishReason || "end_turn", stop_sequence: null },
      usage: { output_tokens: state.outputTokens },
    }));
    events.push(fmt("message_stop", { type: "message_stop" }));
    return events;
  }

  let chunk;
  try { chunk = JSON.parse(line.slice(6)); } catch { return []; }

  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return [];

  const events    = [];
  const content   = delta.content           ?? "";
  const reasoning = delta.reasoning_content ?? "";
  const toolCalls = delta.tool_calls        || [];
  const fr        = chunk.choices?.[0]?.finish_reason;

  if (chunk.usage) state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
  if (fr === "length")     state.finishReason = "max_tokens";
  if (fr === "stop")       state.finishReason = "end_turn";
  if (fr === "tool_calls") state.finishReason = "tool_use";

  // Tool calls
  for (const tc of toolCalls) {
    const idx = tc.index;
    if (!state.toolState[idx]) {
      state.toolState[idx] = { id: "", name: "", arguments: "", opened: false, closed: false, blockIdx: -1 };
    }
    const ts = state.toolState[idx];
    if (tc.id)                  ts.id = tc.id;
    if (tc.function?.name)      ts.name = tc.function.name;
    if (tc.function?.arguments) ts.arguments += tc.function.arguments;

    if (ts.name && !ts.opened) {
      if (closeOpenBlock(events, state)) state.blockIndex++;
      ts.blockIdx = state.blockIndex;
      events.push(fmt("content_block_start", {
        type: "content_block_start", index: state.blockIndex,
        content_block: { type: "tool_use", id: ts.id, name: ts.name, input: {} },
      }));
      ts.opened = true;
      state.blockOpen = true;
    }

    if (ts.opened && tc.function?.arguments) {
      events.push(fmt("content_block_delta", {
        type: "content_block_delta", index: ts.blockIdx,
        delta: { type: "input_json_delta", partial_json: tc.function.arguments },
      }));
    }
  }

  // Reasoning
  if (reasoning && !state.thinkingOpen) {
    if (closeOpenBlock(events, state)) state.blockIndex++;
    events.push(fmt("content_block_start", {
      type: "content_block_start", index: state.blockIndex,
      content_block: { type: "thinking", thinking: "" },
    }));
    state.thinkingOpen = true;
    state.blockOpen    = true;
  }

  if (reasoning) {
    events.push(fmt("content_block_delta", {
      type:  "content_block_delta", index: state.blockIndex,
      delta: { type: "thinking_delta", thinking: reasoning },
    }));
  }

  // Text
  if (content && !state.textOpen) {
    if (state.thinkingOpen) {
      closeOpenBlock(events, state);
      state.blockIndex++;
    }
    for (const idx of Object.keys(state.toolState).sort((a, b) => Number(a) - Number(b))) {
      const ts = state.toolState[idx];
      if (ts.opened && !ts.closed) {
        events.push(fmt("content_block_stop", { type: "content_block_stop", index: ts.blockIdx }));
        state.blockIndex++;
        ts.closed = true;
        state.blockOpen = false;
      }
    }
    if (!state.blockOpen) {
      events.push(fmt("content_block_start", {
        type: "content_block_start", index: state.blockIndex,
        content_block: { type: "text", text: "" },
      }));
      state.textOpen  = true;
      state.blockOpen = true;
    }
  }

  if (content) {
    events.push(fmt("content_block_delta", {
      type:  "content_block_delta", index: state.blockIndex,
      delta: { type: "text_delta", text: content },
    }));
  }

  return events;
}

export function fmt(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// The Anthropic protocol requires every `content_block_start` to be closed by
// exactly one `content_block_stop` at the same index. Closing an open block
// therefore has to mark the *owning* tool block closed too, or the end-of-stream
// sweep closes it a second time and the client sees an unbalanced stream.
export function markToolClosedAt(state, index) {
  for (const ts of Object.values(state.toolState)) {
    if (ts.opened && !ts.closed && ts.blockIdx === index) ts.closed = true;
  }
}

// Close whichever content block is currently open, exactly once. This is the
// single close path: it marks the owning tool block closed (so no later sweep
// can re-close it) and clears every "open" flag. Every transition — a new tool
// opening, reasoning following a tool, text following either — must go through
// this, because the same double-stop bug appeared twice when a caller closed a
// block by hand and left the owning tool marked open.
function closeOpenBlock(events, state) {
  if (!state.blockOpen) return false;
  const index = state.blockIndex;
  markToolClosedAt(state, index);
  events.push(fmt("content_block_stop", { type: "content_block_stop", index }));
  state.blockOpen = false;
  state.thinkingOpen = false;
  state.textOpen = false;
  return true;
}

