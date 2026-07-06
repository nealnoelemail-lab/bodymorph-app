-- 0015_health_summaries.sql
-- Weekly WATCH summaries (Apple Watch via HealthKit; Fitbit later). The phone computes
-- the week-over-week aggregates on-device (resting HR, HRV, active minutes/kcal,
-- distance, workout count/types) and upserts ONE compact row per user per week —
-- no raw samples ever leave the device. Surfaces only in reports:
-- the client's progress report section, the coach's client-detail weekly view,
-- and the coach's compiled weekly briefing.

create table public.health_summaries (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  week_start date        not null,               -- 7-day window start (rolling)
  data       jsonb       not null default '{}',  -- the healthInsights() summary object
  updated_at timestamptz not null default now(),
  primary key (user_id, week_start)
);

alter table public.health_summaries enable row level security;
-- Owner: full access. Coach: read-only, same is_coach_of rule as the other fitness data
-- (steps/sleep/workouts already flow to the coach — weekly aggregates ride the same rails).
create policy health_summaries_owner on public.health_summaries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy health_summaries_coach_read on public.health_summaries
  for select using (public.is_coach_of(user_id));
