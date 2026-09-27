// Chat: threads stored in D1, replies streamed from Workers AI, monthly plan limits enforced
import { json, now, month, randomId, readJson, HttpError } from "./util.js";
import { requireUser, hasAccess } from "./auth.js";
import { PLANS } from "./plans.js";

const SYSTEM_PROMPTS = {
  fast:
    "You are X09, the AI co-pilot of X09 AI. Be concise, clear and genuinely helpful. " +
    "Use a light touch of outer-space mission-control flavor only when natural. Use Markdown for lists and code.",
  deep:
    "You are X09, the AI co-pilot of X09 AI. Think carefully and give thorough, well-structured answers with " +
    "headings, steps and examples where useful. Be accurate and say when you're unsure. Use Markdown.",
};
const HISTORY = 20;          // messages of context sent to the model
const MAX_INPUT = 6000;      // characters per message
const MAX_CONTEXT = 24000;   // characters of history per request (~6k tokens) — caps AI cost per message

// ---------- Threads ----------
async function ownThread(env, userId, id) {
  const t = await env.DB.prepare("SELECT * FROM threads WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!t) throw new HttpError(404, "Conversation not found.");
  return t;
}

export async function listThreads(request, env) {
  const user = await requireUser(request, env);
  const { results } = await env.DB.prepare(
    "SELECT id, title, updated_at AS updated FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200"
  ).bind(user.id).all();
  return json({ threads: results });
}

export async function getThread(request, env, id) {
  const user = await requireUser(request, env);
  const t = await ownThread(env, user.id, id);
  const { results } = await env.DB.prepare(
    "SELECT role, content, created_at AS at FROM messages WHERE thread_id = ? ORDER BY id"
  ).bind(id).all();
  return json({ thread: { id: t.id, title: t.title, updated: t.updated_at }, messages: results });
}

export async function deleteThread(request, env, id) {
  const user = await requireUser(request, env);
  await ownThread(env, user.id, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE thread_id = ?").bind(id),
    env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

export async function deleteAllThreads(request, env) {
  const user = await requireUser(request, env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ?)").bind(user.id),
    env.DB.prepare("DELETE FROM threads WHERE user_id = ?").bind(user.id),
  ]);
  return json({ ok: true });
}

// ---------- Usage ----------
async function consume(env, user, mode) {
  const plan = PLANS[user.plan];
  const col = mode === "deep" ? "deep" : "fast";
  const limit = plan[col];
  const period = month();
  await env.DB.prepare("INSERT INTO usage (user_id, period, fast, deep) VALUES (?, ?, 0, 0) ON CONFLICT(user_id, period) DO NOTHING")
    .bind(user.id, period).run();
  const r = await env.DB.prepare(`UPDATE usage SET ${col} = ${col} + 1 WHERE user_id = ? AND period = ? AND ${col} < ?`)
    .bind(user.id, period, limit).run();
  if (!r.meta || !r.meta.changes) {
    throw new HttpError(402, `You've used all ${limit.toLocaleString()} ${col === "deep" ? "Deep" : "Fast"} messages in your ${plan.name} plan this month. Upgrade for more, or wait until next month.`, { code: "limit_reached" });
  }
  return async () => {
    await env.DB.prepare(`UPDATE usage SET ${col} = MAX(${col} - 1, 0) WHERE user_id = ? AND period = ?`).bind(user.id, period).run();
  };
}

// ---------- AI ----------
function mockStream(messages) {
  const last = messages[messages.length - 1]?.content || "";
  const text = `**X09 test mode** — the real AI isn't connected in this environment.\n\nYou said: "${last.slice(0, 200)}"\n\nOnce deployed with the Workers AI binding, replies stream here word by word.`;
  const words = text.split(/(?<= )/);
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(ctrl) {
      for (const w of words) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ response: w })}\n\n`));
        await new Promise((r) => setTimeout(r, 15));
      }
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
  });
}

async function runModel(env, mode, messages) {
  if (env.MOCK_AI === "1" || !env.AI) {
    if (env.MOCK_AI === "1") return mockStream(messages);
    throw new HttpError(500, "The AI engine isn't connected (missing [ai] binding).");
  }
  const model = mode === "deep" ? env.AI_MODEL_DEEP : env.AI_MODEL;
  return env.AI.run(model, {
    messages: [{ role: "system", content: SYSTEM_PROMPTS[mode] }, ...messages],
    max_tokens: mode === "deep" ? 1500 : 700,
    stream: true,
  });
}

// Pass the SSE stream through to the browser while collecting the text to save afterwards
function tee(stream, onDone) {
  const dec = new TextDecoder();
  let buf = "", text = "";
  const parse = (line) => {
    if (!line.startsWith("data:")) return;
    const d = line.slice(5).trim();
    if (!d || d === "[DONE]") return;
    try { const j = JSON.parse(d); text += j.response ?? j.choices?.[0]?.delta?.content ?? ""; } catch {}
  };
  return stream.pipeThrough(
    new TransformStream({
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
    })
  );
}

// POST /api/chat  { threadId?, message?, mode: "fast"|"deep", regenerate?: bool }
export async function chat(request, env, ctx) {
  const user = await requireUser(request, env);
  if (!hasAccess(user)) throw new HttpError(402, "Choose a plan to start chatting with X09.", { code: "plan_required" });

  const body = await readJson(request);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const mode = body.mode === "deep" ? "deep" : "fast";
  let thread, refund;

  if (body.regenerate) {
    thread = await ownThread(env, user.id, String(body.threadId || ""));
    const lastUser = await env.DB.prepare("SELECT MAX(id) AS id FROM messages WHERE thread_id = ? AND role = 'user'").bind(thread.id).first();
    if (!lastUser?.id) return json({ error: "Nothing to retry." }, 400);
    await env.DB.prepare("DELETE FROM messages WHERE thread_id = ? AND id > ?").bind(thread.id, lastUser.id).run();
  } else {
    const message = String(body.message || "").trim();
    if (!message) return json({ error: "Message is empty." }, 400);
    if (message.length > MAX_INPUT) return json({ error: `Messages are limited to ${MAX_INPUT} characters.` }, 400);
    if (body.threadId) thread = await ownThread(env, user.id, String(body.threadId));
    else {
      const title = message.replace(/\s+/g, " ").slice(0, 60) + (message.length > 60 ? "…" : "");
      thread = { id: randomId(10), title };
      await env.DB.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(thread.id, user.id, title, now(), now()).run();
    }
    // Check the limit before saving the message
    refund = await consume(env, user, mode);
    await env.DB.prepare("INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
      .bind(thread.id, message, now()).run();
  }
  if (!refund) refund = await consume(env, user, mode);

  const { results } = await env.DB.prepare(
    "SELECT role, content FROM (SELECT id, role, content FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id"
  ).bind(thread.id, HISTORY).all();

  // Keep the newest messages that fit in the context budget (always keep the latest one)
  const context = [];
  let chars = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    chars += results[i].content.length;
    if (context.length && chars > MAX_CONTEXT) break;
    context.unshift(results[i]);
  }
  while (context.length && context[0].role !== "user") context.shift();

  let stream;
  try {
    stream = await runModel(env, mode, context);
  } catch (err) {
    await refund();
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "Signal lost — the AI engine returned an error. Please try again.");
  }

  const save = async (text) => {
    if (!text.trim()) return;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").bind(thread.id, text, now()),
      env.DB.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").bind(now(), thread.id),
    ]);
  };

  return new Response(tee(stream, save), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-thread-id": thread.id,
      "x-thread-title": encodeURIComponent(thread.title),
    },
  });
}
