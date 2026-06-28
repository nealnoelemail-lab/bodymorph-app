-- ============================================================================
-- BodyMorph — Billing: subscriptions  (migration 0003)
-- Subscription state mirrored from Stripe. Run in the Supabase SQL Editor after 0002.
--
-- Trust model: rows are written ONLY by the Stripe webhook via the service-role
-- key (server-side, bypasses RLS). The client may READ its own status but can
-- never insert/update it — so entitlement can't be forged from the browser.
-- (This is the paywall foundation; the Stripe Connect coach-split comes later.)
-- ============================================================================

create table public.subscriptions (
  user_id                uuid        primary key references public.profiles(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text,        -- active | trialing | past_due | canceled | incomplete | incomplete_expired
  price_id               text,
  plan                   text,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);
-- Webhook resolves the user from the Stripe customer id -> index it.
create index subscriptions_customer_idx on public.subscriptions (stripe_customer_id);

-- ── ROW-LEVEL SECURITY ──────────────────────────────────────────────────────
-- SELECT only: the owner reads their own status; an active coach reads a client's.
-- No insert/update/delete policies -> only the service-role server can write.
alter table public.subscriptions enable row level security;
create policy subscriptions_read on public.subscriptions
  for select using (user_id = auth.uid() or public.is_coach_of(user_id));

-- ============================================================================
-- NEXT: Stripe Connect (coach onboarding + invite-code coach↔client link +
-- destination-charge split / application fee) — the collect-and-split phase.
-- ============================================================================
