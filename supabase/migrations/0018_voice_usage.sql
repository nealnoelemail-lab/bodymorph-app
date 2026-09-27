-- 0018 — Voice engine cost metering.
--
-- Neal is trialling OpenAI's speech-to-speech coach and needs the REAL per-client
-- running cost before it reaches paying clients at $29/month. Audio output alone is
-- $64 per million tokens (~7.7c per minute the coach talks), so this is the number
-- the price point lives or dies on.
--
-- One row per conversational turn, written from the API's own usage report. Raw token
-- counts are stored ALONGSIDE the computed cost and the rate card that priced it, so
-- history can be recomputed if a rate changes or was wrong — without re-running a
-- month of conversations.

create table if not exists public.voice_usage (
  id              bigserial primary key,
  user_id         uuid references auth.users(id) on delete cascade,
  session_id      text,
  engine          text not null default 'openai-realtime',
  model           text,
  rate_card       text,                 -- e.g. 'gpt-realtime@2026-09-26'
  text_in         integer not null default 0,
  audio_in        integer not null default 0,
  text_out        integer not null default 0,
  audio_out       integer not null default 0,
  cached_text_in  integer not null default 0,
  cached_audio_in integer not null default 0,
  cost_usd        numeric(12,6) not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists voice_usage_user_day on public.voice_usage (user_id, created_at desc);

alter table public.voice_usage enable row level security;

-- A client may write and read only their own usage. Costs are the client's own data;
-- nobody gets to read anyone else's.
drop policy if exists voice_usage_insert_own on public.voice_usage;
create policy voice_usage_insert_own on public.voice_usage
  for insert with check (auth.uid() = user_id);

drop policy if exists voice_usage_select_own on public.voice_usage;
create policy voice_usage_select_own on public.voice_usage
  for select using (auth.uid() = user_id);

-- Convenience roll-up for reading the trial: per user, per day.
create or replace view public.voice_usage_daily as
  select
    user_id,
    date_trunc('day', created_at)::date      as day,
    count(*)                                  as turns,
    sum(cost_usd)                             as cost_usd,
    round(sum(audio_out) / 1200.0, 2)         as coach_minutes,   -- 1200 audio tokens = 1 min spoken
    round(sum(audio_in)  /  600.0, 2)         as client_minutes   --  600 audio tokens = 1 min heard
  from public.voice_usage
  group by user_id, date_trunc('day', created_at);
