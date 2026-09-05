-- Find V2 — the four dealt runs, rewritten as checklists.
-- ======================================================
-- Run once in the SQL editor of the V2 project, AFTER sql/180_supabase_v2_guide_name.sql. Re-runnable.
--
-- A DATA CHANGE, NOT A SCHEMA ONE. Nothing here alters a table or a function; it rewrites the `goal`
-- of the four Guide × Visual runs the study currently deals, and gives each a short `title` for the
-- Admin lists. Everything it does can also be done by hand in Admin → Guide tasks → Rename this
-- task, which is where a fifth run should be reworded.
--
-- WHY. The goal is the sentence a participant is asked to judge against — their entire verdict is
-- "did the agent do THAT?" — and these were written as one long sentence with two or three
-- requirements folded into it. Under a three-minute clock the participant's first job became
-- parsing the instruction rather than checking the run. As a numbered list the judgement becomes
-- what it should be: a checklist, run against a trajectory.
--
-- THE MEANING IS UNCHANGED. Every requirement below is one that was already in the sentence, in the
-- order it was already in. Nothing is added, nothing is dropped, and no run's answer key moves — a
-- run that completed the job still completed it, and one that did not still did not.
--
-- THE SYNTAX is app/study.js's questionHtml: a line before the first "1." is the lead-in, "1." and
-- "2." are requirements, "A." and "B." are sub-requirements of the one above, and **double asterisks**
-- mark the hinge that carries from one requirement to the next. A goal with none of those markers
-- renders exactly as it always did, so nothing not listed here changes shape.

-- 1 · correct × grounded — the pickleball paddle
update public.pageguide_guide_v2_tasks set
  title = 'Pickleball paddle, around Wednesday''s schedule',
  goal = 'I need to buy a pickleball paddle.
1. Check what time I am free on **Wednesday** to go to Walmart.
2. On the Walmart website, find:
A. The cheapest pink pickleball paddle
B. The cheapest green pickleball paddle',
  updated_at = now()
where id = 'gv2-mtlo1j6u-5eo35d';

-- 2 · incorrect × non-grounded — Meditation, then Sportplex
update public.pageguide_guide_v2_tasks set
  title = 'Sportplex after Friday''s Meditation',
  goal = 'I want to go to Sportplex after Meditation on Friday.
1. On recwellness.auburn.edu, check what time **Meditation on Friday** ends.
2. Tell me whether I can still make it to Sportplex after that.',
  updated_at = now()
where id = 'gv2-mtkdnzau-y0qghc';

-- 3 · correct × non-grounded — campus parking
update public.pageguide_guide_v2_tasks set
  title = 'Closest parking to Samford Hall and RBD',
  goal = 'I need to park near two places on campus.
1. Find the closest parking spot to **Samford Hall**.
2. Find the closest parking spot to the **RBD Library**.',
  updated_at = now()
where id = 'gv2-msf0vpxs-qucehj';

-- 4 · incorrect × grounded — second-floor facilities
--
-- READ THIS ONE BEFORE RUNNING IT. The original — "the total number of restrooms and water fountains
-- on the second floor" — can be read as one combined figure or as two. The agent answered it as two
-- ("2 restrooms and 6 water fountains"), and the split below matches that reading, which is the one
-- the run is keyed against. It is the only rewrite here that settles an ambiguity rather than just
-- reformatting a sentence. To keep the ambiguity instead, replace the goal with the original line:
--
--   Find the total number of restrooms and water fountains on the second floor.
update public.pageguide_guide_v2_tasks set
  title = 'Second-floor restrooms and water fountains',
  goal = 'I need to know what is on the **second floor**.
1. Find the total number of restrooms on that floor.
2. Find the total number of water fountains on that floor.',
  updated_at = now()
where id = 'gv2-mthpps9o-zalawk';

select id, title, goal from public.pageguide_guide_v2_tasks
where id in ('gv2-mtlo1j6u-5eo35d', 'gv2-mtkdnzau-y0qghc', 'gv2-msf0vpxs-qucehj', 'gv2-mthpps9o-zalawk');
