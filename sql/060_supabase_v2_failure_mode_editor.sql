-- Find V2 — let Admin classify WHY a Guide run is incorrect.
-- =========================================================
-- Run once in the SQL editor of the V2 project, after sql/030_supabase_v2_arms.sql. Idempotent.
--
-- `guide_ground_truth.problems` decides the failure mode app/find_v2_guide_key.js derives, which
-- decides the Admin board, the per-mode accuracy split and `failure_mode` on every result row. Until
-- now nothing in this repo could WRITE it: app/welcome.js has no control for problems[], the V2
-- inspector renders it read-only, and the only writer was save_pageguide_guide_v2_task — the
-- recorder's own path, which overwrites the whole object from its payload.
--
-- WHICH MEANS A HAND-MADE CLASSIFICATION SILENTLY REVERTED. gv2-mthp4vh8-iyiowo was tagged
-- hallucinated_result, then re-saved from the recorder and came back as ["incomplete"], with
-- in_study flipped off, and nothing said so. Any re-record still wins — that is the recorder's job —
-- but a researcher now has a way to set it back that does not involve a script.
--
-- Only `problems` is written. correctness/correct, errors and no_error are the recorder's account of
-- what happened and are left exactly as recorded; this is a judgement ABOUT that account.

create or replace function public.save_pageguide_guide_v2_problems(
  p_password text,
  p_id text,
  p_problems text[]
)
returns setof public.pageguide_guide_v2_tasks
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_gt jsonb;
  v_clean text[];
  v_one text;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  -- The closed vocabulary, plus `wrong_result`, which vendor/guide_trajectories.js does not declare
  -- and the data contains anyway. Refused here rather than in the browser, like every other rule in
  -- this schema: a typo'd id would classify as "reason not recorded" and quietly leave the run out
  -- of the misreported count it belongs in.
  v_clean := array(select distinct x from unnest(coalesce(p_problems, '{}'::text[])) as x where btrim(x) <> '');
  foreach v_one in array v_clean loop
    if v_one not in ('hallucinated_result', 'wrong_result', 'incomplete', 'could_not_complete') then
      raise exception 'Unknown problem type "%". Use hallucinated_result, wrong_result, incomplete or could_not_complete.', v_one;
    end if;
  end loop;

  select guide_ground_truth into v_gt
  from public.pageguide_guide_v2_tasks where id = p_id;

  if not found then
    raise exception 'No Guide V2 task with id %', p_id;
  end if;

  update public.pageguide_guide_v2_tasks
  set guide_ground_truth = coalesce(v_gt, '{}'::jsonb) || jsonb_build_object('problems', to_jsonb(v_clean)),
      updated_at = now()
  where id = p_id;

  return query select * from public.pageguide_guide_v2_tasks where id = p_id;
end;
$$;

grant execute on function public.save_pageguide_guide_v2_problems(text, text, text[]) to anon;

comment on function public.save_pageguide_guide_v2_problems(text, text, text[]) is
  'Sets guide_ground_truth.problems for one Guide task, leaving the recorder''s errors/correctness untouched. This is the classification app/find_v2_guide_key.js reads to derive the failure mode. Re-recording the run through save_pageguide_guide_v2_task will overwrite it again.';
