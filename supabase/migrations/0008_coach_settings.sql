-- ============================================================================
-- BodyMorph — Coach settings, in-person sessions, per-client fees  (migration 0008)
-- Run in the Supabase SQL Editor after 0007.
--
-- Makes the coach's revenue real + configurable:
--   • coach_settings — the coach's own default rates (in-person $/session, base
--     consulting fee). Coach-controlled, not hardcoded.
--   • coach_sessions — a log of in-person training sessions; "actual" in-person
--     revenue = this month's logged sessions.
--   • relationships.consulting_fee — per-client consulting fee override (a coach
--     can charge different clients different amounts; falls back to the base fee).
-- ============================================================================

create table public.coach_settings (
  coach_id       uuid        primary key references public.profiles(id) on delete cascade,
  inperson_rate  numeric     not null default 75,
  consulting_fee numeric     not null default 105,
  updated_at     timestamptz not null default now()
);
alter table public.coach_settings enable row level security;
create policy coach_settings_owner on public.coach_settings
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

create table public.coach_sessions (
  id         uuid        primary key default gen_random_uuid(),
  coach_id   uuid        not null references public.profiles(id) on delete cascade,
  client_id  uuid        references public.profiles(id) on delete set null,
  day        date        not null,
  amount     numeric     not null default 0,
  note       text,
  created_at timestamptz not null default now()
);
create index coach_sessions_coach_day_idx on public.coach_sessions (coach_id, day);
alter table public.coach_sessions enable row level security;
create policy coach_sessions_owner on public.coach_sessions
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

-- Per-client consulting fee override (null = use the coach's base fee).
alter table public.relationships add column if not exists consulting_fee numeric;
