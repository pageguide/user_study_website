-- Find V2 — replace the alphabet arithmetic with letter operations.
-- =================================================================
-- Run once in the SQL editor of the V2 project. Idempotent, and reversible: it copies the rows it
-- touches into a backup table first, and the last section of this file puts them back.
--
-- WHY. Four of the ten live claims ended in arithmetic: "the alphabet-position difference between
-- those two letters", "the sum of the alphabet positions". That is a second task bolted onto the
-- one being measured. A participant who finds both facts on the page and then miscounts N as 13
-- answers No to a correct claim, and the row is indistinguishable from one where the grounding
-- failed to help — which is the comparison the whole study rests on.
--
-- It also fell entirely on ONE GROUP. Every one of these is find_text, so group A did letter
-- arithmetic under a two-minute clock and group B never did. Modality is the between-subjects
-- factor, so any A/B difference was part modality and part mental arithmetic, with nothing in the
-- data to separate them.
--
-- The replacement keeps both page hops exactly as they were — the finding is still the task — and
-- changes only the final step to something checkable at a glance:
--
--   EDU-v1         the two letters spell a word          n + o -> "no"
--   MARS-v1        the two letters in alphabetical order  P + D -> "DP"
--   MUFC-V1-TEXT   the two letters in alphabetical order  B + S -> "BS"
--   HARRY-v1       already alphabetical order             S + K -> "KS"
--
-- CITATION MARKERS ARE PRESERVED VERBATIM. The [n:"phrase"] markers key the highlighting on the
-- page and the numbered chips in the answer; their ids are page offsets. Every marker below is
-- copied from the row it replaces, in the same order, so the grounded arm keeps working.
--
-- ⚠ ROWS ALREADY COLLECTED WERE ANSWERED UNDER THE OLD WORDING. A verdict on "the difference is 1"
-- and a verdict on "those two letters spell no" are answers to different questions. Analysis has to
-- split on collection date, or those earlier sessions have to be set aside. This file cannot know
-- which you intend, so it changes nothing about the results tables.

-- ── The backup ───────────────────────────────────────────────────────────────────────────────────
-- Whole rows, not just the columns touched, so a restore cannot half-succeed. Created once; a second
-- run of this file leaves the original backup alone rather than overwriting it with edited rows.

create table if not exists public.pageguide_find_v2_claims_backup_letter_ops as
  select * from public.pageguide_find_v2_claims
  where id in ('EDU-v1', 'MARS-v1', 'MUFC-V1-TEXT', 'HARRY-v1', 'NVIDA-V1', 'PEDANT-V1');

comment on table public.pageguide_find_v2_claims_backup_letter_ops is
  'The four claims as they stood before supabase_v2_letter_ops.sql replaced their alphabet arithmetic. Restore instructions are at the bottom of that file.';

-- ── MARS-v1 · sum of positions → alphabetical order ──────────────────────────────────────────────

update public.pageguide_find_v2_claims set
  question = $q$On this page, there is a sentence where a planet name appears between “Mars” and “brightness.” Take **the third letter of that planet’s name**.
