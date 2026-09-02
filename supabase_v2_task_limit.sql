-- Find V2 — the per-task time limit, as a setting rather than a constant.
-- ======================================================================
-- Run once in the SQL editor of the V2 project, after supabase_v2_flags.sql. Idempotent.
--
-- The limit was 3 minutes, hard-coded in app/instrument.js and shared with the Find questions
-- through window.TaskTimer so the two instruments could not drift apart. It is now 2 minutes, and a
-- number a researcher can change — piloting is where you find out whether a task needs more time or
-- less, and re-deploying the site to answer that is the wrong loop.
--
-- It rides with collect_evidence and collect_followup because it is the same KIND of fact: part of
-- the protocol, read once when a run starts, and never re-read mid-session. A participant who began
-- with two minutes keeps two minutes even if this changes while they are answering, or task 4 would
-- be a different task from task 3 of the same sitting and nothing in the data would say so.

alter table public.pageguide_find_v2_settings
  add column if not exists task_limit_seconds integer not null default 120;

-- Bounds, not preferences. Under 30s nobody can read the answer, let alone check it; over 15 minutes
-- the "limit" stops being one and the grace period it drives becomes meaningless. Enforced in the
-- column so a hand-made request cannot set a limit the browser would refuse.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pageguide_find_v2_settings'::regclass
      and conname = 'pageguide_find_v2_settings_task_limit_seconds_check'
  ) then
    alter table public.pageguide_find_v2_settings
      add constraint pageguide_find_v2_settings_task_limit_seconds_check
      check (task_limit_seconds between 30 and 900);
  end if;
end $$;

comment on column public.pageguide_find_v2_settings.task_limit_seconds is
  'Seconds a participant gets per task before the hard cutoff and its 5-second grace. Snapshotted into the session at start, never re-read mid-run. Default 120.';

-- DROPPED FIRST, not replaced. This function already returns (collect_evidence, collect_followup),
-- and `create or replace` refuses to change a function's return type — "cannot change return type of
-- existing function ... Row type defined by OUT parameters is different". Adding the third column
-- therefore needs the old one gone. Safe: it takes no arguments, nothing holds a reference to it
-- across statements, and the grant is re-issued below.
drop function if exists public.pageguide_find_v2_study_flags();

-- Still deliberately narrow: `select *` on this row would hand the browser the admin password hash.
create or replace function public.pageguide_find_v2_study_flags()
returns table (collect_evidence boolean, collect_followup boolean, task_limit_seconds integer)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

grant execute on function public.pageguide_find_v2_study_flags() to anon;

-- The writer. `p_task_limit_seconds` defaults to null meaning "leave it alone", so a browser loaded
-- before this migration keeps saving the two booleans without silently resetting the limit.
create or replace function public.save_pageguide_find_v2_flags(
  p_password text,
  p_collect_evidence boolean,
  p_collect_followup boolean,
  p_task_limit_seconds integer default null
)
returns table (collect_evidence boolean, collect_followup boolean, task_limit_seconds integer)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if p_task_limit_seconds is not null
     and (p_task_limit_seconds < 30 or p_task_limit_seconds > 900) then
    raise exception 'The per-task limit must be between 30 and 900 seconds (got %).', p_task_limit_seconds;
  end if;

  -- ALIASED, because `returns table (... task_limit_seconds integer)` declares an OUT parameter of
  -- that name, and an unqualified reference on the right of the SET is then ambiguous between the
  -- variable and the column ("it could refer to either a PL/pgSQL variable or a table column").
  -- The two booleans do not hit this only because they coalesce to a literal rather than to a column.
  update public.pageguide_find_v2_settings s
  set collect_evidence = coalesce(p_collect_evidence, false),
      collect_followup = coalesce(p_collect_followup, false),
      task_limit_seconds = coalesce(p_task_limit_seconds, s.task_limit_seconds),
      updated_at = now()
  where s.singleton = true;

  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

-- DROP THE THREE-ARGUMENT VERSION. supabase_v2_flags.sql created
-- save_pageguide_find_v2_flags(text, boolean, boolean); adding a fourth parameter with a default
-- makes an overload rather than replacing it, and Postgres then refuses every three-argument call
-- with "function ... is not unique". The four-argument one serves those calls itself, since
-- PostgREST resolves by argument name and the fourth defaults to null.
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean);

grant execute on function public.save_pageguide_find_v2_flags(text, boolean, boolean, integer) to anon;

-- Existing projects were running three minutes; move them to the new default explicitly rather than
-- leaving the column default to decide, so a project migrated today and one created tomorrow agree.
update public.pageguide_find_v2_settings
set task_limit_seconds = 120, updated_at = now()
where singleton = true and task_limit_seconds = 180;
