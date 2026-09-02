#!/usr/bin/env python3
"""Render data/results_table.csv as a readable multi-page PDF table.

The CSV carries two header rows: a metric name that sits over a *pair* of columns and, under
it, the arm that each half of the pair belongs to. matplotlib's `ax.table` cannot merge cells,
so the earlier version dropped the metric name from the right half of every pair and the page
read as a wall of "Non-grounded / PageGuide" columns with no idea what they measured. The table
here is drawn by hand — rectangles and text in axes coordinates — so the metric band really
spans its pair, the two arms keep the palette they have in every other figure, and a blank cell
in the CSV reads as "not applicable" instead of as an empty box.
"""

import csv
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import Rectangle

from common import ARM_COLOR, INK, MUTED, RULE, parse_args, use_style


# ── Which measures land on which page ────────────────────────────────────────────────────
#
# BY NAME, NEVER BY COLUMN INDEX. This list used to hold raw indices into the CSV, and the first
# time scripts/results_table.mjs gained a column every page after it silently rendered the wrong
# measure: the ratings page drew Ctrl-F and text selections under a "Post-study Ratings" heading,
# and mouse travel, confidence and helpfulness dropped off the end of the table altogether. A name
# that disappears from the sheet now fails the run instead, which is the only failure mode a table
# in a paper can afford.
#
# "Condition", "Task rows (n)", "Participants" and "Tasks" are the five lead columns; every other
# entry is a metric band from the CSV's top header row, standing for its Non-grounded/PageGuide
# pair. Spread columns get pages of their own rather than doubling the width of every page above:
# a mean and its SD are read together, but sixteen more columns squeezed into the same rows makes
# both unreadable.
LEAD = ["Condition", "Task rows (n)", "Participants", "Tasks"]

SECTIONS = [
    ("Overview", "Sample size, task time and answer accuracy for every condition.",
     LEAD + ["Judge Time (s)", "Locate Time (s)", "Accuracy"]),
    ("Find and Guide Outcomes", "Component scores; Find rows and Guide rows are scored on "
     "different components, so each block is blank for the other task type.",
     ["Condition", "Find Result (First part)", "Find Result (Second part)",
      "Guide Result (Error Part)", "Guide Result (Step Error)", "Localization"]),
    ("Interaction Behavior", "What participants did on the page while working the task.",
     ["Condition", "Scrolls", "Ctr-F", "Selections", "Clicks", "Mouse Travel (px)"]),
    ("Post-study Ratings", "Self-reported ratings collected after each condition (1-4 scale).",
     ["Condition", "Confidence (/4)", "Helpfulness (/4)"]),
    ("Spread — Outcomes (SD)", "Sample standard deviation (n-1) of the same values the means "
     "above rest on, arm by arm. A 0/1 measure near 0.5 is a divided sample, not a middling one.",
     ["Condition", "Accuracy SD", "Find Result (First part) SD", "Find Result (Second part) SD",
      "Guide Result (Error Part) SD", "Guide Result (Step Error) SD"]),
    ("Spread — Behavior and Ratings (SD)", "Mouse travel is long-tailed, so its spread is the "
     "context its mean needs; the rating scales are ordinal, where the spread is the question of "
     "whether participants agreed at all.",
     ["Condition", "Mouse Travel (px) SD", "Confidence (/4) SD", "Helpfulness (/4) SD"]),
]

# Two columns of the CSV are a Non-grounded/PageGuide pair whose top header names the arm
# rather than the measure, so the metric band above them has to be supplied here.
ROW_COUNT_GROUP = "Task rows (n)"
SINGLE_COLUMN_LABELS = {
    0: "Condition",
    3: "Participants",
    4: "Tasks",
}
ARM_NAMES = {
    "non-grounded": "Non-grounded",
    "non grounded": "Non-grounded",
    "grounded": "Grounded",
    "pageguide": "Grounded",
}
ARM_DISPLAY = {"Non-grounded": "Non-Grounded", "Grounded": "PageGuide"}
# The CSV ships this header misspelled; it is the browser's find-in-page counter.
HEADER_FIXES = {"Ctr-F": "Ctrl-F"}
ROW_LABELS = {
    "FindxVisual": "Find × Visual",
    "FindxText": "Find × Text",
    "GuidexText": "Guide × Text",
    "GuidexVisual": "Guide × Visual",
    "avg (Find)": "Average — Find",
    "avg (Guide)": "Average — Guide",
}