Then find the isotope whose amount on Mars is described as seven times the amount on Earth. Take **the first letter of that isotope**.
Put **the two letters** in alphabetical order. What two-letter string do they form?$q$,
  answer_variants = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    answer_variants,
    '{correct_grounding,answer_text}', to_jsonb($a$The planet name that appears between “Mars” and “brightness” is **Jupiter** [1051:"Jupiter"]. The third letter of Jupiter is **P**. The isotope whose amount on Mars is five to seven times the amount on Earth is **deuterium** [990:"deuterium"], as stated in the text: "The amount of Martian deuterium... is five to seven times the amount on Earth" [985:"The amount of Martian deuterium (D/H = 9.3 ± 1.7 10−4) is five to seven times the amount on Earth"]. The first letter of deuterium is **D**. Putting **P** and **D** in alphabetical order gives **DP**.$a$::text)),
        -- The SAME punctuation as the grounded arm, curly quotes included. The two differed only in
    -- “Mars” versus "Mars", which is invisible in a diff and still a difference between the arms.
    '{correct_nongrounding,answer_text}', to_jsonb($a$The planet name that appears between “Mars” and “brightness” is **Jupiter**. The third letter of Jupiter is **P**. The isotope whose amount on Mars is five to seven times the amount on Earth is **deuterium**, as stated in the text: "The amount of Martian deuterium... is five to seven times the amount on Earth". The first letter of deuterium is **D**. Putting **P** and **D** in alphabetical order gives **DP**.$a$::text)),
    -- Wrong on the FIRST hop: it reads the planet as Earth, so the third letter is r rather than P.
    --
    -- MARKERS INLINE, NOT TRAILING. This variant used to end "...gives **dr**. [338:"Earth"]
    -- [957:"deuterium"]" — both markers dangling after the final full stop. Stripping them for the
    -- non-grounded arm left a trailing space, so the two arms were not the same string, and in the
    -- grounded arm the chips came out attached to nothing: a reference is only useful next to the
    -- claim it backs. Anchored to "Earth" and "deuterium", the way the correct variant is written,
    -- the non-grounded text is now this same sentence with the markers removed and nothing else.
    '{incorrect_grounding,answer_text}', to_jsonb($a$The planet name that appears between 'Mars' and 'brightness' is Earth [338:"Earth"], and the third letter of Earth is **r**. The isotope whose amount on Mars is described as seven times the amount on Earth is deuterium [957:"deuterium"], and its first letter is **d**. Putting **r** and **d** in alphabetical order gives **dr**.$a$::text)),
    -- THE SAME WRONG ANSWER, WITHOUT THE EVIDENCE. An earlier draft of this file gave the two arms
    -- two different errors — the grounded one misread the planet, the non-grounded one put the right
    -- letters in the wrong order. That is two stimuli, not one claim in two conditions: a
    -- participant in the non-grounded arm would have been judging a different mistake, and the
    -- comparison the arms exist for would have been between claims rather than between conditions.
    '{incorrect_nongrounding,answer_text}', to_jsonb($a$The planet name that appears between 'Mars' and 'brightness' is Earth, and the third letter of Earth is **r**. The isotope whose amount on Mars is described as seven times the amount on Earth is deuterium, and its first letter is **d**. Putting **r** and **d** in alphabetical order gives **dr**.$a$::text))
where id = 'MARS-v1';

-- ── MUFC-V1-TEXT · position difference → alphabetical order ──────────────────────────────────────

update public.pageguide_find_v2_claims set
  question = $q$On this page, there is the sentence that lists three cups that Manchester United won and four clubs that won before Manchester United. In that sentence, identify the two-word club name. Take **the first letter of that club name**.
Then find **the nationality** of the person who became Manchester United manager in 1986. Take **the first letter of that nationality**.
Put **the two letters** in alphabetical order. What two-letter string do they form?$q$,
  answer_variants = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    answer_variants,
    '{correct_grounding,answer_text}', to_jsonb($a$The sentence identifies the three cups as the Champions League, Europa League, and Cup Winners' Cup [1668:"European Treble"], and lists four clubs that won them before Manchester United: Ajax [1667:"Ajax"], Juventus [1669:"Juventus"], Bayern Munich, and Chelsea. The two-word club name in that list is Bayern Munich, which starts with the letter 'B'. The person who became manager in 1986 was Alex Ferguson [1459:"Alex Ferguson"], who is Scottish [1461:"Scotland"]. The first letter of his nationality, Scottish, is 'S'. Putting **B** and **S** in alphabetical order gives **BS**.$a$::text)),
    '{correct_nongrounding,answer_text}', to_jsonb($a$The sentence identifies the three cups as the Champions League, Europa League, and Cup Winners' Cup, and lists four clubs that won them before Manchester United: Ajax, Juventus, Bayern Munich, and Chelsea. The two-word club name in that list is Bayern Munich, which starts with the letter 'B'. The person who became manager in 1986 was Alex Ferguson, who is Scottish. The first letter of his nationality, Scottish, is 'S'. Putting **B** and **S** in alphabetical order gives **BS**.$a$::text)),
    -- Wrong on the FIRST hop: it names Manchester United as the two-word club, so M rather than B.
    '{incorrect_grounding,answer_text}', to_jsonb($a$The two-word club name is "Manchester United" [65:"Manchester United Football Club"] [73:"Man United"]. The first letter of this club name is 'M'. The nationality of the person who became Manchester United manager in 1986 is Scottish [1502:"Scotland"] [1503:"Scotland"] [1504:"Alex Ferguson"], so the first letter of the nationality is 'S'. Putting **M** and **S** in alphabetical order gives **MS**.$a$::text)),
    '{incorrect_nongrounding,answer_text}', to_jsonb($a$The two-word club name is "Manchester United". The first letter of this club name is 'M'. The nationality of the person who became Manchester United manager in 1986 is Scottish, so the first letter of the nationality is 'S'. Putting **M** and **S** in alphabetical order gives **MS**.$a$::text))
