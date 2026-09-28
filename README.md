# X09 AI

A paid, black-and-white, outer-space themed AI chat app on **Cloudflare Workers**, powered by **Claude (Anthropic API)**:
synced chat history, monthly usage limits and **Stripe subscriptions**, with no free tier. It uses the shared **X09 account**: one sign-in, profile and bill across X09 Hub, X09 AI and X09 Docs.

**Read `X09-SHARED.md` first.** It covers the shared account, database, billing, AI, plans and physics.

```
public/                 the app (index.html, styles.css, app.js, logo.svg, favicon.svg, manifest)
src/worker.js           router
src/core/               shared X09 core: accounts, Stripe, Claude client, plans catalog
src/chat.js             chat streaming (Claude), threads, usage limits
migrations/             D1 database schema
test/                   local test server + end-to-end API tests (npm test)
wrangler.toml           Cloudflare config
.github/workflows/      test → migrate DB → deploy on every push to main
```

## Plans
See `X09-SHARED.md` (edit `src/core/catalog.js`). Fast = Claude Haiku 4.5, Deep = Claude Sonnet 5.

If you change a price, change it **both** in `src/core/catalog.js` (label) and on the Stripe Price (what's charged).

---

## One-time setup

### 1. Cloudflare
```bash
npm install
npx wrangler login
```
Create a D1 database named `x09-db` (dashboard: Storage & Databases → D1 → Create, or `npx wrangler d1 create x09-db`).
The GitHub deploy looks it up by name and fills in the ID automatically (and creates it if it's missing).
Only if you deploy by hand do you need to paste its `database_id` into `wrangler.toml`.

### 2. Stripe
1. **Products → Add product** three times (Pilot, Commander, Fleet), each with a **recurring monthly** price ($12 / $29 / $79).
   Name them exactly **Pilot**, **Commander** and **Fleet** — the app finds their monthly prices automatically.
   (Optional: pin specific prices by putting their `price_...` IDs in `wrangler.toml`.)
2. **Developers → API keys**: copy the **Secret key** (`sk_test_...` while testing, `sk_live_...` when live).
3. **Developers → Webhooks → Add endpoint**
   - URL: `https://<your-domain>/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (`whsec_...`).
4. **Settings → Billing → Customer portal**: turn it on, allow *cancel* and *switch plans* (add all three products). This is what "Manage billing" / "Change plan" opens.

### 3. GitHub → auto-deploy
Repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template, **plus add permission Account → D1 → Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages overview (right sidebar) |
| `ANTHROPIC_API_KEY` | `sk-ant-...` from console.anthropic.com |
| `STRIPE_SECRET_KEY` | `sk_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |

Push to `main`. The workflow runs the tests, applies database migrations, uploads the Stripe secrets and deploys.
(Without GitHub: `npm run db:migrate`, `npx wrangler secret put STRIPE_SECRET_KEY`, `npx wrangler secret put STRIPE_WEBHOOK_SECRET`, `npm run deploy`.)

### 4. Test a payment
With `sk_test_` keys, subscribe using card `4242 4242 4242 4242`, any future date, any CVC. The plan activates within seconds (via the webhook). Switch to live keys + live price IDs when ready.

---

## How it works
- Visitors land straight in the app. Sending a message asks them to **create an account**, then **pick a plan** → Stripe Checkout → back in the app with the plan active and their message restored.
- Passwords are hashed with PBKDF2-SHA256 (100k iterations, per-user salt). Sessions are random tokens stored hashed; cookie is HttpOnly + Secure + SameSite=Lax, 30 days.
- Cross-site POSTs are rejected; the Stripe webhook is signature-verified (5-min tolerance).
- Chats are stored per account in D1 and follow the user across devices.
- Usage is counted atomically per month per mode; a failed AI call refunds the message.
- Cancel/failed-payment → Stripe webhook → access removed automatically (`past_due` keeps access while Stripe retries the card).

## Local testing
`npm test` runs 22 end-to-end API checks (signup, paywall, checkout, signed webhooks, streaming, limits, cancellation, privacy) with an in-memory database, mock AI and mock Stripe — no accounts needed.
`npm run test:server` starts that same mock environment at http://localhost:8787 to click through the app.

## Good next steps
- Password reset emails (needs an email provider such as Resend or Postmark).
- Cloudflare Turnstile on signup to stop bot signups.
- Annual plans (add yearly Stripe prices + entries in `src/plans.js`).
- Terms of Service and Privacy Policy pages (Stripe requires these for live payments).
