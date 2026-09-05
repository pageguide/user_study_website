-- Find V2 — hiding and deleting steps of a recorded Guide run, with everything renumbered.
-- =======================================================================================
-- Run once in the SQL editor of the V2 project, after sql/030_supabase_v2_arms.sql. Idempotent.
--
-- WHY. A recorded run contains actions that are not part of the task: a cookie banner dismissed, a
-- search retyped, three steps of scrolling that go nowhere. A participant has three minutes to judge
-- whether the agent did the job, and every such step is one more thing to read before they can
-- start. Trimming them is not doctoring the run — the run still shows what the agent did about the
-- TASK — but it has never been possible without hand-editing jsonb in the SQL editor.
--
-- STEP NUMBERS ARE REFERENCES, NOT LABELS. `n` is what a participant reads, what their answer names
-- ("it went wrong at step 6"), and what four other structures point at:
--
--     arms.*.answer_evidence[].step     arms.*.trail.milestones[].step
--     arms.*.answer_segments[].step     guide_ground_truth.errors[].steps
--
-- Remove step 4 of 13 and every one of those pointing past it is off by one. Renumbering the steps
-- alone leaves the evidence chips attached to the wrong action and the answer key blaming the wrong
-- step — the task looks fine and scores wrong. So the remap is the substance of this file, and it is
-- applied in one statement with the removal or not at all.
--
-- MATERIALISED, NOT A VIEW. The alternative — keep every step and filter at render — means two
-- numbering systems live at once: the participant marks step 4 of what they saw, the answer key
-- names step 7 of what was recorded, and something has to translate between them on every read and
-- every score. One numbering, written down, is the version that cannot drift.
--
-- HIDE VS DELETE.
--   hide   moves the step into `hidden_steps`, screenshot and all. Reversible with `show`.
--   delete drops it. Not reversible — offered because a run trimmed for good should not carry
--          megabytes of base64 for pages nobody will ever see again.
-- Both remove it from what the participant is shown, and both renumber identically.
--
-- IT EDITS `arms`, WHICH IS THE SOURCE OF TRUTH FOR THESE ROWS. sql/030_supabase_v2_arms.sql derives `arms`
-- from `trajectory` on the recorder's write path — but a run migrated out of V1 HAS arms and an
-- empty trajectory, which is what every Guide task in this study currently is. `trajectory` is
-- therefore edited too when it holds a matching step count, so a row that does get re-derived later
-- is re-derived from material that has had the same steps taken out of it.

alter table public.pageguide_guide_v2_tasks
  add column if not exists hidden_steps jsonb not null default '[]'::jsonb;

comment on column public.pageguide_guide_v2_tasks.hidden_steps is
  'Steps taken out of the run and kept: [{"orig_n": 4, "step": {...}}, …], newest hide last. Not shown to participants and not counted in step_count. Restored by save_pageguide_guide_v2_steps(…, ''show'', …), which puts each back at its recorded position and renumbers everything again.';


-- ── Remapping one arm ───────────────────────────────────────────────────────
-- `p_map` is {"<old n>": <new n> | null}. A reference to a step that is gone (null) is DROPPED
-- rather than left pointing at a number that no longer exists: a milestone whose step has gone
-- renders as a row that previews nothing, which reads as a broken page rather than as a trimmed run.
--
-- An entry with no `step` key at all is passed through untouched — the shape is the recorder's and
-- this function is not the place to normalise it.
create or replace function public.pageguide_v2_guide_remap_arm(p_arm jsonb, p_steps jsonb, p_map jsonb)
returns jsonb
language sql
immutable
as $$
  with arm as (
    select case when jsonb_typeof(p_arm) = 'object' then p_arm else null end as a
  ),
  list as (
    select 'answer_evidence' as k,
           case when jsonb_typeof(a -> 'answer_evidence') = 'array' then a -> 'answer_evidence' else null end as v
    from arm
    union all
    select 'answer_segments',
           case when jsonb_typeof(a -> 'answer_segments') = 'array' then a -> 'answer_segments' else null end
    from arm
    union all
    select 'milestones',
           case when jsonb_typeof(a -> 'trail' -> 'milestones') = 'array' then a -> 'trail' -> 'milestones' else null end
    from arm
  ),
  remapped as (
    select list.k,
           coalesce(jsonb_agg(
             case when item ? 'step' then jsonb_set(item, '{step}', p_map -> (item ->> 'step')) else item end
             order by ord
           ) filter (
             -- Kept when it names no step, or when the step it names survived.
             where not (item ? 'step') or jsonb_typeof(p_map -> (item ->> 'step')) = 'number'
           ), '[]'::jsonb) as v
    from list, lateral jsonb_array_elements(coalesce(list.v, '[]'::jsonb)) with ordinality as t(item, ord)
    where list.v is not null
    group by list.k
  )
  select case when arm.a is null then p_arm else
    arm.a
    || jsonb_build_object('steps', p_steps)
    || coalesce((select jsonb_build_object('answer_evidence', v) from remapped where k = 'answer_evidence'), '{}'::jsonb)
    || coalesce((select jsonb_build_object('answer_segments', v) from remapped where k = 'answer_segments'), '{}'::jsonb)
    || coalesce((select jsonb_build_object('trail',
          (arm.a -> 'trail') || jsonb_build_object('milestones', v)) from remapped where k = 'milestones'), '{}'::jsonb)
  end
  from arm;
