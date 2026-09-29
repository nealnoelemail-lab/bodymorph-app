-- ============================================================================
-- BodyMorph — Daily calorie burn, measured and estimated  (migration 0020)
-- Run in the Supabase SQL Editor.
--
-- Apple writes resting energy ONLY while the watch is on the wrist, so recorded
-- burn silently omits every hour it spent charging. The app bridges that gap on
-- device — the resting floor for unworn hours, and movement credited from measured
-- distance for anyone with no watch at all. That bridge currently exists only in
-- memory, recomputed from HealthKit each time the app opens.
--
-- Which is fine for today's number and useless for a report. A coach looking at a
-- 90-day trend, or asking "why was Tuesday low", needs the day as it was — and
-- HealthKit's hourly detail is not something you can go back and re-derive cheaply
-- once the day is gone. So each day is stored once, as computed.
--
-- MEASURED AND ESTIMATED ARE KEPT APART, permanently. Nothing downstream is allowed
-- to present the total without being able to say how much of it was actually
-- observed. That is the whole reason the bridge is defensible.
-- ============================================================================

create table if not exists public.daily_burn (
  user_id       uuid    not null references public.profiles(id) on delete cascade,
  day           date    not null,

  -- What Apple actually recorded.
  active_kcal   integer not null default 0,   -- movement the watch credited
  resting_kcal  integer not null default 0,   -- basal, only while worn

  -- What the app filled in, and never mixed with the above.
  active_est    integer not null default 0,   -- from MEASURED distance, uncredited hours only
  resting_est   integer not null default 0,   -- the BMR floor for hours nobody was watching

  -- The sum, stored rather than derived. If the bridge is ever retuned, history must
  -- still read the way it read on the day — the same reason voice_usage stores the
  -- rate card that priced each turn instead of recomputing from today's prices.
  total_kcal    integer not null default 0,

  untracked_min integer not null default 0,   -- how long the watch was off, for "why is this low"
  est_source    text,                         -- 'observed' (their own watch rate) | 'formula' (Mifflin-St Jeor)

  updated_at    timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists daily_burn_user_day on public.daily_burn (user_id, day desc);

alter table public.daily_burn enable row level security;

-- Same rails as every other fitness figure: the client owns it, their coach may read
-- it. Steps, sleep and workouts already flow to the coach; burn is the same class of
-- data and is what Net Calories is built on, so a coach without it is guessing.
drop policy if exists daily_burn_owner on public.daily_burn;
create policy daily_burn_owner on public.daily_burn
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists daily_burn_coach_read on public.daily_burn;
create policy daily_burn_coach_read on public.daily_burn
  for select using (public.is_coach_of(user_id));

-- NOTE FOR ANYONE PRUNING LATER: rows here are history and are never deleted
-- backwards. Reports need an unbroken series; a gap reads as a day of no activity
-- rather than a day nobody recorded, which is exactly the lie this table exists to
-- stop telling.
