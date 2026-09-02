#!/usr/bin/env python3
"""post_study_stacked — the post-experiment questionnaire as 100% stacked bars.

Source: `post_study.csv`. One bar per question, ratings 1 → 7 left to right, every bar summing to
100% of that question's responses. The same 1-7 palette as the diverging panels, so a colour
means the same rating in both figures.
"""

import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

from common import LIKERT_COLORS, parse_args, save, use_style
from post_study_data import load_likert, short_labels

MAX_LABEL_CHARS = 30


def truncate(text, limit=MAX_LABEL_CHARS):
    text = text.strip()
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def main():
    args = parse_args(__doc__)
    use_style()
    data = load_likert(args.data)
    labels = short_labels(data.columns)

    fig, ax = plt.subplots(figsize=(9.5, 0.55 * len(data.columns) + 2.4))

    for row, (item, label) in enumerate(zip(data.columns, labels)):
        y = len(data.columns) - 1 - row
        n = len(item.values) or 1
        left = 0.0
        for v in range(1, 8):
            width = item.counts[v] / n * 100
            if width <= 0:
                continue
            ax.barh(y, width, left=left, height=0.6, color=LIKERT_COLORS[v], zorder=2)
            left += width

    ax.set_yticks(range(len(data.columns)))
    ax.set_yticklabels([f"{item.code}. {truncate(label)}"
                        for item, label in reversed(list(zip(data.columns, labels)))],
                       fontweight="bold", color="#161616")
    ax.set_ylim(-0.7, len(data.columns) - 0.3)
    ax.set_ylabel("Question", fontweight="bold")
    ax.set_xlim(0, 100)
    ax.set_xticks([0, 25, 50, 75, 100])
    ax.set_xlabel("Percentage of Responses (%)", fontweight="bold", labelpad=8)
    ax.set_axisbelow(True)
    ax.xaxis.grid(True, color="#dcdcdc", linewidth=0.7)
    ax.tick_params(axis="both", length=0)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)

    ax.set_title("Post-Experiment Questionnaire Results", fontsize=15, fontweight="bold",
                 loc="left", pad=26, color="#2f3439")
    ax.text(0, 1.03, "Likert Scale Responses (1 = Strongly Disagree / Negative, "
                     "7 = Strongly Agree / Positive)",
            transform=ax.transAxes, fontsize=10, color="#8b8b90")

    handles = [Rectangle((0, 0), 1, 1, facecolor=LIKERT_COLORS[v]) for v in range(1, 8)]
    fig.legend(handles, [str(v) for v in range(1, 8)], loc="lower center", ncol=7,
               bbox_to_anchor=(0.5, -0.02), handlelength=1.2, handleheight=1.2, columnspacing=1.6)

    save(fig, args.out, "post_study_stacked", args.format)


if __name__ == "__main__":
    main()
