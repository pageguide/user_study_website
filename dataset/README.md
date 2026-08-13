---
license: cc-by-4.0
tags: [human-study, web-agents, grounding, hci]
---

# PageGuide user study — results

One row per answered task from the PageGuide web study, on the task selection the analysis
dashboard uses by default. `rows.csv` is the row-level data; the two `behavior_*.csv` files are
the aggregates plotted in the behavioural figures (mean, sd, se and n per cell). `outcomes.csv`
carries accuracy, localization F1 and its two halves, and the timing stages — mean, sd, se,
median and quartiles per cell.

Exported 2026-08-13T22:44:21.826Z · 199 rows · 38 participants.

## Conditions

Every participant sees both arms, interleaved task by task:

- `nongrounding` — the agent reports an answer with no evidence attached.
- `grounding` — the same claims, with citations into the page and saved image crops.

## Task selection

Some tasks are excluded from their card by default. The figures and these files use the same
selection, so they agree with the dashboard:

| Facet | Left out | Why |
|---|---|---|
| Find × Text | MARS-v1, MUFC-V1-TEXT | a disputed answer key, and the page already read in Find × Visual |
| Guide × Text | gv2-ed05a7b6-kk24zp, gv2-ms9iw0pq-5kj5zr, gv2-msf02a2n-88li4p, gv2-msf5mo9m-qm5brt | three duplicate re-recordings, plus both recordings of the New York goal |
| Guide × Visual | gv2-msf1pyqv-omt0hz | a run whose ground truth blames one step under two error types, so no participant can score it in full |

## What is not here

Participants' free-text notes are omitted, and session ids are replaced with a per-export
`participant` integer. Both are deliberate: the notes are the only column that can carry
something about a person rather than about a task.

## Scoring

Localization quality is F1. For Find it is over the passages picked; for Guide it is the mean of
an F1 over the error types named and an F1 over the steps blamed, with a correct "no error"
scoring in full on a run that contains none. A null precision means the participant predicted
nothing, which is zero true positives, so its F1 is 0 rather than missing.
