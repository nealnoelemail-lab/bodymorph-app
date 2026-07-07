-- ============================================================================
-- BodyMorph — In-app coach↔client messaging (migration 0017)
-- Run in the Supabase SQL Editor after 0016.
--
-- One thread per (coach, client) pair. Both parties read the thread; each may
-- only send as themselves, and only while the relationship is ACTIVE. The
-- recipient may mark messages read; a trigger makes everything else immutable
-- (read_at is the only column an UPDATE can actually change).
-- ============================================================================

create table public.messages (
  id         uuid        primary key default gen_random_uuid(),
  coach_id   uuid        not null references public.profiles(id) on delete cascade,
  client_id  uuid        not null references public.profiles(id) on delete cascade,
  sender     text        not null check (sender in ('coach','client')),
  body       text        not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index messages_thread_idx on public.messages (coach_id, client_id, created_at);
create index messages_client_idx on public.messages (client_id, created_at);

alter table public.messages enable row level security;

-- Read: you're a party to the thread, and the relationship is active.
create policy messages_read on public.messages
  for select using (
    (coach_id = auth.uid() or client_id = auth.uid())
    and exists (
      select 1 from public.relationships r
      where r.coach_id = messages.coach_id
        and r.client_id = messages.client_id
        and r.status = 'active'
    )
  );

-- Send: only as yourself, only into your own active thread.
create policy messages_send on public.messages
  for insert with check (
    ((sender = 'coach' and coach_id = auth.uid()) or (sender = 'client' and client_id = auth.uid()))
    and exists (
      select 1 from public.relationships r
      where r.coach_id = messages.coach_id
        and r.client_id = messages.client_id
        and r.status = 'active'
    )
  );

-- Mark read: only the RECIPIENT of a message may update it (trigger below
-- guarantees read_at is the only thing that can actually change).
create policy messages_mark_read on public.messages
  for update using (
    (sender = 'coach' and client_id = auth.uid()) or (sender = 'client' and coach_id = auth.uid())
  ) with check (
    (sender = 'coach' and client_id = auth.uid()) or (sender = 'client' and coach_id = auth.uid())
  );

-- Immutability: an UPDATE may only set read_at. Everything else snaps back.
create or replace function public.messages_guard_update()
returns trigger language plpgsql as $$
begin
  NEW.id         := OLD.id;
  NEW.coach_id   := OLD.coach_id;
  NEW.client_id  := OLD.client_id;
  NEW.sender     := OLD.sender;
  NEW.body       := OLD.body;
  NEW.created_at := OLD.created_at;
  return NEW;
end $$;
create trigger messages_guard before update on public.messages
  for each row execute function public.messages_guard_update();

-- Live delivery (the app also polls as a fallback, so if this line errors on
-- your project it's safe to skip it).
alter publication supabase_realtime add table public.messages;
