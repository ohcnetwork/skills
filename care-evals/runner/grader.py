"""care-evals grader — score a skill's output against a task's ground-truth manifest.

Layer 1 (deterministic, always runs, authoritative for v1):
  - care-review findings task : signal-based recall over must_flag + false-positive count.
  - care-review clean control  : clean-signal present + zero false positives.
  - care-test-grade            : per-criterion verdict enums parsed from the output table,
                                 compared exact-match to expected_verdicts.

Layer 2 (LLM judge, optional): grader-agent.md prompt scored by a strong, pinned model via an
adapter. Refines the coarse layer-1 recall for care-review prose. Deterministic layer stays
authoritative unless a judge adapter is supplied AND agrees.

Also hosts task loading (shared with run_eval). stdlib only.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field

VERDICTS = ["Covered", "Weak", "Missing", "Wrong"]
TRIAGE_VERDICTS = ["address", "decline", "defer"]
CIFIX_VERDICTS = ["test-stale", "code-wrong", "infra"]


# --------------------------------------------------------------------------- task loading
@dataclass
class Task:
    id: str
    dir: str
    skill: str
    kind: str
    tier: str
    args: str
    base_sha: str | None
    expected: dict


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Minimal `key: value` YAML frontmatter parser (no external deps)."""
    meta: dict = {}
    if not text.startswith("---"):
        return meta, text
    end = text.find("\n---", 3)
    if end == -1:
        return meta, text
    block = text[3:end].strip("\n")
    for line in block.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    body = text[end + 4 :].lstrip("\n")
    return meta, body


def load_task(task_dir: str) -> Task:
    with open(os.path.join(task_dir, "task.md"), encoding="utf-8") as fh:
        meta, _ = _parse_frontmatter(fh.read())
    base_sha = None
    base_path = os.path.join(task_dir, "base_sha")
    if os.path.isfile(base_path):
        with open(base_path, encoding="utf-8") as fh:
            base_sha = fh.read().strip()
    with open(os.path.join(task_dir, "expected.json"), encoding="utf-8") as fh:
        expected = json.load(fh)
    return Task(
        id=meta.get("id", os.path.basename(task_dir.rstrip("/"))),
        dir=task_dir,
        skill=meta.get("skill", expected.get("skill", "")),
        kind=meta.get("kind", ""),
        tier=meta.get("tier", ""),
        args=meta.get("args", ""),
        base_sha=base_sha,
        expected=expected,
    )


# --------------------------------------------------------------------------- grading result
@dataclass
class Grading:
    task: str
    skill: str
    model_used: str
    adapter: str
    passed: bool
    score: float
    layer: str = "deterministic"
    detail: dict = field(default_factory=dict)
    judge: dict | None = None


# --------------------------------------------------------------------------- helpers
def _hit(signals: list[str], haystack: str) -> bool:
    return any(sig.lower() in haystack for sig in signals)


def _extract_verdict_from_line(
    line: str, ac_re: re.Pattern, verdicts: list[str], leftmost: bool
) -> str | None:
    if not ac_re.search(line):
        return None
    pick_idx = -1 if not leftmost else 1 << 30
    found: str | None = None
    for v in verdicts:
        for m in re.finditer(rf"\b{v}\b", line, re.IGNORECASE):
            if (not leftmost and m.start() > pick_idx) or (leftmost and m.start() < pick_idx):
                pick_idx = m.start()
                found = v
    return found


def _row_cells(line: str) -> list[str]:
    """Split a markdown table row into its data cells, dropping the empty cells produced by the
    leading/trailing pipes. Rows written with or without edge pipes both normalize correctly."""
    if "|" not in line:
        return []
    cells = [c.strip() for c in line.split("|")]
    while cells and cells[0] == "":
        cells.pop(0)
    while cells and cells[-1] == "":
        cells.pop()
    return cells


def _is_table_id_cell(line: str, ac_re: re.Pattern) -> bool:
    """True if ac appears in the FIRST data cell of a markdown table row."""
    cells = _row_cells(line)
    return bool(cells and ac_re.search(cells[0]))