TINT = {"Non-grounded": "#f7ecee", "Grounded": "#eaf0f9"}
BAND_FILL = "#f4f5f8"
ZEBRA = "#fbfbfc"
AVG_FILL = "#eef1f6"
NA_FILL = "#f6f6f8"


def read_results_table(data_dir):
    path = Path(data_dir) / "results_table.csv"
    if not path.exists():
        raise SystemExit(f"Missing {path}")
    with path.open(newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))
    if len(rows) < 3:
        raise SystemExit(f"{path} does not contain the expected two header rows and data")
    return path, rows[0], rows[1], rows[2:]


def cell(row, index):
    return row[index].strip() if index < len(row) else ""


def resolve_columns(names, top_header):
    """The CSV column indices behind a page's list of measure names.

    A metric band names only the first column of its pair in the top header row, so a named band
    resolves to that column and the one after it. The lead columns are positional by nature — they
    are the sheet's identity columns and carry no metric band — and are looked up by the names in
    SINGLE_COLUMN_LABELS / ROW_COUNT_GROUP so this list reads the same way throughout.
    """
    lead = {label: [index] for index, label in SINGLE_COLUMN_LABELS.items()}
    lead[ROW_COUNT_GROUP] = [1, 2]
    bands = {}
    for index, raw in enumerate(top_header):
        name = raw.strip()
        if name and index > max(SINGLE_COLUMN_LABELS):
            bands.setdefault(name, [index, index + 1])

    indices = []
    for name in names:
        if name in lead:
            indices.extend(lead[name])
        elif name in bands:
            indices.extend(bands[name])
        else:
            raise SystemExit(
                f"results_table.csv has no column group named {name!r}. "
                f"It holds: {', '.join(sorted(bands)) or '(no metric bands)'}. "
                "Either scripts/results_table.mjs renamed it, or this page needs updating."
            )
    return indices


def describe_columns(indices, top_header, sub_header):
    """Turn raw column indices into (group, arm) descriptors, forward-filling the metric band.

    The metric name only appears over the first column of each pair; every column still needs
    to know which band it sits under so the band can be drawn as one merged span.
    """
    columns = []
    for index in indices:
        top = cell(top_header, index)
        sub = cell(sub_header, index)
        if index in SINGLE_COLUMN_LABELS:
            columns.append({"index": index, "group": SINGLE_COLUMN_LABELS[index], "arm": None})
            continue
        if index in (1, 2):
            arm = "Non-grounded" if index == 1 else "Grounded"
            columns.append({"index": index, "group": ROW_COUNT_GROUP, "arm": arm})
            continue
        if not top:  # right half of a pair: walk back for the metric name
            probe = index - 1
            while probe >= 0 and not cell(top_header, probe):
                probe -= 1
            top = cell(top_header, probe)
        group = HEADER_FIXES.get(top, top)
        columns.append({"index": index, "group": group,
                        "arm": ARM_NAMES.get(sub.lower(), sub or None)})
    return columns


def group_spans(columns):
    """Consecutive runs of columns sharing a metric band, as (group, first, last)."""
    spans = []
    for position, column in enumerate(columns):
        if spans and spans[-1][0] == column["group"] and spans[-1][2] == position - 1:
            spans[-1][2] = position
        else:
            spans.append([column["group"], position, position])
    return [tuple(span) for span in spans]


def format_value(text):
    """Print what the CSV says, only grouping thousands so the big counts stay readable."""
    if not text:
        return ""
    try:
        number = float(text)
    except ValueError:
        return text
    if abs(number) >= 1000 and "." not in text:
        return f"{int(number):,}"
    return text


def wrapped(label, width_in, fontsize, max_lines=3):
    chars = max(6, int(width_in / (fontsize * 0.62 / 72)))
    lines = textwrap.wrap(label, chars, break_long_words=False) or [label]
    if len(lines) > max_lines:
        lines = lines[:max_lines - 1] + [" ".join(lines[max_lines - 1:])]
    return "\n".join(lines)


