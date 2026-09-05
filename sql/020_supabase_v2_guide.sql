-- Find V2 — the Guide task.
-- ========================
-- Run once in the Supabase SQL editor of the V2 project (zlezbekyiwomtwdcnsge), AFTER
-- sql/000_supabase_v2_init.sql and sql/010_supabase_v2_flags.sql. Idempotent: re-running changes nothing and does
-- not reset anything an admin has already authored.
--
-- V2 began Find-only. `pageguide_guide_v2_tasks` was created ahead of the work and never filled, so
-- it is extended in place rather than replaced — that keeps its anon read grant, its policy, and the
-- existing save_pageguide_guide_v2_task / pageguide_guide_v2_admin_results functions working.


-- ── The trajectory, in the shape the viewer already reads ───────────────────
-- app/stimulus.js is a port of the extension's trajectory viewer and reads
-- arms.{grounding,nongrounding}.{steps, answer, trail}. The V1 project's
-- study_guide_trajectories rows are already in exactly that shape, so storing
-- them verbatim means a migrated run renders with no translation layer between
-- the recorder and the participant — which is the whole reason the viewer was
-- ported rather than rewritten.
alter table public.pageguide_guide_v2_tasks
  add column if not exists arms jsonb not null default '{}'::jsonb;

-- THE ANSWER KEY for "Did the agent complete the task?".
--
-- NULL means nobody has judged this run yet, and a task with a null key must
-- never enter the study: the verdict would be scored against nothing. It is a
-- separate column from the agent's own summary on purpose — a run that opens
-- "I have completed the task" while its journey shows it failing is the most
-- interesting case in the set, and deriving the key from the summary text would
-- score exactly those backwards.
alter table public.pageguide_guide_v2_tasks
  add column if not exists agent_completed boolean;

-- Where this row came from, so a re-migration can be told from hand authoring.
alter table public.pageguide_guide_v2_tasks
  add column if not exists source_trajectory_id text;

comment on column public.pageguide_guide_v2_tasks.trajectory is
  'UNUSED by the Find V2 guide flow, which reads `arms` instead. Kept because save_pageguide_guide_v2_task still writes it.';
comment on column public.pageguide_guide_v2_tasks.answer_variants is
  'UNUSED by the Find V2 guide flow. Guide correctness is the authored `agent_completed` key, and the arm is always grounded for now.';
comment on column public.pageguide_guide_v2_tasks.correctness_mode is
  'UNUSED by the Find V2 guide flow. See agent_completed.';


-- ── A verdict of NONE, for Guide too ────────────────────────────────────────
-- The three-minute limit is a hard cutoff on both task types, so an unanswered
-- Guide task needs the same third outcome Find has: not a "No", and not a wrong
-- answer, but a question that ran out of time.
alter table public.pageguide_guide_v2_results
  add column if not exists verdict_timed_out boolean not null default false;

alter table public.pageguide_guide_v2_results
  alter column answer_correct_snapshot drop not null;

comment on column public.pageguide_guide_v2_results.verdict_timed_out is
  'True when the 3-minute limit and its 5-second grace both elapsed with no Yes/No chosen. guide_answer_correct is null on these rows; exclude them from accuracy rather than counting them as wrong.';


-- ── The Admin panel's writer for the two authored fields ────────────────────
-- Password-checked the same way every other V2 write is. It writes ONLY the
-- fields a researcher judges — style, the answer key, whether it is live, and
-- the order — and never the trajectory, which comes from the migration.
create or replace function public.save_pageguide_guide_v2_meta(
  p_password text,
  p_id text,
  p_task_style text,
  p_agent_completed boolean,
  p_in_study boolean,
  p_task_index integer
)
returns setof public.pageguide_guide_v2_tasks
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if p_task_style is not null and p_task_style not in ('guide_text', 'guide_visual') then
    raise exception 'task_style must be guide_text or guide_visual.';
  end if;

  -- A live task with no answer key would be scored against nothing, and a live
  -- task with no style cannot be dealt to either group. Refused here rather than
  -- in the browser: browser validation is guidance, not a boundary.
  if coalesce(p_in_study, false) and p_agent_completed is null then
    raise exception 'Set “did the agent complete the task?” before putting this task in the study.';
  end if;

  update public.pageguide_guide_v2_tasks
  set task_style      = coalesce(p_task_style, task_style),
      agent_completed = p_agent_completed,
      in_study        = coalesce(p_in_study, false),
      task_index      = coalesce(p_task_index, task_index),
      updated_at      = now()
  where id = p_id;

  if not found then
    raise exception 'No Guide V2 task with id %', p_id;
  end if;

  return query select * from public.pageguide_guide_v2_tasks where id = p_id;
end;
$$;

grant execute on function public.save_pageguide_guide_v2_meta(text, text, text, boolean, boolean, integer) to anon;

-- The Admin panel reads tasks with a plain select: the "anon reads Guide V2 tasks"
-- policy in sql/000_supabase_v2_init.sql is `using (true)`, so not-yet-live rows are
-- already visible the same way not-yet-live Find claims are (listAllClaims).
-- Nothing privileged is needed to LIST them; only save_pageguide_guide_v2_meta
-- above is password-checked, because only writing needs to be.
