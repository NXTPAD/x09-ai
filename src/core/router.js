// Routes every X09 site shares (accounts, profile, plans, billing).
// Each site's src/worker.js calls coreRoute() first, then handles its own routes.
//
//  Accounts   POST /api/auth/signup | login | logout | delete | password     GET /api/me
//  Profile    POST /api/profile   { name?, company?, avatar? }
//  Plans      GET  /api/plans     → { plans: <this site's plans>, catalog: <every X09 product> }
//  Billing    POST /api/billing/checkout { plan, product? } | /api/billing/portal
//             POST /api/stripe/webhook   (Stripe → us)
import { json } from "./util.js";
import { signup, login, logout, me, deleteAccount, updateProfile, changePassword } from "./auth.js";
import { checkout, portal, webhook, cancelAllSubscriptions } from "./stripe.js";
import { publicPlans, publicCatalog } from "./catalog.js";
import { SITE } from "../site.js";

// Block cross-site form posts: state-changing requests must come from our own origin
export function sameOrigin(request) {
  const o = request.headers.get("origin");
  return !o || o === new URL(request.url).origin;
}

export async function coreRoute(request, env) {
  const p = new URL(request.url).pathname;
  const m = request.method;

  if (p === "/api/stripe/webhook" && m === "POST") return webhook(request, env);
  if (!p.startsWith("/api/")) return null;
  if (m !== "GET" && m !== "HEAD" && !sameOrigin(request)) return json({ error: "Forbidden" }, 403);

  if (p === "/api/health") return json({ ok: true, service: `x09-${SITE}`, time: new Date().toISOString() });
  if (p === "/api/plans" && m === "GET") return json({ plans: publicPlans(SITE), catalog: publicCatalog() });

  if (p === "/api/auth/signup" && m === "POST") return signup(request, env);
  if (p === "/api/auth/login" && m === "POST") return login(request, env);
  if (p === "/api/auth/logout" && m === "POST") return logout(request, env);
  if (p === "/api/auth/delete" && m === "POST") return deleteAccount(request, env, cancelAllSubscriptions);
  if (p === "/api/auth/password" && m === "POST") return changePassword(request, env);
  if (p === "/api/profile" && m === "POST") return updateProfile(request, env);
  if (p === "/api/me" && m === "GET") return me(request, env);

  if (p === "/api/billing/checkout" && m === "POST") return checkout(request, env);
  if (p === "/api/billing/portal" && m === "POST") return portal(request, env);
  return null;
}
