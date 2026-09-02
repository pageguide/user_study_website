-- Find V2 — WHY a Guide run is incorrect, recorded beside the verdict.
-- ===================================================================
-- Run once in the SQL editor of the V2 project, after supabase_v2_arms.sql. Idempotent.
--
-- The Guide task asks one question and stores one verdict. The runs it asks about fail two ways,
-- and the difference is the one the study is built on:
--
--   MISREPORTED — the answer claims something the trajectory does not support. Only checking the
--                 steps reveals it, which is exactly what the grounding condition varies.
--   INCOMPLETE  — the job was part done. Visible in the outcome; no reconstruction needed.
--
-- Splitting accuracy by those costs the participant nothing, because the recorder already wrote the
-- reason into guide_ground_truth.problems. It is derived in the browser by app/find_v2_guide_key.js
-- and STORED PER RESULT rather than joined at analysis time — the same reason
-- answer_correct_snapshot is stored: the ground truth is editable in Admin, and a verdict is only
-- interpretable against the classification that was live when the run was shown.
--
-- Nothing is added to pageguide_guide_v2_tasks. No new fact is authored here; the classification is
-- a reading of one that already exists.

alter table public.pageguide_guide_v2_results
  add column if not exists failure_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pageguide_guide_v2_results'::regclass
      and conname = 'pageguide_guide_v2_results_failure_mode_check'
  ) then
    alter table public.pageguide_guide_v2_results
      add constraint pageguide_guide_v2_results_failure_mode_check
      check (failure_mode is null or failure_mode in
        ('none', 'misreported', 'incomplete', 'could_not_complete', 'unspecified'));
  end if;
end $$;

comment on column public.pageguide_guide_v2_results.failure_mode is
  'Why the run shown to this participant was keyed incorrect, as it stood at the time: none (keyed correct), misreported (the answer claims what the trajectory does not support), incomplete, could_not_complete, or unspecified (keyed incorrect with no problem type recorded). NULL means the task carried no answer key. Derived by app/find_v2_guide_key.js from guide_ground_truth.problems; report accuracy per mode, never averaged into one number.';


-- ── Two stale descriptions, corrected ───────────────────────────────────────
-- TWO DIALECTS OF guide_ground_truth ARE LIVE, and the schema comment describes neither. Runs
-- migrated from V1 carry `correctness: 'success' | 'failure'` with `errors: [{type, steps: [..]}]`;
-- runs saved by the extension recorder carry `correct: boolean`. The comment in
-- supabase_v2_init.sql claims a `correct` key with problem ids ("wrong_element") and an error shape
-- ({step, type}) that appear nowhere in the data. Anyone reading it to write a query gets a query
-- that silently matches half the pool.
comment on column public.pageguide_guide_v2_tasks.guide_ground_truth is
  'The recorder''s own judgement of the run. TWO SHAPES ARE LIVE and both must be read: rows migrated from V1 carry {correctness: ''success''|''failure'', problems: [...], errors: [{type, steps: [n]}], no_error}, while rows saved by the extension recorder carry {correct: boolean, ...}. problems[] holds hallucinated_result | incomplete | could_not_complete, plus wrong_result, which is present in the data though vendor/guide_trajectories.js does not declare it. Researcher-only: never shown to a participant. app/find_v2_guide_key.js is the one place that reads across both shapes.';


