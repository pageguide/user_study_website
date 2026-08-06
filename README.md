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
