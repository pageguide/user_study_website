#!/usr/bin/env python3
"""Rebuild every figure in one go: `python make_all.py --format pdf`."""

import runpy
import sys
from pathlib import Path

SCRIPTS = [
    "accuracy.py",
    "localization_f1.py",
    "time_completion.py",
    "behavior_pooled.py",
    "behavior_by_facet.py",
    "post_study_likert.py",
    "post_study_stacked.py",
    # Last on purpose: it reads results_table.csv, which the dashboard's button fills from the
    # same rows the CSVs above came from, so the table lands beside figures about one selection.
    "results_table_pdf.py",
    # And then the same table again, rebuilt here from rows_master.csv + selection.json rather than
    # read out of a CSV somebody else filled. It prints whether the two agree cell for cell.
    "results_table_subset.py",
    # Not a figure but a table, and last for the same reason the two above are: it describes the
    # sample the figures were drawn from, so it belongs beside them rather than ahead of them.
    "breakdonw_participants.py",
]


def main():
    here = Path(__file__).resolve().parent
    passthrough = sys.argv[1:]
    failed = []
    for script in SCRIPTS:
        print(f"— {script}")
        sys.argv = [str(here / script), *passthrough]
        try:
            runpy.run_path(str(here / script), run_name="__main__")
        except SystemExit as e:
            if e.code:
                print(f"  ✗ {script}: {e}")
                failed.append(script)
    if failed:
        raise SystemExit(f"{len(failed)} figure(s) failed: {', '.join(failed)}")
    print("✓ all figures rebuilt")


if __name__ == "__main__":
    main()
