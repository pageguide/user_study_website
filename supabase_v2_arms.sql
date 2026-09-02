-- Find V2 — build `arms` from what the recorder actually writes.
-- =============================================================
-- Run once in the SQL editor of the V2 project, LAST — after supabase_v2_init.sql,
-- supabase_v2_guide.sql and supabase_v2_faithfulness.sql, whose `claims_completion` column the
-- meta writer below depends on. Idempotent: re-running changes nothing already correct.
--
-- THE BUG THIS FIXES. app/stimulus.js — a port of the extension's trajectory viewer — reads
--
--   arms.{grounding,nongrounding}.{steps, answer, trail, initial_state, final_state, answer_evidence}
--
-- and nothing else. The runs migrated out of V1 by scripts/migrate_guide_v2.mjs arrive in exactly
-- that shape, so they render. A run recorded through the extension does NOT: the writer below,
-- save_pageguide_guide_v2_task, fills `trajectory`, `answer_variants`, `step_count` and
-- `guide_ground_truth`, and never touches `arms`. Such a row therefore has arms = '{}' and plays as
-- an EMPTY STIMULUS — no journey, no screenshots, no answer — while the Admin card cheerfully
-- reports "9 steps", because step_count is counted off `trajectory`, which is the one place the
-- player never looks.
--
-- The two shapes hold the same run. `trajectory` is already the array of steps the viewer wants, and
-- `answer_variants.<cell>` already carries the answer text and its evidence. So this is a
-- projection, not a conversion, and it belongs in the WRITE path: derived once per save, read back
-- by the existing JSON-subpath queries in app/find_v2_supabase.js with no translation layer and no
-- change to the browser at all.
--
-- Two things the recorder does not record, and this fills in from the trajectory rather than leaving
-- blank:
--
--   initial_state / final_state — the before/after pair the participant compares to answer "did this
--     actually get done?". The first step's screenshot IS the page before the agent acted, and the
--     last step's is the page as it was left. Not invented: re-labelled.
--   trail.milestones — the evidence entries, each of which already carries {step, note}, which is
--     the milestone shape. No `summary` key is written: the agent did not write one, and render()
--     handles a summary-less trail. A trail is never fabricated out of the step instructions, which
--     would put the recorder's words in the agent's mouth.


-- ── One arm, from a trajectory and one authored variant ─────────────────────
-- Returns '{}' for an unauthored cell, so an arm that was never written stays absent instead of
-- rendering as an answer nobody wrote.
create or replace function public.pageguide_v2_guide_arm(p_traj jsonb, p_variant jsonb)
returns jsonb
language sql
immutable
as $$
  with traj as (
    select case when jsonb_typeof(p_traj) = 'array' then p_traj else '[]'::jsonb end as t
  ),
  ends as (
    select t,
           case when jsonb_array_length(t) > 0 then t -> 0 end as first_step,
           case when jsonb_array_length(t) > 0 then t -> (jsonb_array_length(t) - 1) end as last_step
    from traj
  ),
  ev as (
    select case when jsonb_typeof(p_variant -> 'evidence') = 'array'
                then p_variant -> 'evidence' else '[]'::jsonb end as e
  ),
  -- One milestone per evidence entry that names a step, in step order, deduplicated: two pieces of
  -- evidence hanging off the same step are one moment in the run, not two.
  milestones as (
    select coalesce(jsonb_agg(m order by (m ->> 'step')::numeric), '[]'::jsonb) as list
    from (
      select distinct on ((item ->> 'step')::numeric)
             jsonb_build_object('step', item -> 'step', 'text', coalesce(item ->> 'note', '')) as m
      from ev, jsonb_array_elements(ev.e) as item
      where (item ->> 'step') ~ '^[0-9]+$'
      order by (item ->> 'step')::numeric, (item ->> 'cited') desc nulls last
    ) ordered
  )
  select case
    when coalesce(p_variant ->> 'answer_text', '') = '' then '{}'::jsonb
    else jsonb_strip_nulls(jsonb_build_object(
      'steps', ends.t,
      'answer', p_variant ->> 'answer_text',
      'answer_evidence', ev.e,
      'initial_state', case when ends.first_step is null then null else jsonb_build_object(
        'url', ends.first_step ->> 'url',
        'screenshot', ends.first_step ->> 'screenshot') end,
      'final_state', case when ends.last_step is null then null else jsonb_build_object(
        'url', ends.last_step ->> 'url',
        'screenshot', ends.last_step ->> 'screenshot') end,
      'trail', case when milestones.list = '[]'::jsonb then null
                    else jsonb_build_object('milestones', milestones.list) end
    ))
  end
  from ends, ev, milestones;
$$;

comment on function public.pageguide_v2_guide_arm(jsonb, jsonb) is
  'Projects one recorded trajectory plus one authored answer variant into the arm shape app/stimulus.js reads. Returns {} when the variant has no answer_text.';