def _verdict_after_id_cell(line: str, ac_re: re.Pattern, verdicts: list[str]) -> str | None:
    """Column-aware read: in a markdown table row whose FIRST data cell is the id, return the verdict
    token from the cell immediately after it (the verdict column). Returns None for non-table lines,
    rows where the id isn't the first cell, or a verdict cell holding no enum token. This ignores any
    verdict words that appear in a later NOTE column — the bug the whole-row scan is prone to."""
    cells = _row_cells(line)
    if len(cells) < 2 or not ac_re.search(cells[0]):
        return None
    verdict_cell = cells[1]
    for v in verdicts:
        if re.search(rf"\b{v}\b", verdict_cell, re.IGNORECASE):
            return v
    return None


def parse_verdict_table(
    text: str,
    ac_ids: list[str],
    verdicts: list[str] | None = None,
    leftmost: bool = False,
    by_column: bool = False,
) -> dict[str, str | None]:
    """For each id, find its row and read the verdict token in it. `verdicts` is the enum to look for
    (defaults to the test-grade VERDICTS).

    Precedence of read strategies:
    - `by_column=True` (preferred, column-aware): the verdict is the cell immediately after the id
      cell in a markdown table row (`| AC# | verdict | note |`). A verdict cell match wins outright;
      only when NO such table row exists do we fall back to a prose scan. This is immune to verdict
      words echoed in the note column — the failure mode that mis-scored real model outputs.
    - `leftmost=True`: the verdict is an EARLY column and later columns/notes may echo verdict words
      (triage: "address"/"decline" are common in prose), so take the FIRST token after the id, with
      table-id-cell rows preferred over prose.
    - default (both False): the RIGHTMOST token in the row wins.
    """
    verdicts = verdicts or VERDICTS
    out: dict[str, str | None] = {}
    lines = text.splitlines()
    for ac in ac_ids:
        ac_re = re.compile(rf"(?<![A-Za-z0-9]){re.escape(ac)}(?![0-9])", re.IGNORECASE)
        if by_column:
            col_found: str | None = None
            prose_found: str | None = None
            for line in lines:
                col = _verdict_after_id_cell(line, ac_re, verdicts)
                if col is not None:
                    col_found = col
                    break
                if prose_found is None:
                    # rightmost token on any other line mentioning the id, as a last resort
                    prose_found = _extract_verdict_from_line(line, ac_re, verdicts, leftmost=False)
            out[ac] = col_found if col_found is not None else prose_found
        elif leftmost:
            table_found: str | None = None
            prose_found: str | None = None
            for line in lines:
                v = _extract_verdict_from_line(line, ac_re, verdicts, leftmost)
                if v is None:
                    continue
                if "|" in line and _is_table_id_cell(line, ac_re):
                    table_found = v
                    break
                if prose_found is None:
                    prose_found = v
            out[ac] = table_found if table_found is not None else prose_found
        else:
            found: str | None = None
            for line in lines:
                v = _extract_verdict_from_line(line, ac_re, verdicts, leftmost)
                if v is not None:
                    found = v
                    break
            out[ac] = found
    return out


# --------------------------------------------------------------------------- care-review
def _grade_care_review(task: Task, text: str) -> tuple[bool, float, dict]:
    low = text.lower()
    exp = task.expected
    outcome = exp.get("expected_outcome", "findings")
    pass_cfg = exp.get("pass", {})

    must_not = exp.get("must_not_flag", [])
    false_positives = [m["id"] for m in must_not if _hit([s.lower() for s in m.get("signals", [])], low)]

    if outcome == "clean":
        clean_signals = [s.lower() for s in exp.get("clean_signals", [])]
        clean_present = _hit(clean_signals, low)
        max_fp = pass_cfg.get("max_false_positives", 0)
        require_clean = pass_cfg.get("require_clean_signal", True)
        passed = (clean_present or not require_clean) and len(false_positives) <= max_fp
        score = (1.0 if clean_present else 0.0) - 0.5 * len(false_positives)
        score = max(0.0, min(1.0, score))
        return passed, score, {
            "outcome": "clean",
            "clean_signal_present": clean_present,
            "false_positives": false_positives,
        }

    must_flag = exp.get("must_flag", [])
    hits, misses = [], []
    for item in must_flag:
        if _hit([s.lower() for s in item.get("signals", [])], low):
            hits.append(item["id"])
        else:
            misses.append(item["id"])
    recall = len(hits) / len(must_flag) if must_flag else 1.0
    min_recall = pass_cfg.get("min_recall", 1.0)
    max_fp = pass_cfg.get("max_false_positives", 0)
    critical = pass_cfg.get("critical_must_flag", [])
    critical_met = all(cid in hits for cid in critical)
    passed = recall >= min_recall and len(false_positives) <= max_fp and critical_met
    score = max(0.0, recall - 0.34 * len(false_positives))
    return passed, min(1.0, score), {
        "outcome": "findings",
        "recall": round(recall, 3),
        "hits": hits,
        "misses": misses,
        "false_positives": false_positives,
        "critical_met": critical_met,
    }


