// End-to-end API test against the local harness.
//   node --experimental-sqlite test/api.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { server, env, stripeCalls } from "./dev-server.mjs";

const PORT = 8799;
await new Promise((r) => server.listen(PORT, r));
const BASE = `http://localhost:${PORT}`;
let cookie = "";

async function api(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", cookie, origin: BASE, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie();
  if (sc.length) cookie = sc[0].split(";")[0];
  if (raw) return res;
  return { status: res.status, data: await res.json().catch(() => null), res };
}

function signed(payload) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  return { "stripe-signature": `t=${t},v1=${sig}` };
}

let pass = 0;
const ok = (name) => { pass++; console.log("  ✓", name); };

try {
  // Plans
  let r = await api("/api/plans");
  assert.equal(r.data.plans.length, 3); ok("lists 3 paid plans");
  assert.deepEqual(r.data.catalog.map((p) => p.key), ["ai", "docs"]); ok("catalog lists every X09 product");

  // Signed out
  r = await api("/api/me"); assert.equal(r.data.user, null); ok("signed-out /api/me");
  r = await api("/api/chat", { method: "POST", body: { message: "hi" } });
  assert.equal(r.status, 401); ok("chat requires sign-in");

  // Validation
  r = await api("/api/auth/signup", { method: "POST", body: { email: "bad", password: "12345678" } });
  assert.equal(r.status, 400); ok("rejects invalid email");
  r = await api("/api/auth/signup", { method: "POST", body: { email: "a@b.co", password: "short" } });
  assert.equal(r.status, 400); ok("rejects short password");

  // Signup
  r = await api("/api/auth/signup", { method: "POST", body: { email: "Pilot@Example.com", password: "orbit-2026!" } });
  assert.equal(r.status, 201); assert.equal(r.data.user.plan, null); assert.ok(cookie.startsWith("x09_sid="));
  const userId = r.data.user.id; ok("signup creates account + session, no plan");
  r = await api("/api/auth/signup", { method: "POST", body: { email: "pilot@example.com", password: "orbit-2026!" } });
  assert.equal(r.status, 409); ok("duplicate email rejected");

  // Paywall
  r = await api("/api/chat", { method: "POST", body: { message: "hi" } });
  assert.equal(r.status, 402); assert.equal(r.data.code, "plan_required"); ok("chat blocked without a plan (paywall)");

  // Cross-site request blocked
  r = await api("/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403); ok("cross-origin POST blocked");

  // Checkout
  r = await api("/api/billing/checkout", { method: "POST", body: { plan: "commander" } });
  assert.equal(r.status, 200); assert.ok(r.data.url);
  const cs = stripeCalls.find((c) => c.path === "/checkout/sessions");
  assert.equal(cs.params["line_items[0][price]"], "price_commander");
  assert.equal(cs.params["mode"], "subscription");
  assert.equal(cs.params["client_reference_id"], userId); ok("checkout finds Commander's monthly price by product name");

  // Webhook: bad signature
  const me0 = (await api("/api/me")).data.user;
  const sub = { id: "sub_1", object: "subscription", customer: "cus_x", status: "active", metadata: { user_id: userId },
    items: { data: [{ price: { id: "price_commander" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } };
  globalThis.__mockSubs = { sub_1: sub };
  const evt = JSON.stringify({ type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", client_reference_id: userId } } });
  r = await api("/api/stripe/webhook", { method: "POST", body: evt, headers: { "stripe-signature": "t=1,v1=deadbeef" } });
  assert.equal(r.status, 400); ok("webhook rejects bad signature");

  // Webhook: good signature → plan active
  r = await api("/api/stripe/webhook", { method: "POST", body: evt, headers: signed(evt) });
  assert.equal(r.status, 200);
  let u = (await api("/api/me")).data.user;
  assert.equal(u.plan, "commander"); assert.equal(u.usage.fastLimit, 1600); assert.equal(u.usage.deepLimit, 160);
  assert.equal(u.products.ai.planName, "Commander"); assert.equal(u.products.docs.plan, null);
  assert.equal(u.guide.limit, 100);
  ok("signed webhook activates Commander plan (shared subscriptions table)");

  // Chat streams + saves
  let res = await api("/api/chat", { method: "POST", body: { message: "Hello X09", mode: "fast" }, raw: true });
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /event-stream/);
  const threadId = res.headers.get("x-thread-id");
  const text = await res.text(); assert.match(text, /data: /);
  await new Promise((r) => setTimeout(r, 50));
  r = await api(`/api/threads/${threadId}`);
  assert.equal(r.data.messages.length, 2); assert.equal(r.data.messages[1].role, "assistant");
  assert.match(r.data.messages[1].content, /Hello X09/); ok("chat streams and saves both messages");

  // Follow-up in same thread + deep
  res = await api("/api/chat", { method: "POST", body: { message: "Go deeper", mode: "deep", threadId }, raw: true });
  await res.text(); await new Promise((r) => setTimeout(r, 50));
  u = (await api("/api/me")).data.user;
  assert.equal(u.usage.fast, 1); assert.equal(u.usage.deep, 1); ok("usage counted per mode");

  // Regenerate
  res = await api("/api/chat", { method: "POST", body: { threadId, regenerate: true, mode: "fast" }, raw: true });
  await res.text(); await new Promise((r) => setTimeout(r, 50));
  r = await api(`/api/threads/${threadId}`);
  assert.equal(r.data.messages.length, 4); ok("retry replaces the last reply");

  // Threads list
  r = await api("/api/threads"); assert.equal(r.data.threads.length, 1); ok("threads listed");

  // Limit enforcement
  await env.DB.prepare("UPDATE usage SET deep = 160 WHERE user_id = ?").bind(userId).run();
  r = await api("/api/chat", { method: "POST", body: { message: "x", mode: "deep", threadId } });
  assert.equal(r.status, 402); assert.equal(r.data.code, "limit_reached"); ok("monthly Deep limit enforced");

  // Portal (already subscribed checkout → portal)
  r = await api("/api/billing/checkout", { method: "POST", body: { plan: "fleet" } });
  assert.match(r.data.url, /portal=1/); ok("subscribed users are sent to billing portal to switch plans");

  // Cross-product: buy X09 Docs from the X09 AI site with the same Stripe customer
  r = await api("/api/billing/checkout", { method: "POST", body: { product: "docs", plan: "pro" } });
  const cs2 = stripeCalls.filter((c) => c.path === "/checkout/sessions").pop();
  assert.equal(cs2.params["line_items[0][price]"], "price_pro"); assert.equal(cs2.params["customer"], cs.params["customer"]);
  ok("any X09 plan can be bought from any site, one Stripe customer");
  const docsSub = { id: "sub_docs", customer: cs.params["customer"], status: "active", metadata: { user_id: userId },
    items: { data: [{ price: { id: "price_pro" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } };
  const e2 = JSON.stringify({ type: "customer.subscription.created", data: { object: docsSub } });
  await api("/api/stripe/webhook", { method: "POST", body: e2, headers: signed(e2) });
  u = (await api("/api/me")).data.user;
  assert.equal(u.products.docs.plan, "pro"); assert.equal(u.plan, "commander"); ok("X09 Docs plan shows up on the X09 AI account too");

  // Cancellation via webhook
  const del = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { ...sub, status: "canceled" } } });
  await api("/api/stripe/webhook", { method: "POST", body: del, headers: signed(del) });
  u = (await api("/api/me")).data.user; assert.equal(u.plan, null);
  r = await api("/api/chat", { method: "POST", body: { message: "hi" } });
  assert.equal(r.status, 402); ok("cancellation removes access");

  // Other user can't read my thread
  const saved = cookie; cookie = "";
  await api("/api/auth/signup", { method: "POST", body: { email: "other@example.com", password: "another-pass" } });
  r = await api(`/api/threads/${threadId}`); assert.equal(r.status, 404); ok("threads are private to their owner");
  cookie = saved;

  // Profile: display name
  r = await api("/api/profile", { method: "POST", body: { name: "  Commander   Shepard  " } });
  assert.equal(r.status, 200); assert.equal(r.data.user.name, "Commander Shepard");
  r = await api("/api/me"); assert.equal(r.data.user.name, "Commander Shepard"); ok("display name saved and trimmed");
  const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  r = await api("/api/profile", { method: "POST", body: { company: "Orbit Roofing", avatar: px } });
  assert.equal(r.data.user.company, "Orbit Roofing"); assert.equal(r.data.user.avatar, px); assert.equal(r.data.user.name, "Commander Shepard");
  ok("company + profile photo saved (shared profile)");
  r = await api("/api/profile", { method: "POST", body: { avatar: "javascript:alert(1)" } });
  assert.equal(r.status, 400); ok("non-image profile photos rejected");

  // Old per-site cookie still works (people stay signed in after the switch)
  const tok = "legacy" + "0".repeat(58);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.createHash("sha256").update(tok).digest("hex"), userId, Date.now() + 864e5, Date.now()).run();
  const keep = cookie; cookie = `x09_session=${tok}`;
  r = await api("/api/me"); assert.equal(r.data.user.id, userId); ok("legacy x09_session cookie still signs you in");
  cookie = keep;

  // Change password (wrong current → rejected; right → works, old one stops working)
  r = await api("/api/auth/password", { method: "POST", body: { current: "nope-nope", next: "brand-new-pass" } });
  assert.equal(r.status, 401); ok("password change needs the current password");
  r = await api("/api/auth/password", { method: "POST", body: { current: "orbit-2026!", next: "short" } });
  assert.equal(r.status, 400); ok("new password must be 8+ characters");
  r = await api("/api/auth/password", { method: "POST", body: { current: "orbit-2026!", next: "brand-new-pass" } });
  assert.equal(r.status, 200);
  r = await api("/api/me"); assert.ok(r.data.user, "still signed in on this device"); ok("password changed, current session kept");

  // Logout / login
  await api("/api/auth/logout", { method: "POST" }); cookie = "";
  r = await api("/api/auth/login", { method: "POST", body: { email: "pilot@example.com", password: "wrong-pass" } });
  assert.equal(r.status, 401); ok("wrong password rejected");
  r = await api("/api/auth/login", { method: "POST", body: { email: "PILOT@example.com", password: "orbit-2026!" } });
  assert.equal(r.status, 401); ok("old password no longer works");
  r = await api("/api/auth/login", { method: "POST", body: { email: "PILOT@example.com", password: "brand-new-pass" } });
  assert.equal(r.status, 200); ok("login works with new password (case-insensitive email)");

  // Delete account
  r = await api("/api/auth/delete", { method: "POST", body: { password: "wrong" } });
  assert.equal(r.status, 401); ok("delete account needs password");
  r = await api("/api/auth/delete", { method: "POST", body: { password: "brand-new-pass" } });
  assert.equal(r.status, 200); cookie = "";
  r = await api("/api/auth/login", { method: "POST", body: { email: "pilot@example.com", password: "brand-new-pass" } });
  assert.equal(r.status, 401); ok("deleted account is gone");
  assert.ok(stripeCalls.some((c) => c.method === "DELETE" && c.path === "/subscriptions/sub_docs")); ok("deleting the account cancels active X09 plans");

  console.log(`\nAll ${pass} checks passed.`);
} catch (e) {
  console.error("\nFAILED after", pass, "checks:", e);
  process.exitCode = 1;
} finally {
  server.close();
}
