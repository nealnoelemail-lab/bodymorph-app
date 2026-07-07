-- ============================================================================
-- BodyMorph — Coach in-app branding (migration 0016)
-- Run in the Supabase SQL Editor after 0015.
--
-- A coach may brand their clients' app experience: business name, small logo
-- (stored as a data URI — client-side resized, so no storage-RLS surgery),
-- accent color. OPTIONAL — no row = default BodyMorph branding.
--
-- Access: coach owns their row; their ACTIVE clients may read it (that's the
-- reverse direction of is_coach_of, so it gets its own policy here).
-- ============================================================================

create table public.coach_branding (
  coach_id   uuid        primary key references public.profiles(id) on delete cascade,
  brand_name text,
  logo       text,        -- data URI, kept small (~320px max) by the client
  accent     text,        -- hex color like #e8ff00
  updated_at timestamptz not null default now()
);

alter table public.coach_branding enable row level security;

create policy coach_branding_owner on public.coach_branding
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

create policy coach_branding_client_read on public.coach_branding
  for select using (
    exists (
      select 1 from public.relationships r
      where r.coach_id = coach_branding.coach_id
        and r.client_id = auth.uid()
        and r.status = 'active'
    )
  );