# --------------------------------------------------------------------------- care-test-grade
def _grade_test_grade(task: Task, text: str) -> tuple[bool, float, dict]:
    exp = task.expected
    expected_verdicts: dict[str, str] = exp.get("expected_verdicts", {})
    ac_ids = list(expected_verdicts.keys())
    parsed = parse_verdict_table(text, ac_ids, by_column=True)

    matches = {ac: (parsed.get(ac) or "").lower() == expected_verdicts[ac].lower() for ac in ac_ids}
    accuracy = sum(matches.values()) / len(ac_ids) if ac_ids else 1.0

    pass_cfg = exp.get("pass", {})
    min_acc = pass_cfg.get("min_verdict_accuracy", 1.0)
    require_block = pass_cfg.get("require_block", False)
    critical = pass_cfg.get("critical_verdicts", [])

    # care-test-grade's contract is "only Wrong blocks", so block is derived strictly from a
    # parsed Wrong verdict — not from prose (which says "nothing blocks" on clean specs).
    block_detected = any((parsed.get(ac) or "").lower() == "wrong" for ac in ac_ids)
    block_ok = block_detected == require_block
    critical_met = all(matches.get(cid, False) for cid in critical)

    passed = accuracy >= min_acc and block_ok and critical_met
    return passed, accuracy, {
        "expected_verdicts": expected_verdicts,
        "parsed_verdicts": parsed,
        "matches": matches,
        "accuracy": round(accuracy, 3),
        "block_expected": require_block,
        "block_detected": block_detected,
        "critical_met": critical_met,
    }


# --------------------------------------------------------------------------- care-triager
def _grade_triage(task: Task, text: str) -> tuple[bool, float, dict]:
    """Per-item triage verdict accuracy: parse the F# → {address|decline|defer} table and exact-match
    it to expected_verdicts. Mirrors care-test-grade, but the enum is the triage verdict and the
    parser takes the LEFTMOST verdict token (verdict is an early column; prose notes echo verdict
    words). missed_by is reported for information but NOT gated in v1 — the FSM branches on verdicts,
    and verdict accuracy is the provable signal; missed_by attribution is noisier and comes later."""
    exp = task.expected
    expected_verdicts: dict[str, str] = exp.get("expected_verdicts", {})
    ids = list(expected_verdicts.keys())
    parsed = parse_verdict_table(text, ids, verdicts=TRIAGE_VERDICTS, leftmost=True)

    matches = {i: (parsed.get(i) or "").lower() == expected_verdicts[i].lower() for i in ids}
    accuracy = sum(matches.values()) / len(ids) if ids else 1.0

    pass_cfg = exp.get("pass", {})
    min_acc = pass_cfg.get("min_verdict_accuracy", 1.0)
    critical = pass_cfg.get("critical_verdicts", [])
    critical_met = all(matches.get(cid, False) for cid in critical)

    passed = accuracy >= min_acc and critical_met
    return passed, accuracy, {
        "expected_verdicts": expected_verdicts,
        "parsed_verdicts": parsed,
        "matches": matches,
        "accuracy": round(accuracy, 3),
        "critical_verdicts": critical,
        "critical_met": critical_met,
    }


