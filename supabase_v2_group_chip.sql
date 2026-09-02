-- Find V2 — whether the participant is told which group they are in.
-- ==================================================================
-- Run once in the SQL editor of the V2 project, after supabase_v2_queue_design.sql. Idempotent.
--
-- The task pane carries a "GROUP A · text" / "GROUP B · visual" chip beside the condition banner. It
-- was added for the researcher's benefit — the counterbalancing half is invisible otherwise, and a
-- screenshot of a session that does not say which half it came from is hard to file.
--
-- IT IS THE WRONG THING TO SHOW A PARTICIPANT. The chip names an experimental factor they are not
-- asked about and cannot act on, and a label that says the person is in a group invites the
-- question the study most needs them not to ask: what is the OTHER group getting, and am I supposed
-- to answer differently? The condition banner is different — it says what is on the screen, which a
-- participant needs in order to read a missing screenshot as the condition rather than as a fault.
-- This one only says which arm of the design they landed in.
--
-- So it is OFF by default and switchable in Admin → Study settings, for piloting and for screenshots.
-- Like the other protocol flags it is read once when a run starts and snapshotted into the session,
-- so a participant who began without the chip finishes without it.

alter table public.pageguide_find_v2_settings
  add column if not exists show_group_chip boolean not null default false;

comment on column public.pageguide_find_v2_settings.show_group_chip is
  'Whether the task pane shows the participant which counterbalancing group (A/text, B/visual) they were assigned to. Off by default: it names a factor the participant is not asked about. Snapshotted into the session at start.';

-- DROPPED FIRST, not replaced: the function''s return type is defined by its OUT parameters, and
-- `create or replace` refuses to change one. Same reasoning as the two migrations before this.
drop function if exists public.pageguide_find_v2_study_flags();

create or replace function public.pageguide_find_v2_study_flags()
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

grant execute on function public.pageguide_find_v2_study_flags() to anon;

-- `p_show_group_chip` defaults to null meaning "leave it alone", so a browser still holding the
-- five-argument version keeps saving the other settings without silently switching the chip back on.
create or replace function public.save_pageguide_find_v2_flags(
  p_password text,
  p_collect_evidence boolean,
  p_collect_followup boolean,
  p_task_limit_seconds integer default null,
  p_queue_design text default null,
  p_show_group_chip boolean default null
)
returns table (
  collect_evidence boolean,
  collect_followup boolean,
  task_limit_seconds integer,
  queue_design text,
  show_group_chip boolean
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
      -- COALESCED TO THE STORED VALUE, not to false. The two booleans above default to false because
      -- an unchecked box is a real answer; this one is absent when the browser is older than the
      -- column, and "absent" must not read as "switch it off".
      show_group_chip = coalesce(p_show_group_chip, s.show_group_chip),
      updated_at = now()
  where s.singleton = true;

  return query
    select s.collect_evidence, s.collect_followup, s.task_limit_seconds,
           s.queue_design, s.show_group_chip
    from public.pageguide_find_v2_settings s
    where s.singleton = true;
end;
$$;

-- DROP THE FIVE-ARGUMENT VERSION. supabase_v2_queue_design.sql created
-- save_pageguide_find_v2_flags(text, boolean, boolean, integer, text); a sixth parameter with a
-- default makes an OVERLOAD rather than replacing it, and Postgres then refuses every five-argument
-- call with "function ... is not unique". The six-argument one serves those calls itself, since
-- PostgREST resolves by argument name and the sixth defaults to null.
drop function if exists public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text);

grant execute on function public.save_pageguide_find_v2_flags(text, boolean, boolean, integer, text, boolean) to anon;
