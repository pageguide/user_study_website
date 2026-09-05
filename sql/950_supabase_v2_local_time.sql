-- Find V2 — reading the result timestamps in Alabama local time.
-- ==============================================================
-- Run in the SQL editor of the V2 project whenever you want it. Idempotent, and it changes NO data.
--
-- NOTHING IS WRONG WITH WHAT IS STORED. `created_at` is `timestamptz not null default now()`, which
-- records an absolute instant — the moment the row was written, independent of anybody's clock. The
-- Supabase table editor renders those instants in UTC, which is why a session you ran at 3:15pm
-- reads 20:15. The number is right; the display is in a different zone from the one you were in.
--
-- DO NOT "FIX" THIS BY STORING LOCAL TIME. Changing the column to `timestamp` (no zone) would drop
-- the offset and make every row ambiguous: 01:30 on a fall-back night happens twice, and a row
-- written from a laptop in another zone would silently claim to be Central. The instant is the fact
-- worth keeping. What is missing is a convenient way to READ it, which is all this file adds.
--
-- 'America/Chicago', NOT 'CST'. Alabama is Central, and Central is CST (UTC-6) in winter and CDT
-- (UTC-5) in summer — your September rows are CDT. A fixed 'CST' would be an hour off for most of
-- the study. The named zone applies whichever was in force on the day, including across the
-- changeover on 1 November 2026, so a session recorded either side of it reads correctly.

-- ── The views ────────────────────────────────────────────────────────────────────────────────────
-- Every column of the results table, plus the local-time reading of created_at. Open these in the
-- table editor instead of the tables themselves when you want wall-clock times.
--
-- A VIEW RATHER THAN A GENERATED COLUMN, and not by preference: `timestamptz at time zone 'zone'`
-- is STABLE, not IMMUTABLE — its answer depends on the timezone database, which gets updated — and
-- Postgres refuses a generated column whose expression is not immutable.

create or replace view public.pageguide_find_v2_results_local as
  select r.*,
         (r.created_at at time zone 'America/Chicago') as created_at_central,
         to_char(r.created_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI:SS') as created_at_central_text,
         to_char(r.created_at at time zone 'America/Chicago', 'Dy DD Mon YYYY, HH12:MI AM') as created_at_central_pretty
  from public.pageguide_find_v2_results r;

comment on view public.pageguide_find_v2_results_local is
  'pageguide_find_v2_results with created_at also rendered in America/Chicago (Alabama) local time. The stored column is unchanged and still authoritative; these are a reading of it.';

create or replace view public.pageguide_guide_v2_results_local as
  select r.*,
         (r.created_at at time zone 'America/Chicago') as created_at_central,
         to_char(r.created_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI:SS') as created_at_central_text,
         to_char(r.created_at at time zone 'America/Chicago', 'Dy DD Mon YYYY, HH12:MI AM') as created_at_central_pretty
  from public.pageguide_guide_v2_results r;

comment on view public.pageguide_guide_v2_results_local is
  'pageguide_guide_v2_results with created_at also rendered in America/Chicago (Alabama) local time. The stored column is unchanged and still authoritative; these are a reading of it.';

-- NO GRANT TO anon, deliberately, and this is the important line in the file. These views carry
-- participant result rows, and the anon key is served to every visitor in app/find_v2_config.js —
-- granting select here would publish the results table to anyone who opened the site. The table
-- editor and the SQL editor use the service role and can read them already; the site reads results
-- through the password-gated function it always has.
revoke all on public.pageguide_find_v2_results_local from anon, authenticated;
revoke all on public.pageguide_guide_v2_results_local from anon, authenticated;

-- ── If you would rather the whole editor spoke Central ───────────────────────────────────────────
-- The rendering above is per-view. The SQL editor's own display zone is a session setting, so this
-- makes every timestamptz in a query read as Central for the rest of that editor session — including
-- the plain tables, with no view involved. It resets when the session ends, and it changes nothing
-- about what is stored.
--
--   set timezone = 'America/Chicago';
--   select created_at, participant_id from public.pageguide_find_v2_results order by created_at desc limit 20;
--
-- To make it the default for every new session on this database, and for the table editor:
--
--   alter database postgres set timezone = 'America/Chicago';
--
-- That one is safe for the same reason the rest of this file is: it is a DISPLAY setting. Rows keep
-- their instants, and a query that compares or sorts on created_at gives the same answer either way.
