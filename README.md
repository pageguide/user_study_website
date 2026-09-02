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

Run the check before every deploy.

## Setup

**1. Create the tables.** In the Supabase SQL editor, run `supabase_schema.sql` from the pageguide
repo, then run `supabase_results_v2.sql` from this repo. The first script creates the stimuli tables;
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

1. In the new project's SQL editor, run all of `supabase_find_v2.sql`.
2. In the same SQL editor, set the password that authorizes the V2 Admin editor:

   ```sql
   select public.set_pageguide_find_v2_admin_password('replace with a long private password');
   ```

3. Copy the example config and add the new project's URL and **publishable/anon** key:

   ```bash
   cp app/find_v2_config.example.js app/find_v2_config.js
   ```

4. Serve the repo and open `http://localhost:8000/` — Find V2 is the default page.

The Guide half of V2 was added after the Find half, in one idempotent SQL file per change. On a
project that has only ever run `supabase_find_v2.sql`, run these in order in the same SQL editor:

| File | What it adds |
| --- | --- |
| `supabase_v2_init.sql` | the V2 tables, the admin password gate, and the item writers |
| `supabase_v2_flags.sql` | the protocol switches (`collect_evidence`, `collect_followup`) |
| `supabase_v2_guide.sql` | the Guide task: `arms`, the `agent_completed` answer key, and `save_pageguide_guide_v2_meta` |
| `supabase_v2_anchors.sql` | citation anchors for Find references |
| `supabase_v2_faithfulness.sql` | `claims_completion`, which separates a false success from an honest failure |
| `supabase_v2_arms.sql` | builds `arms` from what the recorder writes, so a recorded run is not a blank stimulus |

Then, once per batch of imported runs:

```bash
node scripts/migrate_guide_v2.mjs      # copy V1's recorded Guide runs across (optional)
node scripts/classify_guide_runs.mjs   # fill claims_completion from how each answer opens
```

`supabase_v2_arms.sql` matters for any run recorded through the extension rather than migrated from
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

`supabase_find_v2.sql` is safe to re-run: on a project that already ran an earlier version it adds
the new columns and lifts each existing single answer into the matching variant, pinning that row's
`correctness_mode` so it keeps behaving exactly as before until it is re-authored. V1 continues
to use `study_*` tables and `app/config.js` exactly as before.

## Assigning conditions

Participants are assigned by the Supabase RPC in `supabase_results_v2.sql`, not by URL. When a
participant presses Start, `claim_study_assignment` atomically claims the next round-robin slot and
creates the `study_sessions` row. Each participant sees 8 tasks:

- grounded: the slot's Find x Text, Find x Visual, Guide x Text, and Guide x Visual tasks
- non-grounded: the next slot's task from each of those four styles, wrapping within each style

Run `supabase_results_v2.sql` before deploying this version; it adds the assignment counter, session
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
`supabase_results_v2.sql` to fix it at the source.

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
