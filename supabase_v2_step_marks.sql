-- Find V2 Guide — participant-marked wrong steps.
-- =================================================
-- Run once in the Supabase SQL editor of the V2 project before deploying the matching website
-- code. Idempotent: existing result rows become an empty array and are otherwise unchanged.
--
-- This is deliberately separate from `guide_errors`. That older jsonb column belongs to V1's full
-- error taxonomy ({type, steps}); Find V2 asks only WHERE the run went wrong. Keeping the direct
-- answer as an integer array makes it readable in the Table Editor and lets a researcher score old
-- selections later when a task's guide_ground_truth.errors[].steps key is authored.

alter table public.pageguide_guide_v2_results
  add column if not exists marked_wrong_steps integer[] not null default '{}'::integer[];

comment on column public.pageguide_guide_v2_results.marked_wrong_steps is
  'Sorted step numbers the participant marked wrong while reviewing the Guide trajectory. Marking is available before the verdict; an explicit Yes clears the selection, while a verdict timeout may still retain marks. Empty also covers no marks and pre-migration rows. This raw response remains usable when guide_ground_truth.errors[].steps is authored later.';

-- PostgREST caches table shapes. Ask it to expose the new column immediately instead of waiting for
-- its next automatic schema refresh; harmless if the notification is ignored by a local Postgres.
notify pgrst, 'reload schema';
