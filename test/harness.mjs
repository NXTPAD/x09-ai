// X09 local test harness (identical in every X09 repo — test/harness.mjs).
// Runs a site's Worker in Node with a SQLite stand-in for the shared D1 database,
// the site's static assets, mock AI (MOCK_AI=1) and a mock Stripe API. Not deployed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function makeHarness(worker, root, extraEnv = {}) {
  const PORT = Number(process.env.PORT || 8787);

  // ---- D1 stand-in (all shared X09 migrations) ----
  const sqlite = new DatabaseSync(process.env.DB_FILE || ":memory:");
  // Like D1: remember which migrations ran, so several sites can share one DB_FILE
  sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY)");
  for (const f of fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    if (sqlite.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(f)) continue;
    sqlite.exec(fs.readFileSync(path.join(root, "migrations", f), "utf8"));
    sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
  }
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
  const TYPES = { ".png": "image/png", ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".woff": "font/woff", ".txt": "text/plain" };
  const ASSETS = {
    async fetch(req) {
      let p = decodeURIComponent(new URL(req.url).pathname);
      if (p === "/") p = "/index.html";
      let f = path.join(root, "public", p);
      if (!path.extname(f) && fs.existsSync(f + ".html")) f += ".html";
      if (!f.startsWith(path.join(root, "public")) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        const nf = path.join(root, "public", extraEnv.__notFound || "index.html");
        return new Response(fs.readFileSync(nf), { status: extraEnv.__notFound ? 404 : 200, headers: { "content-type": "text/html" } });
      }
      return new Response(fs.readFileSync(f), { headers: { "content-type": TYPES[path.extname(f)] || "application/octet-stream" } });
    },
  };

  // ---- Mock Stripe API (every X09 plan) ----
  const PRICE_PLAN = {
    price_pilot: ["ai", "pilot"], price_commander: ["ai", "commander"], price_fleet: ["ai", "fleet"],
    price_solo: ["docs", "solo"], price_pro: ["docs", "pro"], price_business: ["docs", "business"],
  };
  const stripeCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://api.stripe.com/")) return realFetch(input, init);
    const p = url.replace("https://api.stripe.com/v1", "");
    const params = new URLSearchParams(init.body || "");
    stripeCalls.push({ method: init.method, path: p, params: Object.fromEntries(params) });
    const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (p.startsWith("/prices?")) {
      const mk = (id, name, amount, interval = "month", created = 1) => ({ id, created, unit_amount: amount, recurring: { interval }, product: { id: "prod_" + name.replace(/\W/g, ""), name, active: true } });
      return J({ has_more: false, data: [
        mk("price_pilot", "Pilot", 1200), mk("price_commander", "Commander", 2900), mk("price_fleet", "Fleet", 7900),
        mk("price_fleet_yearly", "Fleet", 79000, "year", 5),
        mk("price_solo", "X09 Docs Solo", 900), mk("price_pro", "X09 Docs Pro", 1900), mk("price_business", "X09 Docs Business", 3900),
        mk("price_other", "Something else", 500),
      ] });
    }
    const pr = p.match(/^\/prices\/(price_\w+)$/);
    if (pr) return J({ id: pr[1], product: "prod_" + pr[1] });
    if (p === "/billing_portal/configurations") return J({ id: "bpc_x09" });
    if (p === "/customers") return J({ id: "cus_test_" + Math.random().toString(36).slice(2, 8) });
    if (p === "/checkout/sessions") return J({ id: "cs_test", url: `http://localhost:${PORT}/?checkout=success&mock_price=${params.get("line_items[0][price]")}&mock_user=${params.get("client_reference_id")}` });
    if (p === "/billing_portal/sessions") return J({ id: "bps_test", url: `http://localhost:${PORT}/?portal=1` });
    const sub = p.match(/^\/subscriptions\/(.+)$/);
    if (sub && init.method === "DELETE") return J({ id: sub[1], status: "canceled" });
    if (sub) return J(globalThis.__mockSubs?.[sub[1]] || { error: { message: "no such sub" } });
    return new Response(JSON.stringify({ error: { message: "unmocked " + p } }), { status: 400 });
  };

  const env = {
    DB, ASSETS, MOCK_AI: "1",
    AI_MODEL_FAST: "fast-model", AI_MODEL_DEEP: "deep-model",
    STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_WEBHOOK_SECRET: "whsec_test",
    // Placeholders on purpose: prices are found automatically by product name (like production)
    STRIPE_PRICE_PILOT: "price_REPLACE_ME", STRIPE_PRICE_COMMANDER: "price_REPLACE_ME", STRIPE_PRICE_FLEET: "price_REPLACE_ME",
    STRIPE_PRICE_SOLO: "price_REPLACE_ME", STRIPE_PRICE_PRO: "price_REPLACE_ME", STRIPE_PRICE_BUSINESS: "price_REPLACE_ME",
    ...extraEnv,
  };

  // Test-only: activate a plan the way Stripe's webhook would
  const activate = (userId, product, plan, subId = `sub_mock_${product}`) =>
    sqlite.prepare(`INSERT INTO subscriptions (user_id, product, plan, status, stripe_subscription_id, current_period_end, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?) ON CONFLICT(user_id, product) DO UPDATE SET plan = excluded.plan, status = 'active'`)
      .run(userId, product, plan, subId, Date.now() + 30 * 864e5, Date.now());

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    // The mock checkout redirects here; simulate Stripe's webhook activating the plan
    const u = new URL(request.url);
    if (u.searchParams.get("mock_user") && PRICE_PLAN[u.searchParams.get("mock_price")]) {
      const [product, plan] = PRICE_PLAN[u.searchParams.get("mock_price")];
      activate(u.searchParams.get("mock_user"), product, plan);
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

  return { server, env, stripeCalls, sqlite, activate, PORT };
}
