-- ============================================================================
-- BodyMorph / Evogenesis — Sync tables  (migration 0002)
-- The per-user data that currently lives in the browser's localStorage, mapped
-- to normalized Postgres tables so it's durable, cross-device, and QUERYABLE by
-- the Coach Dashboard. Run in the Supabase SQL Editor after 0001.
--
-- Design follows 0001 exactly:
--   • Every table is owner-scoped by user_id -> public.profiles(id).
--   • RLS: the owner has full access; an active coach can READ (is_coach_of).
--   • updated_at on every row for last-write-wins on singletons.
--
-- SYNC CONTRACT (see memory: bodymorph-sync-strategy — offline-first + smart-merge):
--   • DATED tables  -> natural key (user_id, day): merge is a conflict-free upsert.
--   • COLLECTION tables -> (user_id, client_key): client_key is a STABLE id the
--       app derives from record content, so re-syncing is idempotent (no dupes).
--   • SINGLETON tables -> one row per user, whole-row last-write-wins via updated_at.
-- ============================================================================

-- Reusable RLS pair: owner full access + coach read-only. Applied per table below.
-- (Postgres has no "apply policy to many tables" syntax, so we repeat the pattern.)

-- ── DATED TIME-SERIES (one row per user per day) ────────────────────────────

create table public.body_entries (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  day        date        not null,
  weight     numeric,
  body_fat   numeric,
  notes      text,
  photos     jsonb       not null default '[]'::jsonb,   -- progress-photo refs
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table public.step_entries (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  day        date        not null,
  steps      int         not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table public.sleep_entries (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  day        date        not null,
  hours      numeric,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table public.hydration_days (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  day        date        not null,
  cups       int         not null default 0,
  goal       int         not null default 8,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Food log: per-day slots kept as jsonb (items keep their app shape), PLUS daily
-- macro totals promoted to columns so the dashboard can chart nutrition adherence.
create table public.food_log_days (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  day        date        not null,
  breakfast  jsonb,
  lunch      jsonb,
  dinner     jsonb,
  snacks     jsonb,
  cal        int         not null default 0,
  protein    int         not null default 0,
  carbs      int         not null default 0,
  fats       int         not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ── COLLECTIONS (rows keyed by a stable client_key per user) ────────────────

-- Workout logs: app stores them keyed by exercise; we flatten to one row per
-- logged exercise-session. client_key = `${day}|${exercise}|${idx}`.
create table public.workout_logs (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  client_key text        not null,
  day        date        not null,
  exercise   text        not null,
  sets       jsonb,                                   -- [{ weight, reps }]
  top_weight numeric,
  top_reps   int,
  pr         boolean     not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, client_key)
);
create index workout_logs_user_day_idx  on public.workout_logs (user_id, day);
create index workout_logs_user_exer_idx on public.workout_logs (user_id, exercise);

create table public.cardio_sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.profiles(id) on delete cascade,
  client_key   text        not null,                  -- `${day}|${type}|${minutes}|${idx}`
  day          date        not null,
  type         text,
  activity     text,
  minutes      int,
  calories     int,
  from_workout boolean     not null default false,
  updated_at   timestamptz not null default now(),
  unique (user_id, client_key)
);
create index cardio_sessions_user_day_idx on public.cardio_sessions (user_id, day);

-- Supplements & peptides already carry their own app id -> client_key = that id.
create table public.supplements (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  client_key text        not null,
  name       text,
  timing     jsonb,                                   -- [string]
  days       jsonb,                                   -- [int|string]
  dose       text,
  notes      text,
  updated_at timestamptz not null default now(),
  unique (user_id, client_key)
);
create index supplements_user_idx on public.supplements (user_id);

create table public.peptides (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  client_key text        not null,
  name       text,
  timing     jsonb,
  days       jsonb,
  dose       text,
  notes      text,
  updated_at timestamptz not null default now(),
  unique (user_id, client_key)
);
create index peptides_user_idx on public.peptides (user_id);

-- Saved-meals catalog: app stores keyed by meal id/name -> client_key = that key.
create table public.meals_catalog (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  client_key text        not null,
  description text,
  cal        int,
  protein    int,
  carbs      int,
  fats       int,
  brand      text,
  per100     jsonb,
  verified   boolean,
  usda_desc  text,
  updated_at timestamptz not null default now(),
  unique (user_id, client_key)
);
create index meals_catalog_user_idx on public.meals_catalog (user_id);

-- ── SINGLETONS (one row per user, whole-row last-write-wins) ────────────────

create table public.rewards (
  user_id    uuid        primary key references public.profiles(id) on delete cascade,
  coins      int         not null default 0,
  earned_ids jsonb       not null default '[]'::jsonb,
  medals     jsonb       not null default '[]'::jsonb,
  stats      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.meal_plans (
  user_id    uuid        primary key references public.profiles(id) on delete cascade,
  plan       jsonb,                                   -- last AI-generated meal plan
  updated_at timestamptz not null default now()
);

create table public.nutrition_goals (
  user_id         uuid        primary key references public.profiles(id) on delete cascade,
  goal_weight     text,
  weekly_pace     text,
  allergies       text,
  allergens       jsonb,
  preferred_brands text,
  updated_at      timestamptz not null default now()
);

-- Grab-bag of per-user app config the dashboard doesn't need to aggregate.
create table public.user_settings (
  user_id          uuid        primary key references public.profiles(id) on delete cascade,
  diet_pref        text,
  cardio_plan      jsonb,                             -- weekday idx -> [type]
  stretch_plan     jsonb,                             -- weekday idx -> [routine]
  stretch_routines jsonb,                             -- routine id -> [pose]
  video_overrides  jsonb,                             -- exercise -> videoId
  todo_checked     jsonb,                             -- "date:section:id" -> bool
  coach_voice      jsonb,                             -- { id, name }
  updated_at       timestamptz not null default now()
);

-- Voice-coach memory (feeds the Coach Dashboard's auto weekly summary later).
create table public.coach_conversations (
  user_id    uuid        primary key references public.profiles(id) on delete cascade,
  day        date,
  messages   jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.coach_summaries (
  user_id    uuid        primary key references public.profiles(id) on delete cascade,
  entries    jsonb       not null default '[]'::jsonb,   -- rolling ~7-day summaries
  updated_at timestamptz not null default now()
);

-- ── ROW-LEVEL SECURITY ──────────────────────────────────────────────────────
-- Same pattern for every table: owner full access; active coach read-only.
do $$
declare t text;
begin
  foreach t in array array[
    'body_entries','step_entries','sleep_entries','hydration_days','food_log_days',
    'workout_logs','cardio_sessions','supplements','peptides','meals_catalog',
    'rewards','meal_plans','nutrition_goals','user_settings',
    'coach_conversations','coach_summaries'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format(
      'create policy %I on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid());',
      t || '_owner', t);
    execute format(
      'create policy %I on public.%I for select using (public.is_coach_of(user_id));',
      t || '_coach_read', t);
  end loop;
end $$;

-- ============================================================================
-- NEXT: the client sync layer (src) — make Store backend-aware (local-first
-- write-through + debounced cloud push) and teach hydrate() to pull + smart-merge
-- on login. Prove one table end-to-end before wiring all of them.
-- ============================================================================