-- ── Both arms, with the correctness half chosen the way the player would ────
-- `correctness_mode` is the item's own instruction about which of the four authored cells it is
-- played as. A `balanced` item that authored only one side is built from the side that exists,
-- because half an item still beats a blank one — and Admin is where the gap gets fixed.
create or replace function public.pageguide_v2_guide_arms(p_traj jsonb, p_variants jsonb, p_mode text)
returns jsonb
language sql
immutable
as $$
  with v as (
    select case when jsonb_typeof(p_variants) = 'object' then p_variants else '{}'::jsonb end as av
  ),
  side as (
    select av,
           case
             when p_mode = 'always_incorrect' then 'incorrect'
             when p_mode = 'always_correct' then 'correct'
             when coalesce(av -> 'correct_grounding' ->> 'answer_text',
                           av -> 'correct_nongrounding' ->> 'answer_text', '') <> '' then 'correct'
             else 'incorrect'
           end as half
    from v
  ),
  built as (
    select public.pageguide_v2_guide_arm(p_traj, side.av -> (side.half || '_grounding')) as g,
           public.pageguide_v2_guide_arm(p_traj, side.av -> (side.half || '_nongrounding')) as ng
    from side
  )
  select coalesce(
    (case when g = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('grounding', g) end)
    || (case when ng = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('nongrounding', ng) end),
    '{}'::jsonb)
  from built;
$$;

comment on function public.pageguide_v2_guide_arms(jsonb, jsonb, text) is
  'The arms object for one Guide item, derived from its trajectory and answer_variants. Written by save_pageguide_guide_v2_task on every save, so re-authoring an answer cannot leave a stale stimulus behind.';


-- ── The writer, with `arms` added ───────────────────────────────────────────
-- Identical to the definition in supabase_v2_init.sql except that `arms` is now derived and stored
-- alongside the legacy columns. Recomputed on every write rather than only when missing: `arms` is a
-- projection of two columns that this same statement is updating, and a derived value that is only
-- filled once is a derived value that goes stale.
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
    -- Without a key there is nothing to score the taxonomy answer against, and
    -- the localization questions silently become unscored free text.
    if not (v_gt ? 'correct') then
      raise exception 'A live Guide item needs guide_ground_truth with at least a "correct" key.';
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


-- ── The gate that would have caught this ────────────────────────────────────
-- The four blank runs did not reach the study through the writer above. They reached it through
-- save_pageguide_guide_v2_meta — Admin's "Use in study" checkbox — which writes the four judged
-- fields and never looks at the stimulus. So the writer's own authoring checks
-- (pageguide_v2_assert_authored) were never on the path that published them, and a run with an
-- empty `arms` went live and played as an empty page.
--
-- Redefined here with the same 7-argument signature supabase_v2_faithfulness.sql gave it, plus one
-- rule: a task cannot go live unless the player has an answer and at least one step to show. Refused
-- in the function rather than in the browser, for the same reason every other rule here is — a stale
-- tab or a hand-made request must not be able to publish a blank stimulus.
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
declare
  v_arm jsonb;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if p_task_style is not null and p_task_style not in ('guide_text', 'guide_visual') then
    raise exception 'task_style must be guide_text or guide_visual.';
  end if;

  if coalesce(p_in_study, false) and p_agent_completed is null then
    raise exception 'Set "did the agent complete the task?" before putting this task in the study.';
  end if;

  -- An honest failure is answerable without opening the page, so it is not a study item. Refused
  -- here rather than in the browser, so it cannot be published by a stale tab or a hand-made request.
  if coalesce(p_in_study, false)
     and p_claims_completion is not null and p_claims_completion = false then
    raise exception 'This run admits it did not finish, so the verdict is readable from its first sentence. Honest failures are not used in the study.';
  end if;

  if coalesce(p_in_study, false) then
    select arms -> 'grounding' into v_arm
    from public.pageguide_guide_v2_tasks where id = p_id;

    if coalesce(v_arm ->> 'answer', '') = ''
       or coalesce(jsonb_array_length(v_arm -> 'steps'), 0) = 0 then
      raise exception 'This task has nothing for the player to show — app/stimulus.js reads arms.grounding.{steps, answer}, and this row has neither. Run supabase_v2_arms.sql (it derives them from the recorded trajectory and the authored answer), then try again.';
    end if;
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


-- ── Backfill the rows recorded before the writer knew about `arms` ──────────
-- Guarded on arms = '{}' so a run migrated out of V1 — which HAS arms, and whose arms are the
-- recorder's own output rather than a projection of anything — is never touched. A no-op on the
-- second run.
update public.pageguide_guide_v2_tasks
set arms = public.pageguide_v2_guide_arms(trajectory, answer_variants, correctness_mode),
    updated_at = now()
where arms = '{}'::jsonb
  and jsonb_typeof(trajectory) = 'array'
  and jsonb_array_length(trajectory) > 0
  and public.pageguide_v2_guide_arms(trajectory, answer_variants, correctness_mode) <> '{}'::jsonb;
