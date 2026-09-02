# PageGuide figures — matplotlib

The paper figures, drawn from the exported CSVs. Every script here plots the same numbers the
study dashboard draws, so a panel produced here can be checked against the published SVG bar for
bar.

## Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python make_all.py                 # every figure, as PDF, into ./figures
python make_all.py --format png    # or PNG / SVG
python accuracy.py                 # or one at a time
```

Each script takes the same flags:

| flag | default | meaning |
| --- | --- | --- |
| `--data` | `./data` | folder holding the exported CSVs |
| `--out` | `./figures` | where the figures are written |
| `--format` | `pdf` | `pdf`, `png` or `svg` |

## The figures

| script | figure | reads |
| --- | --- | --- |
| `accuracy.py` | share of tasks answered correctly, per facet | `outcomes.csv` |
| `localization_f1.py` | the two halves of localization, per facet | `outcomes.csv` |
| `time_completion.py` | time to a correct answer — box plots with every row | `rows.csv` |
| `behavior_pooled.py` | six behaviour metrics, all tasks pooled | `behavior_pooled.csv` |
| `behavior_by_facet.py` | the same six, split by facet | `behavior_by_facet.csv` |
| `post_study_likert.py` | post-study questionnaire, diverging panels | `post_study.csv` |
| `post_study_stacked.py` | post-study questionnaire, 100% stacked bars | `post_study.csv` |
| `results_table_pdf.py` | the paper's results table, drawn as a six-section PDF (four of means, two of SDs) | `results_table.csv` |
| `results_table_subset.py` | **part 1** filters the master rows down to the published task selection; **part 2** rebuilds the table from that subset and draws it | `rows_master.csv`, `selection.json` |
| `breakdonw_participants.py` | who is behind the n — a per-facet summary page, then one line per sitting | `breakdonw_participants.csv` |

`results_table_pdf.py` is always a PDF — its six sections are six pages, and a PNG would keep
only the first — so `--format png` draws it as PDF anyway rather than failing the run. It picks its
columns out of the CSV **by header name**, so a measure added to `scripts/results_table.mjs` cannot
silently shift every page after it; a name that disappears fails the run and says which page wanted
it.

`results_table_subset.py` is the only script that starts from row-level data rather than from an
aggregate somebody else computed. `rows_master.csv` is **every** answered task, selection or not;
`selection.json` is the per-facet task list the dashboard was showing when publish was pressed.
Part 1 writes `data/rows_subset.csv`, part 2 writes `data/results_table_subset.csv` and
`figures/results_table_subset.pdf`. It then checks itself twice: the subset against the
`in_selection` flag the export stamped on each master row, and its own table against
`results_table.csv` cell for cell — Node computed one, Python the other, and they must agree.
Pass `--all-tasks` to ignore the selection and count everything in the master.

`breakdonw_participants.py` is the only page about the SAMPLE rather than about the measures. Every
other figure here aggregates, and none of them can answer the question a within-subject design is
always asked: how many people worked both arms, and how much does a cell rest on one person having
been dealt one task. Page 1 is the summary the dashboard's card headers print — rows per arm,
participants, and how many of them are in both arms; the pages after it are one line per sitting, so
that summary can be checked instead of trusted. Green marks a facet a sitting worked both arms of,
amber one arm only.

It carries `participant`, the same integer stamped on `rows.csv` and `rows_master.csv`, so a line
joins to those files — and **not** the raw `session_id`, for the reason `scripts/figures.mjs` gives:
the id is a join key into a table that also holds the free-text notes. `scripts/breakdonw_participants.mjs
--session-ids` writes a copy with them, for a local run only.

`common.py` holds the palette and the shared marks; `post_study_data.py` reads the Google Forms
export the way the dashboard reads it (a column is a question when every non-empty cell in it is
an integer 1-7).

`figures/` holds the PDFs as they stood at the last publish — the publisher redraws them before it
commits, so the pictures in this folder always match the CSVs beside them and nobody needs to
install matplotlib just to look.

## The data

`data/` is written by the same button that publishes this code, so the CSVs in it are the ones the
dashboard was showing at that moment — including which tasks were selected. `data/PROVENANCE.md`
records that selection: read it before quoting a number out of these figures.

Bars are means and whiskers are ±1 standard error (sd/√n), not a confidence interval. Box plots use
Tukey whiskers (1.5 IQR) and the time axis stops just above the highest whisker, with the count of
rows above it printed in the panel.

## Conventions worth keeping

- **Arm order and colour are fixed.** Non-grounded is first and rose `#bf5a64`; grounded is second
  and blue `#5183c9`. The pair is validated for colour-vision separation and 3:1 contrast on white.
- **Guide rows are scored on the verdict, Find rows on the answer** — `score_verdict_correct` vs
  `score_answer_correct`. Using one column for both silently empties half the panels.
- **Total time is judge + locate** (`answer_multiple_choice_ms + find_supporting_answer_ms`), not
  `answer_time_ms`, which is the whole task duplicated.
