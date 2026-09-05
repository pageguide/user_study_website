# PageGuide user study — browser version

Runs the Guide half of the study from a URL, with nothing to install. A participant reviews what a
web agent did and says whether it got the task right, and if not, where it went wrong.

Two panes, mirroring the extension:

- **left — the material.** What the agent did: the before/after page states, every step, the answer
  it gave and its reasoning trail. Hover a step for the page it was looking at; click for full size.
- **right — the instrument.** The task, one timer, and the questions. Styled as the PageGuide side
  panel it stands in for.

## The rule this repo turns on

`vendor/guide_trajectories.js` is a **verbatim copy** of `sidepanel/guide_trajectories.js` from the
extension. It holds the question vocabularies (`GUIDE_PROBLEM_TYPES`, `GUIDE_ERROR_TYPES`), the
arm-stripping (`_stripGuideArm`) and the scoring (`_scoreGuideAnswer`).

Never edit it here. If the site reimplemented any of that, the two clients would drift — an id that
differs by a character scores as a different answer — and nothing would fail until analysis, with
the data already collected.

```bash
./scripts/sync-vendor.sh          # check the copy is current
./scripts/sync-vendor.sh --write  # update it from the extension
```

Run the check before every deploy — and this one with it:

```bash
node scripts/check-page-scripts.mjs
```

Every page loads its JavaScript as classic `<script src>` tags, which share **one global lexical
scope**. Two files that each declare a top-level `const REFERENCE_DWELL_MS` are fine apart and fatal
together: the duplicate is a parse error, so the second file never runs — not one function of it —
and there is no exception to catch. The page renders its static shell and stops, with both panes
sitting on their "Loading…" placeholders and every request in the Network tab returning 200. That is
how it presents: as a slow network, not as a dead page. The script concatenates each page's scripts
in load order and parses the result the way the browser would.

## Setup

**1. Create the tables.** In the Supabase SQL editor, run `supabase_schema.sql` from the pageguide
repo, then run `sql/002_supabase_results_v2.sql` from this repo. The first script creates the stimuli tables;
the second creates the clean browser-result table this site writes to.

> An insert naming a column the table lacks is rejected **whole**, and the failure is logged and
> swallowed — the study keeps running while nothing reaches Supabase. Run the SQL before the next
> participant, not after.

**2. Set up the publish helper.**

```bash
cp .env.example .env
# fill in SUPABASE_URL and SUPABASE_SECRET_KEY (sb_secret_… from Project Settings → API)
node scripts/publish.mjs --serve
```

The secret key lives in `.env` and never leaves that terminal. It cannot go in the browser at all:
Supabase refuses it from any browser context —

> `401 "Forbidden use of secret API key in browser"`

— and a Chrome side panel is a browser. That is why publishing is split in two: the extension builds
the bundle, this helper does the privileged write.

**3. Publish.** With the helper running, in the extension: ⋯ → 🧭 Record Guide User Study →
**⬆ Publish to web**. It publishes both halves — guide trajectories and the Find questions, answers
and ground truth — and reports per table. Only trajectories ticked for inclusion are sent.

No terminal to hand? **⬇ Export instead** writes the same bundle to a file:

```bash
node scripts/publish.mjs ~/Downloads/study_stimuli.json
```

**4. Configure the site.**

```bash
cp app/config.example.js app/config.js
# fill in SUPABASE_URL and SUPABASE_ANON_KEY
```

The **anon** key is the only key that belongs here — this file is served to participants, so treat
everything in it as public. The secret key belongs in `.env`, read only by the publish helper.

**5. Serve.**

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Any static host works: GitHub Pages, Netlify, Cloudflare Pages. There is no build step.

## Find V2 — correct and incorrect agent answers

**Find V2 is the default study.** It is what `index.html` serves and what `study.html` runs. The
original V1 study is unchanged and still reachable at `find-v1.html` (task page
`find-v1-study.html`), linked from the corner of the V2 welcome screen. The old `find-v2.html` and
`find-v2-study.html` URLs redirect to the new ones so existing pilot links keep working.

V2 does not reuse V1's Supabase URL, browser session, stimulus tables, result table, or
multiple-choice scoring. Participants see one recorded agent answer and answer **Yes** or **No** to
“Does the agent's answer correctly answer the question?” The evidence questions remain, so grounded
versus non-grounded can still be compared.

### The four authored answers

Each V2 claim is one question about one page, carrying **four** hand-written agent answers:

|                | Grounded                     | Non-grounded                 |
| -------------- | ---------------------------- | ---------------------------- |
| **Correct**    | `correct_grounding`          | `correct_nongrounding`       |
| **Incorrect**  | `incorrect_grounding`        | `incorrect_nongrounding`     |

Each cell has its own answer text **and its own references** (citation anchors and saved visual
evidence), because an incorrect answer is not a correct answer with the citations deleted, and a
non-grounded answer is not a grounded one with the brackets stripped. Both are study variables, so
both are written rather than derived.

Which cell a participant is dealt is counterbalanced on **both** axes from their assignment slot:
variant `(slot + position in queue) % 4` walks correct/grounded → correct/non-grounded →
incorrect/grounded → incorrect/non-grounded. The arm therefore flips every task and the answer key
flips every second task, so a single queue is balanced within a participant and four consecutive
slots cover every cell of every claim. The verdict is scored against **the answer that was shown**,
recorded in `variant_key`, not against a fixed property of the claim row.

### Configure the blank `PageGuideUserStudy` Supabase project

1. In the new project's SQL editor, run all of `sql/001_supabase_find_v2.sql`.
2. In the same SQL editor, set the password that authorizes the V2 Admin editor:

   ```sql
   select public.set_pageguide_find_v2_admin_password('replace with a long private password');
   ```

3. Copy the example config and add the new project's URL and **publishable/anon** key:

   ```bash
   cp app/find_v2_config.example.js app/find_v2_config.js
   ```

4. Serve the repo and open `http://localhost:8000/` — Find V2 is the default page.

## Deploying

`.github/workflows/deploy.yml` publishes the site to GitHub Pages on every push to `main`. It writes
both config files at deploy time, because both are gitignored — they hold credentials and must not
live in the repo. Four repository secrets are required (Settings → Secrets and variables → Actions),
and the deploy fails loudly without them rather than publishing a site that reaches no database:

| Secret | What it is |
| --- | --- |
| `SUPABASE_URL` | the V1 project's Project URL |
| `SUPABASE_ANON_KEY` | the V1 project's anon / publishable key |
| `SUPABASE_URL_V2` | the **Find V2** project's Project URL |
| `SUPABASE_PUBLISH_KEY_V2` | the Find V2 project's publishable / anon key |

The V2 pair is the one the front door needs: `index.html` is Find V2, and a deploy without it shows
"Find V2 is waiting for its new Supabase project" with a Start button nobody can press. There is
deliberately no fallback to the V1 secrets — a site pointed at the wrong project does not fail, it
runs, reads no claims, and writes results where nobody will look for them.

Anon keys only. The secret key belongs in `.env` on the researcher's machine, read by
`scripts/publish.mjs`; Supabase refuses it from a browser anyway.

Every schema change is one idempotent SQL file in [`sql/`](sql/), and the number in the name is the
order they are applied in — `sql/README.md` is the index, with what each one adds and what it needs
first. On a project that has only ever run `sql/001_supabase_find_v2.sql`, run these in order in the
same SQL editor:

| File | What it adds |
| --- | --- |
| `sql/000_supabase_v2_init.sql` | the V2 tables, the admin password gate, and the item writers |
| `sql/010_supabase_v2_flags.sql` | the protocol switches (`collect_evidence`, `collect_followup`) |
| `sql/020_supabase_v2_guide.sql` | the Guide task: `arms`, the `agent_completed` answer key, and `save_pageguide_guide_v2_meta` |
| `sql/030_supabase_v2_arms.sql` | builds `arms` from what the recorder writes, so a recorded run is not a blank stimulus |
| `sql/040_supabase_v2_faithfulness.sql` | `claims_completion`, which separates a false success from an honest failure |
| `sql/050_supabase_v2_failure_mode.sql` | `failure_mode` on Guide results, and a publish gate that accepts both ground-truth dialects |
| `sql/060_supabase_v2_failure_mode_editor.sql` | lets Admin classify *why* a run is keyed incorrect |
| `sql/070_supabase_v2_anchors.sql` | citation anchors for Find references |
| `sql/080_supabase_v2_answer_edit.sql` | lets the reference reviewer delete a citation, not only re-link it |
| `sql/090_supabase_v2_reference_use.sql` | did the participant open the references? Run it **before** deploying the matching JS |
| `sql/100_supabase_v2_step_marks.sql` | `marked_wrong_steps` — step numbers a participant marks while reviewing a Guide task |
| `sql/110_supabase_v2_task_limit.sql` | the per-task time limit, as a setting rather than a constant |
| `sql/120_supabase_v2_queue_design.sql` | `queue_design` — which queue a sitting is dealt (see below) |
| `sql/130_supabase_v2_group_chip.sql` | `show_group_chip` — whether a participant is told which group they are in (off by default) |
| `sql/140_supabase_v2_milestone_flag.sql` | `flag_milestones` — whether the Guide journey flags the trail's steps (on by default) |
| `sql/150_supabase_v2_reasoning_trail.sql` | `show_reasoning_trail` — whether a Guide task shows the agent's own account of the run (off by default) |
| `sql/160_supabase_v2_recruit_quota.sql` | `slot_quota` and `pageguide_find_v2_class_counts` — recruiting to a per-class target instead of plain round-robin (see below) |
| `sql/170_supabase_v2_task_picker.sql` | the `guide_visual_4` queue (four fixed Guide × Visual runs, no round robin), `task_selection` for the per-cell picker behind it, `allow_browse_sim` / `browse_sim_delay_ms` for the browse simulator, and `post_survey_url` for the questionnaire (all below). Safe to re-run: it drops each earlier arity of the flags writer before recreating it |
| `sql/180_supabase_v2_guide_name.sql` | a Guide task's name and instruction become editable from Admin |
| `sql/190_supabase_v2_guide_steps.sql` | hiding and deleting steps of a run, with every step reference renumbered |
| `sql/200_supabase_v2_task_limit_3min.sql` | the per-task budget becomes three minutes |

Then, optionally: `sql/900_supabase_v2_letter_ops.sql` and `sql/910_supabase_v2_guide_briefs.sql`
rewrite live stimulus text (both reversible, both documented in their own headers), and
`sql/950_supabase_v2_local_time.sql` adds views that read `created_at` in Alabama local time.

**"Could not find the function … in the schema cache"** on Save means exactly one thing: the browser
is ahead of the project. PostgREST resolves functions **by argument name**, so a page that sends
`p_task_selection` to a database still holding the nine-argument writer gets back a list of twelve
parameter names and no hint which are new. Run the migration the message names — Admin now says which
one instead of showing the raw error. Nothing is saved when this happens, and the app deliberately
does not retry without the new fields: a save that half happened and reported success is worse than
one that failed.

Then, once per batch of imported runs:

```bash
node scripts/migrate_guide_v2.mjs      # copy V1's recorded Guide runs across (optional)
node scripts/classify_guide_runs.mjs   # fill claims_completion from how each answer opens
```

## Which queue a participant is dealt

Three designs, chosen in **Admin → Study settings**, read once when a sitting starts and snapshotted
into the session — a switch flipped mid-run cannot make task 4 belong to a different experiment from
task 1.

- **Crossed 2 × 2** (`balanced_2x2`, the default) — four tasks, one per cell: Find × Grounded,
  Find × Non-grounded, Guide × Grounded, Guide × Non-grounded. Correctness alternates cell by cell
  and sitting by sitting, so every participant sees two correct runs and two incorrect ones and no
  cell is stuck on one answer. Group A is text throughout, group B visual: modality stays
  between-subjects while task type and grounding are both within.
- **Three Find cells + one grounded Guide task** (`legacy_find3`) — what V2 shipped with. Find deals
  three of its four correctness × grounding cells (there is deliberately no correct-and-grounded Find
  task) and the Guide task is grounded only, so nothing in it estimates grounding for the Guide half.
- **Four Guide × Visual runs** (`guide_visual_4`, added by `sql/170_supabase_v2_task_picker.sql`) — four
  tasks, all Guide, all visual, **the same four for everyone**:

  | # | task | answer | condition |
  | --- | --- | --- | --- |
  | 1 | Guide × Visual | Correct | Grounded |
  | 2 | Guide × Visual | Incorrect | Non-grounded |
  | 3 | Guide × Visual | Correct | Non-grounded |
  | 4 | Guide × Visual | Incorrect | Grounded |

  **No round robin.** `assignment_slot` still numbers the sitting — it is the session's identity and
  the recruitment counter's — but it no longer selects anything. No Find claim is dealt and there is
  no text group, so correctness and grounding are both fully within-subjects and *every* cell's n is
  simply the number of completed sittings. Nothing can be short of anything else, which is why
  `slot_quota` has nothing left to level under this design.

  The order is not correct / correct / incorrect / incorrect on purpose: consecutive tasks differ in
  correctness, so nobody can settle into answering the same way twice or read task 3's answer off
  task 2's.

  What this design gives up is the thing the other two are built on. The stimulus is no longer
  crossed with the condition, so **a difference between cells is a difference between four
  particular runs as much as between four conditions**. The four have to be chosen to be comparable
  by hand, which is what **Admin → Study tasks** is for, and per-cell accuracy has to be reported as
  a claim about *these four runs*.

### Admin → Study tasks — one screen for what the study is made of

`in_study` already existed on both pools, but it lived at the bottom of two long authoring forms:
deciding what the study *contains* meant opening eleven of them and holding the tally in your head.
The **Study tasks** tab shows the set instead — both pools as checklists, the cells the current
design deals, and which task fills each cell, with the gaps named before a participant finds them.