-- ── The publish gate, taught the same lesson ────────────────────────────────
-- save_pageguide_guide_v2_task refuses to publish a Guide item whose ground truth has no verdict in
-- it, and tests that by looking for a `correct` key. A run migrated out of V1 does not have one — it
-- says `correctness: 'success'|'failure'` — so a perfectly well-formed V1 row would be refused for
-- speaking the older dialect. Latent today, because migrate_guide_v2.mjs upserts directly rather
-- than through this function; corrected anyway, because the next person to publish a migrated row
-- through Admin would hit it with no idea why.
--
-- Redefined whole rather than patched, following supabase_v2_guide.sql -> _faithfulness.sql ->
-- _arms.sql: each migration restates the function it changes, so the newest file is always the
-- complete definition. Identical to supabase_v2_arms.sql apart from the check below.
create or replace function public.save_pageguide_guide_v2_task(
  p_password text,
  p_task jsonb
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text := nullif(btrim(p_task ->> 'id'), '');
  v_style text := coalesce(nullif(btrim(p_task ->> 'task_style'), ''), 'guide_text');
  v_goal text := coalesce(btrim(p_task ->> 'goal'), '');
  v_in_study boolean := coalesce((p_task ->> 'in_study')::boolean, false);
  v_mode text := coalesce(nullif(btrim(p_task ->> 'correctness_mode'), ''), 'balanced');
  v_traj jsonb := case when jsonb_typeof(p_task -> 'trajectory') = 'array'
                       then p_task -> 'trajectory' else '[]'::jsonb end;
  v_gt jsonb := case when jsonb_typeof(p_task -> 'guide_ground_truth') = 'object'
                     then p_task -> 'guide_ground_truth' else '{}'::jsonb end;
  v_variants jsonb;
  v_arms jsonb;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if v_id is null or v_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$' then
    raise exception 'Item id must be 2-80 characters using letters, numbers, dot, dash, or underscore.';
  end if;
  if v_style not in ('guide_text', 'guide_visual') then
    raise exception 'task_style must be guide_text or guide_visual.';
  end if;
  if v_mode not in ('balanced', 'always_correct', 'always_incorrect') then
    raise exception 'correctness_mode must be balanced, always_correct, or always_incorrect.';
  end if;

  v_variants := public.pageguide_v2_normalize_variants(p_task -> 'answer_variants');
  v_arms := public.pageguide_v2_guide_arms(v_traj, v_variants, v_mode);

  if v_in_study then
    perform public.pageguide_v2_assert_authored(v_variants, v_mode);
    if v_goal = '' then
      raise exception 'A live Guide item needs the goal the agent was given.';
    end if;
    if jsonb_array_length(v_traj) = 0 then
      raise exception 'A live Guide item needs a recorded trajectory with at least one step.';
    end if;
    -- EITHER DIALECT. Without a verdict in here there is nothing to score against, and
    -- app/find_v2_guide_key.js has nothing to classify the run by.
    if not (v_gt ? 'correct' or v_gt ? 'correctness') then
      raise exception 'A live Guide item needs guide_ground_truth carrying a verdict — either "correct" (boolean) or "correctness" ("success"/"failure").';
    end if;
  end if;

  insert into public.pageguide_guide_v2_tasks (
    id, source_task_id, title, url, task_style, goal, answer_variants, correctness_mode,
    trajectory, trajectory_bytes, step_count, arms, guide_ground_truth, in_study, task_index, updated_at
  ) values (
    v_id,
    nullif(btrim(p_task ->> 'source_task_id'), ''),
    nullif(btrim(p_task ->> 'title'), ''),
    coalesce(btrim(p_task ->> 'url'), ''),
    v_style,
    v_goal,
    v_variants,
    v_mode,
    v_traj,
    length(convert_to(v_traj::text, 'UTF8')),
    jsonb_array_length(v_traj),
    v_arms,
    v_gt,
    v_in_study,
    coalesce((p_task ->> 'task_index')::integer, 0),
    now()
  )
  on conflict (id) do update set
    source_task_id = excluded.source_task_id,
    title = excluded.title,
    url = excluded.url,
    task_style = excluded.task_style,
    goal = excluded.goal,
    answer_variants = excluded.answer_variants,
    correctness_mode = excluded.correctness_mode,
    trajectory = excluded.trajectory,
    trajectory_bytes = excluded.trajectory_bytes,
    step_count = excluded.step_count,
    arms = excluded.arms,
    guide_ground_truth = excluded.guide_ground_truth,
    in_study = excluded.in_study,
    task_index = excluded.task_index,
    updated_at = now();

  return v_id;
end;
$$;

grant execute on function public.save_pageguide_guide_v2_task(text, jsonb) to anon;
