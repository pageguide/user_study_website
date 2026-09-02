#!/usr/bin/env python3
"""Rebuild the results table from the row-level master, in two parts you can run and read separately.

    PART 1 — SUBSET.  data/rows_master.csv is every answered task the study has collected, with no
    selection applied. data/selection.json is the task selection the dashboard was showing when
    publish was pressed. Part 1 filters the first by the second and writes data/rows_subset.csv.

    PART 2 — TABLE.  Part 2 computes the paper's table from that subset — the same measures, arms,
    rows and SD columns as data/results_table.csv — writes data/results_table_subset.csv, and draws
    it through results_table_pdf.py into figures/results_table_subset.pdf.

WHY BOTH PARTS ARE HERE rather than a pre-filtered CSV. `rows.csv` in this folder is already
filtered, and a filtered file cannot be checked: it says what was counted but not what was left out,
so nobody reading it can tell a deliberate exclusion from a task that never made it into the export.
With the master and the selection side by side, the subset is reproducible — run part 1 and you get
the same rows the figures were drawn from, or you find out that you do not.

    python results_table_subset.py                    # → data/rows_subset.csv, data/results_table_subset.csv, figures/results_table_subset.pdf
    python results_table_subset.py --all-tasks        # ignore selection.json; count every task in the master
    python results_table_subset.py --data D --out O   # read the CSVs from D, write the PDF into O

SELF-CHECK. When the subset matches the selection this folder was published with, the table built
here must equal data/results_table.csv cell for cell — one is computed in Node from Supabase, the
other in Python from the exported master. The run compares them and prints what differs. A mismatch
is a real finding: it means the two implementations of a measure have drifted apart, and the number
in the paper depends on which one you believe.

THE MEASURES ARE MIRRORED FROM scripts/results_table.mjs, which lifts them from app/welcome.js.
That is a copy, and copies drift — the self-check above is the thing that catches it, so keep it
passing rather than deleting it when it complains.
"""

import argparse
import csv
import json
import os
from pathlib import Path

from common import script_dir
from results_table_pdf import render_table_pdf


# ── Part 1: the subset ───────────────────────────────────────────────────────────────────────────

def load_master(data_dir):
    path = Path(data_dir) / "rows_master.csv"
    if not path.exists():
        raise SystemExit(
            f"Missing {path}.\n"
            "It is written by scripts/figures.mjs beside rows.csv — press the dashboard's "
            "'Export results table + figures' button, or run that script, and publish again."
        )
    with path.open(newline="", encoding="utf-8-sig") as fh:
        return path, list(csv.DictReader(fh))


def load_selection(data_dir):
    path = Path(data_dir) / "selection.json"
    if not path.exists():
        raise SystemExit(
            f"Missing {path}.\n"
            "It records which tasks each card was counting at publish time. Re-publish from the "
            "dashboard, or pass --all-tasks to count every task in the master instead."
        )
    return path, json.loads(path.read_text(encoding="utf-8"))


def subset_rows(master, selection):
    """The master, narrowed to the selection — part 1, and the only place rows are dropped.

    Matched on the master's own `facet` label rather than by re-deriving the facet from task_type
    and task_style here. Deciding a row's style is a rule with real edge cases (app/welcome.js
    taskStyle), and a second implementation of it in this file would be a silent way for the subset
    to stop meaning what the figures mean. The export already applied that rule; this trusts it.
    """
    wanted = {}
    for facet in selection["facets"].values():
        wanted[facet["label"]] = set(facet["task_ids"])
    kept = [r for r in master
            if r.get("facet") in wanted and r.get("task_id") in wanted[r["facet"]]]
    return kept, wanted


def check_against_export(kept, master):
    """Compare part 1's answer with the `in_selection` flag the export wrote on every master row.

    The flag says which rows THAT run counted; this says which rows the selection describes. They
    are two different routes to one set, so a disagreement means the published selection.json does
    not describe the published figures — worth a loud line, not a silent success.
    """
    flagged = {id(r) for r in master if str(r.get("in_selection", "")).lower() == "true"}
    if not flagged:
        return "(the master carries no in_selection flag, so the subset was not cross-checked)"
    ours = {id(r) for r in kept}
    if ours == flagged:
        return f"✓ matches the {len(flagged)} rows the export itself flagged as counted"
    return (f"! the filter kept {len(ours)} rows but the export flagged {len(flagged)} — "
            "selection.json and rows_master.csv are from different runs")


# ── Part 2: the table ────────────────────────────────────────────────────────────────────────────

CONFIDENCE = {"very": 4, "somewhat": 3, "notsure": 2, "guessed": 1}
HELPFULNESS = {"very": 4, "somewhat": 3, "notmuch": 2, "notatall": 1}


