// Stripe billing: Checkout (subscribe), Customer Portal (manage/cancel/switch), webhook (sync plan)
import { json, readJson, hmacHex, safeEqual, HttpError } from "./util.js";
import { requireUser } from "./auth.js";
import { PLANS, planForPriceId, ACTIVE_STATUSES } from "./plans.js";

const API = "https://api.stripe.com/v1";

// Flatten nested params into Stripe's form encoding: a[b][0][c]=v
function encode(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(500, "Billing isn't configured yet (missing STRIPE_SECRET_KEY).");
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params ? encode(params).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(502, data?.error?.message || "Stripe request failed.");
  return data;
}

async function ensureCustomer(env, user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const c = await stripe(env, "POST", "/customers", { email: user.email, metadata: { user_id: user.id } });
  await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(c.id, user.id).run();
  return c.id;
}

const origin = (request) => new URL(request.url).origin;

// POST /api/billing/checkout  { plan: "pilot" | "commander" | "fleet" }
export async function checkout(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const key = body?.plan;
  const plan = PLANS[key];
  if (!plan) return json({ error: "Unknown plan." }, 400);
  const price = env[plan.priceEnv];
  if (!price) return json({ error: `Billing isn't configured yet (missing ${plan.priceEnv}).` }, 500);

  // Already subscribed? Send them to the portal to switch plans instead of double-subscribing.
  if (user.stripe_subscription_id && ACTIVE_STATUSES.has(user.sub_status)) {
    return portal(request, env, user);
  }

  const customer = await ensureCustomer(env, user);
  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: "true",
    subscription_data: { metadata: { user_id: user.id, plan: key } },
    success_url: `${origin(request)}/?checkout=success`,
    cancel_url: `${origin(request)}/?checkout=cancel`,
  });
  return json({ url: session.url });
}

// POST /api/billing/portal
export async function portal(request, env, preloadedUser) {
  const user = preloadedUser || (await requireUser(request, env));
  if (!user.stripe_customer_id) return json({ error: "No billing account yet — choose a plan first." }, 400);
  const session = await stripe(env, "POST", "/billing_portal/sessions", {
    customer: user.stripe_customer_id,
    return_url: `${origin(request)}/`,
  });
  return json({ url: session.url });
}

// ---------- Webhook ----------
async function verifySignature(request, env, payload) {
  const header = request.headers.get("stripe-signature") || "";
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1)];
    })
  );
  const t = parts.t;
  const sigs = header.split(",").filter((p) => p.trim().startsWith("v1=")).map((p) => p.trim().slice(3));
  if (!t || !sigs.length || !env.STRIPE_WEBHOOK_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5-minute tolerance
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${payload}`);
  return sigs.some((s) => safeEqual(s, expected));
}

async function syncSubscription(env, sub, userIdHint) {
  const priceId = sub.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(env, priceId);
  const periodEnd = (sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null);
  const active = ACTIVE_STATUSES.has(sub.status);

  let user = null;
  const uid = userIdHint || sub.metadata?.user_id;
  if (uid) user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uid).first();
  if (!user && sub.customer) user = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").bind(sub.customer).first();
  if (!user) return;

  await env.DB.prepare(
    "UPDATE users SET plan = ?, sub_status = ?, stripe_subscription_id = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?), current_period_end = ? WHERE id = ?"
  )
    .bind(active ? plan : null, sub.status, sub.id, sub.customer || null, periodEnd ? periodEnd * 1000 : null, user.id)
    .run();
}

// POST /api/stripe/webhook
export async function webhook(request, env) {
  const payload = await request.text();
  if (!(await verifySignature(request, env, payload))) return json({ error: "Invalid signature" }, 400);
  const event = JSON.parse(payload);
  const obj = event.data?.object || {};

  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription" || !obj.subscription) break;
      // Fetch the subscription so we get price + status
      const sub = await stripe(env, "GET", `/subscriptions/${obj.subscription}`);
      await syncSubscription(env, sub, obj.client_reference_id);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(env, obj);
      break;
    default:
      break;
  }
  return json({ received: true });
}
