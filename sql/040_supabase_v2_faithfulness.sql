-- Find V2 — Guide runs: what the agent CLAIMED, stored separately from what it DID.
-- ================================================================================
-- Run once in the SQL editor of the V2 project. Idempotent.
--
-- `agent_completed` answers the participant's question — did the agent finish the
-- job? It is not enough on its own to classify a run, because two very different
-- items share the answer "No":
--
--   FALSE SUCCESS  — the answer claims the task is done; the trajectory shows it
--                    is not. The item the Guide condition exists to measure: the
--                    answer reads clean, and only checking the run reveals it.
--   HONEST FAILURE — the answer opens "I could not complete the task", and indeed
--                    it did not. The correct verdict is also No, but a participant
--                    can give it from the first sentence without looking at the
--                    page, the journey or the trail. It measures reading.
--
-- So the claim is stored as its own fact. With both, the classification is exact
-- rather than inferred from prose at render time:
--
--   claims_completion AND     agent_completed -> CORRECT   (faithful success)
--   claims_completion AND NOT agent_completed -> INCORRECT (false success)
--   NOT claims_completion                     -> honest failure, excluded

alter table public.pageguide_guide_v2_tasks
  add column if not exists claims_completion boolean;

comment on column public.pageguide_guide_v2_tasks.claims_completion is
  'Does the agent''s own answer claim the task was completed? Combined with agent_completed this separates a false success (the study item) from an honest failure (excluded).';

-- The Admin panel writes it alongside the other judgements.
create or replace function public.save_pageguide_guide_v2_meta(
  p_password text,
  p_id text,
  p_task_style text,
  p_agent_completed boolean,
  p_in_study boolean,
  p_task_index integer,
  p_claims_completion boolean default null
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

  update public.pageguide_guide_v2_tasks
  set task_style        = coalesce(p_task_style, task_style),
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

grant execute on function public.save_pageguide_guide_v2_meta(text, text, text, boolean, boolean, integer, boolean) to anon;