def column_weights(columns):
    """Relative widths: the condition column carries long labels, the rest share the page."""
    weights = []
    for position, column in enumerate(columns):
        if position == 0:
            weights.append(2.15)
        elif column["arm"] is None:
            weights.append(0.92)
        else:
            weights.append(1.0)
    return weights


def draw_section(pdf, source_path, title, blurb, columns, body, fig_width, width_frac):
    weights = column_weights(columns)
    total = sum(weights)
    edges = [0.0]
    for weight in weights:
        edges.append(edges[-1] + weight / total)
    spans = group_spans(columns)
    has_arms = any(column["arm"] for column in columns)

    group_h, arm_h, row_h = 1.55, 1.05, 1.0
    units = group_h + arm_h + row_h * len(body)
    table_h_in = 0.42 * units
    fig_height = table_h_in + 1.55

    fig = plt.figure(figsize=(fig_width, fig_height))
    bottom = 0.62 / fig_height
    # Sections hold different numbers of columns; scaling the axes instead of the page keeps
    # every page the same size and every column the same width across the whole document.
    ax = fig.add_axes([0.035, bottom, 0.93 * width_frac, table_h_in / fig_height])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, units)
    ax.axis("off")

    table_w_in = 0.93 * width_frac * fig_width
    y_group_top = units
    y_arm_top = units - group_h
    y_body_top = y_arm_top - arm_h

    def rect(x0, x1, y0, y1, color, z=0):
        ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, facecolor=color,
                               edgecolor="none", zorder=z))

    # ── Header: metric bands, then the arm they split into ──────────────────────────────
    for group, first, last in spans:
        x0, x1 = edges[first], edges[last + 1]
        spans_arms = columns[first]["arm"] is not None
        y0 = y_arm_top if spans_arms else y_body_top
        rect(x0, x1, y0, y_group_top, BAND_FILL, z=1)
        label = wrapped(group, (x1 - x0) * table_w_in - 0.12, 8.4)
        ax.text((x0 + x1) / 2, (y0 + y_group_top) / 2, label, ha="center", va="center",
                fontsize=8.4, fontweight="bold", color=INK, zorder=4, linespacing=1.25)

    for position, column in enumerate(columns):
        if column["arm"] is None:
            continue
        x0, x1 = edges[position], edges[position + 1]
        rect(x0, x1, y_body_top, y_arm_top, ARM_COLOR[column["arm"]], z=1)
        ax.text((x0 + x1) / 2, (y_body_top + y_arm_top) / 2, ARM_DISPLAY[column["arm"]],
                ha="center", va="center", fontsize=7.6, fontweight="bold", color="white",
                zorder=4)

    # ── Body ────────────────────────────────────────────────────────────────────────────
    for index, row in enumerate(body):
        y1 = y_body_top - index * row_h
        y0 = y1 - row_h
        raw_label = cell(row, columns[0]["index"])
        is_average = raw_label.lower().startswith("avg")
        rect(0, 1, y0, y1, AVG_FILL if is_average else (ZEBRA if index % 2 else "white"), z=1)
        if not is_average:  # keep the arm pairing visible down the page
            for position, column in enumerate(columns):
                if column["arm"]:
                    rect(edges[position], edges[position + 1], y0, y1,
                         TINT[column["arm"]], z=2)

        for position, column in enumerate(columns):
            x0, x1 = edges[position], edges[position + 1]
            value = cell(row, column["index"])
            if position == 0:
                ax.text(x0 + 0.008, (y0 + y1) / 2, ROW_LABELS.get(value, value),
                        ha="left", va="center", fontsize=8.6, color=INK, zorder=4,
                        fontweight="bold" if is_average else "normal")
                continue
            if not value:
                rect(x0, x1, y0, y1, NA_FILL, z=3)
                ax.text((x0 + x1) / 2, (y0 + y1) / 2, "n/a", ha="center", va="center",
                        fontsize=7.4, color="#a6a6b0", style="italic", zorder=4)
                continue
            ax.text((x0 + x1) / 2, (y0 + y1) / 2, format_value(value), ha="center",
                    va="center", fontsize=8.4, color=INK, zorder=4,
                    fontweight="bold" if is_average else "normal")

    # ── Rules ───────────────────────────────────────────────────────────────────────────
    for position in range(1, len(columns)):
        column, previous = columns[position], columns[position - 1]
        same_group = column["group"] == previous["group"]
        ax.plot([edges[position]] * 2, [0, y_group_top if not same_group else y_body_top],
                color=RULE if same_group else "#c3c3ce",
                linewidth=0.5 if same_group else 0.9, zorder=5)
    for index in range(len(body) + 1):
        y = y_body_top - index * row_h
        ax.plot([0, 1], [y, y], color=RULE, linewidth=0.5, zorder=5)
    ax.plot([0, 1], [y_body_top, y_body_top], color=INK, linewidth=1.1, zorder=6)
    ax.plot([0, 1], [y_group_top, y_group_top], color=INK, linewidth=1.1, zorder=6)
    ax.plot([0, 1], [0, 0], color=INK, linewidth=1.1, zorder=6)
    for index, row in enumerate(body):  # separate each block from its average row
        if cell(row, columns[0]["index"]).lower().startswith("avg"):
            y = y_body_top - index * row_h
            ax.plot([0, 1], [y, y], color="#9a9aa6", linewidth=0.8, zorder=6)

    # ── Page furniture ──────────────────────────────────────────────────────────────────
    fig.text(0.035, 1 - 0.20 / fig_height, "PageGuide Results Table", fontsize=15,
             fontweight="bold", color=INK, ha="left", va="top")
    fig.text(0.035, 1 - 0.48 / fig_height, title, fontsize=10.5, fontweight="bold",
             color=INK, ha="left", va="top")
    right = 0.035 + 0.93 * width_frac
    fig.text(right, 1 - 0.21 / fig_height, f"Source: {source_path.name}", fontsize=7.5,
             color=MUTED, ha="right", va="top")
    if has_arms:
        fig.text(right, 1 - 0.40 / fig_height,
                 "■ Non-Grounded    ■ PageGuide (grounded)", fontsize=8,
                 color=MUTED, ha="right", va="top")
    fig.text(0.035, 0.42 / fig_height, blurb, fontsize=8.2, color=MUTED,
             ha="left", va="top")
    fig.text(0.035, 0.20 / fig_height,
             "Counts are task rows per condition; times are seconds; accuracy, component "
             "outcomes and localization are means; ratings are means on a 1-4 scale; SD pages "
             "carry the sample standard deviation (n-1) of the same values. "
             "'n/a' marks a measure that does not apply to that task type.",
             fontsize=7.4, color=MUTED, ha="left", va="top")

    pdf.savefig(fig)
    plt.close(fig)


