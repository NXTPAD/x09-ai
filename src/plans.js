// ============================================================
//  X09 AI plans — edit prices/limits here.
//  `price` is only the label shown in the app. The amount customers
//  are actually charged is set on the matching Stripe Price, whose ID
//  goes in the env var named by `priceEnv` (see wrangler.toml / README).
// ============================================================
export const PLANS = {
  pilot: {
    name: "Pilot",
    price: "$12",
    interval: "month",
    fast: 1500, // Fast-mode messages per calendar month
    deep: 100, //  Deep-mode messages per calendar month
    priceEnv: "STRIPE_PRICE_PILOT",
    blurb: "For everyday missions.",
  },
  commander: {
    name: "Commander",
    price: "$29",
    interval: "month",
    fast: 5000,
    deep: 600,
    priceEnv: "STRIPE_PRICE_COMMANDER",
    blurb: "For power users and pros.",
    featured: true,
  },
  fleet: {
    name: "Fleet",
    price: "$79",
    interval: "month",
    fast: 15000,
    deep: 2000,
    priceEnv: "STRIPE_PRICE_FLEET",
    blurb: "For heavy, all-day use.",
  },
};

export const PLAN_ORDER = ["pilot", "commander", "fleet"];

// Subscription states that keep access on (past_due = Stripe is retrying the card)
export const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function planForPriceId(env, priceId) {
  for (const key of PLAN_ORDER) if (env[PLANS[key].priceEnv] === priceId) return key;
  return null;
}

export function publicPlans() {
  return PLAN_ORDER.map((key) => {
    const p = PLANS[key];
    return { key, name: p.name, price: p.price, interval: p.interval, fast: p.fast, deep: p.deep, blurb: p.blurb, featured: !!p.featured };
  });
}
