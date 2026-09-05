-- Find V2 — flagging the trail's steps inside the journey.
-- ========================================================
-- Run once in the SQL editor of the V2 project, after sql/130_supabase_v2_group_chip.sql. Idempotent.
--
-- The Guide stimulus shows two accounts of the same run: the reasoning trail, which names the steps
-- the agent treated as milestones, and the View Journey, which lists every action it took. Matching
-- one to the other means holding step numbers in your head while scrolling between two cards.
--
-- With this on, the journey rows the trail accounts for carry an "important milestone" flag and the
-- fold says how many there are. It is a real manipulation and not a polish — it changes where a
-- participant looks first, and it points at the steps the agent CHOSE to narrate, which for a run
-- that misreports what it saw is exactly where the discrepancy is not. That is why it is a setting
-- rather than a constant: it can be turned off for a condition that should not have it.
--
-- ON BY DEFAULT, because the walkthrough teaches the journey by pointing at those steps, and a
-- practice screen that flags them while the real tasks do not would rehearse the wrong screen. The
-- two read the same flag, so they cannot drift.
--
-- Like the other protocol flags it is read once when a run starts and snapshotted into the session.

alter table public.pageguide_find_v2_settings
  add column if not exists flag_milestones boolean not null default true;

comment on column public.pageguide_find_v2_settings.flag_milestones is
  'Whether the Guide journey flags the steps the reasoning trail accounts for as important milestones. On by default; the walkthrough follows the same flag. Snapshotted into the session at start.';

-- DROPPED FIRST: the return type is defined by the OUT parameters and `create or replace` refuses to
-- change one. Same reasoning as the three migrations before this.
drop function if exists public.pageguide_find_v2_study_flags();

create or replace function public.pageguide_find_v2_study_flags()
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean,
  flag_milestones boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip, s.flag_milestones
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

grant execute on function public.pageguide_find_v2_study_flags() to anon;

create or replace function public.save_pageguide_find_v2_flags(
  p_password text,
  p_collect_evidence boolean,
  p_collect_followup boolean,
  p_task_limit_seconds integer default null,
  p_queue_design text default null,
  p_show_group_chip boolean default null,
  p_flag_milestones boolean default null
)
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean,
  flag_milestones boolean
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

  update public.pageguide_find_v2_settings s
  set collect_evidence = coalesce(p_collect_evidence, false),
      collect_followup = coalesce(p_collect_followup, false),
      task_limit_seconds = coalesce(p_task_limit_seconds, s.task_limit_seconds),
      queue_design = coalesce(p_queue_design, s.queue_design),
      -- Both of these coalesce to the STORED value, not to false: they are absent when the browser
      -- is older than the column, and "absent" must not read as "switch it off".
      show_group_chip = coalesce(p_show_group_chip, s.show_group_chip),
      flag_milestones = coalesce(p_flag_milestones, s.flag_milestones),
      updated_at = now()
  where s.singleton = true;

  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip, s.flag_milestones
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

-- DROP THE SIX-ARGUMENT VERSION, or the seventh parameter makes an overload and Postgres refuses
-- every six-argument call with "function ... is not unique".
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean);

grant execute on function public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean) to anon;
