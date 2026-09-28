// X09 accounts — ONE account for every X09 site (email + password, PBKDF2-SHA256).
// Sessions live in the shared database and the cookie is scoped to x09hub.com, so a person
// signs in once and is signed in on X09 Hub, X09 AI and X09 Docs.
import { json, now, month, randomId, toHex, sha256Hex, safeEqual, getCookie, readJson, HttpError, cookieDomain } from "./util.js";
import { PRODUCTS, PRODUCT_ORDER, ACTIVE_STATUSES, GUIDE_MONTHLY_LIMIT, planDef } from "./catalog.js";
import { SITE } from "../site.js";

const COOKIE = "x09_sid";
const LEGACY_COOKIES = ["x09_session", "x09docs_session"]; // older per-site cookies (still honoured)
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // Workers' maximum for PBKDF2
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_AVATAR = 200_000; // characters of data: URL (~150 KB image)

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}

function cookieHeader(name, value, request, maxAge, domain = cookieDomain(request)) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${domain ? `; Domain=${domain}` : ""}${secure}`;
}

// Cookies to clear on sign-out: the shared one plus any old per-site cookies
function clearCookies(request) {
  const h = new Headers();
  h.append("set-cookie", cookieHeader(COOKIE, "", request, 0));
  for (const c of LEGACY_COOKIES) h.append("set-cookie", cookieHeader(c, "", request, 0, null));
  return h;
}

async function createSession(env, userId, request) {
  const token = randomId(32);
  const expires = now() + SESSION_DAYS * 864e5;
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, expires, now())
    .run();
  return cookieHeader(COOKIE, token, request, SESSION_DAYS * 86400);
}

function sessionToken(request) {
  return getCookie(request, COOKIE) || LEGACY_COOKIES.map((c) => getCookie(request, c)).find(Boolean) || null;
}

// ---------- Loading the signed-in person ----------
export async function loadSubs(env, userId) {
  const { results } = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ?").bind(userId).all();
  return Object.fromEntries((results || []).map((r) => [r.product, r]));
}

export async function getUser(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256Hex(token), now()).first();
  if (!row) return null;
  row.subs = await loadSubs(env, row.id);
  return row;
}

export async function requireUser(request, env) {
  const user = await getUser(request, env);
  if (!user) throw new HttpError(401, "Please sign in to continue.", { code: "auth_required" });
  return user;
}

// Active plan key for a product, or null
export function activePlan(user, product) {
  const s = user?.subs?.[product];
  return s && planDef(product, s.plan) && ACTIVE_STATUSES.has(s.status) ? s.plan : null;
}

export function hasAccess(user, product = SITE) {
  return !!activePlan(user, product);
}

export const hasAnyPlan = (user) => PRODUCT_ORDER.some((p) => activePlan(user, p));

// ---------- Usage (one row per user per month, a column per meter) ----------
export async function usageThisMonth(env, userId) {
  const r = await env.DB.prepare("SELECT fast, deep, docs, guide FROM usage WHERE user_id = ? AND period = ?").bind(userId, month()).first();
  return { fast: r?.fast || 0, deep: r?.deep || 0, docs: r?.docs || 0, guide: r?.guide || 0 };
}

// Atomically count one use of `col` against `limit`; returns a refund() for failed AI calls
export async function consume(env, userId, col, limit, message) {
  if (!["fast", "deep", "docs", "guide"].includes(col)) throw new Error("bad meter");
  const period = month();
  await env.DB.prepare("INSERT INTO usage (user_id, period) VALUES (?, ?) ON CONFLICT(user_id, period) DO NOTHING").bind(userId, period).run();
  const r = await env.DB.prepare(`UPDATE usage SET ${col} = ${col} + 1 WHERE user_id = ? AND period = ? AND ${col} < ?`)
    .bind(userId, period, limit).run();
  if (!r.meta || !r.meta.changes) throw new HttpError(402, message, { code: "limit_reached" });
  return async () => {
    await env.DB.prepare(`UPDATE usage SET ${col} = MAX(${col} - 1, 0) WHERE user_id = ? AND period = ?`).bind(userId, period).run();
  };
}

// ---------- What the browser sees ----------
function productState(user, product, usage) {
  const s = user.subs?.[product];
  const key = activePlan(user, product);
  const d = key ? planDef(product, key) : null;
  const limits = d ? d.limits : {};
  const meters = product === "ai"
    ? { fast: usage.fast, deep: usage.deep, fastLimit: limits.fast || 0, deepLimit: limits.deep || 0 }
    : { docs: usage.docs, docsLimit: limits.docs || 0 };
  return {
    name: PRODUCTS[product].name, url: PRODUCTS[product].url,
    plan: key, planName: d ? d.name : null, price: d ? d.price : null,
    status: s?.status || null, renewsAt: s?.current_period_end || null,
    whiteLabel: !!d?.whiteLabel, usage: meters,
  };
}

export function publicUser(user, usage) {
  const products = Object.fromEntries(PRODUCT_ORDER.map((p) => [p, productState(user, p, usage)]));
  const anyPlan = hasAnyPlan(user);
  const out = {
    id: user.id,
    email: user.email,
    name: user.display_name || null,
    company: user.company || null,
    avatar: user.avatar || null,
    createdAt: user.created_at,
    hasBilling: !!user.stripe_customer_id,
    products,
    guide: { used: usage.guide, limit: anyPlan ? GUIDE_MONTHLY_LIMIT : 0 },
  };
  // Shortcuts for the site you're on (what each app's own UI reads)
  const here = products[SITE];
  if (here) {
    Object.assign(out, { plan: here.plan, planName: here.planName, subStatus: here.status, renewsAt: here.renewsAt, whiteLabel: here.whiteLabel });
    out.usage = SITE === "ai" ? here.usage : { ai: here.usage.docs, aiLimit: here.usage.docsLimit };
  }
  return out;
}

async function freshUser(env, id) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  u.subs = await loadSubs(env, id);
  return publicUser(u, await usageThisMonth(env, id));
}

// ---------- Routes ----------
export async function signup(request, env) {
  const body = await readJson(request);
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);
  if (password.length > 200) return json({ error: "Password is too long." }, 400);

  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return json({ error: "An X09 account with that email already exists. Try signing in." }, 409);

  const { hash, salt } = await hashPassword(password);
  const id = randomId(12);
  await env.DB.prepare("INSERT INTO users (id, email, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, hash, salt, now()).run();
  const cookie = await createSession(env, id, request);
  return json({ user: await freshUser(env, id) }, 201, { "set-cookie": cookie });
}

export async function login(request, env) {
  const body = await readJson(request);
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  // Always hash to keep timing similar whether or not the user exists
  const { hash } = await hashPassword(password, user ? user.pass_salt : "00".repeat(16));
  if (!user || !safeEqual(hash, user.pass_hash)) return json({ error: "Incorrect email or password." }, 401);
  const cookie = await createSession(env, user.id, request);
  return json({ user: await freshUser(env, user.id) }, 200, { "set-cookie": cookie });
}

export async function logout(request, env) {
  const token = sessionToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  const h = clearCookies(request);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ ok: true }), { headers: h });
}

export async function me(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ user: null });
  return json({ user: publicUser(user, await usageThisMonth(env, user.id)) });
}

// POST /api/profile  { name?, company?, avatar? }  — shared by every X09 site
export async function updateProfile(request, env) {
  const user = await requireUser(request, env);
  const body = (await readJson(request)) || {};
  const sets = [], args = [];
  if ("name" in body) {
    sets.push("display_name = ?");
    args.push(String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || null);
  }
  if ("company" in body) {
    sets.push("company = ?");
    args.push(String(body.company ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || null);
  }
  if ("avatar" in body) {
    const a = body.avatar == null ? "" : String(body.avatar);
    if (a && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a)) return json({ error: "Profile photo must be a PNG, JPEG or WebP image." }, 400);
    if (a.length > MAX_AVATAR) return json({ error: "That photo is too large. Try a smaller image." }, 400);
    sets.push("avatar = ?");
    args.push(a || null);
  }
  if (sets.length) await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...args, user.id).run();
  return json({ user: await freshUser(env, user.id) });
}

// POST /api/auth/password  { current, next }  — signs out other devices
export async function changePassword(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const current = String(body?.current || ""), next = String(body?.next || "");
  const { hash } = await hashPassword(current, user.pass_salt);
  if (!safeEqual(hash, user.pass_hash)) return json({ error: "Current password is incorrect." }, 401);
  if (next.length < 8) return json({ error: "New password must be at least 8 characters." }, 400);
  if (next.length > 200) return json({ error: "New password is too long." }, 400);
  const h = await hashPassword(next);
  const token = sessionToken(request);
  const keep = token ? await sha256Hex(token) : "";
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?").bind(h.hash, h.salt, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, keep),
  ]);
  return json({ ok: true });
}

// POST /api/auth/delete  { password }  — deletes the X09 account and its data on EVERY site,
// and cancels any active X09 subscriptions so the person isn't charged again.
export async function deleteAccount(request, env, cancelSubscriptions) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const { hash } = await hashPassword(String(body?.password || ""), user.pass_salt);
  if (!safeEqual(hash, user.pass_hash)) return json({ error: "Incorrect password." }, 401);
  if (cancelSubscriptions) {
    try { await cancelSubscriptions(env, user); } catch (err) { console.warn("Cancel on delete failed:", err?.message); }
  }
  const id = user.id;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM threads WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM docs WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM business WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM counters WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM usage WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  const h = clearCookies(request);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ ok: true }), { headers: h });
}
