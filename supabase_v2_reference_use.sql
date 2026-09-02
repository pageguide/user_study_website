-- Find V2 — did the participant actually open the references?
-- ==========================================================
-- Run once in the SQL editor of the V2 project. Idempotent.
--
-- RUN THIS BEFORE DEPLOYING THE MATCHING JS. insertStudyResult and insertGuideResult POST the result
-- row verbatim, with no column whitelist (see the comment in app/find_v2_supabase.js) — so a row
-- carrying a column the table does not have is rejected WHOLE. The participant would lose the
-- result, not just the new field.
--
-- WHY THIS EXISTS. The grounded arm's premise is that the agent's evidence is there to check:
-- citation chips in the answer, highlighted passages in the page, a screenshot behind every step.
-- Nothing recorded whether anyone touched it. Without that, grounded and non-grounded coming out
-- equal has two opposite readings — grounding does not help, or nobody looked — and no way to tell
-- them apart. These four columns are the manipulation check.
--
-- A chip click was already invisible in the existing telemetry rather than merely uncounted: Find
-- chips sit in the question pane and land in `panel_click_count`, Guide chips sit in the stimulus
-- pane and land in `website_click_count`, neither distinguishable from any other click.

do $$
declare
  t text;
begin
  foreach t in array array['pageguide_find_v2_results', 'pageguide_guide_v2_results']
  loop
    -- Deliberate opens: citation chips, the 📎 evidence chips, marked passages in the page, journey
    -- and trail rows, and the before/after state buttons.
    execute format('alter table public.%I add column if not exists reference_click_count integer', t);
    -- Previews held past the dwell threshold. Counted apart from clicks because hovering IS how the
    -- Guide viewer is meant to be read, and merging the two would hide which gesture was used.
    execute format('alter table public.%I add column if not exists reference_hover_count integer', t);
    -- How many DIFFERENT references were touched. Ten clicks on one chip is not ten checks.
    execute format('alter table public.%I add column if not exists reference_distinct_count integer', t);
    -- Milliseconds from the task opening to the first open of either kind. Null when there was none —
    -- the one genuine null here, because no first event happened.
    execute format('alter table public.%I add column if not exists reference_first_ms integer', t);
  end loop;
end $$;

-- NULLABLE AND NOT DEFAULTED TO ZERO, matching the five counts beside them: a row whose
-- instrumentation never started observed nothing, and a 0 would average in as a participant who
-- looked at nothing.
--
-- But a zero that IS observed stays zero. A grounded participant who opened no reference had the
-- chance and took it nowhere, which is the finding — not missing data. Whether references were
-- available at all is already determined by `condition`, so analysis splits on that rather than
-- reading a null as "not offered".
comment on column public.pageguide_find_v2_results.reference_click_count is
  'Deliberate reference opens during the task: citation chips, evidence chips, marked passages in the page. NULL means no telemetry; 0 means the participant opened none. Split by `condition` — the non-grounded arm has none to open. Per-kind breakdown is in interaction_summary.';
comment on column public.pageguide_find_v2_results.reference_first_ms is
  'Milliseconds from task start to the first reference opened, click or dwelled hover. NULL when none was ever opened. Says whether the evidence was checked BEFORE the verdict or not at all.';
comment on column public.pageguide_guide_v2_results.reference_click_count is
  'Deliberate reference opens during the task: answer chips, underlined phrases, journey and trail rows, before/after state buttons. NULL means no telemetry; 0 means the participant opened none. Note the state buttons render in BOTH arms, so a non-grounded Guide row can legitimately be non-zero.';
comment on column public.pageguide_guide_v2_results.reference_first_ms is
  'Milliseconds from task start to the first reference opened, click or dwelled hover. NULL when none was ever opened.';