where id = 'MUFC-V1-TEXT';

-- ── EDU-v1 · the question already asks for the word; three answers had not caught up ─────────────
-- `correct_grounding` was already written for the word form and only loses a typo ("The word of that
-- those two letters make up"). The other three still reported an alphabet-position difference, so a
-- participant read a question about a word and an answer about arithmetic.

update public.pageguide_find_v2_claims set
  answer_variants = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    answer_variants,
    '{correct_grounding,answer_text}', to_jsonb($a$The noun appearing between the words 'alternative' and 'encompasses' is 'education' [281:"Alternative education encompasses"]. The last letter of 'education' is **n**. The third university listed as having emerged during the medieval era is 'Oxford University' [766:"Oxford University"], following the University of Bologna [764:"University of Bologna"] and the University of Paris [765:"University of Paris"]. The first letter of 'Oxford University' is **o**. Those two letters make up the word **no**.$a$::text)),
    '{correct_nongrounding,answer_text}', to_jsonb($a$The noun appearing between the words 'alternative' and 'encompasses' is 'education'. The last letter of 'education' is **n**. The third university listed as having emerged during the medieval era is 'Oxford University', following the University of Bologna and the University of Paris. The first letter of 'Oxford University' is **o**. Those two letters make up the word **no**.$a$::text)),
    -- Wrong on the FIRST hop, as before: the noun is read as 'approach', giving h instead of n.
    '{incorrect_grounding,answer_text}', to_jsonb($a$The noun appearing between 'alternative' and 'encompasses' is 'approach', so its last letter is **h**. The third university listed from the medieval era is Oxford University, so its first letter is **o** [281:"approach", 766:"Oxford University"]. Those two letters make up the word **oh**.$a$::text)),
    '{incorrect_nongrounding,answer_text}', to_jsonb($a$The noun appearing between 'alternative' and 'encompasses' is 'approach', so its last letter is **h**. The third university listed from the medieval era is Oxford University, so its first letter is **o**. Those two letters make up the word **oh**.$a$::text))
where id = 'EDU-v1';

-- ── HARRY-v1 · already the right operation, and wrong in two places ──────────────────────────────
-- Not an arithmetic change. Two authoring bugs found while reading the four variants:
--
--   1. `correct_grounding` answered "SK". S and K in alphabetical order are **KS** — so the variant
--      keyed CORRECT gave the wrong string, and a participant who did the task properly was scored
--      as having missed a correct answer.
--   2. `correct_nongrounding` said "the second name" and listed a different set of names from the
--      grounded variant. The same claim described the page differently depending on the arm, which
--      is a second difference between the arms that nothing in the design accounts for.

update public.pageguide_find_v2_claims set
  answer_variants = jsonb_set(jsonb_set(
    answer_variants,
    '{correct_grounding,answer_text}', to_jsonb($a$The sentence in which Harry's assumptions are challenged lists five distinct names: Harry, Quirrell, Snape, Voldemort, and Dumbledore. The third name in this sentence is Snape [368:"Quirrell is on the side of good because he opposes Snape"], and its first letter is 'S'. The author who praised Rowling's work as a "feat" is Stephen King [580:"Stephen King called the series "]. The first letter of his last name is 'K'. Putting 'S' and 'K' in alphabetical order gives the two-letter string **KS**.$a$::text)),
    '{correct_nongrounding,answer_text}', to_jsonb($a$The sentence in which Harry's assumptions are challenged lists five distinct names: Harry, Quirrell, Snape, Voldemort, and Dumbledore. The third name in this sentence is Snape, and its first letter is 'S'. The author who praised Rowling's work as a "feat" is Stephen King. The first letter of his last name is 'K'. Putting 'S' and 'K' in alphabetical order gives the two-letter string **KS**.$a$::text))
where id = 'HARRY-v1';

