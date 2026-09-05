-- Find V2 — the fixed Guide × Visual queue, the task picker behind it, and the browse simulator.
-- =============================================================================================
-- Run once in the SQL editor of the V2 project, after sql/160_supabase_v2_recruit_quota.sql. Idempotent.
--
-- THREE THINGS, one migration, because they are one decision. The study is moving off the round
-- robin: every participant now sees the SAME four Guide × Visual runs, one per cell of correctness
-- × grounding. That only works if the four runs are named — a rotation picks them from a pool, a
-- fixed design has to be told — so the queue design, the per-cell choice and the switch for the new
-- browse simulator land together rather than as three half-applied migrations.
--
-- 1. queue_design gains 'guide_visual_4'
--    ------------------------------------
--    Four tasks, all Guide, all VISUAL, in this order:
--
--        1  Correct   × Grounded          3  Correct   × Non-grounded
--        2  Incorrect × Non-grounded      4  Incorrect × Grounded
--
--    NO ROUND ROBIN. `assignment_slot` still numbers the sittings — it is the session's identity and
--    the recruitment counter's — but it no longer selects anything: every participant is dealt the
--    same four runs in the same order. Modality stops being a between-subjects factor (there is no
--    text half any more) and both correctness and grounding become fully within-subjects, so the
--    n of every cell is simply the number of completed sittings.
--
--    That also makes `slot_quota` inert under this design. It is left switchable rather than
--    removed: switching back to a rotating design must not silently lose the target.
--
-- 2. task_selection jsonb — WHICH runs fill those cells
--    --------------------------------------------------
--    A fixed design cannot pick its own stimuli. This column is that pick, written from
--    Admin → Study tasks, and it is keyed BY DESIGN so switching between designs does not destroy
--    the other one's choices:
--
--        {
--          "guide_visual_4": ["ms9j3200", "a1b2c3d4", "…", "…"],
--          "balanced_2x2":   { "A": [null, null, "…", null], "B": [ … ] }
--        }
--
--    A design whose queue still varies by group stores one array per group; the fixed design, which
--    has no groups, stores one array. A null or absent entry means "not pinned" — that cell falls
--    back to the rotation the design already had, so a partly-filled selection degrades to the old
--    behaviour rather than to an empty queue.
--
--    DELIBERATELY NOT A FOREIGN KEY, and deliberately not validated here. A task id that has been
--    withdrawn from the study should show up in Admin as a named gap the researcher can see and fix,
--    not as a write that fails at 2am when somebody unticks a checkbox in another tab. The browser
--    resolves the ids against the live pool at deal time and falls back when one no longer answers.
--
-- 3. allow_browse_sim boolean — the browse simulator, and browse_sim_delay_ms, its page load
--    ---------------------------------------------------------------------------------------
--    A Guide task shows what the agent did as a list of steps. The simulator turns that list back
--    into the browsing it describes — a button that opens the run as a slideshow, one page state per
--    step, stepped through with Back and Next. It OPENS ON THE LAST PAGE and travels backwards,
--    because the claim being judged is about where the run ended.
--
--    OFFERED IN BOTH ARMS. It began as the non-grounded arm's one way back to the pages and is now
--    a constant of the study rather than part of what separates the conditions. What the arms differ
--    in is the CHECKABLE JOURNEY, and everything that makes a step checkable travels together on the
--    grounded side: the milestone flags that say which steps are worth checking, the hover that
--    shows the page a step acted on, and the click that opens it full size. The non-grounded arm is
--    the same steps as text. Both get the same optional walk through the same pages, so the
--    simulator can no longer be read as a non-grounded affordance, and its usage is a behavioural
--    measure directly comparable across the two arms — which it never was while only one of them
--    had the button.
--
--    `browse_sim_delay_ms` is how long a page takes to come up, 500ms by default. Browsing is not
--    instant, and with no delay the buttons scrub: fourteen pages in a second, none of them on
--    screen long enough to read. It is a SETTING rather than a constant because it is the one number
--    here that changes what the instrument measures — the cost of looking is the whole difference
--    between "the evidence was there" and "the evidence was worth going to get", and half a second
--    per page is a guess until a pilot says otherwise. 0 switches the delay off entirely.
--
--    Whether the simulator was opened, and how far back it was walked, is recorded in each result
--    row's `interaction_summary.browse_sim`, so a session that never opened it can be separated from
--    one that retraced the whole run.
--
--    Default ON, because a project applying this migration is applying it to get the button.
--
-- 4. post_survey_url text — the questionnaire the last screen sends people to
--    ----------------------------------------------------------------------
--    It was a constant in app/study.js with an app/find_v2_config.js override, so changing the form
--    meant a code edit and a deploy. That is the wrong shape for the one URL most likely to change
--    while a study is running — a form gets rebuilt, or a pilot and the real run want different
--    ones — so it moves into the settings row and gets a field in Admin.
--
--    EMPTY MEANS "USE THE BUILT-IN", not "no survey". A blank column falls through to the config
--    override and then to the address compiled into the page, so a project that never touches this
--    keeps the form it already had and a mistyped clear cannot silently drop the last step of the
--    study.

