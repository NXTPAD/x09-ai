// X09 billing (Stripe) — shared by every X09 site.
// One Stripe customer per X09 account; one subscription per product (X09 AI, X09 Docs).
// Any site can start a checkout for any product, and every site's webhook understands every
// product, so it doesn't matter which site's webhook endpoint Stripe calls.
import { json, readJson, hmacHex, safeEqual, HttpError, now } from "./util.js";
import { requireUser, activePlan } from "./auth.js";
import { PRODUCTS, PRODUCT_ORDER, ACTIVE_STATUSES } from "./catalog.js";
import { SITE } from "../site.js";

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

export async function stripe(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(500, "Billing isn't configured yet (missing STRIPE_SECRET_KEY).");
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: params ? encode(params).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(502, data?.error?.message || "Stripe request failed.");
  return data;
}

// ---------- Price lookup ----------
// For every plan: the STRIPE_PRICE_* var if set, otherwise the newest active monthly price of the
// Stripe product whose name matches the plan's `stripeProduct`. Cached for 10 minutes.
let priceCache = null;
const isRealPriceId = (v) => typeof v === "string" && /^price_(?!REPLACE)/.test(v);
const allPlans = () => PRODUCT_ORDER.flatMap((product) => PRODUCTS[product].order.map((plan) => ({ product, plan, def: PRODUCTS[product].plans[plan] })));
const slot = (product, plan) => `${product}:${plan}`;

export async function priceMap(env) {
  const plans = allPlans();
  if (plans.every((p) => isRealPriceId(env[p.def.priceEnv]))) {
    return Object.fromEntries(plans.map((p) => [slot(p.product, p.plan), env[p.def.priceEnv]]));
  }
  if (priceCache && priceCache.expires > Date.now()) return priceCache.map;
  const map = {};
  for (const p of plans) if (isRealPriceId(env[p.def.priceEnv])) map[slot(p.product, p.plan)] = env[p.def.priceEnv];
  let url = "/prices?active=true&type=recurring&limit=100&expand[]=data.product";
  const prices = [];
  for (let page = 0; page < 5; page++) {
    const r = await stripe(env, "GET", url);
    prices.push(...r.data);
    if (!r.has_more) break;
    url = `/prices?active=true&type=recurring&limit=100&expand[]=data.product&starting_after=${r.data[r.data.length - 1].id}`;
  }
  const norm = (s) => String(s || "").trim().toLowerCase();
  for (const p of plans) {
    const k = slot(p.product, p.plan);
    if (map[k]) continue;
    const want = norm(p.def.stripeProduct);
    const matches = prices.filter(
      (x) => x.product && typeof x.product === "object" && x.product.active !== false && norm(x.product.name) === want && x.recurring?.interval === "month"
    );
    if (matches.length) map[k] = matches.sort((a, b) => b.created - a.created)[0].id;
  }
  priceCache = { map, expires: Date.now() + 10 * 60 * 1000 };
  return map;
}

async function planForPrice(env, priceId) {
  if (!priceId) return null;
  const map = await priceMap(env);
  const hit = Object.entries(map).find(([, id]) => id === priceId);
  if (!hit) return null;
  const [product, plan] = hit[0].split(":");
  return { product, plan };
}

async function ensureCustomer(env, user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const c = await stripe(env, "POST", "/customers", { email: user.email, metadata: { user_id: user.id, x09: "account" } });
  await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(c.id, user.id).run();
  return c.id;
}

const origin = (request) => new URL(request.url).origin;

// POST /api/billing/checkout  { plan, product? }  (product defaults to the site you're on)
export async function checkout(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const product = PRODUCTS[body?.product] ? body.product : SITE;
  const key = body?.plan;
  const plan = PRODUCTS[product]?.plans[key];
  if (!plan) return json({ error: "Unknown plan." }, 400);
  const price = (await priceMap(env))[slot(product, key)];
  if (!price) return json({ error: `Billing isn't set up yet: no active monthly Stripe price found for a product named "${plan.stripeProduct}".` }, 500);

  // Already subscribed to this product? Switch plans in the portal instead of double-subscribing.
  if (activePlan(user, product) && user.subs[product]?.stripe_subscription_id) return portal(request, env, user);

  const customer = await ensureCustomer(env, user);
  const back = `${origin(request)}/?checkout=success&product=${product}`;
  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: "true",
    subscription_data: { metadata: { user_id: user.id, product, plan: key, app: `x09-${product}` } },
    success_url: back,
    cancel_url: `${origin(request)}/?checkout=cancel`,
  });
  return json({ url: session.url });
}

