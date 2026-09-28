/**
 * X09 AI — Cloudflare Worker (router)
 *
 *  Shared X09 routes (src/core/router.js): accounts, profile, plans, billing, Stripe webhook
 *  Chat       POST /api/chat             (streams SSE from Claude)
 *             GET  /api/threads | GET/DELETE /api/threads/:id | DELETE /api/threads
 *  Everything else → the app in /public
 */
import { json, HttpError } from "./core/util.js";
import { coreRoute } from "./core/router.js";
import { chat, listThreads, getThread, deleteThread, deleteAllThreads } from "./chat.js";
import { voiceDemo } from "./voice.js";

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;

  const core = await coreRoute(request, env);
  if (core) return core;

  if ((p === "/api/voice-demo" || p === "/api/voice-demo/audio") && m === "GET") return voiceDemo(request, env);

  if (p === "/api/chat" && m === "POST") return chat(request, env, ctx);
  if (p === "/api/threads" && m === "GET") return listThreads(request, env);
  if (p === "/api/threads" && m === "DELETE") return deleteAllThreads(request, env);
  const t = p.match(/^\/api\/threads\/([a-f0-9]{8,40})$/);
  if (t && m === "GET") return getThread(request, env, t[1]);
  if (t && m === "DELETE") return deleteThread(request, env, t[1]);

  if (p.startsWith("/api/")) return json({ error: "Not found" }, 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on our side. Please try again." }, 500);
    }
  },
};
