-- ============================================================================
-- BodyMorph — Gym equipment profile + photos  (migration 0019)
-- Run in the Supabase SQL Editor.
--
-- Gym orientation: the client photographs each machine in their gym (front and side,
-- voice coach narrating), and every exercise in their program then shows the actual
-- machine they will walk up to. "Pec deck" means nothing to someone who has never
-- been shown one.
--
-- Two things live here: the identified equipment list (small, synced like any other
-- profile data) and the photos themselves (bytes, private bucket, signed URLs).
-- Same split and the same ownership rule as progress photos in 0006.
-- ============================================================================

-- ── The equipment profile ───────────────────────────────────────────────────
-- One row per unique piece of equipment. Deduped by type: a second leg press is not
-- a second row. `variant` marks a genuinely different machine in the same family
-- (a curved sprint treadmill beside a motorised one) — matching uses base_id, so a
-- variant can never split a gym's capability in two.
create table if not exists public.gym_equipment (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  base_id      text not null,              -- 'leg-press', 'cable-crossover' — the matching key
  equip_id     text not null,              -- 'leg-press' or 'treadmill/curved'
  label        text,                       -- what the coach called it out loud
  photo_front  text,                       -- storage path, not bytes
  photo_side   text,
  confidence   text,                       -- high | medium | low, from the vision pass
  confirmed    boolean not null default false,  -- the client agreed with the ID
  gym_name     text,                       -- so a second gym doesn't overwrite the first
  created_at   timestamptz not null default now(),
  unique (user_id, equip_id, gym_name)
);

create index if not exists gym_equipment_user on public.gym_equipment (user_id, base_id);

alter table public.gym_equipment enable row level security;

drop policy if exists gym_equipment_owner on public.gym_equipment;
create policy gym_equipment_owner on public.gym_equipment
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- A coach can see which equipment a client has — it changes what they can prescribe.
drop policy if exists gym_equipment_coach_read on public.gym_equipment;
create policy gym_equipment_coach_read on public.gym_equipment
  for select
  using (public.is_coach_of(user_id));

-- ── The photos ──────────────────────────────────────────────────────────────
-- Private bucket. Paths are "{user_id}/{equip_id}/{front|side}.jpg", so the first
-- segment identifies the owner exactly as it does for progress photos.
insert into storage.buckets (id, name, public)
values ('gym-equipment', 'gym-equipment', false)
on conflict (id) do nothing;

drop policy if exists gym_equipment_photos_owner on storage.objects;
create policy gym_equipment_photos_owner on storage.objects
  for all
  using (bucket_id = 'gym-equipment' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'gym-equipment' and (storage.foldername(name))[1] = auth.uid()::text);

-- Coach read-only, same rule as the table above. NOTE: gym photos are not body
-- photos — there is no consent gate here, because a picture of a leg press is not
-- personal in the way a progress photo is.
drop policy if exists gym_equipment_photos_coach_read on storage.objects;
create policy gym_equipment_photos_coach_read on storage.objects
  for select
  using (bucket_id = 'gym-equipment' and public.is_coach_of( ((storage.foldername(name))[1])::uuid ));
