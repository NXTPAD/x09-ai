// Anthropic API (Claude) — the AI behind every X09 site.
// Needs the ANTHROPIC_API_KEY secret. Models are set in wrangler config:
//   AI_MODEL_FAST  (default claude-haiku-4-5)  — quick answers, rewrites, the Hub guide
//   AI_MODEL_DEEP  (default claude-sonnet-5)   — deep answers and document drafting
import { HttpError } from "./util.js";

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export const model = (env, kind = "fast") =>
  kind === "deep" ? env.AI_MODEL_DEEP || "claude-sonnet-5" : env.AI_MODEL_FAST || "claude-haiku-4-5";

// Claude needs alternating user/assistant turns that start with the user: merge repeats
export function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = String(m.content || "");
    if (!content.trim()) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n\n" + content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function call(env, body) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, "The AI isn't configured yet (missing ANTHROPIC_API_KEY).");
  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": VERSION, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json())?.error?.message || ""; } catch {}
    console.error("Anthropic API error", res.status, msg);
    if (res.status === 429 || res.status === 529) throw new HttpError(503, "X09 is handling a lot of traffic right now. Please try again in a moment.");
    throw new HttpError(502, "Signal lost — the AI returned an error. Please try again.");
  }
  return res;
}

// Non-streaming call. Returns the full message object.
export async function claude(env, { kind = "fast", system, messages, max_tokens = 1024, temperature, tools, tool_choice }) {
  const res = await call(env, {
    model: model(env, kind), max_tokens, system, temperature, tools, tool_choice,
    messages: normalizeMessages(messages),
  });
  return res.json();
}

export const textOf = (msg) => (msg?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

// Streaming call. Returns a ReadableStream of simple server-sent events that the X09 apps read:
//   data: {"response":"text chunk"}\n\n  …  data: [DONE]\n\n
export async function claudeStream(env, { kind = "fast", system, messages, max_tokens = 1024, temperature }) {
  if (env.MOCK_AI === "1") return mockStream(messages);
  const res = await call(env, { model: model(env, kind), max_tokens, system, temperature, stream: true, messages: normalizeMessages(messages) });
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "";
  const emit = (ctrl, obj) => ctrl.enqueue(enc.encode(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`));
  return res.body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
        if (d.type === "content_block_delta" && d.delta?.type === "text_delta") emit(ctrl, { response: d.delta.text });
        else if (d.type === "message_delta" && d.delta?.stop_reason === "max_tokens") emit(ctrl, { response: "\n\n_…reply trimmed at the length limit. Ask me to continue._" });
        else if (d.type === "error") emit(ctrl, { error: d.error?.message || "stream error" });
        else if (d.type === "message_stop") emit(ctrl, "[DONE]");
      }
    },
  }));
}

// Test mode (MOCK_AI=1): no API calls
function mockStream(messages) {
  const last = messages[messages.length - 1]?.content || "";
  const text = `**X09 test mode** — the real AI isn't connected in this environment.\n\nYou said: "${String(last).slice(0, 200)}"\n\nOnce deployed with your Anthropic API key, Claude's replies stream here word by word.`;
  const words = text.split(/(?<= )/);
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(ctrl) {
      for (const w of words) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ response: w })}\n\n`));
        await new Promise((r) => setTimeout(r, 12));
      }
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
  });
}

// Pass an SSE stream through while collecting the text (to save it afterwards)
export function teeText(stream, onDone) {
  const dec = new TextDecoder();
  let buf = "", text = "";
  const parse = (line) => {
    if (!line.startsWith("data:")) return;
    const d = line.slice(5).trim();
    if (!d || d === "[DONE]") return;
    try { text += JSON.parse(d).response ?? ""; } catch {}
  };
  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      lines.forEach(parse);
    },
    async flush() {
      parse(buf);
      await onDone(text);
    },
  }));
}
