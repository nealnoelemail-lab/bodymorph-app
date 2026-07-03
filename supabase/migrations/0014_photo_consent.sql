-- 0014_photo_consent.sql
-- Progress-photo privacy: coach access to a client's photos becomes OPT-IN.
-- Clients photograph themselves in underwear — the coach must never see those
-- unless the client explicitly turns sharing on. Enforced at the DATABASE level
-- (storage RLS), not just hidden in the UI:
--   • relationships.share_photos (default FALSE) — the client's consent flag.
--   • progress_photos_coach_read policy now requires share_photos = true
--     (replaces the 0006 policy that let any active coach read any client's photos).
--   • set_photo_sharing(bool) — SECURITY DEFINER RPC so the client can flip ONLY
--     this flag on their own relationship row (table RLS otherwise allows updates
--     only by the coach, and we do NOT want clients editing fee/status columns).

alter table public.relationships add column if not exists share_photos boolean not null default false;

drop policy if exists progress_photos_coach_read on storage.objects;
create policy progress_photos_coach_read on storage.objects
  for select
  using (
    bucket_id = 'progress-photos' and exists (
      select 1 from public.relationships r
      where r.client_id = ((storage.foldername(name))[1])::uuid
        and r.coach_id  = auth.uid()
        and r.status    = 'active'
        and r.share_photos = true
    )
  );

create or replace function public.set_photo_sharing(p_share boolean)
returns void language sql security definer set search_path = public as $$
  update relationships set share_photos = p_share where client_id = auth.uid();
$$;
grant execute on function public.set_photo_sharing(boolean) to authenticated;
