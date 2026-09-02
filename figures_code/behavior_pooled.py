#!/usr/bin/env python3
"""behavior_pooled — six behaviour metrics, all tasks pooled.

Source: `behavior_pooled.csv` (facet, metric, condition, n, mean, sd, se).
Bars are means; whiskers are ±1 standard error (sd/√n), not a confidence interval.
"""

import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

from common import (ARM_ORDER, arm_legend, grouped_bars, load_csv, num, parse_args, save,
                    thousands, tidy, use_style, PANEL_LETTERS)


def main():
    args = parse_args(__doc__)
    use_style()
    rows = [r for r in load_csv(args.data, "behavior_pooled.csv") if r["facet"] == "All tasks"]

    metrics = []
    for r in rows:
        if r["metric"] not in metrics:
            metrics.append(r["metric"])
    cells = {(r["metric"], r["condition"]): {"mean": num(r["mean"]), "se": num(r["se"])} for r in rows}

    fig, axes = plt.subplots(1, len(metrics), figsize=(2.05 * len(metrics), 2.6))
    for i, (ax, metric) in enumerate(zip(axes, metrics)):
        panel_cells = {("", arm): cells.get((metric, arm)) for arm in ARM_ORDER}
        grouped_bars(ax, [""], panel_cells, width=0.32)
        tidy(ax)
        ax.set_title(f"{PANEL_LETTERS[i]}) {metric}", pad=8)
        ax.set_xticklabels([""])
        if metric.endswith("(px)"):
            ax.yaxis.set_major_formatter(FuncFormatter(thousands))
        if i == 0:
            ax.set_ylabel("Mean per task")

    arm_legend(fig, y=-0.06)
    fig.subplots_adjust(wspace=0.45)
    save(fig, args.out, "behavior_pooled", args.format)


if __name__ == "__main__":
    main()
