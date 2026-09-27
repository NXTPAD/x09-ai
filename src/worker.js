/**
 * X09 AI — Cloudflare Worker (router)
 *
 *  Accounts   POST /api/auth/signup | /api/auth/login | /api/auth/logout | /api/auth/delete
 *             GET  /api/me
 *  Plans      GET  /api/plans
 *  Billing    POST /api/billing/checkout | /api/billing/portal
 *             POST /api/stripe/webhook   (Stripe → us)
 *  Chat       POST /api/chat             (streams SSE)
 *             GET  /api/threads | GET/DELETE /api/threads/:id | DELETE /api/threads
 *  Everything else → the app in /public
 */
import { json, HttpError } from "./util.js";
import { signup, login, logout, me, deleteAccount } from "./auth.js";
import { checkout, portal, webhook } from "./stripe.js";
import { chat, listThreads, getThread, deleteThread, deleteAllThreads } from "./chat.js";
import { publicPlans } from "./plans.js";

// Block cross-site form posts: state-changing requests must come from our own origin
function sameOrigin(request) {
  const o = request.headers.get("origin");
  return !o || o === new URL(request.url).origin;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;

  if (p === "/api/stripe/webhook" && m === "POST") return webhook(request, env);

  if (m !== "GET" && m !== "HEAD" && !sameOrigin(request)) return json({ error: "Forbidden" }, 403);

  if (p === "/api/health") return json({ ok: true, service: "x09-ai", time: new Date().toISOString() });
  if (p === "/api/plans" && m === "GET") return json({ plans: publicPlans() });

  if (p === "/api/auth/signup" && m === "POST") return signup(request, env);
  if (p === "/api/auth/login" && m === "POST") return login(request, env);
  if (p === "/api/auth/logout" && m === "POST") return logout(request, env);
  if (p === "/api/auth/delete" && m === "POST") return deleteAccount(request, env);
  if (p === "/api/me" && m === "GET") return me(request, env);

  if (p === "/api/billing/checkout" && m === "POST") return checkout(request, env);
  if (p === "/api/billing/portal" && m === "POST") return portal(request, env);

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