# --------------------------------------------------------------------------- care-ci-fix
def _grade_cifix(task: Task, text: str) -> tuple[bool, float, dict]:
    """Per-failure CLASSIFICATION accuracy: parse the F# → {test-stale|code-wrong|infra} table and
    exact-match to expected_verdicts. Mirrors care-triager (leftmost token; prose echoes the words).
    This grades the ci-fixer's classification judgment — the offline-gradeable core that drives
    update-spec / fix-source / no-edit. Applying the edit + re-running the check is a v1.5 concern;
    a wrong classification is the failure mode that ships a regression (fix the test when the code is
    broken) or edits over a flake, so it's the signal worth gating on."""
    exp = task.expected
    expected_verdicts: dict[str, str] = exp.get("expected_verdicts", {})
    ids = list(expected_verdicts.keys())
    parsed = parse_verdict_table(text, ids, verdicts=CIFIX_VERDICTS, leftmost=True)

    matches = {i: (parsed.get(i) or "").lower() == expected_verdicts[i].lower() for i in ids}
    accuracy = sum(matches.values()) / len(ids) if ids else 1.0

    pass_cfg = exp.get("pass", {})
    min_acc = pass_cfg.get("min_verdict_accuracy", 1.0)
    critical = pass_cfg.get("critical_verdicts", [])
    critical_met = all(matches.get(cid, False) for cid in critical)

    passed = accuracy >= min_acc and critical_met
    return passed, accuracy, {
        "expected_verdicts": expected_verdicts,
        "parsed_verdicts": parsed,
        "matches": matches,
        "accuracy": round(accuracy, 3),
        "critical_verdicts": critical,
        "critical_met": critical_met,
    }


# --------------------------------------------------------------------------- public API
def grade(task: Task, output_text: str, *, model_used: str = "?", adapter: str = "?",
          judge_adapter=None, judge_model: str | None = None) -> Grading:
    if task.skill in ("care-review", "care-ux-review"):
        # care-ux-review output is prose findings too — signal-based recall over must_flag +
        # false-positive count + clean-control handling, same as care-review.
        passed, score, detail = _grade_care_review(task, output_text)
    elif task.skill == "care-test-grade":
        passed, score, detail = _grade_test_grade(task, output_text)
    elif task.skill == "care-triager":
        passed, score, detail = _grade_triage(task, output_text)
    elif task.skill == "care-ci-fix":
        passed, score, detail = _grade_cifix(task, output_text)
    else:
        raise ValueError(f"no grader for skill {task.skill!r}")

    g = Grading(task=task.id, skill=task.skill, model_used=model_used, adapter=adapter,
                passed=passed, score=round(score, 3), detail=detail)

    if judge_adapter is not None:
        g.judge = _llm_judge(task, output_text, judge_adapter, judge_model)
        g.layer = "deterministic+judge"
    return g


def _llm_judge(task: Task, output_text: str, judge_adapter, judge_model: str | None) -> dict:
    """Layer 2: score the output with grader-agent.md on a strong pinned model. Best-effort;
    a judge failure never crashes the run (deterministic layer already decided pass/fail)."""
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "grader-agent.md"), encoding="utf-8") as fh:
        rubric = fh.read()
    prompt = (
        f"{rubric}\n\n---\n## Ground truth (expected.json)\n```json\n"
        f"{json.dumps(task.expected, indent=2)}\n```\n\n"
        f"## Skill output under grade\n```\n{output_text}\n```\n\n"
        "Return ONLY the JSON object described above."
    )
    try:
        res = judge_adapter.invoke(prompt=prompt, cwd=os.getcwd(), model=judge_model)
        m = re.search(r"\{.*\}", res.text, re.DOTALL)
        parsed = json.loads(m.group(0)) if m else {"error": "no json in judge output"}
        parsed["judge_model"] = res.model_used
        return parsed
    except Exception as exc:  # judge is advisory; never fatal
        return {"error": str(exc)}


def write_grading(grading: Grading, path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(asdict(grading), fh, indent=2)
        fh.write("\n")


# --------------------------------------------------------------------------- CLI
def _main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Grade a saved skill output against a task manifest.")
    ap.add_argument("task_dir", help="path to tasks/<id>/")
    ap.add_argument("output_file", help="path to the saved skill output (.md/.txt)")
    ap.add_argument("--out", help="write grading.json here")
    ap.add_argument("--model", default="?")
    ap.add_argument("--adapter", default="?")
    args = ap.parse_args(argv)

    task = load_task(args.task_dir)
    with open(args.output_file, encoding="utf-8") as fh:
        text = fh.read()
    g = grade(task, text, model_used=args.model, adapter=args.adapter)
    out = json.dumps(asdict(g), indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out + "\n")
    print(out)
    return 0 if g.passed else 1


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv[1:]))
