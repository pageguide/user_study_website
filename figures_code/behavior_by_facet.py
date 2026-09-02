#!/usr/bin/env python3
"""behavior_by_facet — the same six behaviour metrics, split by facet.

Source: `behavior_by_facet.csv` (facet, metric, condition, n, mean, sd, se).
Bars are means; whiskers are ±1 standard error.
"""

import math

import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

from common import (FACETS, FACET_SHORT, PANEL_LETTERS, arm_legend, grouped_bars, load_csv, num,
                    parse_args, save, thousands, tidy, use_style)


def main():
    args = parse_args(__doc__)
    use_style()
    rows = load_csv(args.data, "behavior_by_facet.csv")

    metrics = []
    for r in rows:
        if r["metric"] not in metrics:
            metrics.append(r["metric"])
    facets = [f for f in FACETS if any(r["facet"] == f for r in rows)]
    cells = {(r["metric"], r["facet"], r["condition"]): {"mean": num(r["mean"]), "se": num(r["se"])}
             for r in rows}

    cols = 3
    rows_n = math.ceil(len(metrics) / cols)
    fig, axes = plt.subplots(rows_n, cols, figsize=(3.1 * cols, 2.9 * rows_n))
    flat = axes.ravel() if hasattr(axes, "ravel") else [axes]

    for i, metric in enumerate(metrics):
        ax = flat[i]
        panel_cells = {(f, arm): cells.get((metric, f, arm))
                       for f in facets for arm in ("Non-grounded", "Grounded")}
        grouped_bars(ax, facets, panel_cells)
        tidy(ax)
        ax.set_title(f"{PANEL_LETTERS[i]}) {metric}", pad=8)
        ax.set_xticklabels([FACET_SHORT.get(f, f) for f in facets])
        if metric.endswith("(px)"):
            ax.yaxis.set_major_formatter(FuncFormatter(thousands))
        if i % cols == 0:
            ax.set_ylabel("Mean per task")

    for ax in flat[len(metrics):]:
        ax.axis("off")

    arm_legend(fig, y=-0.02)
    fig.subplots_adjust(wspace=0.3, hspace=0.55)
    save(fig, args.out, "behavior_by_facet", args.format)


if __name__ == "__main__":
    main()
