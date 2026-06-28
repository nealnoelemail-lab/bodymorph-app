// Stripe webhook — the ONLY writer of subscription entitlement. Verifies the
// Stripe signature, then mirrors subscription status into Supabase via the
// service-role client (bypasses RLS, so the browser can't forge it).
import { stripe, admin, readRawBody } from "./_lib/server.js";

// Disable Vercel's body parser so we can verify the raw payload signature.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("webhook signature:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        if (s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          if (!sub.metadata?.user_id && s.client_reference_id) {
            sub.metadata = { ...sub.metadata, user_id: s.client_reference_id };
          }
          await upsertFromSub(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await upsertFromSub(event.data.object);
        break;
      case "invoice.paid":
      case "invoice.payment_failed": {
        const inv = event.data.object;
        if (inv.subscription) await upsertFromSub(await stripe.subscriptions.retrieve(inv.subscription));
        break;
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("webhook handler:", e);
    return res.status(500).json({ error: e.message });
  }
}

// Resolve the BodyMorph user for a subscription (metadata first, else by customer)
// and upsert the mirrored status.
async function upsertFromSub(sub) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  let userId = sub.metadata?.user_id;
  if (!userId && customerId) {
    const { data } = await admin.from("subscriptions").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
    userId = data?.user_id;
  }
  if (!userId) { console.warn("webhook: could not resolve user for sub", sub.id); return; }

  await admin.from("subscriptions").upsert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: sub.items?.data?.[0]?.price?.id || null,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    plan: "app_only",
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
}
