## X09 shared platform (same in X09 Hub, X09 AI and X09 Docs)

All three sites run on **one X09 account system**:

| Shared piece | Where | What it does |
|---|---|---|
| Database | D1 `x09-db` | One database bound by all three Workers: accounts, sessions, profiles, plans, chats, documents |
| Sign-in | `src/core/auth.js` | Cookie `x09_sid` scoped to `x09hub.com` → sign in once, signed in on every X09 site |
| Profile | `POST /api/profile` | Name, company and profile photo, shown on every site (the "Your X09 account & plans" panel) |
| Billing | `src/core/stripe.js` | One Stripe customer per person, one subscription per product, one Customer Portal for every plan. Any site can sell any plan, and every site's webhook understands every product |
| AI | `src/core/anthropic.js` | Claude via the Anthropic API — Fast = `claude-haiku-4-5`, Deep = `claude-sonnet-5` |
| Plans | `src/core/catalog.js` | Every product, plan, price label and monthly limit |
| Look | `public/x09/` | Design system (`x09.css`), logo, fonts, physics engine (`x09-space.js`), account kit (`x09-account.js`) |

**`src/core/`, `migrations/`, `public/x09/` and `test/harness.mjs` must stay identical in all three repos.** Edit them in one repo, then copy them to the other two.

### Plans (edit `src/core/catalog.js`)

| Product | Plan | Price | Monthly limits | Stripe product name |
|---|---|---|---|---|
| X09 AI | Pilot | $12 | 700 Fast + 60 Deep | `Pilot` |
| X09 AI | Commander | $29 | 1,600 Fast + 160 Deep | `Commander` |
| X09 AI | Fleet | $79 | 4,500 Fast + 500 Deep | `Fleet` |
| X09 Docs | Solo | $9 | 40 AI drafts | `X09 Docs Solo` |
| X09 Docs | Pro | $19 | 200 AI drafts | `X09 Docs Pro` |
| X09 Docs | Business | $39 | 600 AI drafts, no X09 branding | `X09 Docs Business` |

Any active plan also includes **Ask X09** on the Hub (100 questions/month, Claude Haiku).
Claude pricing used for the limits: Haiku 4.5 $1/$5 and Sonnet 5 $2/$10 per million input/output tokens. Even a customer who
uses every message costs about half their plan price or less; typical use costs far less. X09 AI's limits were lowered from the
Llama version because Claude costs more per message.

### Secrets (set on EACH of the three Workers)
`ANTHROPIC_API_KEY` (console.anthropic.com → API keys), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

### Stripe
All six products live in the same Stripe account (names above; each with a recurring monthly price). One webhook endpoint is
enough — e.g. `https://x09hub.com/api/stripe/webhook` — with events `checkout.session.completed`,
`customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Existing endpoints on
ai./docs. keep working too (every site processes every product, and the writes are identical).

### Database migrations
`migrations/` is identical in every repo, so whichever site deploys first applies `0003_x09_shared.sql` to `x09-db`
(new profile columns, the `subscriptions` table with existing X09 AI subscriptions copied in, and the X09 Docs tables).
Anyone already signed in to X09 AI stays signed in. X09 Docs used its own `x09-docs-db` before, and accounts made there
are **not** copied over.

### Physics (public/x09/x09-space.js)
Starfield with parallax, shooting stars, and rigid-body asteroids, moons and ringed planets with collisions, spin and weak
mutual gravity. Grab and fling any body; press and hold empty space for a gravity well, then release for a shockwave;
double-click empty space to drop in a new moon. Elements marked `data-x09-solid` are solid (bodies bounce off them), and
page scroll and phone tilt push bodies around. Buttons marked `data-magnet` and cards marked `data-tilt` react with spring
physics. The Hub adds an orbit system with Newtonian gravity where you can fling the app worlds. It all turns off with the
operating system's "reduce motion" setting.
