// Chat: threads stored in the shared X09 database, replies streamed from Claude (Anthropic API),
// monthly plan limits enforced. Fast = Claude Haiku 4.5, Deep = Claude Sonnet 5.
import { json, now, randomId, readJson, HttpError } from "./core/util.js";
import { requireUser, hasAccess, activePlan, consume } from "./core/auth.js";
import { PRODUCTS } from "./core/catalog.js";
import { claudeStream, teeText } from "./core/anthropic.js";

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
const MAX_CONTEXT = 16000;   // characters of history per request (~4k tokens) — caps AI cost per message

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
function consumeMsg(env, user, mode) {
  const key = activePlan(user, "ai");
  const plan = PRODUCTS.ai.plans[key];
  const col = mode === "deep" ? "deep" : "fast";
  const limit = plan.limits[col];
  return consume(env, user.id, col, limit,
    `You've used all ${limit.toLocaleString()} ${col === "deep" ? "Deep" : "Fast"} messages in your ${plan.name} plan this month. Upgrade for more, or wait until next month.`);
}

// POST /api/chat  { threadId?, message?, mode: "fast"|"deep", regenerate?: bool }
export async function chat(request, env, ctx) {
  const user = await requireUser(request, env);
  if (!hasAccess(user, "ai")) throw new HttpError(402, "Choose a plan to start chatting with X09.", { code: "plan_required" });

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
    refund = await consumeMsg(env, user, mode);
    await env.DB.prepare("INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
      .bind(thread.id, message, now()).run();
  }
  if (!refund) refund = await consumeMsg(env, user, mode);

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
    stream = await claudeStream(env, {
      kind: mode,
      system: SYSTEM_PROMPTS[mode] + (user.display_name ? ` The user's name is ${user.display_name}.` : ""),
      messages: context,
      max_tokens: mode === "deep" ? 2048 : 1024,
    });
  } catch (err) {
    await refund();
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "Signal lost — the AI returned an error. Please try again.");
  }

  const save = async (text) => {
    if (!text.trim()) return;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").bind(thread.id, text, now()),
      env.DB.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").bind(now(), thread.id),
    ]);
  };

  return new Response(teeText(stream, save), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-thread-id": thread.id,
      "x-thread-title": encodeURIComponent(thread.title),
    },
  });
}
