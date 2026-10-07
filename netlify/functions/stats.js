// Running total for the "Paid directly to artists" counter on the About page.
// = ARTIST_PAYOUT_BASE (what you've paid artists from the machines; update it in
//   Netlify > Environment variables whenever you like)
// + 50% of every completed online bag sale, read straight from Stripe.
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const BASE = Number(process.env.ARTIST_PAYOUT_BASE || 213487);
const ARTIST_SHARE = 0.5;

exports.handler = async () => {
  let onlineCents = 0;
  try {
    for await (const s of stripe.checkout.sessions.list({ status: "complete", limit: 100 })) {
      if (s.metadata && s.metadata.bag && s.payment_status === "paid") onlineCents += s.amount_subtotal || 0;
    }
  } catch (err) {
    console.error(err);
  }
  const paid = Math.floor(BASE + (onlineCents * ARTIST_SHARE) / 100);
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      // Netlify's CDN keeps the number for 5 minutes so Stripe isn't asked on every visit
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
    body: JSON.stringify({ paid }),
  };
};