-- ── NVIDA-V1 · "which word contains those letters" → the two-letter string ───────────────────────
--
-- The old final step was not the same kind of question as the others. "Which word that contains
-- those letters in the following?" asks the participant to pick a word from a list that is not on
-- the page, and the authored answer — 'Sugar' contains g and S — is true of a great many words. A
-- claim whose correct answer is not unique cannot be judged wrong on the evidence.
--
-- ⚠ THE LETTERS HERE ARE g AND S, WHICH SPELL NO WORD. So this one cannot take EDU-v1's "what word
-- do those two letters make up?" phrasing — there is no word to name, and asking for one would make
-- the correct answer unanswerable. It takes the alphabetical-order form that MARS-v1 and
-- MUFC-V1-TEXT use instead, which is the same one-glance operation and does have a single answer.
--
-- To use the word form here, one of the two hops has to change so the letters spell something. The
-- second hop is the candidate: the last listed director's employer is S-Cubed Capital, and any hop
-- landing on an o, an n or a t would give "go", "gn"… — worth authoring deliberately rather than
-- guessing at from here.

update public.pageguide_find_v2_claims set
  question = $q$On this page, there is a sentence where a person’s name appears between “2026” and “AI.” Take **the last letter of that person’s last name**.
Then find the last listed director’s current employer. Take **the first letter of that employer**.
Put **the two letters** in alphabetical order. What two-letter string do they form?$q$,
  answer_variants = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    answer_variants,
    '{correct_grounding,answer_text}', to_jsonb($a$The person's name that appears between '2026' and 'AI' is Jensen Huang [1158:"Jensen Huang"], and the last letter of his last name is **g**. The last listed director is Mark Stevens [813:"Mark Stevens"], whose current employer is S-Cubed Capital [813:"S-Cubed Capital"], and the first letter of that employer is **S**. Putting **g** and **S** in alphabetical order gives **gS**.$a$::text)),
    '{correct_nongrounding,answer_text}', to_jsonb($a$The person's name that appears between '2026' and 'AI' is Jensen Huang, and the last letter of his last name is **g**. The last listed director is Mark Stevens, whose current employer is S-Cubed Capital, and the first letter of that employer is **S**. Putting **g** and **S** in alphabetical order gives **gS**.$a$::text)),
    -- Wrong on BOTH hops, as it already was: it reads the name as Nebius and the employer as Eli
    -- Lilly. The opening "The two-letter string is HT" is dropped — HT followed from neither hop,
    -- so the answer contradicted itself before a participant had read a word of the page.
    '{incorrect_grounding,answer_text}', to_jsonb($a$The sentence in question is: "On March 11, 2026, Nvidia announced that it will invest $2 billion in artificial intelligence cloud company Nebius." [720: "On March 11, 2026, Nvidia announced that it will invest $2 billion in artificial intelligence cloud company Nebius."] The last letter of "Nebius" is **s**. The last listed director's current employer is "Eli Lilly and Company" [861: "Eli Lilly and Company"], and its first letter is **E**. Putting **s** and **E** in alphabetical order gives **Es**.$a$::text)),
    '{incorrect_nongrounding,answer_text}', to_jsonb($a$The sentence in question is: "On March 11, 2026, Nvidia announced that it will invest $2 billion in artificial intelligence cloud company Nebius." The last letter of "Nebius" is **s**. The last listed director's current employer is "Eli Lilly and Company", and its first letter is **E**. Putting **s** and **E** in alphabetical order gives **Es**.$a$::text))
where id = 'NVIDA-V1';

-- ── The two arms must differ in grounding and in NOTHING ELSE ────────────────────────────────────
--
-- Checked across all ten live claims, comparing each pair with the citation markers stripped the way
-- app/find_citations.js strips them for the non-grounded arm:
--
--   INCORRECT pair — 2 of 10 differ beyond the markers: PEDANT-V1 and HARRY-v1.
--   CORRECT   pair — 5 of 10 differ: PEDANT-V1, SVSF-V1, TREE-V1, TESLA-V1, MARS-v1.
--
-- This section fixes the two INCORRECT ones. The correct pair is a different repair and is left
-- alone here; see the note at the end of this file.
--
-- WHAT WENT WRONG, in both cases the same way. The non-grounded variant was written by hand from the
-- grounded one, and the phrase inside a marker was left behind as prose:
--
--   grounded      …is titled *El pedante* by Francesco Belo [45:"the first play in which a pedant
--                 takes a central role, El pedante"].
--   non-grounded  …is titled *El pedante* by Francesco Belo the first play in which a pedant takes a
--                 central role, El pedante.
--
-- That is not a cosmetic difference. The marker's quote is the page phrase the answer rests on, and
-- the non-grounded arm exists to withhold exactly that — so the arm that is supposed to show LESS
-- was showing the evidence spelled out in the prose, while the grounded arm showed it only behind a
-- numbered chip. The manipulation was inverted for those two claims.
--
-- Both are set to the grounded text with the markers removed, which is what the renderer produces
-- for every other claim.

update public.pageguide_find_v2_claims set
  answer_variants = jsonb_set(
    answer_variants,
    '{incorrect_nongrounding,answer_text}', to_jsonb($a$The play where the pedant assumes an important part is titled *El pedante* by Francesco Belo. In the decorative border directly below the portrait, there are books and flowers, but specific details about what appears there are not provided in the text or the screenshot.$a$::text))
where id = 'PEDANT-V1';

update public.pageguide_find_v2_claims set
  answer_variants = jsonb_set(
    answer_variants,
    '{incorrect_nongrounding,answer_text}', to_jsonb($a$The second letter of the second name in the sentence is "K". The author who praised Rowling's work as a feat was Stephen King. The first letter of his last name is "K". When these two letters are put in alphabetical order, they form the two-letter string "KK".$a$::text))
where id = 'HARRY-v1';

-- ── The same check, as a query you can re-run ────────────────────────────────────────────────────
-- Any row this returns is a claim whose two arms differ in more than their markers. It should come
-- back empty for the incorrect pair once the statements above have run.

with stripped as (
  select id,
         regexp_replace(regexp_replace(
           coalesce(answer_variants->'incorrect_grounding'->>'answer_text', ''),
           '\[\s*[0-9]+\s*:\s*"[^"]*"(\s*,\s*[0-9]+\s*:\s*"[^"]*"\s*)*\]', '', 'g'),
           '\[ev:[^\]]*\]', '', 'g') as g,
         coalesce(answer_variants->'incorrect_nongrounding'->>'answer_text', '') as ng
  from public.pageguide_find_v2_claims where in_study
)
select id, g, ng from stripped
where regexp_replace(trim(regexp_replace(g, '\s+', ' ', 'g')), '\s+([.,])', '\1', 'g')
   is distinct from
      regexp_replace(trim(regexp_replace(ng, '\s+', ' ', 'g')), '\s+([.,])', '\1', 'g');

-- ── Check what you now have ──────────────────────────────────────────────────────────────────────

select id,
       answer_variants->'correct_grounding'->>'answer_text'     as correct_grounded,
       answer_variants->'incorrect_grounding'->>'answer_text'   as incorrect_grounded
from public.pageguide_find_v2_claims
where id in ('EDU-v1', 'MARS-v1', 'MUFC-V1-TEXT', 'HARRY-v1', 'NVIDA-V1', 'PEDANT-V1')
order by id;

-- ── Undo ─────────────────────────────────────────────────────────────────────────────────────────
-- Puts the four claims back exactly as they were, from the backup this file made:
--
--   update public.pageguide_find_v2_claims c
--   set question = b.question, answer_variants = b.answer_variants
--   from public.pageguide_find_v2_claims_backup_letter_ops b
--   where c.id = b.id;

-- ── STILL OUTSTANDING: the CORRECT pair on five claims ───────────────────────────────────────────
-- PEDANT-V1, SVSF-V1, TREE-V1, TESLA-V1 have the same leftover-phrase problem in their correct
-- variants, and MARS-v1 differs only in curly versus straight quotation marks.
--
-- Those four are NOT a copy-and-strip fix, because the grounded text put the phrase INSIDE the
-- marker rather than before it — so stripping leaves a hole in the sentence:
--
--   grounded (TREE-V1)   In the [1:"Portrait of a Carthusian (1446) by Petrus Christus"], a small
--                        fly appears on the lower ledge.
--   stripped             In the, a small fly appears on the lower ledge.
--
-- The repair is to the GROUNDED text: the phrase belongs in the prose with the marker appended after
-- it, the way every working claim is written —
--
--   In the Portrait of a Carthusian (1446) by Petrus Christus [1:"Portrait of a Carthusian (1446) by
--   Petrus Christus"], a small fly appears on the lower ledge.
--
-- — after which the non-grounded arm is the same sentence with the marker removed, and reads
-- correctly on its own. Left out of this file because it changes what the GROUNDED arm shows, which
-- is a stimulus change worth making deliberately rather than as a tidy-up.

-- ── One more trailing marker, left alone ─────────────────────────────────────────────────────────
-- TESLA-V1's incorrect_grounding ends with [ev:tesla_lighting_demo] after the final full stop. That
-- one is defensible as written — an image reference for the answer as a whole rather than for a
-- phrase in it — and its two arms already match once markers are stripped, so it is not touched
-- here. Worth moving next to the sentence about the lecture image if that claim is ever re-authored.
