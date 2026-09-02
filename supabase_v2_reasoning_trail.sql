-- Find V2 — whether a Guide task shows the agent's reasoning trail.
-- =================================================================
-- Run once in the SQL editor of the V2 project, after supabase_v2_milestone_flag.sql. Idempotent.
--
-- The Guide stimulus carries two accounts of the same run. The VIEW JOURNEY is the record: every
-- action the agent took, in order, each one checkable against the page it was taken on. The
-- REASONING TRAIL is the agent's own story about that run, written afterwards — and a story is not
-- evidence. It opens "I have completed the task", names the steps it considers milestones, and says
-- nothing about the ones it would rather not discuss.
--
-- SHOWING IT PUTS THE AGENT'S CLAIM IN FRONT OF THE RECORD, twice: once in the trail and once in the
-- answer below it. A participant who reads a confident summary before opening the journey is being
-- asked to disconfirm a claim rather than to check one, and that is a different task with a
-- different error rate. It matters most for exactly the runs this study is built around — the ones
-- that finish and misdescribe what they did, where the trail is the misdescription.
--
-- So it is OFF by default. The journey, the two page states and the answer remain; the trail is
-- available as a setting for a condition that wants it. The walkthrough reads the same flag, so
-- practice cannot rehearse a screen the study then withholds.
--
-- Read once when a run starts and snapshotted into the session, like every other protocol flag.

alter table public.pageguide_find_v2_settings
  add column if not exists show_reasoning_trail boolean not null default false;

comment on column public.pageguide_find_v2_settings.show_reasoning_trail is
  'Whether a Guide task shows the agent''s reasoning trail above its answer. Off by default: the trail is the agent''s own account of the run, not evidence about it, and it frames the judgement before the journey is read. Snapshotted into the session at start.';

-- DROPPED FIRST: the return type is defined by the OUT parameters and `create or replace` refuses to
-- change one. Same as the three migrations before this.
drop function if exists public.pageguide_find_v2_study_flags();

create or replace function public.pageguide_find_v2_study_flags()
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean,
  flag_milestones boolean,
  show_reasoning_trail boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip, s.flag_milestones, s.show_reasoning_trail
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
  p_flag_milestones boolean default null,
  p_show_reasoning_trail boolean default null
)
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean,
  flag_milestones boolean,
  show_reasoning_trail boolean
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
      -- All three coalesce to the STORED value, not to false: they are absent when the browser is
      -- older than the column, and "absent" must not read as "switch it off".
      show_group_chip = coalesce(p_show_group_chip, s.show_group_chip),
      flag_milestones = coalesce(p_flag_milestones, s.flag_milestones),
      show_reasoning_trail = coalesce(p_show_reasoning_trail, s.show_reasoning_trail),
      updated_at = now()
  where s.singleton = true;

  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip, s.flag_milestones, s.show_reasoning_trail
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

-- DROP THE SEVEN-ARGUMENT VERSION, or the eighth parameter makes an overload and Postgres refuses
-- every seven-argument call with "function ... is not unique".
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean);

grant execute on function public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean, boolean) to anon;
