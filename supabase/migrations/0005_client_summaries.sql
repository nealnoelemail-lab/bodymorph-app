-- ============================================================================
-- BodyMorph — Coach Dashboard: cached AI weekly briefings  (migration 0005)
-- Run in the Supabase SQL Editor after 0004.
--
-- One row per (coach, client): the latest Claude-generated coach-facing summary.
-- Cached so we don't regenerate (and re-pay) on every dashboard view.
-- ============================================================================

create table public.client_summaries (
  coach_id     uuid        not null references public.profiles(id) on delete cascade,
  client_id    uuid        not null references public.profiles(id) on delete cascade,
  summary      text,
  generated_at timestamptz not null default now(),
  primary key (coach_id, client_id)
);

-- A coach reads/writes only their own clients' summaries.
alter table public.client_summaries enable row level security;
create policy client_summaries_owner on public.client_summaries
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());
