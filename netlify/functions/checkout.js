// Creates a Stripe Embedded Checkout session for one $25 Mystry Mart bag.
// The secret key comes from the STRIPE_SECRET_KEY environment variable
// set in Netlify (Site settings > Environment variables). Never hard-code it.
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_CENTS = 2500; // price is fixed here on the server, not trusted from the browser
const VALID_CODE = /^[A-D][1-5]$/;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Bad JSON" }; }
  const { code, artist = "", name = "", email = "" } = body;
  if (!VALID_CODE.test(code)) return { statusCode: 400, body: "Unknown bag" };

  const origin = event.headers.origin || process.env.URL;
  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PRICE_CENTS,
          product_data: {
            name: `Mystry Mart mystery bag ${code}`,
            description: artist ? `A sealed mystery bag from ${String(artist).slice(0, 80)}` : undefined,
          },
        },
      }],
      customer_email: email || undefined,
      metadata: { bag: code, artist: String(artist).slice(0, 200), name: String(name).slice(0, 200) },
      // Every order ships, so Stripe always asks for an address
      shipping_address_collection: { allowed_countries: ["US"] },
      return_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}#shop`,
    });
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientSecret: session.client_secret }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Could not start checkout" };
  }
};
