#!/usr/bin/env python3
"""localization_f1 — the two halves of localization, per facet.

Source: `outcomes.csv`, rows whose measure starts with `F1 · `.

The halves are NOT the same question across task types — Find's are its two hops (passage, image),
Guide's are the error type and the step — so each panel names its own pair instead of sharing one
legend of part labels. Bars are means; whiskers are ±1 standard error.
"""

import matplotlib.pyplot as plt

from common import (FACETS, PANEL_LETTERS, arm_legend, grouped_bars, load_csv, num, parse_args,
                    save, tidy, use_style)

PREFIX = "F1 · "


def main():
    args = parse_args(__doc__)
    use_style()
    rows = [r for r in load_csv(args.data, "outcomes.csv") if r["measure"].startswith(PREFIX)]
    facets = [f for f in FACETS if any(r["facet"] == f for r in rows)]

    parts_by_facet = {}
    for r in rows:
        parts = parts_by_facet.setdefault(r["facet"], [])
        part = r["measure"][len(PREFIX):]
        if part not in parts:
            parts.append(part)
    cells = {(r["facet"], r["measure"][len(PREFIX):], r["condition"]):
             {"mean": num(r["mean"]), "se": num(r["se"])} for r in rows}

    fig, axes = plt.subplots(1, len(facets), figsize=(2.5 * len(facets), 3.1), sharey=True)
    for i, (ax, facet) in enumerate(zip(axes, facets)):
        parts = parts_by_facet[facet]
        grouped_bars(ax, parts, {(p, arm): cells.get((facet, p, arm))
                                 for p in parts for arm in ("Non-grounded", "Grounded")})
        tidy(ax)
        ax.set_title(f"{PANEL_LETTERS[i]}) {facet}", pad=8)
        ax.set_xticklabels([p.replace(" · ", "\n") for p in parts])
        ax.set_ylim(0, 1)
        if i == 0:
            ax.set_ylabel("F1")

    arm_legend(fig, y=-0.13)
    fig.subplots_adjust(wspace=0.25)
    save(fig, args.out, "localization_f1", args.format)


if __name__ == "__main__":
    main()