def render_table_pdf(source_path, top_header, sub_header, body, out_path):
    """Draw one results table, already parsed, as the multi-page PDF.

    Split out of main() so a table built somewhere else — results_table_subset.py rebuilds one from
    the row-level master — lands on exactly these pages, with exactly this styling, instead of a
    second drawing routine growing beside this one and slowly diverging from it.
    """
    sections = [(title, blurb,
                 describe_columns(resolve_columns(names, top_header), top_header, sub_header))
                for title, blurb, names in SECTIONS]
    widest = max(sum(column_weights(columns)) for _, _, columns in sections)

    with PdfPages(out_path) as pdf:
        for title, blurb, columns in sections:
            draw_section(pdf, source_path, title, blurb, columns, body, fig_width=13.5,
                         width_frac=sum(column_weights(columns)) / widest)
    return out_path


def main():
    args = parse_args("Render results_table.csv as a readable PDF table")
    # A multi-page table is a PDF and nothing else: PdfPages is what puts four sections in one
    # file, and a PNG would silently keep only the first of them. `make_all.py --format png`
    # therefore does not fail here — it draws the table as a PDF and says so, so a run asking
    # for PNGs still comes back with every figure the folder is meant to hold.
    if args.format != "pdf":
        print(f"  (the results table is multi-page, so it is written as PDF, not {args.format})")
    use_style()
    source_path, top_header, sub_header, body = read_results_table(args.data)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "results_table.pdf"

    render_table_pdf(source_path, top_header, sub_header, body, out_path)
    print(f"✓ {out_path}")


if __name__ == "__main__":
    main()
