-- Find V2 — a recruitment quota, so a shortfall can actually be recruited away.
-- ============================================================================
-- Run once in the SQL editor of the V2 project, after supabase_v2_reasoning_trail.sql. Idempotent.
--
-- WHAT THIS FIXES. `assignment_slot % 4` decides everything about a sitting: `slot % 2` picks the
-- between-subjects modality (even = A/text, odd = B/visual) and `floor(slot / 2) % 2` picks which of
-- the two correctness sequences is dealt. Four consecutive slots therefore fill every Find cell and
-- every Guide cell exactly once, and the count of COMPLETED sittings in a class is, identically, the
-- n of four Find cells and four Guide cells.
--
-- The queue is balanced; who finishes is not. The counter has handed out 13-14 of each class and got
-- back 7 / 4 / 9 / 8 completed sittings, so the Find x Visual correct-grounded cell sits at n = 4
-- while its non-grounded neighbour sits at 8. Nothing in the old claim function could repair that:
-- it incremented a counter and handed out whatever came next, so recruiting more people preserved
-- the shortfall instead of closing it.
--
-- WHAT IT DOES. `slot_quota` is the target number of COMPLETED sittings per class. While it is set,
-- the claim deals the class that is furthest from that target rather than the next one in line, by
-- skipping the counter forward to the next slot of that class.
--
-- FORWARD-ONLY, deliberately. `cycle = floor(slot / 2)` also selects WHICH claims are dealt
-- (`pickClaims` in app/find_v2_welcome.js), so rewinding the counter would re-deal the same stimuli
-- to a later participant. Skipping forward only ever skips a class that is already over-filled.
--
-- Set it to 0 to switch back to plain round-robin. That is the value the Admin panel writes when the
-- target field is cleared, so "off" is a stored decision rather than an absent one.

alter table public.pageguide_find_v2_settings
  add column if not exists slot_quota integer not null default 0;

comment on column public.pageguide_find_v2_settings.slot_quota is
  'Target COMPLETED sittings per assignment_slot %% 4 class. Above 0, claim_pageguide_find_v2_session deals the class furthest from this target instead of the next slot in line; 0 restores plain round-robin. A class count is identically the n of four Find cells and four Guide cells, so one number levels both halves of the study at once.';


-- ── The protocol flags, plus the quota ──────────────────────────────────────
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
  slot_quota integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip, s.flag_milestones, s.show_reasoning_trail,
           s.slot_quota
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
  p_slot_quota integer default null
)
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean,
  flag_milestones boolean,
  show_reasoning_trail boolean,
  slot_quota integer
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

  -- 0 is off. The ceiling is a typo guard, not a design limit: 200 per class is 800 completed
  -- sittings, which is past anything this study will run.
  if p_slot_quota is not null and (p_slot_quota < 0 or p_slot_quota > 200) then
    raise exception 'The per-class recruitment target must be between 0 and 200 (got %).', p_slot_quota;
  end if;

  update public.pageguide_find_v2_settings s
  set collect_evidence = coalesce(p_collect_evidence, false),
      collect_followup = coalesce(p_collect_followup, false),
      task_limit_seconds = coalesce(p_task_limit_seconds, s.task_limit_seconds),
      queue_design = coalesce(p_queue_design, s.queue_design),
      -- All of these coalesce to the STORED value, not to a default: they are absent when the
      -- browser is older than the column, and "absent" must not read as "switch it off".
      show_group_chip = coalesce(p_show_group_chip, s.show_group_chip),
      flag_milestones = coalesce(p_flag_milestones, s.flag_milestones),
      show_reasoning_trail = coalesce(p_show_reasoning_trail, s.show_reasoning_trail),
      slot_quota = coalesce(p_slot_quota, s.slot_quota),
      updated_at = now()
  where s.singleton = true;

  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip, s.flag_milestones, s.show_reasoning_trail,
           s.slot_quota
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

-- DROP THE EIGHT-ARGUMENT VERSION, or the ninth parameter makes an overload and Postgres refuses
-- every eight-argument call with "function ... is not unique".
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean, boolean);

grant execute on function public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean, boolean, boolean, integer) to anon;


