-- 0013_at_risk.sql
-- At-risk resolution workflow on the coach↔client relationship:
--   • client_type — 'consulting' (default) or 'app_only'; a downgrade outcome flips this
--     and the dashboard counts app_only separately (they don't carry the consulting fee).
--   • risk_resolved_at / risk_outcome / risk_note — set when the coach resolves an
--     at-risk flag from the Overview queue. A resolved client is suppressed from the
--     "needs attention" list for 14 days; if they're still quiet after that, they resurface.
--     risk_outcome: 'back_on_track' | 'app_only' | 'lost' (lost also sets status='ended').

alter table public.relationships add column if not exists client_type text not null default 'consulting';
alter table public.relationships add column if not exists risk_resolved_at timestamptz;
alter table public.relationships add column if not exists risk_outcome text;
alter table public.relationships add column if not exists risk_note text;
