#!/usr/bin/env python3
"""accuracy — share of tasks answered correctly, per facet and arm.

Source: `outcomes.csv`, rows whose measure is `accuracy`.
Bars are means; whiskers are ±1 standard error.
"""

import matplotlib.pyplot as plt

from common import (FACETS, PANEL_LETTERS, arm_legend, grouped_bars, load_csv, num, parse_args,
                    save, tidy, use_style)


def main():
    args = parse_args(__doc__)
    use_style()
    rows = [r for r in load_csv(args.data, "outcomes.csv") if r["measure"] == "accuracy"]
    facets = [f for f in FACETS if any(r["facet"] == f for r in rows)]
    cells = {(r["facet"], r["condition"]): {"mean": num(r["mean"]), "se": num(r["se"])} for r in rows}

    fig, axes = plt.subplots(1, len(facets), figsize=(2.3 * len(facets), 2.9), sharey=True)
    for i, (ax, facet) in enumerate(zip(axes, facets)):
        grouped_bars(ax, [""], {("", arm): cells.get((facet, arm))
                                for arm in ("Non-grounded", "Grounded")}, width=0.32)
        tidy(ax)
        ax.set_title(f"{PANEL_LETTERS[i]}) {facet}", pad=8)
        ax.set_xticklabels([""])
        ax.set_ylim(0, 1)
        ax.set_yticks([0, 0.3, 0.5, 0.8, 1.0])
        if i == 0:
            ax.set_ylabel("Accuracy")

    arm_legend(fig, y=-0.08)
    fig.subplots_adjust(wspace=0.25)
    save(fig, args.out, "accuracy", args.format)


if __name__ == "__main__":
    main()