-- ── How many completed sittings each class has ──────────────────────────────
-- The same definition the Admin Results tab uses: one real session appearing in BOTH result tables
-- with every global task position 0..3 present. `question_index` is the global position even though
-- the rows live in two tables; `task_index` is the fallback for rows saved before that column.
--
-- Exposed as its own function because the Admin panel wants to SHOW these numbers and the claim
-- wants to ACT on them, and two copies of the completeness rule is how they drift apart.
create or replace function public.pageguide_find_v2_class_counts()
returns table (
  slot_class integer,
  started bigint,
  complete bigint,
  inflight bigint
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with sittings as (
    select
      (s.assignment_slot % 4)::integer as slot_class,
      s.created_at,
      (
        select count(distinct t.position)
        from (
          select coalesce(r.question_index, r.task_index) as position
          from public.pageguide_find_v2_results r
          where r.session_id = s.id
          union all
          select coalesce(g.question_index, g.task_index) as position
          from public.pageguide_guide_v2_results g
          where g.session_id = s.id
        ) t
        where t.position between 0 and 3
      ) as positions
    from public.pageguide_find_v2_sessions s
  ),
  classes as (select generate_series(0, 3) as slot_class)
  select
    c.slot_class,
    count(x.slot_class) as started,
    count(*) filter (where x.positions >= 4) as complete,
    -- STILL IN THE ROOM. A sitting that started minutes ago and has not finished yet is neither a
    -- completer nor a lost cause, and counting it as neither is what stops four people who press
    -- Start in the same minute from all being steered into the same class.
    count(*) filter (where x.positions < 4 and x.created_at > now() - interval '30 minutes') as inflight
  from classes c
  left join sittings x on x.slot_class = c.slot_class
  group by c.slot_class
  order by c.slot_class;
$$;

grant execute on function public.pageguide_find_v2_class_counts() to anon;


-- ── Claim a counterbalancing slot, honouring the quota ──────────────────────
-- Atomic, as before: the `select ... for update` takes the settings row lock, so two participants
-- pressing Start at the same moment cannot be handed the same slot or read the same tally.
create or replace function public.claim_pageguide_find_v2_session(p_participant_id text)
returns table (session_id bigint, assignment_slot bigint, condition_order text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_participant text := coalesce(nullif(btrim(p_participant_id), ''), 'anonymous');
  v_next  bigint;
  v_quota integer;
  v_class integer;
begin
  select s.next_assignment, coalesce(s.slot_quota, 0)
  into v_next, v_quota
  from public.pageguide_find_v2_settings s
  where s.singleton = true
  for update;

  if v_quota > 0 then
    -- The class furthest from its target, ties broken by the lowest class so the choice is
    -- reproducible. Null when every class is already at or over target, which falls through to
    -- plain round-robin below.
    select t.slot_class into v_class
    from public.pageguide_find_v2_class_counts() t
    where v_quota - t.complete - t.inflight > 0
    order by (v_quota - t.complete - t.inflight) desc, t.slot_class asc
    limit 1;
  end if;

  if v_class is null then
    assignment_slot := v_next;
  else
    -- The smallest slot at or after the counter that belongs to the wanted class. Never backwards:
    -- `cycle = floor(slot / 2)` also picks which claims are dealt, so rewinding would re-deal the
    -- same stimuli. The slots skipped belong to classes that are already over-filled.
    assignment_slot := v_next + ((v_class - (v_next % 4)::integer) % 4 + 4) % 4;
  end if;

  update public.pageguide_find_v2_settings
  set next_assignment = assignment_slot + 1,
      updated_at = now()
  where singleton = true;

  -- Names the cell this sitting STARTS on. The browser walks its queue from there; the label only
  -- records it, and window.FindV2Variants.deal in app/find_v2_variants.js is authoritative for the
  -- order actually shown. Change one, change the other.
  condition_order := 'v2_cycle4_from_' || case assignment_slot % 4
    when 0 then 'correct_grounding'
    when 1 then 'correct_nongrounding'
    when 2 then 'incorrect_grounding'
    else 'incorrect_nongrounding'
  end;

  insert into public.pageguide_find_v2_sessions (
    participant_id, assignment_slot, condition_order
  ) values (
    v_participant, assignment_slot, condition_order
  ) returning id into session_id;

  return next;
end;
$$;

grant execute on function public.claim_pageguide_find_v2_session(text) to anon;
