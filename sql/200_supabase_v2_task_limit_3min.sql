-- Find V2 — the per-task limit becomes three minutes, and running out no longer answers for anyone.
-- ================================================================================================
-- Run once in the SQL editor of the V2 project. Idempotent.
--
-- 1. THE DEFAULT MOVES 120 → 180. The two-minute budget was set before the Guide × Visual queue
--    existed, and that queue asks for more per task than the Find claims it was measured on: a
--    grounded run has a journey to open, chips to follow and an optional walk through the pages,
--    and a participant doing all three was reliably over the limit while doing exactly what the
--    instrument asks of them. A limit that the intended behaviour overruns is not measuring
--    deliberation, it is measuring whether somebody gave up.
--
-- 2. THE EXISTING ROW IS MOVED TOO, but only if it is still on the old default. A project whose
--    researcher has deliberately typed 240 or 90 into Admin → Study settings keeps it: this
--    migration is correcting a default nobody chose, not overriding a choice somebody made.
--
-- The column, its check constraint and the flag functions are unchanged — see
-- sql/110_supabase_v2_task_limit.sql. What running out DOES is a browser-side behaviour and needs no
-- migration: the task now folds away everything past the verdict, asks for Yes/No and waits, rather
-- than counting down five seconds and submitting a row with no judgment in it.

alter table public.pageguide_find_v2_settings
  alter column task_limit_seconds set default 180;

update public.pageguide_find_v2_settings
   set task_limit_seconds = 180,
       updated_at = now()
 where singleton = true
   and task_limit_seconds = 120;

comment on column public.pageguide_find_v2_settings.task_limit_seconds is
  'How long one task is budgeted, in seconds (30-900, default 180). A SOFT budget: at 00:00 the chip
   goes red and counts the overrun, anything past the verdict is folded away, and the task then WAITS
   for a Yes/No — nothing is submitted on the participant''s behalf and the queue does not advance.
   time_ms records what they actually took.';

notify pgrst, 'reload schema';
