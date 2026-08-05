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
repo. It creates `study_guide_trajectories` and `study_tasks` (the stimuli, anon-readable) and
migrates `study_task_results` with the `score_*` columns.

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

`ARM_ASSIGNMENT` in `app/config.js`:

- `'url'` *(default)* — `?arm=grounding` or `?arm=nongrounding`. The link you send **is** the
  assignment, which keeps a record of it outside the browser.
- `'random'` — a coin flip per participant.

A participant must never pick their own condition.

## What lands in the database

One `study_sessions` row per participant, one `study_task_results` row per task — the same tables
and the same field names the extension writes, so a web run and an extension run are one dataset.
Rows are written as each task finishes, so a participant who closes the tab three tasks in leaves
three rows behind.

Each row carries the raw answer (`guide_answer_correct`, `guide_answer_problems`, `guide_errors`)
and its score against the trajectory's ground truth (`score_*`), computed client-side by the
vendored scorer. Two groups, never averaged:

| | |
|---|---|
| **detection** | `score_verdict_correct`, `score_problem_*` — did they notice it went wrong? |
| **localization** | `score_type_*`, `score_step_*`, `score_no_error_agreement` — can they find where? |

`null` means *not scored* — no ground truth recorded, or nothing to be precise about — and never
zero. An unfinished stimulus must not read as a participant who got everything wrong.

## Known gap

Behaviour counts (`scroll_user_count`, `ctrl_f_count`, `mouse_move_px`, …) come from a content
script watching the live page. A website cannot observe the participant's other tabs, so these are
0 for web rows rather than invented. Check before mixing the two sources in an analysis that uses
them.
