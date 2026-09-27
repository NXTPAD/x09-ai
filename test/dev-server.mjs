// Local test harness: runs the Worker in Node with a SQLite-backed D1 stand-in,
// static assets, mock AI and a mock Stripe API. Not deployed — for testing only.
//   node --experimental-sqlite test/dev-server.mjs   → http://localhost:8787
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.PORT || 8787);

// ---- D1 stand-in ----
const sqlite = new DatabaseSync(process.env.DB_FILE || ":memory:");
sqlite.exec(fs.readFileSync(path.join(ROOT, "migrations/0001_init.sql"), "utf8"));
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  _s() { return sqlite.prepare(this.sql); }
  async first() { return this._s().get(...this.args) ?? null; }
  async all() { return { results: this._s().all(...this.args) }; }
  async run() { const r = this._s().run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  batch: async (stmts) => { sqlite.exec("BEGIN"); try { const out = []; for (const s of stmts) out.push(await s.run()); sqlite.exec("COMMIT"); return out; } catch (e) { sqlite.exec("ROLLBACK"); throw e; } },
};

// ---- Static assets (SPA fallback) ----
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p === "/") p = "/index.html";
    let f = path.join(ROOT, "public", p);
    if (!f.startsWith(path.join(ROOT, "public")) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, "public/index.html");
    return new Response(fs.readFileSync(f), { headers: { "content-type": TYPES[path.extname(f)] || "application/octet-stream" } });
  },
};

// ---- Mock Stripe API ----
export const stripeCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.startsWith("https://api.stripe.com/")) return realFetch(input, init);
  const p = url.replace("https://api.stripe.com/v1", "");
  const params = new URLSearchParams(init.body || "");
  stripeCalls.push({ method: init.method, path: p, params: Object.fromEntries(params) });
  const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  if (p.startsWith("/prices")) {
    const mk = (id, name, amount, interval = "month", created = 1) => ({ id, created, unit_amount: amount, recurring: { interval }, product: { id: "prod_" + name, name, active: true } });
    return J({ has_more: false, data: [
      mk("price_pilot", "Pilot", 1200), mk("price_commander", "Commander", 2900), mk("price_fleet", "Fleet", 7900),
      mk("price_fleet_yearly", "Fleet", 79000, "year", 5), mk("price_other", "Something else", 500),
    ] });
  }
  if (p === "/customers") return J({ id: "cus_test_" + Math.random().toString(36).slice(2, 8) });
  if (p === "/checkout/sessions") return J({ id: "cs_test", url: `http://localhost:${PORT}/?checkout=success&mock_price=${params.get("line_items[0][price]")}&mock_user=${params.get("client_reference_id")}` });
  if (p === "/billing_portal/sessions") return J({ id: "bps_test", url: `http://localhost:${PORT}/?portal=1` });
  const sub = p.match(/^\/subscriptions\/(.+)$/);
  if (sub) return J(globalThis.__mockSubs?.[sub[1]] || { error: { message: "no such sub" } });
  return new Response(JSON.stringify({ error: { message: "unmocked " + p } }), { status: 400 });
};

export const env = {
  DB, ASSETS, MOCK_AI: "1",
  AI_MODEL: "fast-model", AI_MODEL_DEEP: "deep-model",
  STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_WEBHOOK_SECRET: "whsec_test",
  // Placeholders on purpose: prices are found automatically by product name (like production)
  STRIPE_PRICE_PILOT: "price_REPLACE_ME", STRIPE_PRICE_COMMANDER: "price_REPLACE_ME", STRIPE_PRICE_FLEET: "price_REPLACE_ME",
};

export const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
  // Test-only: the mock checkout redirects here; simulate Stripe's webhook activating the plan
  const u = new URL(request.url);
  if (u.searchParams.get("mock_user")) {
    const plan = { price_pilot: "pilot", price_commander: "commander", price_fleet: "fleet" }[u.searchParams.get("mock_price")];
    sqlite.prepare("UPDATE users SET plan = ?, sub_status = 'active', stripe_subscription_id = 'sub_mock' WHERE id = ?").run(plan, u.searchParams.get("mock_user"));
  }
  const response = await worker.fetch(request, env, { waitUntil() {} });
  const headers = {};
  response.headers.forEach((v, k) => { if (k === "set-cookie") return; headers[k] = v; });
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
  }
  res.end();
});

// Test-only helper: simulate Stripe firing a signed webhook after checkout
server.on("request", () => {});
if (process.argv[1] && process.argv[1].endsWith("dev-server.mjs")) {
  server.listen(PORT, () => console.log(`X09 test server on http://localhost:${PORT}`));
}
