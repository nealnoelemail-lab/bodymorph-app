-- ============================================================================
-- BodyMorph — Coach calendar events  (migration 0009)
-- Run in the Supabase SQL Editor after 0008.
--
-- BodyMorph-native events for the coach's weekly calendar (appointments, client
-- follow-up reminders, planned sessions). External Google/Outlook/personal
-- calendars merge in later via GoHighLevel — not stored here.
-- ============================================================================

create table public.coach_events (
  id         uuid        primary key default gen_random_uuid(),
  coach_id   uuid        not null references public.profiles(id) on delete cascade,
  client_id  uuid        references public.profiles(id) on delete set null,
  starts_at  timestamptz not null,
  title      text,
  type       text        not null default 'appointment',  -- appointment | followup | session
  note       text,
  created_at timestamptz not null default now()
);
create index coach_events_coach_idx on public.coach_events (coach_id, starts_at);

alter table public.coach_events enable row level security;
create policy coach_events_owner on public.coach_events
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());
