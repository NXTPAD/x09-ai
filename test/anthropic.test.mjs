// Checks the Claude (Anthropic API) client with the network mocked: request shape,
// streaming → X09's SSE format, tool-call JSON, and error handling. No API key needed.
import assert from "node:assert/strict";
import { claude, claudeStream, textOf, normalizeMessages } from "../src/core/anthropic.js";

let pass = 0; const ok = (n) => { pass++; console.log("  ✓", n); };
const calls = [];
let reply;
globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return reply(); };
const env = { ANTHROPIC_API_KEY: "sk-ant-test", AI_MODEL_FAST: "claude-haiku-4-5", AI_MODEL_DEEP: "claude-sonnet-5" };
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

try {
  assert.deepEqual(normalizeMessages([{ role: "assistant", content: "hi" }, { role: "user", content: "a" }, { role: "user", content: "b" }, { role: "assistant", content: "" }]),
    [{ role: "user", content: "a\n\nb" }]); ok("messages normalized for Claude (user first, alternating)");

  reply = () => sse([
    { type: "message_start", message: {} }, { type: "content_block_start", index: 0 },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "pilot." } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
  ]);
  const s = await claudeStream(env, { kind: "deep", system: "sys", messages: [{ role: "user", content: "hey" }], max_tokens: 50 });
  const out = await new Response(s).text();
  const c = calls.at(-1);
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.init.headers["x-api-key"], "sk-ant-test"); assert.equal(c.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(c.body.model, "claude-sonnet-5"); assert.equal(c.body.stream, true); assert.equal(c.body.system, "sys");
  ok("streaming request goes to the Anthropic Messages API with the Deep model");
  assert.equal(out, 'data: {"response":"Hello "}\n\ndata: {"response":"pilot."}\n\ndata: [DONE]\n\n'); ok("Claude stream converted to X09 SSE");

  reply = () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "write_document", input: { title: "Roof", items: [] } }] }));
  const m = await claude(env, { kind: "deep", messages: [{ role: "user", content: "x" }], tools: [{ name: "write_document", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "write_document" } });
  assert.equal(m.content[0].input.title, "Roof"); assert.equal(calls.at(-1).body.tool_choice.name, "write_document"); ok("forced tool call returns structured JSON (Docs drafts)");

  reply = () => new Response(JSON.stringify({ content: [{ type: "text", text: "Improved." }] }));
  assert.equal(textOf(await claude(env, { messages: [{ role: "user", content: "x" }] })), "Improved."); assert.equal(calls.at(-1).body.model, "claude-haiku-4-5"); ok("fast calls use Haiku");

  reply = () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
  await assert.rejects(claude(env, { messages: [{ role: "user", content: "x" }] }), (e) => e.status === 503); ok("overloaded API → friendly 503");
  await assert.rejects(claude({}, { messages: [{ role: "user", content: "x" }] }), /ANTHROPIC_API_KEY/); ok("missing API key explained");
  console.log(`\nAll ${pass} Claude client checks passed.`);
} catch (e) { console.error("FAILED", e); process.exitCode = 1; }
