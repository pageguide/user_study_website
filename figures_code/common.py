"""Shared style and data loading for every PageGuide figure script.

The figures in the paper are drawn twice: once by `scripts/figures.mjs` (SVG, straight from
Supabase) and once here (matplotlib, from the CSVs that run exported). Both read the same
numbers, so a panel drawn here can be checked against the published SVG bar for bar.

Colours, arm order and facet order are copied from `scripts/figures.mjs` and must stay in step
with it: non-grounded is always first and always rose, grounded always second and always blue,
so a figure cannot repaint its arms because one of them had no rows.
"""

import argparse
import csv
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ── Palette ──────────────────────────────────────────────────────────────────────────────────
# A muted rose and a muted blue, validated for CVD separation and 3:1 contrast on white.
# Do not soften these without re-running the checks documented in scripts/figures.mjs.
ARMS = [
    ("Non-grounded", "#bf5a64"),
    ("Grounded", "#5183c9"),
]
ARM_COLOR = dict(ARMS)
ARM_ORDER = [label for label, _ in ARMS]

FACETS = ["Find × Text", "Find × Visual", "Guide × Text", "Guide × Visual"]
FACET_SHORT = {
    "Find × Text": "Find\n×Text",
    "Find × Visual": "Find\n×Visual",
    "Guide × Text": "Guide\n×Text",
    "Guide × Visual": "Guide\n×Visual",
}

INK = "#16161a"
MUTED = "#5c5c66"
RULE = "#d8d8e0"

# The 1-7 Likert palette from the dashboard (app/welcome.js LIKERT_COLORS).
LIKERT_COLORS = {
    1: "#c2185b",
    2: "#e7548a",
    3: "#f4b5cf",
    4: "#e7e7e7",
    5: "#bddd9c",
    6: "#63b765",
    7: "#2e7d32",
}

PANEL_LETTERS = "abcdefgh"


def use_style():
    plt.rcParams.update({
        "figure.dpi": 150,
        "savefig.dpi": 150,
        "figure.facecolor": "white",
        "savefig.facecolor": "white",
        "font.size": 9,
        "font.family": "sans-serif",
        "font.sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
        "axes.edgecolor": RULE,
        "axes.labelcolor": MUTED,
        "axes.titlecolor": INK,
        "axes.titlesize": 10,
        "axes.titleweight": "bold",
        "axes.titlelocation": "left",
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.spines.left": False,
        "text.color": INK,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "xtick.labelcolor": MUTED,
        "ytick.labelcolor": MUTED,
        "xtick.direction": "out",
        "legend.frameon": False,
    })


def tidy(ax, ygrid=True):
    """Horizontal rules only, behind the marks — the house look of these panels."""
    ax.set_axisbelow(True)
    if ygrid:
        ax.yaxis.grid(True, color=RULE, linewidth=0.7)
    ax.xaxis.grid(False)
    ax.tick_params(axis="both", length=0)


def arm_legend(fig, ncol=2, y=0.02):
    handles = [plt.Rectangle((0, 0), 1, 1, facecolor=color, edgecolor="none") for _, color in ARMS]
    fig.legend(handles, ARM_ORDER, loc="lower center", ncol=ncol,
               bbox_to_anchor=(0.5, y), handlelength=1.1, handleheight=1.1,
               columnspacing=1.6, fontsize=9)


# ── Data ─────────────────────────────────────────────────────────────────────────────────────

def script_dir():
    return Path(__file__).resolve().parent


def parse_args(description):
    """Every script takes the same two paths, so a whole folder can be rebuilt in one loop."""
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--data", default=os.environ.get("PAGEGUIDE_DATA", str(script_dir() / "data")),
                    help="folder holding the exported CSVs (default: ./data)")
    ap.add_argument("--out", default=os.environ.get("PAGEGUIDE_OUT", str(script_dir() / "figures")),
                    help="folder to write the figures into (default: ./figures)")
    ap.add_argument("--format", default="pdf", choices=["pdf", "png", "svg"],
                    help="output format (default: pdf)")
    return ap.parse_args()


def load_csv(data_dir, name):
    path = Path(data_dir) / name
    if not path.exists():
        raise SystemExit(
            f"Missing {path}.\n"
            "These scripts plot the CSVs exported beside the figures. Copy figures/*.csv, "
            "dataset/rows.csv and post_study/post_study.csv into the data folder, or pass "
            "--data pointing at them."
        )
    with path.open(newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def num(value):
    try:
        text = str(value).strip()
        return float(text) if text else None
    except (TypeError, ValueError):
        return None


def save(fig, out_dir, name, fmt="pdf"):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{name}.{fmt}"
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)
    print(f"✓ {path}")
    return path


# ── Marks ────────────────────────────────────────────────────────────────────────────────────

def grouped_bars(ax, groups, cells, width=0.34, capsize=3):
    """Bars with ±1 standard error whiskers — the mark used by every mean panel.

    `cells[(group, arm)] = {"mean": float, "se": float}`; a missing cell is drawn as nothing
    rather than as zero, because "no rows" and "zero" are different facts.
    """
    positions = range(len(groups))
    for i, (arm, color) in enumerate(ARMS):
        offset = (i - (len(ARMS) - 1) / 2) * width
        xs, ys, errs = [], [], []
        for x, group in zip(positions, groups):
            cell = cells.get((group, arm))
            if not cell or cell.get("mean") is None:
                continue
            xs.append(x + offset)
            ys.append(cell["mean"])
            errs.append(cell.get("se") or 0)
        ax.bar(xs, ys, width=width, color=color, edgecolor="none", zorder=2)
        ax.errorbar(xs, ys, yerr=errs, fmt="none", ecolor=INK, elinewidth=0.9,
                    capsize=capsize, capthick=0.9, zorder=3)
    ax.set_xticks(list(positions))
    ax.set_xlim(-0.6, len(groups) - 0.4)
    ax.set_ylim(bottom=0)


def thousands(value, _pos=None):
    """20000 → 20k, matching the mouse-distance axis in the published SVG."""
    if value >= 1000:
        trimmed = f"{value / 1000:.0f}k"
        return trimmed
    return f"{value:.0f}"
