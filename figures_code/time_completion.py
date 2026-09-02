#!/usr/bin/env python3
"""time_completion — how long a correct answer took, per facet and arm.

Source: `rows.csv` (the row-level export). Time is judge time + locate time,
`answer_multiple_choice_ms + find_supporting_answer_ms`, in seconds, over correctly answered
rows only.

SCALED BY THE WHISKER, NOT BY THE WORST ROW. One 4000-second task — someone who left the tab
open — flattens all four boxes into a line at the bottom, and the figure then shows nothing
except that an outlier exists. The axis stops just above the highest Tukey whisker and the panel
says in words how many rows are above it, which is the fact the squashed version was conveying
by accident.
"""

import hashlib

import matplotlib.pyplot as plt

from common import (ARMS, FACETS, INK, PANEL_LETTERS, arm_legend, load_csv, num, parse_args, save,
                    tidy, use_style)

CONDITION_LABEL = {"nongrounding": "Non-grounded", "grounding": "Grounded"}


def quantile(sorted_values, p):
    if not sorted_values:
        return None
    i = (len(sorted_values) - 1) * p
    lo, hi = int(i), min(int(i) + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (i - lo)


def upper_fence(values):
    """The Tukey upper fence — the top of the whisker, not the top of the data."""
    v = sorted(values)
    if not v:
        return 0
    q1, q3 = quantile(v, 0.25), quantile(v, 0.75)
    hi = q3 + 1.5 * (q3 - q1)
    within = [x for x in v if x <= hi]
    return within[-1] if within else v[-1]


def jitter(key, i):
    """Deterministic jitter: the same export always draws the same cloud."""
    digest = hashlib.md5(f"{key}:{i}".encode()).digest()
    return (int.from_bytes(digest[:4], "big") % 1000) / 1000 - 0.5


def answer_correct(row):
    """Find rows are scored by the answer, Guide rows by the verdict — never the same column."""
    column = "score_answer_correct" if row.get("task_type") == "find" else "score_verdict_correct"
    return str(row.get(column, "")).strip().lower() == "true"


def total_time_s(row):
    judge, locate = num(row.get("answer_multiple_choice_ms")), num(row.get("find_supporting_answer_ms"))
    if judge is None or locate is None:
        return None
    return (judge + locate) / 1000


def main():
    args = parse_args(__doc__)
    use_style()
    rows = load_csv(args.data, "rows.csv")
    facets = [f for f in FACETS if any(r["facet"] == f for r in rows)]

    series = {}
    for facet in facets:
        for condition, arm in CONDITION_LABEL.items():
            values = [total_time_s(r) for r in rows
                      if r["facet"] == facet and r["condition"] == condition and answer_correct(r)]
            series[(facet, arm)] = sorted(v for v in values if v is not None)

    fig, axes = plt.subplots(1, len(facets), figsize=(2.5 * len(facets), 3.4))
    for i, (ax, facet) in enumerate(zip(axes, facets)):
        arms = [(label, color) for label, color in ARMS]
        top = max([upper_fence(series[(facet, label)]) for label, _ in arms] + [0]) * 1.12 or 1
        above = sum(len([v for v in series[(facet, label)] if v > top]) for label, _ in arms)

        for j, (label, color) in enumerate(arms):
            values = series[(facet, label)]
            if not values:
                continue
            box = ax.boxplot([values], positions=[j], widths=0.52, whis=1.5, showfliers=False,
                             patch_artist=True, zorder=2)
            for patch in box["boxes"]:
                patch.set(facecolor=color, alpha=0.85, edgecolor=INK, linewidth=1)
            for part in ("whiskers", "caps"):
                for line in box[part]:
                    line.set(color=INK, linewidth=1)
            for line in box["medians"]:
                line.set(color=INK, linewidth=1.6)
            xs = [j + jitter(f"{facet}|{label}", k) * 0.62 for k in range(len(values))]
            ax.scatter(xs, values, s=4, color=INK, alpha=0.42, linewidths=0, zorder=3)

        tidy(ax)
        n = [len(series[(facet, label)]) for label, _ in arms]
        ax.set_title(f"{PANEL_LETTERS[i]}) {facet}  (n {n[0]} vs {n[1]})", pad=14)
        if above:
            ax.text(0, 1.02, f"{above} row{'' if above == 1 else 's'} above the axis",
                    transform=ax.transAxes, fontsize=7.5, color="#5c5c66")
        ax.set_xticks(range(len(arms)))
        ax.set_xticklabels([""] * len(arms))
        ax.set_xlim(-0.7, len(arms) - 0.3)
        ax.set_ylim(0, top)
        if i == 0:
            ax.set_ylabel("Time (s), correct answers only")

    arm_legend(fig, y=-0.03)
    fig.subplots_adjust(wspace=0.35)
    save(fig, args.out, "time_completion", args.format)


if __name__ == "__main__":
    main()