alter table public.pageguide_find_v2_settings
  add column if not exists task_selection jsonb not null default '{}'::jsonb;

alter table public.pageguide_find_v2_settings
  add column if not exists allow_browse_sim boolean not null default true;

alter table public.pageguide_find_v2_settings
  add column if not exists browse_sim_delay_ms integer not null default 500;

alter table public.pageguide_find_v2_settings
  add column if not exists post_survey_url text not null default '';

comment on column public.pageguide_find_v2_settings.task_selection is
  'Which task fills each cell of a queue, keyed by queue_design. A design with no groups stores one array of task ids indexed by cell; a design that still varies by group stores {"A": [...], "B": [...]}. null or absent means the cell is not pinned and falls back to that design''s rotation. Not a foreign key on purpose: a withdrawn task must read as a visible gap in Admin, not as a failed write.';

comment on column public.pageguide_find_v2_settings.allow_browse_sim is
  'Whether a Guide task offers the browse simulator — a button that opens the run as a stepped slideshow of its page states, starting at the last and walking back. Offered in BOTH arms, so it is a constant of the study rather than part of what separates them; what the arms differ in is the checkable journey — milestone flags, hover and click all belong to the grounded one. Usage lands in interaction_summary.browse_sim on each result row.';

comment on column public.pageguide_find_v2_settings.post_survey_url is
  'The post-study questionnaire the final screen links to and embeds. Empty means fall through to app/find_v2_config.js and then to the address compiled into app/study.js, so a blank cannot silently drop the last step. Prefer the long docs.google.com/forms/d/e/.../viewform address over a forms.gle short link: the short link is a 302 and a redirect does not carry ?embedded=true forward, so an embedded short link renders with Google''s full page chrome inside the frame.';

comment on column public.pageguide_find_v2_settings.browse_sim_delay_ms is
  'How long one page of the browse simulator takes to come up, in milliseconds (0-5000, default 500). Browsing is not instant, and with no delay the buttons scrub past pages faster than they can be read. A setting rather than a constant because it is what sets the COST of looking, which is the difference between evidence being available and being worth going to get; 0 switches the delay off.';

-- The closed vocabulary gains the fixed design. Dropped and re-added rather than altered: a check
-- constraint has no ALTER, and the browser maps an unknown value to the default, so a design missing
-- from this list would silently deal a different study rather than fail.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.pageguide_find_v2_settings'::regclass
      and conname = 'pageguide_find_v2_settings_queue_design_check'
  ) then
    alter table public.pageguide_find_v2_settings
      drop constraint pageguide_find_v2_settings_queue_design_check;
  end if;

  alter table public.pageguide_find_v2_settings
    add constraint pageguide_find_v2_settings_queue_design_check
    check (queue_design in ('balanced_2x2', 'legacy_find3', 'guide_visual_4'));
end $$;

comment on column public.pageguide_find_v2_settings.queue_design is
  'Which queue a new sitting is dealt: balanced_2x2 (Find/Guide × grounded/non-grounded, correctness alternating), legacy_find3 (three fixed Find cells + one grounded Guide task), or guide_visual_4 (four Guide × Visual runs, one per correctness × grounding cell, the same four for everyone — no round robin; the runs are named in task_selection). Snapshotted into the session at start, never re-read mid-run.';


-- ── The protocol flags, plus the picker and the simulator ───────────────────
-- DROPPED FIRST: the return type is defined by the OUT parameters and `create or replace` refuses to
-- change one. Same as every flags migration before this.
drop function if exists public.pageguide_find_v2_study_flags();

