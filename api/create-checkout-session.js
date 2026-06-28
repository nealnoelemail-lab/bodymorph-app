// Creates a Stripe Checkout Session for the $25/mo subscription and returns its
// URL for the client to redirect to. Auth required (Supabase Bearer token).
import { stripe, admin, getUser, appUrl } from "./_lib/server.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    // Find or create this user's Stripe customer (stored on the subscriptions row).
    const { data: row } = await admin
      .from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
    let customerId = row?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
      customerId = customer.id;
      await admin.from("subscriptions").upsert(
        { user_id: user.id, stripe_customer_id: customerId }, { onConflict: "user_id" });
    }

    const base = appUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${base}/?checkout=success`,
      cancel_url: `${base}/?checkout=cancel`,
      client_reference_id: user.id,
      subscription_data: { metadata: { user_id: user.id } },
      allow_promotion_codes: true,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session:", e);
    return res.status(500).json({ error: e.message });
  }
}
