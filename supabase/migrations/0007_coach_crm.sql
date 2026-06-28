-- ============================================================================
-- BodyMorph — Coach CRM: prospects + per-client invites  (migration 0007)
-- Run in the Supabase SQL Editor after 0006.
--
-- Powers the coach business dashboard: a prospecting pipeline and per-client
-- onboarding invites. A coach invites a specific person; the client completes
-- signup on their phone via the invite link and is auto-linked to the coach.
-- ============================================================================

-- ── Prospecting pipeline (coach's own leads) ────────────────────────────────
create table public.prospects (
  id         uuid        primary key default gen_random_uuid(),
  coach_id   uuid        not null references public.profiles(id) on delete cascade,
  name       text,
  email      text,
  phone      text,
  stage      text        not null default 'lead',  -- lead|contacted|trial|invited|won|lost
  source     text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index prospects_coach_idx on public.prospects (coach_id);

alter table public.prospects enable row level security;
create policy prospects_owner on public.prospects
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

-- ── Per-client onboarding invites ───────────────────────────────────────────
create table public.client_invites (
  code        text        primary key,
  coach_id    uuid        not null references public.profiles(id) on delete cascade,
  name        text,
  phone       text,
  email       text,
  intake      jsonb       not null default '{}'::jsonb,   -- {goal, focus, ...} to pre-seed the client
  status      text        not null default 'pending',     -- pending|redeemed
  redeemed_by uuid,
  created_at  timestamptz not null default now(),
  redeemed_at timestamptz
);
create index client_invites_coach_idx on public.client_invites (coach_id);

alter table public.client_invites enable row level security;
-- A coach reads/manages only their own invites. Redemption happens via the
-- SECURITY DEFINER RPC below (a client can't read an invite row directly).
create policy client_invites_owner on public.client_invites
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

-- Client: redeem a per-client invite -> link to the coach, return the intake.
create or replace function public.redeem_client_invite(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from client_invites where code = p_code;
  if inv.coach_id is null          then return json_build_object('ok', false, 'error', 'Invalid invite code'); end if;
  if inv.coach_id = auth.uid()     then return json_build_object('ok', false, 'error', 'That is your own code'); end if;

  insert into relationships(coach_id, client_id, status)
    values (inv.coach_id, auth.uid(), 'active')
    on conflict (coach_id, client_id) do update set status = 'active';

  if inv.status = 'pending' then
    update client_invites set status = 'redeemed', redeemed_by = auth.uid(), redeemed_at = now() where code = p_code;
  end if;

  return json_build_object('ok', true, 'intake', inv.intake);
end $$;

grant execute on function public.redeem_client_invite(text) to authenticated;

-- ── AI intake evaluation (coach decision-support; latest per client) ─────────
create table public.client_evaluations (
  coach_id   uuid        not null references public.profiles(id) on delete cascade,
  client_id  uuid        not null references public.profiles(id) on delete cascade,
  intake     jsonb       not null default '{}'::jsonb,   -- health, activity, nutrition, allergies, injuries, goal, timeframe
  evaluation jsonb       not null default '{}'::jsonb,   -- AI: assessment, diet, exercise, timeline
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (coach_id, client_id)
);
alter table public.client_evaluations enable row level security;
create policy client_evaluations_owner on public.client_evaluations
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());