**It lists only what the current design can actually deal.** Under `guide_visual_4` that means the
Guide pool shows *only* `guide_visual` runs and the Find section is not drawn at all — both are
choices that could not take effect, and a screen whose job is "decide what the study contains" must
not present them, because ticking one and seeing nothing change is how somebody concludes the picker
is broken. What is left out is counted and named rather than silently dropped ("2 Guide × Text runs
are not listed…"), the rows are untouched in their own authoring tabs, and they come back the moment
the design changes.

Two kinds of decision, kept apart on the screen because they are different facts:

- **In the pool** — `in_study` on the row. Under a rotating design this is the whole choice: the
  queue walks whatever is live.
- **In this cell** — a pin in `pageguide_find_v2_settings.task_selection`. Only a fixed design needs
  one, though a rotating design accepts one too, where it overrides that cell and leaves the rotation
  to fill the rest.

`task_selection` is keyed **by design**, so switching designs to look at one does not throw the
other's choices away:

```json
{ "guide_visual_4": ["ms9j3200", "…", "…", "…"],
  "balanced_2x2":   { "A": [null, null, "…", null], "B": [ … ] } }
```

A missing or `null` entry means *not pinned* — that cell falls back to the rotation its design
already had, so a half-filled selection degrades to the old behaviour rather than to a short queue.
It is deliberately **not** a foreign key: untick a task and every pin to it goes stale, and a stale
pin should show up in Admin as a named gap someone can fix, not as a write that fails at 2am. A cell
whose pin no longer resolves is drawn in red and falls back; the tab also warns when one run would
fill two cells, since a participant who reads the same trajectory twice has answered the second one
before seeing it.

Nothing is written until **Save** is pressed, and the pool writes go before the pins — a pin is only
meaningful if the task it names is dealt, so a failure part-way leaves a pool that is right and pins
that are still the old ones. Only rows that actually changed are written, and a claim is re-read in
full first (`getClaim`) because the claim writer replaces the whole row and the list query leaves out
`page_html`.

### Admin → Guide tasks → **View** — one run on the real task screen

Each Guide task card carries **View ↗** and **non-grounded ↗** beside Save and Inspect. They open
`study.html?task=<id>&arm=<arm>`, which plays that one run through `showTask` — the real two panes,
the condition banner, the journey, the answer card in the question pane, the opening lock, the walk.

It is not what **Inspect** shows, and both are worth having. Inspect is a researcher's table of the
material: both arms' answers side by side, the evidence keyed to its steps, the recorded errors —
the right view for *keying* a task. View answers the different question of what a participant will
actually be looking at.

A dry run in every sense that matters: no session row, no assignment slot, and `saveStudyResult`
refuses to write because `dryRun` is set. It can therefore be answered through to the end, which is
the point — a preview you cannot finish cannot tell you whether finishing works. It reads the pool
with `listAllGuideTasks` rather than the live-only query, because a run being previewed is very often
one that is not live yet; that is usually what is being decided.

### Admin → The four cells — the fixed queue, previewed as it is dealt

**Only on the tab strip when `queue_design` is `guide_visual_4`**, and that is the point rather than
a limitation: under a rotating design "the four tasks" is not a thing that exists, because the slot
decides which run fills each cell, so the honest answer is per-participant and the screen could only
lie about it. The fixed design is what makes *what is everyone about to see?* a question with one
answer.

Four collapsible cards, one frame open at a time, each rendered in **the arm that cell is actually
dealt in** — cell 1 grounded, cell 2 non-grounded, and so on — with the Study settings switches
applied, so it is the screen as it will be dealt rather than a neutral rendering of the material.
Each card says whether its run is pinned or is the fallback (and, if a pin went stale, which pin),
whether the browse simulator is offered there, and whether the run's own answer key disagrees with
the cell's label. It resolves through `buildGuideVisualQueue`, the same function the study deals
with, so a falling-back cell shows the run it will really fall back to rather than the one somebody
meant to pin.

This is not **Guide arms** with a filter. That tab takes *one* run and shows *both* arms, to study
the difference between the conditions; nobody is ever shown that grid. This one shows the four
screens a participant really meets, in order.

### Admin → Guide arms — both conditions, side by side, both live

The grounded and non-grounded arms of a Guide run *are* the independent variable, and everything that
matters about them is a difference: which chips survive, which step rows lose their screenshot, what
the answer says once its `[ev:…]` markers are stripped. Comparing them by changing a dropdown and
remembering the first one is the one thing memory is worst at. This tab renders both at once, and
both are fully live — hover a grounded step for its screenshot, press the non-grounded pane's
simulate button and the walk opens. It is where the simulator gets checked before a participant meets
it. Nothing on the screen is recorded.

Each pane is an **iframe** over `guide-arm.html`, which is not a decoration: `app/stimulus.js` keeps
the mounted arm in module-level state and marks the non-grounded condition with a class on
`document.body`, so two mounts in one document silently become one arm shown twice — rendering
correctly and behaving as a single arm, which is the worst possible outcome for a screen whose whole
job is to show the difference. A frame each gives both panes their own document and their own copy of
the renderer, unchanged.

### Four classes, and why a class count is a cell n

Under the crossed design `assignment_slot % 4` decides everything about a sitting. `slot % 2` picks
the between-subjects modality (even = group A, text; odd = group B, visual) and
`Math.floor(slot / 2) % 2` picks the correctness sequence, because `crossedCorrect` reads the
cycle's **parity**. There are therefore **two** sequences, not four:

| `slot % 4` | group | task 1 · Find | task 2 · Find | task 3 · Guide | task 4 · Guide |
| --- | --- | --- | --- | --- | --- |
| 0 | A · text | correct / grounded | incorrect / non-grounded | incorrect / grounded | correct / non-grounded |
| 1 | A · visual | correct / grounded | incorrect / non-grounded | incorrect / grounded | correct / non-grounded |
| 2 | B · text | incorrect / grounded | correct / non-grounded | correct / grounded | incorrect / non-grounded |
| 3 | B · visual | incorrect / grounded | correct / non-grounded | correct / grounded | incorrect / non-grounded |

Four consecutive slots fill every Find cell and every Guide cell exactly once, so two people cover
the four Find cells and four people cover all sixteen cells of the study. The consequence worth
holding on to:

> **The number of completed sittings in a class is, identically, the n of four Find cells and four
> Guide cells.** There is no separate Find recruitment and Guide recruitment — one number per class
> levels both halves at once.

Two things this design does *not* control, which belong in a write-up rather than in the counts:
grounding is confounded with task order (the grounded task always precedes the non-grounded one
within each task type), and a cell is confounded with its position (a correct-and-grounded Find
trial is always task 1). Removing either means a reversed cell order — an eight-class design — which
is not what is shipped.

## The answer sits in the question pane

The agent's answer used to be a section in the left pane, between the journey and the trail. It is
the claim being judged, so it now sits in the **right pane, directly above Q1** — a participant
re-reading the sentence they are about to say Yes or No to no longer has to scroll away from the Yes
and the No to do it.

**In both arms.** Layout is not a condition, and a pane arrangement that differed by arm would be a
second variable riding along with grounding.

It is still rendered by `app/stimulus.js` (`answerSectionHtml` / `bindAnswerNode`), not rebuilt in
`study.js`, because the markup is arm-dependent in a way that is easy to get subtly wrong: the
grounded arm numbers the surviving `[ev:…]` markers into chips and underlines the linked phrases, and
the non-grounded arm does neither. A second copy of that rule in the question pane is a second thing
to get wrong, and the two would disagree silently. The chips stay live in their new home — the hover
card and the step walk work there exactly as they did beside the journey.

The two single-pane admin views (**Guide arms**, **The four cells**, and `guide-arm.html` generally)
still draw the answer inside the stage, because they have no second pane to put it in.

## A step shows the page it produced, not the page before it

The recorder captures each step's screenshot as the page it was looking at **when it decided to
act**, so `steps[i].screenshot` is the state *before* step i runs. Rendered next to step i's own
instruction that read as an off-by-one, and not subtly: *"Click on the search icon to search for RBD
Library"* sat beside a picture of the Samford Hall panel, which is where the previous step had left
the page.

A step now displays the **next** step's capture — the same pixels the recorder took one moment
later, which is the page once this action had landed. The last step falls back to `final_state`,
which is exactly the page after the last action, so the shift closes cleanly at both ends rather than
leaving the final step blank. The walk applies the same shift (a walk labelling its pages differently
from the rows they were reached from would be worse than the bug it fixed), and drops its trailing
"After the agent finished" frame when the last step already displays that image.

**Nothing is re-saved** — this is a display rule and only a display rule, in `shotAt`/`shotForStep`.
The stored trajectory is untouched and this is revertible by deleting one function. It assumes
pre-action capture throughout; a run recorded post-action would be pushed one the other way, which is
worth checking on any trajectory imported from a different recorder.

## Editing a task's wording mid-study

A task renamed in Supabase shows up everywhere on the next read. Three things make that true, and
each of them used to be false in a different way:

- **The task screen prefers the freshly-fetched record over the queue snapshot.** `showGuideV2Task`
  re-reads the trajectory for every task, so `record.goal` is whatever the database says right now;
  the queue in `localStorage` was written when the run was dealt and never re-read. The snapshot used
  to win, so a participant who pressed Start before an edit saw the old wording for the rest of their
  sitting and a researcher fixing a typo could not reach the people it was confusing.

  This is deliberately *not* the same decision as the queue snapshot itself. **Which** run a
  participant is dealt must not change mid-sitting — that would put two experiments in one session.
  What the task is *called* is not the experiment; it is the instruction, and the current instruction
  is always the right one to show. The result row stores the goal **as displayed** (`goalText`), so a
  rename cannot make earlier rows ambiguous about which wording they were answered under.

- **Admin re-reads on every tab open.** *Session preview* and *Guide arms* used to fetch once and
  keep the list for the life of the page, so a renamed task kept its old title until somebody
  happened to reload — in the two tabs whose whole job is showing what a participant will see. The
  query is list columns only (no `arms`, so no screenshots), so paying for it each visit costs
  nothing worth saving.

- **Every cached read is dropped on Leave Admin.** Admin is where the database is *changed*, so a
  list that outlives one visit is a list that can describe the study as it was before the last edit.

Requests already send `cache: 'no-store'`, so nothing is served from the HTTP cache.

## What the arms differ in

The grounded arm is the **checkable journey**, and everything that makes a step checkable travels
together:

| | Grounded | Non-grounded |
| --- | --- | --- |
| **Milestone flags** | the steps the trail narrates are marked, with a legend saying those can be checked instead of the whole journey | none |
| **Hover a step** | the page it was looking at when it acted | nothing |
| **Click a step** | that page full size **and paged from there** — Back and Next walk the run without leaving the overlay, with no delay — plus a line under the legend saying so | nothing |
| **The agent's answer** | in the **right pane**, above Q1 | in the right pane too — layout is not a condition |
| **Evidence chips in the answer** | numbered, and they open what the agent saw | none, and the `[ev:…]` markers are stripped from the prose |
| **Before / after page states** | shown in **both** — the arms differ in whether each *action* can be checked, not in whether the outcome is known | |
| **Steps, order, wording, answer, trail, browse simulator** | identical | |

The milestone flags used to render in both arms. That made them a fifth thing the non-grounded
participant was handed, and a signpost to a door that is not there: a flagged row they cannot open is
a line of text like every other row, and the legend inviting them to "check these rather than viewing
the entire journey" invited them to check something uncheckable. Moving the flags into the grounded
bundle makes the manipulation wider than "the screenshots are missing", deliberately —
`flag_milestones` still switches them off for the grounded arm when a condition wants the journey
unmarked.

### Expanding a step is a walk, not a dead end

Clicking a step in the grounded journey used to open one picture in a lightbox: to see the step
before it you closed the box, found the previous row, and clicked again. That is three gestures to
answer *"and what did the page look like a moment earlier?"* — which is most of what checking a step
consists of, since a screenshot means little except against the one beside it.

It now opens the **same walker the simulate-browsing button uses**, positioned at the step that was
clicked, so the pages either side are one press away. One walker behind both doors, because two
overlays that page through the same screenshots with subtly different rules would be two sets of
behaviour to keep in step, and the participant is not told which one they are in.

**The step route has no delay, and that is not an inconsistency.** The button's delay *is* the study
variable — the cost of going to look, deliberately imposed. Expanding a step is the grounded arm's
own affordance, already paid for by the click, and the paging is just "and the one after that";
charging half a second there would tax the condition rather than measure it. At zero the move is
applied synchronously rather than deferred a tick, so the second half of an ordinary double-click is
not thrown away by the drop-don't-queue rule that protects the delayed route.

Paging done this way is recorded as `interaction_summary.step_walk` (`{opens, moves}`), **separate
from `browse_sim`**. They are two gestures — "I am going to look through this run" versus "I want a
closer look at this one" — and the step route exists in the grounded arm whether or not the study
offers the simulator at all. Pooling them would let a study with the button switched off still report
browse-simulator activity.

An item that is not a step the walk contains — an evidence chip with no recorded step number, a
before/after bookend opened from its own card — still opens the plain lightbox. A walk of one frame
with both buttons dead would be a lightbox wearing a costume.

## The browse simulator — the run as browsing, in both arms

A Guide task shows what the agent did as a list of steps. `allow_browse_sim`
(`sql/170_supabase_v2_task_picker.sql`, **Admin → Study settings**, default on) adds a button above the
journey that turns that list back into the browsing it describes — the run as a slideshow, one page
state per step, walked with Back and Next, arrow keys as well as the buttons, and a click on the page
for the full-size view without losing your place.

**It is offered in both arms**, which makes it a constant of the study rather than part of what
separates the conditions — see *What the arms differ in* below. That makes its usage a behavioural
measure *directly comparable across the arms*, which it could never be while only one of them had the
button: "did grounding change how much people went and looked?" is now a question the data can answer.

**It opens on the last page and travels backwards.** The task is to judge a claim about an outcome,
and the outcome is where the run ends: starting at page 1 asks a participant to replay the whole run
forwards and hold it in their head until they reach something that bears on the answer, while
starting at the end puts the state the agent is describing on screen first and makes every press of
Back ask the question that matters — *how did it get here, and does that support what it said?* The
buttons keep their ordinary meaning (Back is earlier in the run, Next is later), so opening at the
end simply opens with Next spent and Back live; nothing is relabelled.

**Each move takes `browse_sim_delay_ms`, 500ms by default** — the *How long a simulated page takes to
load* field in Admin → Study settings, between 0 and 5000. Browsing is not instant, and at 0 the
buttons scrub: a fourteen-step run empties in a second with no page on screen long enough to read.
During the wait the page being *left* stays up and dims while the bar goes indeterminate, which is
what a browser does; a press that lands inside it is **dropped, not queued**, so a held arrow key
cannot bank up a dozen moves that play out after the key is released.

It is a setting rather than a constant because it is the one number here that changes what the
instrument *measures*. The walk's whole subject is the **cost of looking** — the difference between
the evidence being available and being worth going to get — and that cost is mostly this number.
Half a second a page is a guess until a pilot says otherwise, so it is a dial rather than a decision
baked into the code.

**It is a manipulation, not a convenience, and it is worth being blunt about what it does.** Opened
and walked to the end, a non-grounded participant has seen every screenshot a grounded one was shown.
What still differs is the **cost and the deliberateness**: grounding puts the evidence beside each
claim, where checking one step is a hover; the simulator makes them decide to go and look, then find
the step they want. The arms stay distinguishable, but "non-grounded" stops meaning "the evidence was
unavailable" and starts meaning "the evidence was not to hand". That is a defensible condition and it
is not the one V2 ran before the button, so it is switchable and its use is recorded.

Two rules the renderer owns rather than its callers:

- **The pictures come from the record, never from `arm`.** In the non-grounded arm `arm` is the
  stripped copy and its step screenshots are all `null` by design. Un-stripping it to fill the
  slideshow would put them back into the journey as well and quietly end the condition.
- **The bookends are part of the walk, a screenshot-less step is not.** "Before the agent started"
  and "after it finished" are already shown in both arms, so including them costs the condition
  nothing — and a walk that ends at step 1 rather than at the opening state would stop short of the
  comparison a participant is making. A step the recorder captured nothing for is skipped rather
  than drawn blank.

Usage lands in each Guide result row's `interaction_summary.browse_sim` — no new columns, because
that column already holds everything about *how* a participant worked through a task and the
questions about this one are not settled yet:

```json
{ "offered": true, "frames": 14, "opens": 1, "moves": 9,
  "nearest_page": 1, "pages_back": 13, "reached_first": true, "first_open_ms": 8412 }
```

The three position fields are measured **backwards**, because that is the direction the walk runs.
`nearest_page` is the earliest page reached, 1-based against `frames`: it equals `frames` for someone
who opened the walk and never pressed Back, and `1` for someone who retraced the whole run.
`pages_back` is the same fact as a count of pages actually walked, and `reached_first` is the
all-the-way-back flag. They replace an earlier `furthest` / `reached_end` pair rather than
reinterpreting it — the walk used to start at page 1 and those names meant the opposite thing, so
keeping them would have left every row ambiguous about which direction it was recorded under.

It is **absent** on any session the study did not offer the button to, and a **zeroed object** on one
that had it and left it alone. Those are different facts and only the second is about the
participant: a session that never pressed it judged the run from what was on the page, which is the
condition the study ran before the button existed, and can be analysed as one.

## Recruiting to a target

The queue deals the four classes evenly. **Who finishes does not**, and plain round-robin preserves
a shortfall rather than closing it: hand out 13–14 of each class, get back 7 / 4 / 9 / 8 completed
sittings, and the Find × Visual correct-grounded cell sits at n = 4 beside a non-grounded neighbour
at 8. Recruiting more people under round-robin keeps that ratio.

`sql/160_supabase_v2_recruit_quota.sql` adds `slot_quota`, the target number of **completed** sittings per
class, set in **Admin → Study settings**. Above 0, `claim_pageguide_find_v2_session` deals the class
furthest from the target instead of the next one in line, by skipping the counter forward to the next
slot of that class. It never rewinds: `cycle = floor(slot / 2)` also picks *which* claims are dealt,
so going backwards would re-deal the same stimuli to a later participant. The slots it skips belong
to classes that are already over-filled. **0 is off** — plain round-robin, exactly as before.

Under `guide_visual_4` this whole mechanism is **inert**: every sitting is dealt the same four runs,
so every completed sitting is an n of 1 in all four cells and no class can be behind another. The
setting is left switchable rather than removed, so that going back to a rotating design does not
silently lose the target.

A sitting started in the last 30 minutes and not yet finished counts as *in flight* and is subtracted
from the deficit alongside the completers, so a group of people who press Start in the same minute
are not all steered into the same class.

**Admin → Results opens with a Recruitment balance panel** built on the same
`pageguide_find_v2_class_counts()` the dealer calls — the panel that shows the standings and the
claim that acts on them must not carry two copies of the completeness rule. It reports, per class,
sittings started / completed / in flight, what is still owed, and how many people to run for it at
the observed completion rate; then the Find and Guide per-cell n now and at target; then what the
finished dataset looks like. It always counts completed sittings, whatever the "Completed sittings
only" checkbox says, because a partial sitting fills no cell and counting one would under-state what
is still needed. With no target set it levels every class up to the fullest one.

The panel reads *started* from the sessions table rather than from the result rows, because a sitting
that pressed Start and answered nothing leaves no result row at all — a completion rate computed from
results alone would read 100%.

Its last line is a cross-check rather than a count: `pickGuideFor` settles for a Guide run of the
wrong correctness when a style's pool has none of the wanted one, which would unbalance the Guide
half without moving any class count. Any cell that disagrees with its class is named. Recruiting
cannot fix that one; authoring the missing run can.

## The post-study questionnaire

The form the final screen links to and embeds. It used to be a constant in `app/study.js` with an
`app/find_v2_config.js` override, so changing it meant a code edit and a deploy — the wrong shape for
the one URL most likely to change while a study is running. It is now `post_survey_url` in the
settings row, with a field in **Admin → Study settings**.

**Blank means "use the built-in", never "no survey".** An empty box falls through to the config file
and then to the address compiled into the page, so the last step of the study cannot be removed by
clearing a text field — a missing final step looks exactly like a finished study to everyone except
the person reading the responses.

**It is read at the end, not snapshotted at Start.** The protocol flags must not change mid-run
because they change what a task asks; this is reached once, after the last task, and the right form is
whichever one is current then. A run resumed days later must not post into a form that has since been
replaced. That is the one setting on that tab whose change reaches people already answering, and the
save confirmation says so.

**Prefer the long address over a `forms.gle` short link.** `?embedded=true` is what strips Google's
page chrome from the frame, and a short link is a 302 — a redirect does not carry a query string
forward, so the parameter is dropped and the final screen embeds the full Google Forms page inside
itself. It still works and a participant can still submit, which is why Admin *warns* rather than
refusing: it is a cosmetic cost with an easy fix. Google offers the long form under
**Send → the link tab → untick "Shorten URL"**.

## The walkthrough

Offered once, before task 1, on a browser that has not seen it — and skippable from anywhere. Two
practice tasks, one Find and one Guide, rendered by the study's own screens so what is rehearsed is
the thing that comes next rather than a diagram of it. Each is followed by the answer and why.

**A sitting that deals no Find task gets no Find practice.** Under `guide_visual_4` the walkthrough
is one practice task, the intro card promising "a saved webpage" is not drawn, and every count that
follows — the progress label, Back, and the "Done — start task 1" button — follows from the shorter
queue. The rule it obeys is the one the milestone flag already obeys: a walkthrough must not teach a
screen the study then withholds, and the Find practice would otherwise spend a participant's first
two minutes on a layout, a question and a set of gestures they never meet again, leaving them
waiting for a page that never arrives.

The test is the **dealt queue**, not `queue_design`: "will this participant meet a Find task?" is
answered directly by what they are about to be shown, and going via the design flag would be a second
derivation of the same fact — one that reads wrong for a run resumed from a session saved before the
design was recorded. The admin preview is the one case with no dealt queue (it builds none on
purpose), so **Admin → Walkthrough** passes the design in the URL:
`study.html?tutorial=preview&design=…`.

**The verdict is locked for the first five seconds** of every Find V2 task (`ANSWER_LOCK_MS`). Yes/No
is one click away from the moment a task opens, and a participant who wants to be finished can answer
before the page has finished rendering — producing a row that looks like a judgment and is a coin
flip. During the lock the radios are disabled, the Submit button is disabled, and **the button counts
itself down** ("Submit in 3s"), because the one place someone is looking when they press Submit is the
button. It used to say so only in a line of grey text beside the radios while the button itself stayed
solid purple with a live hover and `cursor: pointer` — genuinely disabled, but looking and feeling
pressable, so a click that did nothing read as the study being broken rather than as being early.
`.q-btn:disabled` now has a muted state and the hover rules are gated on `:not(:disabled)`.

On the Guide practice and every real Guide task, a small **Mark wrong** control is visible on every
Journey row from the start. Participants can mark problems while reviewing, before choosing their
Yes/No verdict; multiple steps are allowed, and step marking remains optional after a No verdict.
Choosing Yes clears contradictory marks. Real Guide results store the sorted selection in
`pageguide_guide_v2_results.marked_wrong_steps`. If a task already has
`guide_ground_truth.errors[].steps`, the existing `score_step_*` fields are filled immediately. If
not, the raw selection is still retained so it can be scored after that ground truth is added.

The material is invented (`app/find_v2_tutorial_fixtures.js`): a community pool timetable that no
real stimulus touches, and not the library V1's walkthrough uses, so somebody who has done both
studies does not meet the same practice twice. A practice answer builds no row, writes nothing and
never advances the queue, so the real study still begins at task 1. Both practice tasks are grounded
and the non-grounded arm is explained in words — the one thing practice must not teach is that a
missing screenshot means you did something wrong.

One verdict of each kind, deliberately: the Find practice is a correct answer and the Guide practice
is a run that finishes, sounds certain, and reports a booking reference its own steps never produced.

Admin → Study settings has **Preview the walkthrough** (`study.html?tutorial=preview&design=…`, which
claims no assignment slot) and a button to clear the "already seen" mark on that browser.

**There are three practice tasks now: Find, Guide × grounded, and Guide × non-grounded.** The
non-grounded arm used to be explained in a sentence and met for the first time on a scored task, so a
participant's first encounter with a journey that has no screenshots was one where their answer
counted. It is a *different run*, not the same one with the pictures removed — showing one trajectory
twice would let the second answer be recalled rather than worked out.

It also fails in a way that arm can actually catch. The grounded practice misreports what a
screenshot shows, which is the right lesson there and an unfair one without the screenshot; the
non-grounded practice claims an action it never took, and the step list says so in words (four steps,
none of them a calendar). The correct verdict is reachable from the text alone, which is exactly the
skill the non-grounded arm asks for. Grounded comes first, so the arm *with* the evidence is met
before the one without it — otherwise the missing screenshots read as a fault rather than as the
condition. Under `guide_visual_4` the Find practice drops and the two Guide practices remain.

The walkthrough also rehearses the browse simulator, for free: the walk is offered in both arms, so
every Guide practice carries the same button the real tasks do.

Switching designs mid-study splits the collected rows into two experiments. `queue_design` defaults
to the crossed design for every project, including one that has already collected sittings under the
old one — `sql/120_supabase_v2_queue_design.sql` ends with the one-line update that pins such a project back
to `legacy_find3`.

`sql/030_supabase_v2_arms.sql` matters for any run recorded through the extension rather than migrated from
V1. `app/stimulus.js` reads only `arms.{grounding,nongrounding}.{steps, answer, trail, …}`, and the
recorder's writer used to fill `trajectory` and `answer_variants` and leave `arms` empty — so the run
played as an empty stimulus while the Admin card still reported its step count, which is counted off
`trajectory`. The file teaches the writer to derive `arms` on every save and backfills the rows saved
before it. Re-running it is a no-op.

Do not put a secret/service-role key in `find_v2_config.js`. Admin saves go through a
password-checked Supabase function; results are also read through that function and have no direct
anon SELECT policy.

### Author V2 claims

Open **Admin → Edit claims** (the Admin button on the default page). A row is one question with its
four answers. The editor can:

- create a new claim or duplicate an existing one, all four answers included;
- write each of the four answers in its own tab, with its own citation markers and references —
  the tab strip is the authoring checklist, and a hollow dot is a cell not yet written;
- choose how the answer key is dealt: **Counterbalanced** (needs all four answers), **Always
  correct**, or **Always incorrect** (each needs only its own two);
- choose Find × Text or Find × Visual, queue order, and whether the claim is live;
- upload the saved page HTML and edit the shared evidence ground truth.

New and duplicated claims start held out, and a partially written claim saves fine while held out —
that is how a claim gets authored one cell at a time. Going **live** additionally requires a
question, URL, saved page HTML, and an answer for every cell the claim can be dealt. That last rule
is enforced in the browser *and* again in `save_pageguide_find_v2_claim`, so an authoring gap cannot
reach a participant as a blank agent answer.

The V2 schema creates three plainly separated data tables:

- `pageguide_find_v2_claims` — editable stimuli, their four authored answers, and how the key is dealt;
- `pageguide_find_v2_sessions` — one counterbalanced sitting per participant;
- `pageguide_find_v2_results` — Yes/No verdicts, the `variant_key` shown, scores, evidence choices,
  timing, and telemetry.

The Admin **Results** tab summarizes verdict accuracy overall, by arm, and **by each of the four
cells** — accuracy on a correct answer is the false-alarm rate, accuracy on an incorrect one is the
catch rate, and grounding should move the second without moving the first.

The same V2 Results tab merges Find and Guide rows by `session_id` to show how many participants
submitted anything, how many completed all four V2 tasks, and how many stopped part-way. Completed
means the same non-null session appears in both tables with task positions 0, 1, 2, and 3. Open
**Filter out V2 participants** to uncheck individual sittings; every V2 summary, table, chart and
significance test is redrawn without them. **Completed sittings only** is a standing filter that
holds out every partial sitting and keeps doing so after a reload, so a cell's n cannot quietly grow
by an abandoned session — it is the one to use before reading a rate, and the write-up should say
which of the two counts a number came from. **Exclude all incomplete** does the same as a one-off
edit, leaving individual sittings free to be re-admitted by hand. **Include everyone** clears both.

`sql/001_supabase_find_v2.sql` is safe to re-run: on a project that already ran an earlier version it adds
the new columns and lifts each existing single answer into the matching variant, pinning that row's
`correctness_mode` so it keeps behaving exactly as before until it is re-authored. V1 continues
to use `study_*` tables and `app/config.js` exactly as before.

## Assigning conditions

Participants are assigned by the Supabase RPC in `sql/002_supabase_results_v2.sql`, not by URL. When a
participant presses Start, `claim_study_assignment` atomically claims the next round-robin slot and
creates the `study_sessions` row. Each participant sees 8 tasks:

- grounded: the slot's Find x Text, Find x Visual, Guide x Text, and Guide x Visual tasks
- non-grounded: the next slot's task from each of those four styles, wrapping within each style

Run `sql/002_supabase_results_v2.sql` before deploying this version; it adds the assignment counter, session
metadata columns, and the claim RPC. `ARM_ASSIGNMENT` remains only as a fallback for old debug paths.

## What lands in the database

One `study_sessions` row per participant, one `study_task_results_v2` row per task. Rows are upserted
by a stable `result_key`, so a double-click on submission updates the same task row instead of
creating a duplicate. Rows are written as each task finishes, so a participant who closes the tab
three tasks in leaves three rows behind.

Guide rows carry the raw answer (`guide_answer_correct`, `guide_answer_problems`, `guide_errors`)
and their score against the trajectory's ground truth (`score_*`), computed client-side by the
vendored scorer. Find rows carry `answer_correct` plus evidence scores against `study_ground_truth`.
Guide scores stay in two groups, never averaged:

| | |
|---|---|
| **detection** | `score_verdict_correct`, `score_problem_*` — did they notice it went wrong? |
| **localization** | `score_type_*`, `score_step_*`, `score_no_error_agreement` — can they find where? |

`null` means *not scored* — no ground truth recorded, or nothing to be precise about — and never
zero. An unfinished stimulus must not read as a participant who got everything wrong.

That is the V1 protocol. **Find V2's Guide task starts with one binary verdict**, in these exact
words:

> **Did the agent successfully complete the task?**
>
> **Yes** — It did the whole job, and its answer matches what it actually did.
> **No** — It did not finish the job, **or** its answer claims something that did not happen.

The options name both failure modes deliberately. A run can fall short of the job, or it can finish
and misdescribe what it saw, and the second is the item the Guide condition exists to measure —
the answer reads clean and only the trajectory contradicts it. Asked as "did the agent complete the
task?", a participant had no way to know that a fluent, confident, fabricated answer was a **No**,
so the wording served that item worst of all.

If the participant chooses **No**, one lighter localization question follows: “Which step or steps
went wrong?” They may optionally mark those numbers directly on the Journey rows, or submit without
marking a step. The study still asks no second
outcome verdict: a second key derived from the two facts already stored
(`claims_completion = agent_completed`) would land every live run on the diagonal and measure
nothing without either re-admitting the excluded honest failures or re-keying the successes.

**Why/type** a run is incorrect is not asked, because the recorder already wrote it down.
`app/find_v2_guide_key.js` reads `guide_ground_truth` and classifies each run as `none`,
`misreported`, `incomplete`, `could_not_complete` or `unspecified`, and the mode is snapshotted onto
each result row as `failure_mode` — snapshotted, not joined, because the ground truth is editable
and a verdict is only interpretable against the classification that was live when it was shown.
Accuracy is then reported per mode and, like detection and localization above, **never averaged**:

| | |
|---|---|
| **misreported** | the answer claims what the trajectory does not support — only checking the steps reveals it |
| **incomplete** | the job was part done — readable from the outcome alone |

Grounding should move the first without needing to move the second.

That module is also the only place that reads across **two live ground-truth dialects**: runs
migrated from V1 carry `correctness: 'success'|'failure'`, runs saved by the extension recorder carry
`correct: boolean`, and `problems[]` contains a `wrong_result` id that
`vendor/guide_trajectories.js` does not declare.

## Known gap

Behaviour counts (`scroll_user_count`, `ctrl_f_count`, `mouse_move_px`, …) come from the extension's
content script watching the live page. The browser website cannot observe a participant's other
tabs, so those legacy fields are intentionally not part of `study_task_results_v2`.

## Reading the dashboard

The Visualizations tab opens with **the four questions, at a glance** — one card per facet, because
the study asks four questions and their answers can point four different ways:

| | The question | What leads | The guardrail |
|---|---|---|---|
| **Find × Text** | does grounding verify an on-page answer faster? | time to locate | accuracy |
| **Find × Visual** | same, when the answer needs the visuals | time to locate | accuracy |
| **Guide × Visual** | how does visual evidence support step-by-step checking? | error-type and step recall | time, accuracy |
| **Guide × Text** | how does textual evidence support it? | error-type and step recall | time, accuracy |

The guardrail is what stops a win being claimed on one number: faster but less accurate is not a
win, and neither is better localization bought with a drop in verdict accuracy. A cell under
`MIN_CELL_N` still shows its direction, marked *too early to call* — withholding it entirely invites
somebody to recompute it by hand without the caveat.

### Rerun analysis

The card carries a **↻ Rerun analysis** button that asks a model to read the numbers out and say
what they mean — the part arithmetic can't do. It runs on the rows currently in view, on demand
(never on render: a request per keystroke in the search box would spend real money), and the result
is kept so a filter change puts it back rather than paying for it twice.

It goes through the local publish helper, not the browser:

```bash
# .env — the same file the Supabase secret lives in, and for the same reason
OPENROUTER_API_KEY=sk-or-v1-…
OPENROUTER_MODEL=google/gemini-3-flash-preview   # the default; any id from openrouter.ai/models

node scripts/publish.mjs --serve           # prints the admin token, and whether analysis is on
```

An LLM key is a spending credential, and `app/config.js` is served to every participant — a key
there would be a public key. So the dashboard posts to `127.0.0.1:8790/admin/analysis`, gated by the
same admin token the canned-response editor uses, and the helper holds the key. Without the key the
helper says so on startup and the button reports it; everything else still works.

**What crosses the wire is aggregates**: per-facet means and counts, the same numbers the cards
draw. No participant ids, no session ids, no raw rows. The participants' free-text notes are the one
field that could carry something personal, so they are sent only when the checkbox beside the button
is ticked, and the panel says which of the two it was. The answer is rendered as a quotation, not as
a result — it is a summary to check, and the charts remain the data.

`task_style` is what splits those facets, and it is written per row as `guide_text` / `find_visual`
/ … If the column is missing from the table, `insertStudyResult` drops it and saves the row anyway
(the answer is worth more than a label), so the dashboard says so at the top and falls back to the
stimulus each row came from. Run the `alter table … add column if not exists task_style text;` from
`sql/002_supabase_results_v2.sql` to fix it at the source.

### Publishing the figure code

`figures_code/` holds a matplotlib version of every figure the dashboard draws — the five paper
figures plus the two post-study Likert charts — each reading the CSVs that `scripts/figures.mjs`
exports. It is the version to hand to a co-author who wants to re-plot rather than re-derive.

The dashboard's **🐍 Publish matplotlib code** button does the whole trip in one press, through the
same publish helper: it rebuilds `figures/*.csv` and `dataset/rows.csv` from the tasks the cards are
counting *right now*, copies those CSVs and the scripts into `~/Downloads/figures-code`, redraws the
seven PDFs into `figures/` there, and then commits and pushes that folder. Any `.py` already in the
target's top level is cleared first, so the publish replaces the code rather than merging with an
older copy of it.

**It pulls before it publishes.** If that folder is behind its remote — a publish from another
machine, an edit made on GitHub — the push at the end would be rejected after everything had already
been drawn and committed. So the pull happens *before any file is written*, which is the one moment
the working tree is clean and a fast-forward cannot collide with the CSVs and PDFs about to be
rewritten. Every case that stops it says so and the publish continues: uncommitted changes in that
folder are never merged over, a folder whose history has diverged is committed and rebased onto the
remote's instead, and an unreachable remote leaves the files on disk with a line saying why. If the
remote moves while the run is in flight, the rejected push is retried once after a rebase.

**Press it again whenever anything moves.** Each press repeats the whole trip and commits exactly
what changed — a CSV, a script, a figure — and a press that changed nothing says so and makes no
commit. The PDFs are drawn with `SOURCE_DATE_EPOCH=0`, so an unchanged figure is byte-identical and
does not turn up in the diff.

Drawing needs matplotlib. The publisher uses the first interpreter that can import it —
`$PAGEGUIDE_PYTHON`, then `~/Downloads/figures-code/.venv/bin/python`, then `python3` — and if none
can, it says so and still publishes the code and data. To set the venv up once:

```bash
cd ~/Downloads/figures-code && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

### The finalized results table

The figures show the shape of a result; the paper also needs the numbers written out, and typing
them into a spreadsheet by hand is where a transcription error enters a paper and is never caught —
nothing downstream disagrees with it. **🧾 Export results table + figures** writes the sheet instead.

One press does the whole trip, on the rows the four cards are counting right now: it rebuilds
`figures/*.csv` and `dataset/rows.csv` from that selection, fills
`~/Downloads/Aug 19 - User Study Results Finalized - Sheet1.csv` from the same rows, and then
publishes the code, the CSVs and the redrawn PDFs to `~/Downloads/figures-code`. The order is the
point: a table filled from one run of the numbers beside figures drawn from another would be
invisible in both documents.

Six rows, in the sheet's own order — the four categories, plus an average per task type. The two
averages **pool rows** across their pair of facets rather than averaging the two facet means: the
facets do not hold equal row counts, and pooling is the one that says "the average Find task".

Each measure is a pair of columns, non-grounded then grounded, and each is a mean that **leaves out
the rows with no value** for that measure rather than counting them as zero — the rule the cards use
— so the n behind a cell can be smaller than the row counts in the first columns. `Non_grounded_n`
and `Grounded_n` are rows; `Participants` is the distinct sittings behind them. Find's two "parts"
are its two evidence hops and are blank on Guide rows; Guide's are error-type F1 and step F1, blank
on Find rows. Times are seconds, the scores are proportions rather than percentages, and the two
self-report columns stay on the four-point scale they came off.

The sheet's own two-row header is kept as it is, inconsistent wording included, so the file drops
back into the workbook. If the header on disk is not the one the script fills, it says which columns
moved and writes its own rather than filling the wrong cells silently.

```bash
node scripts/results_table.mjs                    # fill the sheet in ~/Downloads, and figures/
node scripts/results_table.mjs --table=/some/x.csv --all-tasks
```

From a terminal it is the same two scripts:

```bash
node scripts/figures.mjs                        # rebuild the CSVs (add --all-tasks to skip exclusions)
node scripts/figures_code.mjs                   # → ~/Downloads/figures-code, draw, commit + push
node scripts/figures_code.mjs --out=/some/where --no-push --no-figures
```

`scripts/dashboard_defs.mjs` is what keeps all of them honest: the facet list, the task selection,
the timings and the scoring are read out of `app/welcome.js` at run time rather than restated, so a
figure, a row in the table and a card on the dashboard cannot quietly disagree. Rename one of those
in the browser file and the next run fails loudly instead of plotting something else.

`data/PROVENANCE.md` travels with the CSVs: the numbers alone do not say which tasks were counted,
and a figure whose selection is unknown is one nobody can quote. Inside that folder,
`python make_all.py` redraws everything with no flags.

## The walkthrough

Before task 1, a participant is offered a two-minute walkthrough and can skip it. Taking it gives
them two practice tasks — one Find, one Guide, both grounded — with coachmarks pointing at the real
screen as they go, and a short "what we were looking for" after each.

- **The material is invented.** `app/tutorial_fixtures.js` holds a made-up library page, its canned
  answer and ground truth, and a four-step trajectory whose screenshots are drawn by
  `app/fake_page.js`. Every published row is `in_study=true` and reachable through the round-robin,
  so practising on a real task would mean rehearsing on one somebody is later scored on.
- **Nothing is recorded.** The practice paths return before a row is built, `saveStudyResult`
  refuses anyway, and `state.idx` never moves — the study still starts at task 1 of 8.
- **Each practice ends on the other condition.** After a practice is answered and debriefed, the
  same task is shown again non-grounded — no questions, no second walkthrough, just the difference
  named — so nobody meets their first non-grounded task thinking the page is broken.
- **Six coachmarks per task, no more.** Three that read the screen, then three that are the task —
  read and answer, point at the evidence, submit. The action steps have no Next button: the action
  is the Next, and they advance on the stage the study itself opens rather than on the button press,
  so a press the study rejected never moves the walkthrough on.
- **Nothing is a one-way door.** A bar at the bottom carries where you are, **← Go back** and a
  forward button through every screen already visited (practice → debrief → non-grounded → the next
  practice), and Skip. Forward only appears for a screen that exists: an unanswered practice has no
  debrief to jump to.
- **Two ways to get the coachmarks out of the way without ending the walkthrough.** Every card
  carries **See the whole page**, which drops the dim and the rings so the whole sample task is
  visible with the card still on it, and **Explore on my own**, which hides the walkthrough entirely
  and leaves a single *Back to the walkthrough* button that returns to the same step. The paused
  step keeps its `wait` binding, so doing the thing it was asking for while exploring advances it —
  you come back to the step after, not to a card waiting for something already done.
- **It runs the real screens.** `app/tutorial.js` walks the practice tasks through `showTask()` and
  points at elements the study renders for itself, so what is rehearsed is what comes next. That
  does mean the tour knows those selectors: a step whose target has gone simply skips itself, but if
  a rename makes several steps vanish, the walkthrough has stopped describing the study.

## Test runs

Type **`test`** as the participant ID on the welcome screen and the study runs for real — the real
tasks, the real timers, the real questions — while writing nothing.

- **No assignment is claimed.** `claim_study_assignment` writes a session row and burns a
  round-robin slot, so a researcher walking the study would otherwise shift every participant after
  them by one. The slot is computed locally instead: `test` walks slot 0, and **`test-3`** walks the
  queue slot 3 would be dealt, which is how to look at a particular counterbalancing.
- **No result rows.** `saveStudyResult` refuses for `state.dryRun` exactly as it does for the
  walkthrough, and logs `[test run] not saved:` with the row it would have written — so you can
  still check that the right thing *would* have been saved.
- **No questionnaire response.** The final screen links the survey instead of embedding it, with a
  banner saying which kind of run it was. Same reasoning as an admin review walk: the form is live.
- **‹ › between tasks.** An amber bar sits bottom-left saying `Test run · Task 3 of 8 · Find ·
  grounding`, with a step back and a skip forward — the two things a real run must not have. It is
  a bar of its own rather than buttons in the question pane, because during a real task that pane
  belongs to the instrument and is rebuilt on every task. Stepping **back** truncates `results` to
  the task returned to, so re-answering it does not leave two rows for it in the download.
- **It says so before you press Start.** Typing `test` into the ID box puts the warning under it
  straight away — finding out afterwards means the assignment has already been spent.

`dryRun` is saved with the session, so a refresh three tasks into a test run comes back as a test
run rather than turning into a participant.

## Required questions

Every question except the two free-text boxes must be answered — the study cannot use a row with a
hole in it — so each carries a red `*`, and a rejected submit outlines the question(s) still missing
and scrolls to the first of them. Both marks clear the moment the question is answered, so red
always means *still needed* and never *wrong*. `window.QForm` (app/instrument.js) owns the mark, the
highlight and the one delegated `change` listener that clears them; the Find questions and the
follow-up use it rather than growing a second visual language for the same idea.

One latent bug the walkthrough surfaced: `mountInstrument` has always returned a cleanup that
`study.js` stored and never called. Nothing broke while the only way off a task was to submit it, but the Back button
leaves a task mid-question — so `detachQuestionPane()` now runs on every task change, and the Find
questions register the same cleanup the guide instrument does.

Whether it has been offered is kept in `localStorage['pageguide_web_tutorial_done']` — outside the
session, so it cannot invalidate one, and cleared on every Start. Preview it without spending an
assignment slot from the admin panel: **▶ Preview the walkthrough** (`find-v1-study.html?tutorial=preview`).
