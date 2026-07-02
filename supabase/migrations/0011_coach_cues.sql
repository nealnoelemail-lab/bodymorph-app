-- 0011_coach_cues.sql
-- Coach-authored form cues: the coach writes (or edits) the exact teaching points the
-- VOICE COACH speaks to a specific client for a given exercise. These BEAT the cues
-- auto-extracted from a pinned video's description on the client's device — the coach
-- is the authority on their own teaching.
-- Coach: full read/write on rows they own (and only for clients actually linked to
-- them). Client: read-only on cues addressed to them.

create table if not exists public.coach_cues (
  coach_id   uuid not null references auth.users(id) on delete cascade,
  client_id  uuid not null references auth.users(id) on delete cascade,
  exercise   text not null,
  cues       text not null default '',
  updated_at timestamptz not null default now(),
  primary key (coach_id, client_id, exercise)
);

alter table public.coach_cues enable row level security;

create policy coach_cues_coach_rw on public.coach_cues
  for all
  using (coach_id = auth.uid())
  with check (coach_id = auth.uid() and public.is_coach_of(client_id));

create policy coach_cues_client_read on public.coach_cues
  for select
  using (client_id = auth.uid());
