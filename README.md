# X09 AI

A paid, black-and-white, outer-space themed AI chat app on **Cloudflare Workers**:
accounts, synced chat history, monthly usage limits and **Stripe subscriptions** — no free tier.

```
public/                 the app (index.html, styles.css, app.js, logo.svg, favicon.svg, manifest)
src/worker.js           router
src/auth.js             accounts: signup / login / logout / delete, sessions (HttpOnly cookie)
src/stripe.js           Stripe Checkout, Customer Portal, webhook
src/chat.js             chat streaming (Workers AI), threads, usage limits
src/plans.js            ← PLANS: prices, names, monthly limits (edit here)
migrations/             D1 database schema
test/                   local test server + end-to-end API tests (npm test)
wrangler.toml           Cloudflare config
.github/workflows/      test → migrate DB → deploy on every push to main
```

## Plans (edit `src/plans.js`)

| Plan | Price | Fast msgs / mo | Deep msgs / mo |
|---|---|---|---|
| Pilot | $12 | 1,500 | 100 |
| Commander | $29 | 5,000 | 600 |
| Fleet | $79 | 15,000 | 2,000 |

Limits reset on the 1st of each month (UTC). Fast = Llama 3.1 8B (fp8-fast), Deep = Llama 3.3 70B (fp8-fast).
Worst-case AI cost if a customer uses every message: ≈ $1.60 / $6.90 / $22 per month; typical use costs a fraction of that.
If you change a price, change it **both** in `src/plans.js` (label) and on the Stripe Price (what's charged).

---

## One-time setup

### 1. Cloudflare
```bash
npm install
npx wrangler login
npx wrangler d1 create x09-db          # copy the database_id it prints
```
Paste the `database_id` into `wrangler.toml`.

### 2. Stripe
1. **Products → Add product** three times (Pilot, Commander, Fleet), each with a **recurring monthly** price ($12 / $29 / $79).
   Copy each **Price ID** (`price_...`) into `wrangler.toml` → `STRIPE_PRICE_PILOT`, `STRIPE_PRICE_COMMANDER`, `STRIPE_PRICE_FLEET`.
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
