-- ============================================================================
-- BodyMorph — Progress photos in Storage  (migration 0006)
-- Run in the Supabase SQL Editor after 0005.
--
-- A PRIVATE bucket for body/progress photos. Paths are "{user_id}/{date}/{angle}.jpg",
-- so the first path segment identifies the owner. The app stores only the path in
-- body_entries.photos (small + syncable); bytes live here and render via signed URLs.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('progress-photos', 'progress-photos', false)
on conflict (id) do nothing;

-- Owner: full access to their own folder ({user_id}/...).
create policy progress_photos_owner on storage.objects
  for all
  using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Coach: read-only access to an active client's photos (same is_coach_of() rule).
create policy progress_photos_coach_read on storage.objects
  for select
  using (bucket_id = 'progress-photos' and public.is_coach_of( ((storage.foldername(name))[1])::uuid ));
