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
  where id in ('EDU-v1', 'MARS-v1', 'MUFC-V1-TEXT', 'HARRY-v1');

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
    '{correct_nongrounding,answer_text}', to_jsonb($a$The planet name that appears between "Mars" and "brightness" is **Jupiter**. The third letter of Jupiter is **P**. The isotope whose amount on Mars is five to seven times the amount on Earth is **deuterium**, as stated in the text: "The amount of Martian deuterium... is five to seven times the amount on Earth". The first letter of deuterium is **D**. Putting **P** and **D** in alphabetical order gives **DP**.$a$::text)),
    -- Wrong on the FIRST hop: it reads the planet as Earth, so the third letter is r rather than P.
    '{incorrect_grounding,answer_text}', to_jsonb($a$The planet name that appears between 'Mars' and 'brightness' is Earth, and the third letter of Earth is **r**. The isotope whose amount on Mars is described as seven times the amount on Earth is deuterium, and its first letter is **d**. Putting **r** and **d** in alphabetical order gives **dr**. [338:"Earth"] [957:"deuterium"]$a$::text)),
    -- Wrong on the OPERATION: both letters are right and the order is backwards. Previously this
    -- variant reported the wrong SUM, which was the same idea in the arithmetic the file removes.
    '{incorrect_nongrounding,answer_text}', to_jsonb($a$The planet name that appears between 'Mars' and 'brightness' is Jupiter, and the third letter of Jupiter is **p**. The isotope whose amount on Mars is described as seven times the amount on Earth is deuterium, and its first letter is **d**. Putting **p** and **d** in alphabetical order gives **pd**.$a$::text))
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

-- ── Check what you now have ──────────────────────────────────────────────────────────────────────

select id,
       answer_variants->'correct_grounding'->>'answer_text'     as correct_grounded,
       answer_variants->'incorrect_grounding'->>'answer_text'   as incorrect_grounded
from public.pageguide_find_v2_claims
where id in ('EDU-v1', 'MARS-v1', 'MUFC-V1-TEXT', 'HARRY-v1')
order by id;

-- ── Undo ─────────────────────────────────────────────────────────────────────────────────────────
-- Puts the four claims back exactly as they were, from the backup this file made:
--
--   update public.pageguide_find_v2_claims c
--   set question = b.question, answer_variants = b.answer_variants
--   from public.pageguide_find_v2_claims_backup_letter_ops b
--   where c.id = b.id;
