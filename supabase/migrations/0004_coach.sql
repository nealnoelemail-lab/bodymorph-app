-- ============================================================================
-- BodyMorph — Coach access + coach↔client linking  (migration 0004)
-- Run in the Supabase SQL Editor after 0003.
--
-- Security model:
--   • `profiles.role` is server-controlled — a user can NEVER self-promote.
--     A trigger reverts any direct role change; role flips to 'coach' ONLY
--     inside redeem_coach_access() (a SECURITY DEFINER fn that sets a txn flag
--     the trigger honors).
--   • Coaches are minted only via single-use, revocable, audited ACCESS CODES
--     you mint by hand into coach_access_codes.
--   • Clients link to a coach by redeeming the coach's reusable INVITE code;
--     redemption goes through a SECURITY DEFINER fn because a client cannot
--     read a coach's row directly (RLS blocks it).
-- ============================================================================

-- ── Platform-issued coach access codes (you mint these) ─────────────────────
create table public.coach_access_codes (
  code       text        primary key,
  email      text,                              -- optional: bind to one email
  max_uses   int         not null default 1,    -- single-use by default
  uses       int         not null default 0,
  expires_at timestamptz,
  disabled   boolean     not null default false,-- revoke anytime
  created_at timestamptz not null default now()
);
-- Audit trail of who redeemed what.
create table public.coach_access_log (
  id          uuid        primary key default gen_random_uuid(),
  code        text,
  user_id     uuid,
  redeemed_at timestamptz not null default now()
);
-- A coach's reusable client-invite code.
create table public.coach_invites (
  coach_id   uuid        not null references public.profiles(id) on delete cascade,
  code       text        not null unique,
  created_at timestamptz not null default now(),
  primary key (coach_id)
);
create index coach_invites_code_idx on public.coach_invites (code);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Access codes + log: NO policies -> only service-role / SECURITY DEFINER fns
-- can touch them. Invites: a coach reads/manages only their own row.
alter table public.coach_access_codes enable row level security;
alter table public.coach_access_log  enable row level security;
alter table public.coach_invites     enable row level security;
create policy coach_invites_owner on public.coach_invites
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

-- ── Role lockdown ────────────────────────────────────────────────────────────
-- Revert any direct change to role; only the redeem RPC (which sets the txn flag)
-- may change it.
create or replace function public.guard_role()
returns trigger language plpgsql as $$
begin
  if NEW.role is distinct from OLD.role
     and coalesce(current_setting('app.role_change_ok', true), '') <> 'on' then
    NEW.role := OLD.role;
  end if;
  return NEW;
end $$;
create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_role();

-- ── RPCs ─────────────────────────────────────────────────────────────────────
-- Become a coach by redeeming a platform access code.
create or replace function public.redeem_coach_access(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare c record; uemail text;
begin
  select * into c from coach_access_codes where code = p_code;
  if not found        then return json_build_object('ok', false, 'error', 'Invalid code'); end if;
  if c.disabled       then return json_build_object('ok', false, 'error', 'Code disabled'); end if;
  if c.expires_at is not null and c.expires_at < now()
                      then return json_build_object('ok', false, 'error', 'Code expired'); end if;
  if c.uses >= c.max_uses
                      then return json_build_object('ok', false, 'error', 'Code already used'); end if;
  if c.email is not null then
    uemail := auth.jwt() ->> 'email';
    if uemail is null or lower(uemail) <> lower(c.email) then
      return json_build_object('ok', false, 'error', 'Code is bound to a different email');
    end if;
  end if;

  update coach_access_codes set uses = uses + 1 where code = p_code;
  insert into coach_access_log(code, user_id) values (p_code, auth.uid());
  perform set_config('app.role_change_ok', 'on', true);
  update profiles set role = 'coach', updated_at = now() where id = auth.uid();
  return json_build_object('ok', true);
end $$;

-- Coach: get (or create) my reusable client-invite code.
create or replace function public.generate_coach_invite()
returns text language plpgsql security definer set search_path = public as $$
declare existing text; newcode text;
begin
  if (select role from profiles where id = auth.uid()) <> 'coach' then
    raise exception 'Only coaches can generate invites';
  end if;
  select code into existing from coach_invites where coach_id = auth.uid();
  if existing is not null then return existing; end if;
  newcode := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into coach_invites(coach_id, code) values (auth.uid(), newcode);
  return newcode;
end $$;

-- Client: link to a coach by their invite code.
create or replace function public.redeem_coach_invite(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select coach_id into cid from coach_invites where code = upper(p_code);
  if cid is null        then return json_build_object('ok', false, 'error', 'Invalid invite code'); end if;
  if cid = auth.uid()   then return json_build_object('ok', false, 'error', 'That is your own code'); end if;
  insert into relationships(coach_id, client_id, status)
    values (cid, auth.uid(), 'active')
    on conflict (coach_id, client_id) do update set status = 'active';
  return json_build_object('ok', true);
end $$;

grant execute on function public.redeem_coach_access(text)  to authenticated;
grant execute on function public.generate_coach_invite()    to authenticated;
grant execute on function public.redeem_coach_invite(text)  to authenticated;

-- ============================================================================
-- To mint a test coach code:   insert into coach_access_codes(code) values ('COACH-TEST');
-- NEXT: Stripe Connect coach onboarding/split builds on these relationships.
-- ============================================================================
