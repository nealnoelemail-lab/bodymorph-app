// Creates a Stripe Billing Portal session so the user can manage / cancel their
// subscription and update payment. Auth required. Powers the Settings menu items.
import { stripe, admin, getUser, appUrl } from "./_lib/server.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const { data: row } = await admin
      .from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
    if (!row?.stripe_customer_id) return res.status(400).json({ error: "No billing account yet" });

    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${appUrl(req)}/`,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-portal-session:", e);
    return res.status(500).json({ error: e.message });
  }
}