def num(value):
    """A cell as a number, with the CSV's booleans counting as 1 and 0 — blank is missing, not zero."""
    text = str(value).strip().lower()
    if text in ("", "none", "null"):
        return None
    if text == "true":
        return 1.0
    if text == "false":
        return 0.0
    try:
        return float(text)
    except ValueError:
        return None


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def sd(values):
    """Sample standard deviation (n-1), matching scripts/dashboard_defs.mjs stats()."""
    values = [v for v in values if v is not None]
    if not values:
        return None
    if len(values) == 1:
        return 0.0
    m = sum(values) / len(values)
    return (sum((v - m) ** 2 for v in values) / (len(values) - 1)) ** 0.5


def f1(precision, recall):
    """The harmonic mean, with a null precision read as zero true positives — not as unknown.

    app/welcome.js explains why at length: precision is null exactly when the participant predicted
    nothing, which is most of the guide rows. Treating that as missing would drop them out of their
    own average. A null RECALL is genuinely unknown — the key had nothing to find — and leaves.
    """
    r = num(recall)
    if r is None:
        return None
    p = num(precision)
    if p is None or p + r == 0:
        return 0.0
    return min(1.0, max(0.0, (2 * p * r) / (p + r)))


def evidence_quality(row):
    if row.get("task_type") == "find":
        return f1(row.get("score_evidence_precision"), row.get("score_evidence_recall"))
    if row.get("task_type") == "guide":
        balanced = mean([f1(row.get("score_type_precision"), row.get("score_type_recall")),
                         f1(row.get("score_step_precision"), row.get("score_step_recall"))])
        if balanced is not None:
            return balanced
        agreed = num(row.get("score_no_error_agreement"))
        return agreed
    return None


def accuracy(row):
    key = "score_answer_correct" if row.get("task_type") == "find" else "score_verdict_correct"
    return num(row.get(key))


def scale(field, table):
    def value(row):
        return table.get(str(row.get(field, "")).strip().lower())
    return value


def column(field, scale_by=1.0):
    def value(row):
        raw = num(row.get(field))
        return None if raw is None else raw * scale_by
    return value


# Group name, how to read it off a row, decimals, and whether it also gets an SD column beside it.
# The order and the names are the sheet's, so results_table_pdf.py finds the same bands here as it
# does in the CSV scripts/results_table.mjs writes.
MEASURES = [
    ("Judge Time (s)", column("answer_multiple_choice_ms", 0.001), 1, False),
    ("Locate Time (s)", column("find_supporting_answer_ms", 0.001), 1, False),
    ("Accuracy", accuracy, 3, True),
    ("Find Result (First part)", column("score_evidence_hop_exact_1"), 3, True),
    ("Find Result (Second part)", column("score_evidence_hop_exact_2"), 3, True),
    ("Guide Result (Error Part)",
     lambda r: f1(r.get("score_type_precision"), r.get("score_type_recall")), 3, True),
    ("Guide Result (Step Error)",
     lambda r: f1(r.get("score_step_precision"), r.get("score_step_recall")), 3, True),
    ("Localization", evidence_quality, 3, False),
    ("Scrolls", column("scroll_count"), 2, False),
    ("Ctr-F", column("ctrl_f_count"), 2, False),
    ("Selections", column("text_select_count"), 2, False),
    ("Clicks", column("click_count"), 2, False),
    ("Mouse Travel (px)", column("mouse_move_px"), 0, True),
    ("Confidence (/4)", scale("confidence", CONFIDENCE), 2, True),
    ("Helpfulness (/4)", scale("helpfulness", HELPFULNESS), 2, True),
]

LEAD_COLUMNS = ["Type", "Non_grounded_n", "Grounded_n", "Participants", "N_tasks"]
ARMS = [("nongrounding", "Non-grounded"), ("grounding", "PageGuide")]
# The sheet's own sub-headers, which are not consistent across groups. Reproduced rather than
# tidied, for the same reason scripts/results_table.mjs reproduces them: this file has to drop into
# the existing workbook beside columns nobody diffs.
SUB_HEADERS = {
    "Judge Time (s)": ("Non-grounded", "Grounded"),
    "Locate Time (s)": ("Non-grounded", "Grounded"),
    "Accuracy": ("Non-grounded", "PageGuide"),
    "Find Result (First part)": ("Non Grounded", "PageGuide"),
    "Find Result (Second part)": ("Non Grounded", "PageGuide"),
    "Guide Result (Error Part)": ("Non Grounded", "PageGuide"),
    "Guide Result (Step Error)": ("Non Grounded", "PageGuide"),
    "Localization": ("Non Grounded", "PageGuide"),
}
DEFAULT_SUB = ("Non-grounded", "PageGuide")

# The six lines of the sheet. The two averages pool ROWS across their pair of facets rather than
# averaging the two facet means: the facets hold different numbers of rows, and pooling is the one
# that answers "the average Find task".
TABLE_ROWS = [
    ("FindxVisual", ["Find × Visual"]),
    ("FindxText", ["Find × Text"]),
    ("avg (Find)", ["Find × Visual", "Find × Text"]),
    ("GuidexText", ["Guide × Text"]),
    ("GuidexVisual", ["Guide × Visual"]),
    ("avg (Guide)", ["Guide × Text", "Guide × Visual"]),
]