create or replace function public.pageguide_find_v2_study_flags()
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean,
  flag_milestones boolean,
  show_reasoning_trail boolean,
  slot_quota integer,
  task_selection jsonb,
  allow_browse_sim boolean,
  browse_sim_delay_ms integer,
  post_survey_url text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip, s.flag_milestones, s.show_reasoning_trail,
           s.slot_quota, s.task_selection, s.allow_browse_sim, s.browse_sim_delay_ms,
           s.post_survey_url
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
  p_show_reasoning_trail boolean default null,
  p_slot_quota integer default null,
  p_task_selection jsonb default null,
  p_allow_browse_sim boolean default null,
  p_browse_sim_delay_ms integer default null,
  p_post_survey_url text default null
)
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean,
  flag_milestones boolean,
  show_reasoning_trail boolean,
  slot_quota integer,
  task_selection jsonb,
  allow_browse_sim boolean,
  browse_sim_delay_ms integer,
  post_survey_url text
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
     and p_queue_design not in ('balanced_2x2', 'legacy_find3', 'guide_visual_4') then
    raise exception 'Unknown queue design %. Expected balanced_2x2, legacy_find3 or guide_visual_4.', p_queue_design;
  end if;

  if p_slot_quota is not null and (p_slot_quota < 0 or p_slot_quota > 200) then
    raise exception 'The per-class recruitment target must be between 0 and 200 (got %).', p_slot_quota;
  end if;

  -- SHAPE ONLY. Which ids are valid is a question about the task pool, which changes under this
  -- function's feet; that check belongs in Admin, where an unpinned cell can be shown as a gap. What
  -- is checked here is that the column keeps holding an object, because the browser indexes into it
  -- by design name and an array or a scalar would fail at deal time rather than at write time.
  if p_task_selection is not null and jsonb_typeof(p_task_selection) <> 'object' then
    raise exception 'task_selection must be a JSON object keyed by queue design (got %).',
      jsonb_typeof(p_task_selection);
  end if;

  -- 0 is "no delay". The ceiling is a usability guard rather than a design limit: five seconds a
  -- page turns a fourteen-step run into a minute and a half of waiting, which is past the point
  -- where the number is measuring the cost of looking and into where it is measuring patience.
  if p_browse_sim_delay_ms is not null
     and (p_browse_sim_delay_ms < 0 or p_browse_sim_delay_ms > 5000) then
    raise exception 'The browse simulator page delay must be between 0 and 5000 ms (got %).',
      p_browse_sim_delay_ms;
  end if;

  -- SCHEME ONLY, and empty is allowed because empty means "fall back to the built-in". Which form
  -- is the right one is not a question this function can answer, but "somebody pasted a page title
  -- into the URL field" is, and that one would take the last screen of the study down silently.
  if p_post_survey_url is not null and btrim(p_post_survey_url) <> ''
     and p_post_survey_url !~* '^https://' then
    raise exception 'The post-study survey URL must be an https:// address (got %).', p_post_survey_url;
  end if;

  update public.pageguide_find_v2_settings s
  set collect_evidence = coalesce(p_collect_evidence, false),
      collect_followup = coalesce(p_collect_followup, false),
      task_limit_seconds = coalesce(p_task_limit_seconds, s.task_limit_seconds),
      queue_design = coalesce(p_queue_design, s.queue_design),
      show_group_chip = coalesce(p_show_group_chip, s.show_group_chip),
      flag_milestones = coalesce(p_flag_milestones, s.flag_milestones),
      show_reasoning_trail = coalesce(p_show_reasoning_trail, s.show_reasoning_trail),
      slot_quota = coalesce(p_slot_quota, s.slot_quota),
      -- Coalesced to the STORED value like the rest: the picker tab saves the selection and the
      -- settings tab does not, so "absent" here means "that tab had no opinion", never "clear it".
      task_selection = coalesce(p_task_selection, s.task_selection),
      allow_browse_sim = coalesce(p_allow_browse_sim, s.allow_browse_sim),
      browse_sim_delay_ms = coalesce(p_browse_sim_delay_ms, s.browse_sim_delay_ms),
      post_survey_url = coalesce(p_post_survey_url, s.post_survey_url),
      updated_at = now()
  where s.singleton = true;

  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip, s.flag_milestones, s.show_reasoning_trail,
           s.slot_quota, s.task_selection, s.allow_browse_sim, s.browse_sim_delay_ms,
           s.post_survey_url
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

-- DROP EVERY EARLIER ARITY, or the new parameters make an overload and Postgres refuses the older
-- calls with "function ... is not unique". The eleven-argument line matters for a project that ran
-- an earlier copy of THIS file, before the page delay was added — re-running it is safe and
-- expected, and without that drop the second run would leave two live overloads.
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean, boolean, integer);
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean, boolean, integer, jsonb, boolean);
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean, boolean, integer, jsonb, boolean, integer);

grant execute on function public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean, boolean, integer, jsonb, boolean, integer, text) to anon;

-- PostgREST caches function signatures as well as table shapes.
notify pgrst, 'reload schema';
