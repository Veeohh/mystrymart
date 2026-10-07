// Lets the page confirm a payment after Stripe sends the buyer back.
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const id = event.queryStringParameters && event.queryStringParameters.session_id;
  if (!id) return { statusCode: 400, body: "Missing session_id" };
  try {
    const s = await stripe.checkout.sessions.retrieve(id);
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: s.status, email: s.customer_details && s.customer_details.email, bag: s.metadata && s.metadata.bag }) };
  } catch (err) {
    return { statusCode: 404, body: JSON.stringify({ status: "unknown" }) };
  }
};
