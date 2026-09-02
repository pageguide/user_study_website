"""Reading the post-study Google Forms export, exactly as the dashboard reads it.

A column is a question when every non-empty cell in it is an integer 1-7 — the same rule
`postStudyLikertFromCsv` in app/welcome.js uses, so the two never disagree about which columns
are questions. Codes (F1, G2, …) come from the wording, in column order.
"""

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List


@dataclass
class Question:
    question: str
    group: str
    code: str
    values: List[int]
    counts: Dict[int, int] = field(default_factory=dict)


@dataclass
class Likert:
    source: str
    rows: int
    columns: List[Question]


def _code_for(question, index_by_group):
    upper = question.upper()
    group = "OTHER"
    if "FIND" in upper:
        group = "FIND"
    elif "GUIDE" in upper:
        group = "GUIDE"
    elif "HIDE" in upper:
        group = "HIDE"
    prefix = {"FIND": "F", "GUIDE": "G", "HIDE": "H", "OTHER": "Q"}[group]
    index_by_group[group] = index_by_group.get(group, 0) + 1
    return group, f"{prefix}{index_by_group[group]}"


def load_likert(data_dir, name="post_study.csv"):
    path = Path(data_dir) / name
    if not path.exists():
        raise SystemExit(f"Missing {path}. Copy post_study/post_study.csv into the data folder.")
    with path.open(newline="", encoding="utf-8-sig") as fh:
        table = list(csv.reader(fh))
    if len(table) < 2:
        raise SystemExit("The CSV needs a header row and at least one response row.")

    headers = [h.strip() for h in table[0]]
    body = [row for row in table[1:] if any(str(c).strip() for c in row)]
    columns, index_by_group = [], {}

    for i, header in enumerate(headers):
        cells = [str(row[i]).strip() if i < len(row) else "" for row in body]
        non_empty = [c for c in cells if c]
        values = [int(c) for c in non_empty if re.fullmatch(r"[1-7]", c)]
        if not values or len(values) < len(non_empty):
            continue
        counts = {v: values.count(v) for v in range(1, 8)}
        group, code = _code_for(header, index_by_group)
        columns.append(Question(question=header, group=group, code=code, values=values, counts=counts))

    if not columns:
        raise SystemExit("No 1-7 Likert question columns were found.")
    return Likert(source=str(path), rows=len(body), columns=columns)


def short_labels(columns):
    """Drop the wording every question repeats, so the y axis shows what differs.

    Compared on letters and digits only, so "PageGuide" and "Page Guide" share a prefix.
    """
    texts = [c.question.strip() for c in columns]
    norms = []
    for text in texts:
        key, index_map = [], []
        for i, ch in enumerate(text):
            if ch.isalnum():
                key.append(ch.lower())
                index_map.append(i)
        norms.append(("".join(key), index_map))

    shared = 0
    while all(shared < len(key) - 1 for key, _ in norms) and len({key[shared] for key, _ in norms}) == 1:
        shared += 1
    if not shared:
        return texts

    out = []
    for text, (_, index_map) in zip(texts, norms):
        rest = text[index_map[shared]:].lstrip(" ,;:.–-")
        out.append(rest[0].upper() + rest[1:] if rest else text)
    return out
