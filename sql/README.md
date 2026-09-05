# The SQL, in the order it is applied

Every schema change to the V2 Supabase project is one idempotent file, and this directory is the
whole history of them. The file name carries the order, because these are applied by hand in the
Supabase SQL editor and "which one have I run?" is the only question that matters when a project is
half migrated.

```
000–009   base schema   run ONE of these on a blank project, then everything above it
010–899   migrations    in this order, each safe to re-run
900–949   data edits    they change rows, not shape
950–999   reporting     views and helpers; no schema change, run whenever
```

**Numbers never change.** A file that has been applied to a project is a fact about that project, and
renumbering it later would make every note that names it point somewhere else. New work takes the
next free number; gaps are left where they fall.

**Everything is idempotent** unless its own header says otherwise: re-running a file changes nothing
and never resets a setting an admin has chosen. When in doubt, re-run it — that is cheaper than
working out whether you did.

---

## Base — one of these, on a blank project

| # | File | What it is |
| --- | --- | --- |
| 000 | `000_supabase_v2_init.sql` | **Start here.** The complete from-scratch V2 schema, Find *and* Guide, plus the admin-password gate. Touches no V1 table. |
| 001 | `001_supabase_find_v2.sql` | The Find-only V2 schema, from before Guide existed. Superseded by 000 — kept because projects created from it are still running. |
| 002 | `002_supabase_results_v2.sql` | Not this project. The **V1** study's results-v2 columns, in the V1 Supabase project. |

## Migrations — in this order

| # | File | What it adds | Needs |
| --- | --- | --- | --- |
| 010 | `010_supabase_v2_flags.sql` | The protocol switches: `collect_evidence`, `collect_followup`, and room for a timed-out verdict | 000 |
| 020 | `020_supabase_v2_guide.sql` | The Guide task: `arms`, the `agent_completed` answer key, `save_pageguide_guide_v2_meta` | 000, 010 |
| 030 | `030_supabase_v2_arms.sql` | Derives `arms` from what the recorder writes, so a recorded run is not a blank stimulus | 000 |
| 040 | `040_supabase_v2_faithfulness.sql` | `claims_completion` — separates a false success from an honest failure | 020 |
| 050 | `050_supabase_v2_failure_mode.sql` | `failure_mode` on Guide results, and a publish gate that accepts both ground-truth dialects | 030 |
| 060 | `060_supabase_v2_failure_mode_editor.sql` | Lets Admin classify *why* a run is incorrect | 030 |
| 070 | `070_supabase_v2_anchors.sql` | Saves one variant's citation anchors without rewriting the whole claim | 000 |
| 080 | `080_supabase_v2_answer_edit.sql` | Lets the reference reviewer delete a citation, not only re-link it | 070 |
| 090 | `090_supabase_v2_reference_use.sql` | Did the participant actually open the references? **Run before deploying the matching JS** | 000 |
| 100 | `100_supabase_v2_step_marks.sql` | `marked_wrong_steps` — the steps a participant marks while reviewing a Guide run | 000 |
| 110 | `110_supabase_v2_task_limit.sql` | The per-task time limit, as a setting rather than a constant | 010 |
| 120 | `120_supabase_v2_queue_design.sql` | `queue_design` — which queue a sitting is dealt | 110 |
| 130 | `130_supabase_v2_group_chip.sql` | `show_group_chip` — whether a participant is told their group (off by default) | 120 |
| 140 | `140_supabase_v2_milestone_flag.sql` | `flag_milestones` — whether the journey flags the trail's steps (on by default) | 130 |
| 150 | `150_supabase_v2_reasoning_trail.sql` | `show_reasoning_trail` — the agent's own account of the run (off by default) | 140 |
| 160 | `160_supabase_v2_recruit_quota.sql` | `slot_quota` and `pageguide_find_v2_class_counts` — recruiting to a per-class target | 150 |
| 170 | `170_supabase_v2_task_picker.sql` | The `guide_visual_4` queue, `task_selection`, the browse simulator's switches, `post_survey_url` | 160 |
| 180 | `180_supabase_v2_guide_name.sql` | A Guide task's name and instruction become editable from Admin | 040 |
| 190 | `190_supabase_v2_guide_steps.sql` | Hiding and deleting steps of a run, with every reference renumbered | 030 |
| 200 | `200_supabase_v2_task_limit_3min.sql` | The per-task budget becomes three minutes | 110 |

## Data edits — they change rows, not shape

| # | File | What it does |
| --- | --- | --- |
| 900 | `900_supabase_v2_letter_ops.sql` | Replaces the alphabet arithmetic in four live claims. Reversible: it backs the rows up first, and the last section puts them back |
| 910 | `910_supabase_v2_guide_briefs.sql` | Rewrites the four dealt Guide runs' instructions as checklists. Read the note above run 4 before running it |

## Reporting — no schema change, run whenever

| # | File | What it does |
| --- | --- | --- |
| 950 | `950_supabase_v2_local_time.sql` | Views that read `created_at` in Alabama local time |

---

## "Could not find the function … in the schema cache"

The browser is ahead of the project. PostgREST resolves functions **by argument name**, so a page
sending `p_task_selection` to a database still holding the older writer gets back a list of parameter
names and no hint which are new. Run the migration Admin names. Nothing is saved when this happens,
and the app deliberately does not retry without the new fields — a save that half happened and
reported success is worse than one that failed.

## Which project?

Everything numbered `000`, `001` and `010`+ belongs to the **V2** project. `002` belongs to the
**V1** project, and `supabase_schema.sql` — referenced from `app/config.js` and the root README — is
V1's base schema and lives in the separate `pageguide` repository, not here.
