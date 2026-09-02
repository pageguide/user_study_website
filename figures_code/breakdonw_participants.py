#!/usr/bin/env python3
"""Render data/breakdonw_participants.csv as a PDF: who is behind the n, sitting by sitting.

Every other figure in this folder aggregates. This one does not, and that is its whole job: a
within-subject claim rests on how many people worked BOTH arms, and no bar chart can show that.
Page 1 is the per-facet summary the card headers print; the pages after it are one line per
sitting, so the summary can be checked rather than taken on trust.

Drawn by hand — rectangles and text in axes coordinates — for the same reason results_table_pdf.py
is: `ax.table` cannot merge cells, and the four facet columns are each a Non-grounded/Grounded pair
that has to read as one band.

`participant` is the integer scripts/figures.mjs stamps on rows.csv and rows_master.csv, so a line
here joins to those files. The raw session id is deliberately not in the CSV.
"""

import csv
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import Rectangle

from common import ARM_COLOR, FACETS, INK, MUTED, RULE, parse_args, use_style

SOURCE = "breakdonw_participants.csv"

# The CSV's facet key ↔ the label every other figure uses. By name, never by column position: a
# column added to scripts/breakdonw_participants.mjs must not shift what these pages draw.
FACET_KEYS = [
    ("find_text", "Find × Text"),
    ("find_visual", "Find × Visual"),
    ("guide_text", "Guide × Text"),
    ("guide_visual", "Guide × Visual"),
]

ROWS_PER_PAGE = 26

BAND_FILL = "#f4f5f8"
ZEBRA = "#fbfbfc"
TOTAL_FILL = "#eef1f6"
BOTH_FILL = "#e8f1e6"      # a sitting that worked both arms of this facet
ONE_ARM_FILL = "#fdf3e7"   # …only one of them
NA_FILL = "#f6f6f8"
TINT = {"Non-grounded": "#f7ecee", "Grounded": "#eaf0f9"}