def columns_with_spread():
    """Every measure, with a `<name> SD` group inserted after each one that carries a spread."""
    out = []
    for group, value, places, has_sd in MEASURES:
        out.append((group, value, places, "mean"))
        if has_sd:
            out.append((f"{group} SD", value, places, "sd"))
    return out


def fmt(value, places):
    return "" if value is None else f"{value:.{places}f}"


def build_table(rows):
    columns = columns_with_spread()
    top = list(LEAD_COLUMNS)
    sub = ["" for _ in LEAD_COLUMNS]
    for group, _, _, _ in columns:
        base = group[:-3] if group.endswith(" SD") else group
        ng, g = SUB_HEADERS.get(base, DEFAULT_SUB)
        top.extend([group, ""])
        sub.extend([ng, g])

    table = [top, sub]
    for label, facets in TABLE_ROWS:
        line_rows = [r for r in rows if r.get("facet") in facets]
        # Strings, not ints, all the way through: this table is handed both to csv.writer and
        # straight to the PDF renderer, which reads a CSV's cells and so expects text.
        line = [
            label,
            str(sum(1 for r in line_rows if r.get("condition") == "nongrounding")),
            str(sum(1 for r in line_rows if r.get("condition") == "grounding")),
            str(len({r.get("participant") for r in line_rows if r.get("participant")})),
            str(len({r.get("task_id") for r in line_rows if r.get("task_id")})),
        ]
        for _, value, places, stat in columns:
            for arm_id, _ in ARMS:
                values = [value(r) for r in line_rows if r.get("condition") == arm_id]
                values = [v for v in values if v is not None]
                line.append(fmt(sd(values) if stat == "sd" else mean(values), places))
        table.append(line)
    return table


def compare_with_published(table, data_dir):
    """The same table, built the other way. See the note at the top of the file."""
    path = Path(data_dir) / "results_table.csv"
    if not path.exists():
        return f"(no {path.name} beside it, so the two implementations were not compared)"
    with path.open(newline="", encoding="utf-8-sig") as fh:
        published = list(csv.reader(fh))
    if len(published) != len(table) or len(published[0]) != len(table[0]):
        return (f"! {path.name} has {len(published)}×{len(published[0])} cells and this table has "
                f"{len(table)}×{len(table[0])} — they describe different selections or different columns")
    header = table[0]
    diffs = []
    for r, (mine, theirs) in enumerate(zip(table[2:], published[2:]), start=2):
        for c, (a, b) in enumerate(zip(mine, theirs)):
            if str(a) != str(b):
                band = header[c] or header[c - 1]
                diffs.append(f"{mine[0]} · {band}: python {a!r} vs node {b!r}")
    if not diffs:
        return f"✓ every cell matches {path.name} — the Node and Python measures agree"
    shown = "; ".join(diffs[:6])
    return (f"! {len(diffs)} cell(s) differ from {path.name}: {shown}"
            + (" …" if len(diffs) > 6 else ""))


def write_csv(path, table):
    with Path(path).open("w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(table)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=os.environ.get("PAGEGUIDE_DATA", str(script_dir() / "data")))
    ap.add_argument("--out", default=os.environ.get("PAGEGUIDE_OUT", str(script_dir() / "figures")))
    ap.add_argument("--all-tasks", action="store_true",
                    help="ignore selection.json and count every task in the master")
    # Accepted and ignored, so `make_all.py --format png` can hand it the same flags as every other
    # script: a multi-page table is a PDF or it is only its first page.
    ap.add_argument("--format", default="pdf", choices=["pdf", "png", "svg"])
    args = ap.parse_args()

    master_path, master = load_master(args.data)

    # ── Part 1 ──────────────────────────────────────────────────────────────────────────────
    if args.all_tasks:
        kept = [r for r in master if r.get("facet")]
        note = "--all-tasks: every task in the master, selection.json ignored"
    else:
        selection_path, selection = load_selection(args.data)
        kept, wanted = subset_rows(master, selection)
        counts = ", ".join(f"{label} {len(ids)}" for label, ids in wanted.items())
        note = f"{selection_path.name} ({counts} tasks)"
    subset_path = Path(args.data) / "rows_subset.csv"
    with Path(master_path).open(newline="", encoding="utf-8-sig") as fh:
        fieldnames = csv.DictReader(fh).fieldnames
    with subset_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(kept)

    print(f"— part 1: {len(kept)} of {len(master)} master rows kept by {note}")
    print(f"  {check_against_export(kept, master)}")
    print(f"✓ {subset_path}")

    # ── Part 2 ──────────────────────────────────────────────────────────────────────────────
    table = build_table(kept)
    table_path = Path(args.data) / "results_table_subset.csv"
    write_csv(table_path, table)
    print(f"— part 2: {len(table) - 2} category rows × {len(table[0])} columns from the subset")
    if not args.all_tasks:
        print(f"  {compare_with_published(table, args.data)}")
    print(f"✓ {table_path}")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / "results_table_subset.pdf"
    render_table_pdf(table_path, table[0], table[1], table[2:], pdf_path)
    print(f"✓ {pdf_path}")


if __name__ == "__main__":
    main()
