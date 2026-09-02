-- Find V2 — which queue a participant is dealt, as a setting rather than a constant.
-- ================================================================================
-- Run once in the SQL editor of the V2 project, after supabase_v2_task_limit.sql. Idempotent.
--
-- V2 shipped with one queue: three Find claims in three FIXED cells (grounded/incorrect,
-- non-grounded/correct, non-grounded/incorrect — there is deliberately no grounded/correct Find
-- task) followed by one grounded Guide task whose key alternates. That design answers a narrow
-- question well and cannot answer a wider one at all: grounding never varies within the Guide half,
-- so nothing in it estimates grounding × task type.
--
-- The second design crosses the two factors properly. Four tasks, one per cell:
--
--     Find  × Grounded        Find  × Non-grounded
--     Guide × Grounded        Guide × Non-grounded
--
-- with correctness alternating cell by cell and sitting by sitting, so every participant sees two
-- correct and two incorrect runs and no cell is stuck on one answer. Group A is text throughout and
-- group B is visual throughout, exactly as before — modality stays between-subjects, task type and
-- grounding become within-subjects.
--
-- IT RIDES WITH THE OTHER PROTOCOL FLAGS because it is the same kind of fact: read once when a run
-- starts, snapshotted into the session, never re-read mid-sitting. A participant who began under one
-- design finishes under it even if this changes while they are answering — otherwise task 4 would
-- belong to a different experiment from task 1 and nothing in the data would say so.
--
-- THE DEFAULT IS THE CROSSED DESIGN, for new projects and for existing ones that have never chosen.
-- A project already running the three-cell queue and wanting to keep it must say so in
-- Admin → Study settings; see the note at the bottom.

alter table public.pageguide_find_v2_settings
  add column if not exists queue_design text not null default 'balanced_2x2';

-- A closed vocabulary, enforced in the column. The browser maps an unknown value to the default, so
-- a typo here would silently move a study rather than fail — which is precisely the failure mode a
-- check constraint exists to prevent.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pageguide_find_v2_settings'::regclass
      and conname = 'pageguide_find_v2_settings_queue_design_check'
  ) then
    alter table public.pageguide_find_v2_settings
      add constraint pageguide_find_v2_settings_queue_design_check
      check (queue_design in ('balanced_2x2', 'legacy_find3'));
  end if;
end $$;

comment on column public.pageguide_find_v2_settings.queue_design is
  'Which queue a new sitting is dealt: balanced_2x2 (Find/Guide × grounded/non-grounded, correctness alternating) or legacy_find3 (three fixed Find cells + one grounded Guide task). Snapshotted into the session at start, never re-read mid-run. Default balanced_2x2.';

-- DROPPED FIRST, not replaced: this function returns a row type defined by its OUT parameters, and
-- `create or replace` refuses to change one ("cannot change return type of existing function").
-- Adding the fourth column therefore needs the old one gone. Safe — it takes no arguments and the
-- grant is re-issued below. Same reasoning as supabase_v2_task_limit.sql.
drop function if exists public.pageguide_find_v2_study_flags();

-- Still deliberately narrow: `select *` on this row would hand the browser the admin password hash.
create or replace function public.pageguide_find_v2_study_flags()
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds, s.queue_design
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

grant execute on function public.pageguide_find_v2_study_flags() to anon;

-- The writer. `p_queue_design` defaults to null meaning "leave it alone", so a browser still holding
-- the four-argument version keeps saving the other three settings without silently resetting the
-- design out from under a running study.
create or replace function public.save_pageguide_find_v2_flags(
  p_password text,
  p_collect_evidence boolean,
  p_collect_followup boolean,
  p_task_limit_seconds integer default null,
  p_queue_design text default null
)
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text
)
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

  if p_queue_design is not null
     and p_queue_design not in ('balanced_2x2', 'legacy_find3') then
    raise exception 'Unknown queue design %. Expected balanced_2x2 or legacy_find3.', p_queue_design;
  end if;

  -- ALIASED, because `returns table (... queue_design text)` declares an OUT parameter of that name
  -- and an unqualified reference on the right of the SET would be ambiguous between the variable and
  -- the column. The two booleans escape this only because they coalesce to a literal.
  update public.pageguide_find_v2_settings s
  set collect_evidence = coalesce(p_collect_evidence, false),
      collect_followup = coalesce(p_collect_followup, false),
      task_limit_seconds = coalesce(p_task_limit_seconds, s.task_limit_seconds),
      queue_design = coalesce(p_queue_design, s.queue_design),
      updated_at = now()
  where s.singleton = true;

  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds, s.queue_design
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

-- DROP THE FOUR-ARGUMENT VERSION. supabase_v2_task_limit.sql created
-- save_pageguide_find_v2_flags(text, boolean, boolean, integer); adding a fifth parameter with a
-- default makes an OVERLOAD rather than replacing it, and Postgres then refuses every four-argument
-- call with "function ... is not unique". The five-argument one serves those calls itself, since
-- PostgREST resolves by argument name and the fifth defaults to null.
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean, integer);

grant execute on function public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text) to anon;

-- A PROJECT MID-STUDY SHOULD NOT CHANGE DESIGN BECAUSE A MIGRATION RAN.
--
-- The column default above only applies to rows created after it; the existing singleton row is
-- backfilled to the same value by `add column ... not null default`, which means a project that has
-- already collected sittings under the three-cell queue moves to the crossed one the moment this
-- file is run. That is the intended default for a project that has not started, and the wrong thing
-- for one that has — the two halves of the data would not be comparable and nothing would say why.
--
-- So: if this project has results you intend to keep analysing under the old design, run the line
-- below as well, and switch designs deliberately in Admin → Study settings when you are ready.
--
--   update public.pageguide_find_v2_settings
--   set queue_design = 'legacy_find3', updated_at = now()
--   where singleton = true;
