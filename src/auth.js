// Accounts: email + password (PBKDF2-SHA256), sessions via HttpOnly cookie
import { json, now, randomId, toHex, sha256Hex, safeEqual, getCookie, readJson, HttpError, month } from "./util.js";
import { PLANS, ACTIVE_STATUSES } from "./plans.js";

const COOKIE = "x09_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // Workers' maximum for PBKDF2
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}

function sessionCookie(token, request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function createSession(env, userId, request) {
  const token = randomId(32);
  const expires = now() + SESSION_DAYS * 864e5;
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, expires, now())
    .run();
  return sessionCookie(token, request, SESSION_DAYS * 86400);
}

export async function getUser(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  )
    .bind(await sha256Hex(token), now())
    .first();
  return row || null;
}

export async function requireUser(request, env) {
  const user = await getUser(request, env);
  if (!user) throw new HttpError(401, "Please sign in to continue.", { code: "auth_required" });
  return user;
}

export function hasAccess(user) {
  return !!(user && user.plan && PLANS[user.plan] && ACTIVE_STATUSES.has(user.sub_status));
}

export function publicUser(user, usage) {
  const plan = hasAccess(user) ? PLANS[user.plan] : null;
  return {
    id: user.id,
    email: user.email,
    name: user.display_name || null,
    createdAt: user.created_at,
    plan: plan ? user.plan : null,
    planName: plan ? plan.name : null,
    subStatus: user.sub_status || null,
    renewsAt: user.current_period_end || null,
    hasBilling: !!user.stripe_customer_id,
    usage: {
      fast: usage.fast, deep: usage.deep,
      fastLimit: plan ? plan.fast : 0, deepLimit: plan ? plan.deep : 0,
    },
  };
}

export async function usageThisMonth(env, userId) {
  const r = await env.DB.prepare("SELECT fast, deep FROM usage WHERE user_id = ? AND period = ?").bind(userId, month()).first();
  return r ? { fast: r.fast, deep: r.deep } : { fast: 0, deep: 0 };
}

export async function signup(request, env) {
  const body = await readJson(request);
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);
  if (password.length > 200) return json({ error: "Password is too long." }, 400);

  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return json({ error: "An account with that email already exists. Try signing in." }, 409);

  const { hash, salt } = await hashPassword(password);
  const id = randomId(12);
  await env.DB.prepare("INSERT INTO users (id, email, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, hash, salt, now())
    .run();
  const cookie = await createSession(env, id, request);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  return json({ user: publicUser(user, { fast: 0, deep: 0 }) }, 201, { "set-cookie": cookie });
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
  return json({ user: publicUser(user, await usageThisMonth(env, user.id)) }, 200, { "set-cookie": cookie });
}

export async function logout(request, env) {
  const token = getCookie(request, COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
}

export async function me(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ user: null });
  return json({ user: publicUser(user, await usageThisMonth(env, user.id)) });
}

export async function deleteAccount(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const { hash } = await hashPassword(String(body?.password || ""), user.pass_salt);
  if (!safeEqual(hash, user.pass_hash)) return json({ error: "Incorrect password." }, 401);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ?)").bind(user.id),
    env.DB.prepare("DELETE FROM threads WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM usage WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
}

// POST /api/profile  { name }
export async function updateProfile(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(name || null, user.id).run();
  const fresh = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return json({ user: publicUser(fresh, await usageThisMonth(env, user.id)) });
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
  const token = getCookie(request, COOKIE);
  const keep = token ? await sha256Hex(token) : "";
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?").bind(h.hash, h.salt, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, keep),
  ]);
  return json({ ok: true });
}