// One Customer Portal configuration for all X09 plans, created on first use and remembered.
async function portalConfig(env) {
  const saved = await env.DB.prepare("SELECT value FROM meta WHERE key = 'portal_config_x09'").first();
  if (saved?.value) return saved.value;
  const map = await priceMap(env);
  const byProduct = {};
  for (const id of Object.values(map)) {
    const price = await stripe(env, "GET", `/prices/${id}`);
    const prod = typeof price.product === "string" ? price.product : price.product?.id;
    if (prod) (byProduct[prod] ||= []).push(id);
  }
  const products = Object.entries(byProduct).map(([product, prices]) => ({ product, prices }));
  if (!products.length) return null;
  const cfg = await stripe(env, "POST", "/billing_portal/configurations", {
    business_profile: { headline: "X09 — manage your plans" },
    features: {
      invoice_history: { enabled: "true" },
      payment_method_update: { enabled: "true" },
      customer_update: { enabled: "true", allowed_updates: ["email"] },
      subscription_cancel: { enabled: "true", mode: "at_period_end" },
      subscription_update: { enabled: "true", default_allowed_updates: ["price"], proration_behavior: "create_prorations", products },
    },
    metadata: { app: "x09" },
  });
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('portal_config_x09', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(cfg.id).run();
  return cfg.id;
}

// POST /api/billing/portal
export async function portal(request, env, preloadedUser) {
  const user = preloadedUser || (await requireUser(request, env));
  if (!user.stripe_customer_id) return json({ error: "No billing account yet — choose a plan first." }, 400);
  let configuration = null;
  try { configuration = await portalConfig(env); } catch (err) { console.warn("Portal config:", err.message); }
  const session = await stripe(env, "POST", "/billing_portal/sessions", {
    customer: user.stripe_customer_id,
    configuration: configuration || undefined,
    return_url: `${origin(request)}/`,
  });
  return json({ url: session.url });
}

// Used when an account is deleted: cancel every active X09 subscription immediately
export async function cancelAllSubscriptions(env, user) {
  for (const s of Object.values(user.subs || {})) {
    if (s.stripe_subscription_id && ACTIVE_STATUSES.has(s.status)) {
      await stripe(env, "DELETE", `/subscriptions/${s.stripe_subscription_id}`);
    }
  }
}

// ---------- Webhook ----------
async function verifySignature(request, env, payload) {
  const header = request.headers.get("stripe-signature") || "";
  const t = header.split(",").map((p) => p.trim()).find((p) => p.startsWith("t="))?.slice(2);
  const sigs = header.split(",").map((p) => p.trim()).filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || !env.STRIPE_WEBHOOK_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5-minute tolerance
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${payload}`);
  return sigs.some((s) => safeEqual(s, expected));
}

export async function syncSubscription(env, sub, userIdHint) {
  const found = await planForPrice(env, sub.items?.data?.[0]?.price?.id);
  if (!found) return; // not an X09 plan (some other product on this Stripe account)
  const { product, plan } = found;
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;

  let user = null;
  const uid = userIdHint || sub.metadata?.user_id;
  if (uid) user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uid).first();
  if (!user && sub.customer) user = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").bind(sub.customer).first();
  if (!user) return;

  // Don't let an old, ended subscription overwrite a newer active one for the same product
  const existing = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND product = ?").bind(user.id, product).first();
  if (existing && existing.stripe_subscription_id && existing.stripe_subscription_id !== sub.id &&
      ACTIVE_STATUSES.has(existing.status) && !ACTIVE_STATUSES.has(sub.status)) return;

  await env.DB.batch([
    // If this subscription was switched to another product in the portal, drop its old row
    env.DB.prepare("DELETE FROM subscriptions WHERE stripe_subscription_id = ? AND product != ?").bind(sub.id, product),
    env.DB.prepare(
      `INSERT INTO subscriptions (user_id, product, plan, status, stripe_subscription_id, current_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, product) DO UPDATE SET plan = excluded.plan, status = excluded.status,
         stripe_subscription_id = excluded.stripe_subscription_id, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`
    ).bind(user.id, product, plan, sub.status, sub.id, periodEnd ? periodEnd * 1000 : null, now()),
    env.DB.prepare("UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?").bind(sub.customer || null, user.id),
  ]);
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
