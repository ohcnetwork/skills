"""Regression tests for grader.py verdict parsing — stdlib only, run with `python3 test_grader.py`.

Guards the column-aware test-grade parser (fixed 2026-07-20): the verdict is the cell immediately
after the id cell, and verdict words in a later note/finding column must NOT be read as the verdict.
This bug recurred once (deflated real Sonnet tg-01 0.75→0.5), so it earns a test."""

from __future__ import annotations

from grader import TRIAGE_VERDICTS, parse_verdict_table

_failures: list[str] = []


def check(label: str, got, want) -> None:
    if got != want:
        _failures.append(f"{label}\n    got : {got}\n    want: {want}")


# 1) The real failure mode: verdict column says Weak, a later Finding column echoes "wrong".
sonnet = """
| AC# | Verdict | Criticality | Finding |
| AC1 | Weak | Critical | happy-path only; thin but faithful |
| AC2 | Weak | Critical | substring match is not precise enough to fail on a wrong value |
| AC3 | **Wrong** | Critical | asserts the discount is applied — contradicts the criterion |
| AC4 | Missing | Secondary | no spec covers the zero-discount state |
"""
check(
    "column-aware ignores verdict word in note column (bolded verdict too)",
    parse_verdict_table(sonnet, ["AC1", "AC2", "AC3", "AC4"], by_column=True),
    {"AC1": "Weak", "AC2": "Weak", "AC3": "Wrong", "AC4": "Missing"},
)

# 2) The OLD default (rightmost) still misreads AC2 — proves the two modes differ and the bug was real.
check(
    "rightmost default still mis-scores AC2 (documents the old bug)",
    parse_verdict_table(sonnet, ["AC2"]),
    {"AC2": "Wrong"},
)

# 3) Rows written without leading/trailing pipes, notes mentioning other ACs/verdict words.
alt = """AC1 | Covered | the real value, not a Wrong stand-in
AC2 | Missing | unlike AC1 which was Covered"""
check(
    "no-edge-pipe rows + cross-references",
    parse_verdict_table(alt, ["AC1", "AC2"], by_column=True),
    {"AC1": "Covered", "AC2": "Missing"},
)

# 4) Triage leftmost mode is unaffected (verdict is the first column after the id).
triage = """
| # | verdict | rationale |
| F1 | address | real defect; decline would lose it |
| F2 | decline | out of scope |
"""
check(
    "triage leftmost still reads the verdict column",
    parse_verdict_table(triage, ["F1", "F2"], verdicts=TRIAGE_VERDICTS, leftmost=True),
    {"F1": "address", "F2": "decline"},
)

if _failures:
    print(f"FAIL ({len(_failures)}):")
    for f in _failures:
        print("  -", f)
    raise SystemExit(1)
print("ok — grader verdict-parsing regression tests passed")
