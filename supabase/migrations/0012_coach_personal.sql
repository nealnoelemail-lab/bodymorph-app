-- 0012_coach_personal.sql
-- Coach "Settings" page needs two more per-coach fields on coach_settings:
--   • monthly_goal — the coach's monthly financial target (they set/change it anytime;
--     the Financials page can show progress toward it).
--   • voice_id — the coach's own (eventually cloned) voice, so their clients hear
--     coaching in THEIR voice. Nullable until they record/select one.
-- Personal identity (name / phone / email) already lives on public.profiles (0010);
-- the coach edits their own profiles row (existing owner RLS covers it).

alter table public.coach_settings add column if not exists monthly_goal numeric not null default 0;
alter table public.coach_settings add column if not exists voice_id text;
