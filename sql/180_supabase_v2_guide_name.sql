-- Find V2 — the Guide task's name and instruction become editable from Admin.
-- ==========================================================================
-- Run once in the SQL editor of the V2 project, after sql/040_supabase_v2_faithfulness.sql. Idempotent.
--
-- THE EDIT PATH ONLY WENT ONE WAY. Every screen in the app reads `goal` and `title` live — the
-- welcome screen's queue, the task picker, the Admin list, and the task itself, which deliberately
-- re-reads the record per task so a renamed run reaches a participant mid-sitting rather than
-- showing them the wording that was snapshotted when their queue was dealt. So Supabase → app has
-- always worked. What did not exist was the other direction: `save_pageguide_guide_v2_meta` wrote
-- the four judged fields and nothing else, so the only way to fix a task's wording was the SQL
-- editor, and the panel that shows the name had no way to change it.
--
-- WHY THE INSTRUCTION MATTERS MORE THAN THE NAME. `goal` is not a label. It is the sentence shown
-- to the participant as "the task the agent was given", and their entire verdict is "did it do
-- THAT?" — a typo in it does not make the panel untidy, it changes what is being asked. `title` is
-- the short name the Admin lists and the picker use, and falls back to the goal when it is blank.
--
-- REFUSED WHEN EMPTY ON A LIVE TASK, for that reason: a study item whose instruction is blank is
-- unanswerable, and the failure would show up as a participant staring at an empty card rather than
-- as a rejected write.

create or replace function public.save_pageguide_guide_v2_meta(
  p_password text,
  p_id text,
  p_task_style text,
  p_agent_completed boolean,
  p_in_study boolean,
  p_task_index integer,
  p_claims_completion boolean default null,
  p_title text default null,
  p_goal text default null
)
returns setof public.pageguide_guide_v2_tasks
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_goal  text := nullif(btrim(coalesce(p_goal, '')), '');
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if p_task_style is not null and p_task_style not in ('guide_text', 'guide_visual') then
    raise exception 'task_style must be guide_text or guide_visual.';
  end if;

  if coalesce(p_in_study, false) and p_agent_completed is null then
    raise exception 'Set "did the agent complete the task?" before putting this task in the study.';
  end if;

  -- An honest failure is answerable without opening the page, so it is not a study
  -- item. Refused here rather than in the browser, so it cannot be published by a
  -- stale tab or a hand-made request.
  if coalesce(p_in_study, false)
     and p_claims_completion is not null and p_claims_completion = false then
    raise exception 'This run admits it did not finish, so the verdict is readable from its first sentence. Honest failures are not used in the study.';
  end if;

  -- The instruction is the question the participant answers. A live task cannot lose it — and
  -- checked against what the row would hold AFTER this write, not against what was passed, so
  -- publishing a task without retyping its goal is still allowed.
  if coalesce(p_in_study, false)
     and coalesce(v_goal, (select goal from public.pageguide_guide_v2_tasks where id = p_id)) is null then
    raise exception 'This task has no instruction. Fill in "the task the agent was given" before putting it in the study.';
  end if;

  update public.pageguide_guide_v2_tasks
  -- COALESCED TO THE STORED VALUE, like task_style: a caller that sends no name is a caller with no
  -- opinion about the name, never one asking for it to be cleared. Blanking a name is therefore not
  -- expressible here, which is the right trade — a name is cleared by mistake far more often than
  -- on purpose, and the goal falls back to the title and the title to the id.
  set task_style        = coalesce(p_task_style, task_style),
      title             = coalesce(v_title, title),
      goal              = coalesce(v_goal, goal),
      agent_completed   = p_agent_completed,
      claims_completion = coalesce(p_claims_completion, claims_completion),
      in_study          = coalesce(p_in_study, false),
      task_index        = coalesce(p_task_index, task_index),
      updated_at        = now()
  where id = p_id;

  if not found then
    raise exception 'No Guide V2 task with id %', p_id;
  end if;

  return query select * from public.pageguide_guide_v2_tasks where id = p_id;
end;
$$;

-- DROP EVERY EARLIER ARITY. The new parameters are optional, so the old signatures would survive as
-- separate overloads and PostgREST would refuse every call with "function is not unique".
drop function if exists public.save_pageguide_guide_v2_meta(text, text, text, boolean, boolean, integer);
drop function if exists public.save_pageguide_guide_v2_meta(text, text, text, boolean, boolean, integer, boolean);

grant execute on function public.save_pageguide_guide_v2_meta(text, text, text, boolean, boolean, integer, boolean, text, text) to anon;

notify pgrst, 'reload schema';
