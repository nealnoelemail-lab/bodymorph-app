-- ============================================================================
-- BodyMorph / Evogenesis — Foundation schema  (migration 0001)
-- Multi-tenant, RLS-isolated, designed to scale (Postgres on Supabase).
-- Run this in the Supabase SQL Editor once the project exists.
--
-- Design principles baked in (per the agreed scaling plan):
--   • Multi-tenant isolation via Row-Level Security (coaches/clinics see ONLY
--     their own clients) — enforced at the database, not the app.
--   • Indexed from day one; dated high-volume tables (logs) are partition-ready.
--   • Additive growth — add tables/indexes later without rewriting this.
-- ============================================================================

-- Roles a user can hold across both editions (BodyMorph + Evogenesis).
create type user_role as enum ('client', 'coach', 'clinician', 'admin');

-- ── PROFILES ────────────────────────────────────────────────────────────────
-- One row per authenticated user. Extends Supabase auth.users.
create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  role           user_role   not null default 'client',
  first_name     text,
  last_name      text,
  gender         text,
  goal           text,
  focus          text,
  diet_pref      text,
  carb_level     text,
  body_fat       numeric,
  weight         numeric,
  height_in      numeric,
  age            int,
  activity_level text,
  fitness_level  text,
  training_days  int[],
  session_time   int,
  -- Fields we haven't normalized yet live here (keeps migration light; promote later).
  extra          jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── RELATIONSHIPS ───────────────────────────────────────────────────────────
-- Coach/clinician ↔ client links. THE core of multi-tenancy + RLS.
create table public.relationships (
  id          uuid        primary key default gen_random_uuid(),
  coach_id    uuid        not null references public.profiles(id) on delete cascade,
  client_id   uuid        not null references public.profiles(id) on delete cascade,
  status      text        not null default 'active',   -- active | invited | inactive
  invite_code text,
  created_at  timestamptz not null default now(),
  unique (coach_id, client_id)
);
create index relationships_coach_idx  on public.relationships (coach_id);
create index relationships_client_idx on public.relationships (client_id);

-- Helper: is the current user an active coach of the given client?
create or replace function public.is_coach_of(target uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.relationships r
    where r.client_id = target
      and r.coach_id  = auth.uid()
      and r.status    = 'active'
  );
$$;

-- ── DAILY METRICS ───────────────────────────────────────────────────────────
-- Template for dated per-user data: one row per user per day (steps/sleep/water).
-- High-volume + dated → the pattern future log tables follow; partition-ready by date.
create table public.daily_metrics (
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  day         date        not null,
  steps       int,
  sleep_hours numeric,
  water_cups  int,
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

-- ── ROW-LEVEL SECURITY ──────────────────────────────────────────────────────
alter table public.profiles      enable row level security;
alter table public.relationships enable row level security;
alter table public.daily_metrics enable row level security;

-- Profiles: a user sees/edits their own; a coach can read their clients'.
create policy profiles_read   on public.profiles for select using (id = auth.uid() or public.is_coach_of(id));
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());
create policy profiles_update on public.profiles for update using (id = auth.uid());

-- Relationships: the coach or the client in the row can see it; the coach manages it.
create policy rel_read   on public.relationships for select using (coach_id = auth.uid() or client_id = auth.uid());
create policy rel_manage on public.relationships for all    using (coach_id = auth.uid()) with check (coach_id = auth.uid());

-- Daily metrics: a user owns their rows; a coach can read their clients'.
create policy metrics_read  on public.daily_metrics for select using (user_id = auth.uid() or public.is_coach_of(user_id));
create policy metrics_write on public.daily_metrics for all    using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── AUTO-PROVISION PROFILE ON SIGNUP ────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- NEXT (migration 0002): the remaining sync tables — workout_logs, body_entries,
-- cardio_sessions, food_log, meal_plans, supplements/peptides, nutrition_goals,
-- coach_conversations/summaries — each following the same owner+coach RLS pattern.
-- ============================================================================
