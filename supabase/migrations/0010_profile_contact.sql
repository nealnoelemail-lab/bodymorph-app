-- 0010_profile_contact.sql
-- Store the client's verified email + phone on their profile row so the Coach
-- Dashboard / CRM can see and contact them alongside their name. auth.users stays
-- the source of truth; these are a synced copy the client writes on profile save.
-- Existing RLS on profiles (0001) already covers these columns — owner writes,
-- linked coach reads via is_coach_of().

alter table public.profiles add column if not exists last_name text;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists phone text;
