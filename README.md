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
- **It runs the real screens.** `app/tutorial.js` walks the practice tasks through `showTask()` and
  points at elements the study renders for itself, so what is rehearsed is what comes next. That
  does mean the tour knows those selectors: a step whose target has gone simply skips itself, but if
  a rename makes several steps vanish, the walkthrough has stopped describing the study.

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
assignment slot from the admin panel: **▶ Preview the walkthrough** (`study.html?tutorial=preview`).