$$;

comment on function public.pageguide_v2_guide_remap_arm(jsonb, jsonb, jsonb) is
  'One arm with a new step list and every step reference remapped through {"old": new|null}. References to a removed step are dropped.';


-- ── The one write ───────────────────────────────────────────────────────────
create or replace function public.save_pageguide_guide_v2_steps(
  p_password text,
  p_id text,
  p_op text,
  p_steps integer[]
)
returns table (n integer, instruction text, hidden boolean, orig_n integer)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_arms    jsonb;
  v_steps   jsonb;
  v_hidden  jsonb;
  v_answer  text;
  v_map     jsonb;
  v_kept    jsonb;
  v_moved   jsonb;
  v_total   integer;
  v_traj    jsonb;
  v_gt      jsonb;
  v_broken  text;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if p_op not in ('hide', 'show', 'delete') then
    raise exception 'Unknown step operation %. Expected hide, show or delete.', p_op;
  end if;
  if p_steps is null or array_length(p_steps, 1) is null then
    raise exception 'No steps given.';
  end if;

  select arms, coalesce(hidden_steps, '[]'::jsonb), guide_ground_truth, trajectory
    into v_arms, v_hidden, v_gt, v_traj
    from public.pageguide_guide_v2_tasks where id = p_id for update;
  if not found then
    raise exception 'No Guide V2 task with id %', p_id;
  end if;

  v_steps := case when jsonb_typeof(v_arms -> 'grounding' -> 'steps') = 'array'
                  then v_arms -> 'grounding' -> 'steps' else '[]'::jsonb end;

  -- ── Every step tagged with the identity the REFERENCES currently use ──
  -- `__old` is what evidence, segments, milestones and the answer key mean when they say "step 6".
  -- Position in the array wins over the stored `n`: a row whose numbering has drifted is renumbered
  -- into agreement rather than trusted, and a map keyed on a duplicate `n` would silently lose one.
  -- The tag is stripped again before the steps are written back.
  v_steps := (
    select coalesce(jsonb_agg(jsonb_set(item, '{__old}', to_jsonb(pos)) order by pos), '[]'::jsonb)
    from jsonb_array_elements(v_steps) with ordinality as t(item, pos)
  );

  -- ── show: put the named originals back, then fall through to the same renumber ──
  if p_op = 'show' then
    -- THE RESTORED STEPS CARRY NO `__old`, which is the point: nothing referenced them while they
    -- were away, and everything that referenced the steps around them must shift up to make room.
    -- Restoring without that shift is how "reversible" quietly becomes "the chips now open the wrong
    -- page" — the steps come back in the right places and every reference stays where the trimmed
    -- run left it.
    --
    -- ANCHORED TO A SURVIVOR, NOT TO ITS OLD NUMBER. `after_n` is which VISIBLE step this one sat
    -- behind at the moment it was hidden, so it goes back between the same two steps whatever the
    -- run has been renumbered to since. Anchoring on `orig_n` instead compares a number from the
    -- untrimmed run against numbers from the trimmed one — two different numbering systems — and
    -- interleaves the restored steps among the survivors. `orig_n - 0.5` is the fallback for an
    -- entry hidden before this column carried an anchor.
    --
    -- The half-step key puts a restored step immediately after its anchor, and the tie-break keeps
    -- several restored behind the same anchor in the order they were recorded in.
    v_steps := (
      select coalesce(jsonb_agg(step order by sort_n, tie, tie_n), '[]'::jsonb)
      from (
        select item as step, (item ->> '__old')::numeric as sort_n, 0 as tie, 0 as tie_n
        from jsonb_array_elements(v_steps) as item
        union all
        select h -> 'step',
               coalesce((h ->> 'after_n')::numeric, greatest((h ->> 'orig_n')::numeric - 1, 0)) + 0.5,
               1, (h ->> 'orig_n')::integer
        from jsonb_array_elements(v_hidden) as h
        where (h ->> 'orig_n')::integer = any(p_steps)
      ) all_steps
    );
    v_hidden := coalesce((
      select jsonb_agg(h) from jsonb_array_elements(v_hidden) as h
      where not ((h ->> 'orig_n')::integer = any(p_steps))
    ), '[]'::jsonb);
    -- Nothing is removed on this path, so no reference is dropped.
    p_steps := '{}'::integer[];
  end if;

  v_total := jsonb_array_length(v_steps);
  if v_total = 0 then
    raise exception 'This task has no steps to edit — app/stimulus.js reads arms.grounding.steps and this row has none.';
  end if;

  -- ── The map, from the reference numbering to the new one, and the new step list ──
  with numbered as (
    select item, row_number() over () as pos,
           case when item ? '__old' then (item ->> '__old')::integer end as old_n
    from jsonb_array_elements(v_steps) as item
  ),
  flagged as (
    select item, pos, old_n, (old_n is not null and old_n = any(p_steps)) as removed
    from numbered
  ),
  -- How many steps SURVIVE ahead of this one — the anchor a hidden step is restored behind.
  anchored as (
    select item, pos, old_n, removed,
           coalesce(sum(case when removed then 0 else 1 end)
                    over (order by pos rows between unbounded preceding and 1 preceding), 0) as kept_before
    from flagged
  ),
  kept as (
    select item, pos, old_n, row_number() over (order by pos) as new_n
    from anchored where not removed
  )
  select coalesce((select jsonb_object_agg(anchored.old_n::text, coalesce(to_jsonb(kept.new_n), 'null'::jsonb))
                   from anchored left join kept on kept.pos = anchored.pos
                   where anchored.old_n is not null), '{}'::jsonb),
         coalesce((select jsonb_agg(jsonb_set(kept.item, '{n}', to_jsonb(kept.new_n)) - '__old' order by kept.new_n) from kept), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'orig_n', anchored.old_n, 'after_n', anchored.kept_before, 'step', anchored.item - '__old')
                   order by anchored.old_n)
                   from anchored where anchored.removed), '[]'::jsonb)
    into v_map, v_kept, v_moved;

  if jsonb_array_length(v_kept) = 0 then
    raise exception 'A run needs at least one visible step.';
  end if;

  -- A CITED CHIP CANNOT LOSE ITS TARGET. The answer carries [ev:key] markers that render as the
  -- numbered chips beside it; hiding the step one of them rests on would leave a chip that opens
  -- nothing, which is a broken stimulus rather than a trimmed one. Uncited evidence — the
  -- recorder's scratchpad entries — is dropped silently, because nothing on screen points at it.
  v_answer := coalesce(v_arms -> 'grounding' ->> 'answer', '');
  select string_agg(e ->> 'key', ', ') into v_broken
  from jsonb_array_elements(case when jsonb_typeof(v_arms -> 'grounding' -> 'answer_evidence') = 'array'
                                 then v_arms -> 'grounding' -> 'answer_evidence' else '[]'::jsonb end) as e
  where e ? 'step'
    and jsonb_typeof(v_map -> (e ->> 'step')) <> 'number'
    and position('[ev:' || coalesce(e ->> 'key', '') || ']' in replace(v_answer, ' ', '')) > 0;
  if v_broken is not null then
    raise exception 'Step % backs a claim the answer cites (%). Remove the citation from the answer first, or keep the step.',
      array_to_string(p_steps, ', '), v_broken;
  end if;

  -- ── Apply, to both arms and to the ground truth ──
  v_arms := jsonb_set(v_arms, '{grounding}',
    public.pageguide_v2_guide_remap_arm(v_arms -> 'grounding', v_kept, v_map));
  if jsonb_typeof(v_arms -> 'nongrounding') = 'object' then
    -- The same steps, this arm's own screenshots — which _stripGuideArm has nulled. Remapped from
    -- the grounded list rather than its own so the two arms cannot end up different runs.
    v_arms := jsonb_set(v_arms, '{nongrounding}',
      public.pageguide_v2_guide_remap_arm(v_arms -> 'nongrounding',
        (select coalesce(jsonb_agg(item - 'screenshot' || jsonb_build_object('screenshot', null) order by (item ->> 'n')::numeric), '[]'::jsonb)
           from jsonb_array_elements(v_kept) as item),
        v_map));
  end if;

  -- The answer key. An error whose every step has gone keeps its entry with an empty step list:
  -- "keyed incorrect, no longer localized" is the truth after the trim, and deleting the entry would
  -- quietly change what the run is keyed AS.
  if jsonb_typeof(v_gt -> 'errors') = 'array' then
    v_gt := jsonb_set(v_gt, '{errors}', coalesce((
      select jsonb_agg(jsonb_set(err, '{steps}', coalesce((
               select jsonb_agg(v_map -> (s #>> '{}') order by (v_map -> (s #>> '{}'))::numeric)
               from jsonb_array_elements(case when jsonb_typeof(err -> 'steps') = 'array' then err -> 'steps' else '[]'::jsonb end) as s
               where jsonb_typeof(v_map -> (s #>> '{}')) = 'number'
             ), '[]'::jsonb)) order by ord)
      from jsonb_array_elements(v_gt -> 'errors') with ordinality as t(err, ord)
    ), '[]'::jsonb));
  end if;

  -- The recorder's own copy, when it is a matching run. Guarded on the length so a row whose
  -- trajectory is empty (every V1-migrated task) or out of step is left alone rather than mangled.
  if jsonb_typeof(v_traj) = 'array' and jsonb_array_length(v_traj) = v_total then
    v_traj := (select coalesce(jsonb_agg(jsonb_set(item, '{n}', v_map -> pos::text) order by pos), '[]'::jsonb)
               from jsonb_array_elements(v_traj) with ordinality as t(item, pos)
               where jsonb_typeof(v_map -> pos::text) = 'number');
  end if;

  update public.pageguide_guide_v2_tasks
  set arms = v_arms,
      guide_ground_truth = v_gt,
      trajectory = v_traj,
      -- KEPT ONLY WHEN HIDING. A deleted step is gone: that is the whole difference between the two
      -- operations, and a "delete" that quietly archived the step would be a hide under another name.
      hidden_steps = case when p_op = 'hide' then v_hidden || v_moved else v_hidden end,
      step_count = jsonb_array_length(v_kept),
      updated_at = now()
  where id = p_id;

  return query
    select (s ->> 'n')::integer, coalesce(s ->> 'instruction', s ->> 'action', ''), false, null::integer
    from jsonb_array_elements(v_kept) as s
    union all
    select null::integer, coalesce(h -> 'step' ->> 'instruction', h -> 'step' ->> 'action', ''), true,
           (h ->> 'orig_n')::integer
    from jsonb_array_elements(case when p_op = 'hide' then v_hidden || v_moved else v_hidden end) as h
    order by 3, 1, 4;
end;
$$;

-- ── Reading the same list back, without the pictures ────────────────────────
-- The Admin panel needs to know what is hidden in order to offer it back, and `hidden_steps` carries
-- a full base64 screenshot per entry — hundreds of kilobytes to render three lines of text. This
-- returns exactly what the writer returns, so the panel renders the same list before and after an
-- edit, and neither call moves an image.
--
-- No password: this table is already readable by anon (the queue is built from it in the browser),
-- and step instructions are the stimulus rather than a secret.
create or replace function public.pageguide_guide_v2_step_list(p_id text)
returns table (n integer, instruction text, hidden boolean, orig_n integer)
language sql
stable
as $$
  select (s ->> 'n')::integer, coalesce(s ->> 'instruction', s ->> 'action', ''), false, null::integer
  from public.pageguide_guide_v2_tasks t,
       jsonb_array_elements(case when jsonb_typeof(t.arms -> 'grounding' -> 'steps') = 'array'
                                 then t.arms -> 'grounding' -> 'steps' else '[]'::jsonb end) as s
  where t.id = p_id
  union all
  select null::integer, coalesce(h -> 'step' ->> 'instruction', h -> 'step' ->> 'action', ''), true,
         (h ->> 'orig_n')::integer
  from public.pageguide_guide_v2_tasks t,
       jsonb_array_elements(coalesce(t.hidden_steps, '[]'::jsonb)) as h
  where t.id = p_id
  order by 3, 1, 4;
$$;

grant execute on function public.pageguide_guide_v2_step_list(text) to anon;

grant execute on function public.save_pageguide_guide_v2_steps(text, text, text, integer[]) to anon;

notify pgrst, 'reload schema';