def read_breakdown(data_dir):
    path = Path(data_dir) / SOURCE
    if not path.exists():
        raise SystemExit(
            f"Missing {path}.\n"
            "It is written by scripts/breakdonw_participants.mjs, which the dashboard's publish "
            "buttons run before this folder is copied. Run that first, or pass --data at the CSV."
        )
    with path.open(newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        raise SystemExit(f"{path} holds a header and no sittings.")
    required = {"participant", "rows_counted", "nongrounded_rows", "grounded_rows", "both_arms"}
    missing = required - set(rows[0])
    if missing:
        raise SystemExit(
            f"{path} has no {', '.join(sorted(missing))} column. "
            "scripts/breakdonw_participants.mjs renamed it, or this page needs updating."
        )
    for key, _ in FACET_KEYS:
        for suffix in ("ng", "g"):
            if f"{key}_{suffix}" not in rows[0]:
                raise SystemExit(f"{path} has no {key}_{suffix} column.")
    return path, rows


def flag(value):
    return str(value).strip().lower() in ("true", "1", "yes")


def count(value):
    text = str(value).strip()
    return int(float(text)) if text else 0


# ── The summary the card headers print ───────────────────────────────────────────────────

# The four cards, then the three rollups. A rollup is NOT the sum of the rows above it — the same
# sitting is dealt tasks in several facets, so its people would be counted two, three or four times.
# Each line is therefore computed from the sittings themselves, over the facet keys it spans, which
# is the only way "how many unique participants are in the Find tasks" has one answer.
GROUPS = [(label, [key]) for key, label in FACET_KEYS] + [
    ("All Find tasks", ["find_text", "find_visual"]),
    ("All Guide tasks", ["guide_text", "guide_visual"]),
    ("All four facets", [key for key, _ in FACET_KEYS]),
]


def summarise(rows):
    """Per facet and per rollup: rows per arm, and how the people behind them split across arms."""
    out = []
    for label, keys in GROUPS:
        def arm(row, suffix):
            return sum(count(row[f"{key}_{suffix}"]) for key in keys)

        here = [r for r in rows if arm(r, "ng") or arm(r, "g")]
        ng_only = [r for r in here if arm(r, "ng") and not arm(r, "g")]
        g_only = [r for r in here if arm(r, "g") and not arm(r, "ng")]
        out.append({
            "label": label,
            "keys": keys,
            "ng_rows": sum(arm(r, "ng") for r in here),
            "g_rows": sum(arm(r, "g") for r in here),
            "people": len(here),
            "both": len(here) - len(ng_only) - len(g_only),
            "ng_only": len(ng_only),
            "g_only": len(g_only),
        })
    return out


def draw_summary(pdf, source_path, rows, summary):
    columns = [
        ("Facet", 2.3, lambda s: s["label"], None),
        ("Rows —\nNon-grounded", 1.25, lambda s: s["ng_rows"], "Non-grounded"),
        ("Rows —\nGrounded", 1.25, lambda s: s["g_rows"], "Grounded"),
        ("Participants", 1.25, lambda s: s["people"], None),
        ("In both arms", 1.25, lambda s: s["both"], None),
        # NOT arm-coloured, though they name an arm: these are counts of PEOPLE left unpaired, and
        # painting them as the arm bands would read as two more columns of rows.
        ("Non-grounded\nonly", 1.25, lambda s: s["ng_only"], None),
        ("Grounded\nonly", 1.25, lambda s: s["g_only"], None),
    ]
    total_rows = len(rows)
    complete = sum(1 for r in rows if flag(r.get("complete", "")))
    blurb = (
        f"{total_rows} sittings wrote at least one row; {complete} of them finished all eight "
        "tasks. A participant appears in a facet when the tasks that facet is counting include one "
        "they were dealt, so the facet counts do not add to the total: one sitting is spread over "
        "all four, and the three bold rows count each of its people ONCE rather than adding the "
        "lines above them. 'In both arms' is the number who worked that row grounded AND "
        "non-grounded — the paired comparison — and the two columns after it are the remainder, "
        "who contribute to one arm only. Row counts are the tasks these cards are counting; a task "
        "the dashboard leaves out by default is not in any of them."
    )
    _draw_page(pdf, source_path, "Participants per facet", blurb, columns, summary,
               highlight=lambda s: s["label"].startswith("All"),
               fig_width=11.0, page=None)


# ── One line per sitting ─────────────────────────────────────────────────────────────────

def draw_people(pdf, source_path, rows, page_index, page_count):
    def facet_cell(key):
        def read(r):
            ng, g = count(r[f"{key}_ng"]), count(r[f"{key}_g"])
            return "" if not ng and not g else f"{ng} / {g}"
        return read

    columns = [
        ("Participant", 1.35, lambda r: r["participant"], None),
        ("Rows\nwritten", 1.0, lambda r: count(r["rows_total"]), None),
        ("Tasks\nwalked", 1.0, lambda r: count(r["tasks_total"]), None),
        ("Finished\nall 8", 1.0, lambda r: "yes" if flag(r["complete"]) else "—", None),
        ("Rows\ncounted", 1.0, lambda r: count(r["rows_counted"]), None),
        ("Non-\ngrounded", 1.05, lambda r: count(r["nongrounded_rows"]), "Non-grounded"),
        ("Grounded", 1.05, lambda r: count(r["grounded_rows"]), "Grounded"),
        ("In both\narms", 1.05, lambda r: "yes" if flag(r["both_arms"]) else "—", None),
    ] + [(label.replace(" × ", "\n× ") + "\nng / g", 1.15, facet_cell(key), None)
         for key, label in FACET_KEYS]

    blurb = (
        "One line per sitting, over the tasks these cards are counting. The four facet columns are "
        "rows non-grounded / rows grounded: green where that sitting worked both arms of the facet, "
        "amber where it worked only one, blank where the facet's counted tasks never reached it. "
        "'Rows written' and 'Tasks walked' are the whole sitting, selection or not, so a person who "
        "looks thin here can be told from one who barely took part."
    )
    _draw_page(pdf, source_path, "Every sitting", blurb, columns, rows,
               highlight=lambda r: False, fig_width=13.5,
               page=(page_index, page_count), facet_tint=True)


def _draw_page(pdf, source_path, title, blurb, columns, body, highlight, fig_width,
               page=None, facet_tint=False):
    weights = [w for _, w, _, _ in columns]
    total = sum(weights)
    edges = [0.0]
    for weight in weights:
        edges.append(edges[-1] + weight / total)

    head_h, row_h = 1.7, 1.0
    units = head_h + row_h * len(body)
    table_h_in = 0.30 * units
    fig_height = table_h_in + 2.0

    fig = plt.figure(figsize=(fig_width, fig_height))
    ax = fig.add_axes([0.035, 1.05 / fig_height, 0.93, table_h_in / fig_height])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, units)
    ax.axis("off")

    def rect(x0, x1, y0, y1, color, z=0):
        ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, facecolor=color,
                               edgecolor="none", zorder=z))

    y_head_top = units
    y_body_top = units - head_h

    # The two arm columns keep the palette they carry in every other figure, so a reader who has
    # seen one panel already knows which half is which before reading the header. Which columns
    # those are is declared per column, never sniffed from the label: "Grounded only" counts people,
    # not rows, and painting it blue because of its name is exactly the confusion the palette exists
    # to prevent.
    for position, (label, _, _, arm) in enumerate(columns):
        x0, x1 = edges[position], edges[position + 1]
        rect(x0, x1, y_body_top, y_head_top, ARM_COLOR[arm] if arm else BAND_FILL, z=1)
        ax.text((x0 + x1) / 2, (y_body_top + y_head_top) / 2, label, ha="center", va="center",
                fontsize=7.8, fontweight="bold", color="white" if arm else INK,
                zorder=4, linespacing=1.3)

    facet_start = len(columns) - len(FACET_KEYS) if facet_tint else len(columns)

    for index, row in enumerate(body):
        y1 = y_body_top - index * row_h
        y0 = y1 - row_h
        strong = highlight(row)
        rect(0, 1, y0, y1, TOTAL_FILL if strong else (ZEBRA if index % 2 else "white"), z=1)
        for position, (label, _, read, arm) in enumerate(columns):
            x0, x1 = edges[position], edges[position + 1]
            value = read(row)
            text = "" if value is None else str(value)
            if facet_tint and position >= facet_start:
                if not text:
                    rect(x0, x1, y0, y1, NA_FILL, z=2)
                else:
                    ng, g = (int(part) for part in text.split(" / "))
                    rect(x0, x1, y0, y1, BOTH_FILL if ng and g else ONE_ARM_FILL, z=2)
            elif arm:
                rect(x0, x1, y0, y1, TINT[arm], z=2)
            ax.text(x0 + 0.008 if position == 0 else (x0 + x1) / 2, (y0 + y1) / 2,
                    text or "—", ha="left" if position == 0 else "center", va="center",
                    fontsize=8.2, color=INK if text else "#a6a6b0", zorder=4,
                    fontweight="bold" if strong else "normal")

    for position in range(1, len(columns)):
        ax.plot([edges[position]] * 2, [0, y_head_top], color=RULE, linewidth=0.5, zorder=5)
    for index in range(len(body) + 1):
        y = y_body_top - index * row_h
        ax.plot([0, 1], [y, y], color=RULE, linewidth=0.5, zorder=5)
    for y in (0, y_body_top, y_head_top):
        ax.plot([0, 1], [y, y], color=INK, linewidth=1.1, zorder=6)

    fig.text(0.035, 1 - 0.20 / fig_height, "PageGuide — Participant Breakdown", fontsize=15,
             fontweight="bold", color=INK, ha="left", va="top")
    heading = title if page is None else f"{title} — page {page[0] + 1} of {page[1]}"
    fig.text(0.035, 1 - 0.48 / fig_height, heading, fontsize=10.5, fontweight="bold",
             color=INK, ha="left", va="top")
    fig.text(0.965, 1 - 0.21 / fig_height, f"Source: {source_path.name}", fontsize=7.5,
             color=MUTED, ha="right", va="top")
    # Wrapped to the page rather than left to `wrap=True`, which measures against the FIGURE and
    # happily runs the last line off a wide one. 8pt text sits at roughly 0.62 em per character.
    fig.text(0.035, 0.72 / fig_height,
             textwrap.fill(blurb, max(60, int(0.93 * fig_width / (8.0 * 0.62 / 72)))),
             fontsize=8.0, color=MUTED, ha="left", va="top", linespacing=1.45)
    return pdf.savefig(fig), plt.close(fig)


def main():
    args = parse_args("Render the per-participant breakdown as a PDF table")
    # Multi-page by nature — one page of summary and as many as the sample needs after it — so a
    # PNG would keep only the first. Same rule as results_table_pdf.py: draw the PDF and say so,
    # rather than failing a `make_all.py --format png` run that wants every figure.
    if args.format != "pdf":
        print(f"  (the participant breakdown is multi-page, so it is written as PDF, not {args.format})")
    use_style()
    source_path, rows = read_breakdown(args.data)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "breakdonw_participants.pdf"

    pages = [rows[i:i + ROWS_PER_PAGE] for i in range(0, len(rows), ROWS_PER_PAGE)]
    with PdfPages(out_path) as pdf:
        draw_summary(pdf, source_path, rows, summarise(rows))
        for index, page in enumerate(pages):
            draw_people(pdf, source_path, page, index, len(pages))
    print(f"✓ {out_path}")


if __name__ == "__main__":
    main()
