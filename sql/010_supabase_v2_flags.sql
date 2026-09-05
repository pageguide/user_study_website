-- Find V2 — study protocol flags, and room for a timed-out verdict.
-- ================================================================
-- Run this once in the Supabase SQL editor of the Find V2 project, AFTER
-- sql/000_supabase_v2_init.sql. It is idempotent: re-running it changes nothing and
-- does not reset a flag an admin has already set.
--
-- Two things happen here.
--
-- 1. The Admin panel gains two switches — "ask participants to pick evidence"
--    and "ask the task follow-up". They live in the settings singleton so they
--    apply to every participant on every machine, rather than to whichever
--    browser the researcher happened to open Admin in. BOTH DEFAULT TO FALSE:
--    the default protocol is the verdict alone, and that default is enforced
--    here rather than in JavaScript, so a client that fails to read them still
--    runs the intended study.
--
-- 2. The results table learns to store a verdict of NONE. The three-minute
--    timer is a hard cutoff now: at 00:00 the participant is given five more
--    seconds to answer Yes or No, and a task that reaches the end of those is
--    submitted unanswered. "Unanswered" is a third outcome, not a No, so the
--    verdict columns become nullable and a flag says why they are null.


-- ── The two protocol flags ──────────────────────────────────────────────────
-- The settings table stays private: no anon grant, read only through the
-- SECURITY DEFINER function below, which returns the two booleans and nothing
-- else. The admin password hash and the assignment counter never leave it.
alter table public.pageguide_find_v2_settings
  add column if not exists collect_evidence boolean not null default false;
alter table public.pageguide_find_v2_settings
  add column if not exists collect_followup boolean not null default false;

-- What the welcome screen reads before it builds a queue. Anon-executable, and
-- deliberately narrow: `select *` on the settings row would hand the browser
-- the password hash.
create or replace function public.pageguide_find_v2_study_flags()
returns table (collect_evidence boolean, collect_followup boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.collect_evidence, s.collect_followup
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

grant execute on function public.pageguide_find_v2_study_flags() to anon;

-- The Admin panel's writer. Password-checked the same way every other V2 write
-- is; browser-side validation is guidance, not an authorization boundary.
create or replace function public.save_pageguide_find_v2_flags(
  p_password text,
  p_collect_evidence boolean,
  p_collect_followup boolean
)
returns table (collect_evidence boolean, collect_followup boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  update public.pageguide_find_v2_settings
  set collect_evidence = coalesce(p_collect_evidence, false),
      collect_followup = coalesce(p_collect_followup, false),
      updated_at = now()
  where singleton = true;

  return query
    select s.collect_evidence, s.collect_followup
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

grant execute on function public.save_pageguide_find_v2_flags(text, boolean, boolean) to anon;


-- ── A verdict of NONE ───────────────────────────────────────────────────────
-- participant_verdict and verdict_correct were NOT NULL, which made a
-- timed-out task impossible to store at all. NULL now means "the timer ran out
-- before a choice was made" — an outcome distinct from both Yes and No, which
-- must not be collapsed into either.
alter table public.pageguide_find_v2_results
  alter column participant_verdict drop not null;
alter table public.pageguide_find_v2_results
  alter column verdict_correct drop not null;

-- So a null verdict is provably a timeout rather than a client bug or a
-- half-written row, and so timed-out tasks can be taken out of an accuracy
-- denominator with one predicate.
alter table public.pageguide_find_v2_results
  add column if not exists verdict_timed_out boolean not null default false;

comment on column public.pageguide_find_v2_results.verdict_timed_out is
  'True when the 3-minute limit and its 5-second grace both elapsed with no Yes/No chosen. participant_verdict and verdict_correct are null on these rows; exclude them from accuracy rather than counting them as wrong.';
