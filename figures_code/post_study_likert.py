#!/usr/bin/env python3
"""post_study_likert — the diverging Likert panels, one panel per question group.

Source: `post_study.csv` (the Google Forms export). Every column whose non-empty values are all
integers 1-7 is a question; the question's wording decides its group (FIND / GUIDE / HIDE).

Bars are centred on the neutral rating: 1-3 run left of the line, 4 straddles it, 5-7 run right,
each half scaled to 50% of the responses. The percentage printed beside a bar is the share that
answered 5, 6 or 7.
"""

import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

from common import LIKERT_COLORS, parse_args, save, use_style
from post_study_data import load_likert

GROUP_TITLE = {"FIND": "a) FIND", "GUIDE": "b) GUIDE", "HIDE": "c) HIDE", "OTHER": "QUESTIONS"}
GROUP_COLOR = {"FIND": "#1e97ea", "GUIDE": "#3fb34f", "HIDE": "#f29900", "OTHER": "#5f6673"}
GROUP_ORDER = ["FIND", "GUIDE", "HIDE", "OTHER"]


def main():
    args = parse_args(__doc__)
    use_style()
    data = load_likert(args.data)

    groups = [(key, [c for c in data.columns if c.group == key]) for key in GROUP_ORDER]
    groups = [(key, items) for key, items in groups if items]
    max_rows = max(len(items) for _, items in groups)

    fig, axes = plt.subplots(1, len(groups), figsize=(4.4 * len(groups), 0.8 * max_rows + 2.2))
    axes = axes if hasattr(axes, "__len__") else [axes]

    for ax, (key, items) in zip(axes, groups):
        for row, item in enumerate(items):
            y = len(items) - 1 - row
            n = len(item.values) or 1
            share = {v: item.counts[v] / n for v in range(1, 8)}

            left = -sum(share[v] for v in (1, 2, 3))
            for v in (1, 2, 3):
                ax.barh(y, share[v], left=left, height=0.42, color=LIKERT_COLORS[v], zorder=2)
                left += share[v]
            ax.barh(y, share[4], left=-share[4] / 2, height=0.42, color=LIKERT_COLORS[4], zorder=2)
            right = 0.0
            for v in (5, 6, 7):
                ax.barh(y, share[v], left=right, height=0.42, color=LIKERT_COLORS[v], zorder=2)
                right += share[v]

            agree = round(sum(share[v] for v in (5, 6, 7)) * 100)
            ax.text(1.04, y, f"{agree}%", va="center", ha="left", fontsize=10,
                    fontweight="bold", color="#2e7d32")

        ax.axvline(0, color="#9d9d9d", linewidth=0.9, zorder=3)
        ax.set_yticks(range(len(items)))
        ax.set_yticklabels([item.code for item in reversed(items)], fontweight="bold", color="#161616")
        ax.set_ylim(-0.7, max_rows - 0.3)
        ax.set_xlim(-0.5, 1.0)
        ax.set_xticks([-0.5, 0, 1.0])
        ax.set_xticklabels(["50%", "0%", "100%"], fontweight="bold")
        # DejaVu Sans ships with matplotlib and has the arrows; the Helvetica family often does not.
        ax.set_xlabel("← Disagree / Agree →", fontweight="bold", labelpad=8, fontname="DejaVu Sans")
        ax.set_title(GROUP_TITLE.get(key, key), color=GROUP_COLOR.get(key, "#5f6673"),
                     fontsize=12, fontweight="heavy", loc="center", pad=12)
        ax.tick_params(axis="both", length=0)
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)

    handles = [Rectangle((0, 0), 1, 1, facecolor=LIKERT_COLORS[v]) for v in range(1, 8)]
    fig.legend(handles, [str(v) for v in range(1, 8)], loc="upper center", ncol=7,
               bbox_to_anchor=(0.5, 1.06), frameon=True, handlelength=1.4, handleheight=0.7,
               title="Rating: (1=Strongly Disagree, 7=Strongly Agree)")

    caption = "\n".join(f"{item.code}: {item.question}" for item in data.columns)
    fig.text(0.01, -0.02, caption, ha="left", va="top", fontsize=8, fontweight="bold", wrap=True,
             bbox={"facecolor": "#c9c9c9", "edgecolor": "#123040", "linewidth": 1.5, "pad": 8})

    fig.subplots_adjust(wspace=0.35)
    save(fig, args.out, "post_study_likert", args.format)


if __name__ == "__main__":
    main()
