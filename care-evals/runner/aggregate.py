"""care-evals aggregation — turn per-task grading.json files into a benchmark + ladder scorecard.

Adapted from skill-creator's aggregate_benchmark.py idea (mean +/- stddev, stdlib only), extended
with the ladder view the plan calls for: pass-rate + $ per skill per model-id, so a cheaper rung
that holds up is visible. Every row carries model-id + date because deltas are only valid within a
single model-id (free-tier churn invalidates cross-model comparison).
"""

from __future__ import annotations

import glob
import json
import os
import statistics
from collections import defaultdict


def _load_gradings(results_dir: str) -> list[dict]:
    out = []
    for path in sorted(glob.glob(os.path.join(results_dir, "*.grading.json"))):
        with open(path, encoding="utf-8") as fh:
            out.append(json.load(fh))
    return out


def _fmt_pct(x: float) -> str:
    return f"{100 * x:.0f}%"


def _mean_std(values: list[float]) -> tuple[float, float]:
    if not values:
        return 0.0, 0.0
    if len(values) == 1:
        return values[0], 0.0
    return statistics.mean(values), statistics.pstdev(values)


def build_benchmark(gradings: list[dict], run_date: str) -> str:
    by_skill: dict[str, list[dict]] = defaultdict(list)
    for g in gradings:
        by_skill[g["skill"]].append(g)

    lines = [f"# care-evals benchmark — {run_date}", ""]
    total_pass = sum(1 for g in gradings if g["passed"])
    lines.append(f"**Overall: {total_pass}/{len(gradings)} tasks passed.**")
    lines.append("")
    lines.append("| skill | tasks | pass | mean score | stddev | model(s) | adapter |")
    lines.append("|---|---|---|---|---|---|---|")
    for skill, gs in sorted(by_skill.items()):
        scores = [g["score"] for g in gs]
        mean, std = _mean_std(scores)
        passed = sum(1 for g in gs if g["passed"])
        models = ", ".join(sorted({g["model_used"] for g in gs}))
        adapters = ", ".join(sorted({g["adapter"] for g in gs}))
        lines.append(
            f"| {skill} | {len(gs)} | {passed}/{len(gs)} | {mean:.2f} | {std:.2f} | {models} | {adapters} |"
        )
    lines += ["", "## Per-task", "", "| task | skill | model | pass | score | detail |", "|---|---|---|---|---|---|"]
    for g in gradings:
        d = g.get("detail", {})
        # Key the summary on the grading's OUTCOME shape, not the skill name: recall/clean-style
        # skills (care-review AND care-ux-review) set detail.outcome to "findings"/"clean", while
        # verdict-enum skills (test-grade/triager/ci-fix) set detail.accuracy. Branching on skill
        # name silently mis-rendered care-ux-review as "acc None · block None" (its detail has neither
        # accuracy nor block) even though it is graded identically to care-review.
        outcome = d.get("outcome")
        if outcome == "findings":
            summary = f"recall {d.get('recall')} · fp {len(d.get('false_positives', []))}"
        elif outcome == "clean":
            summary = f"clean_signal {d.get('clean_signal_present')} · fp {len(d.get('false_positives', []))}"
        else:
            summary = f"acc {d.get('accuracy')} · block {d.get('block_detected')}=={d.get('block_expected')}"
        lines.append(
            f"| {g['task']} | {g['skill']} | {g['model_used']} | "
            f"{'PASS' if g['passed'] else 'FAIL'} | {g['score']:.2f} | {summary} |"
        )
    lines.append("")
    return "\n".join(lines)


def build_ladder(gradings: list[dict], run_date: str) -> str:
    """Per skill x model-id: pass-rate + mean score + $ — the cost-optimization scorecard.
    Compare within a model-id + date only (rows are annotated accordingly)."""
    cell: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for g in gradings:
        cell[(g["skill"], g["model_used"])].append(g)

    lines = [
        f"# care-evals ladder scorecard — {run_date}",
        "",
        "> Compare deltas **within a single model-id + date only**. A model swap (free-tier churn)",
        "> invalidates prior deltas — re-run the suite on the new model before trusting a comparison.",
        "",
        "| skill | model-id | date | tasks | pass-rate | mean score | est $ |",
        "|---|---|---|---|---|---|---|",
    ]
    for (skill, model), gs in sorted(cell.items()):
        passed = sum(1 for g in gs if g["passed"])
        mean, _ = _mean_std([g["score"] for g in gs])
        cost = sum(float(g.get("cost_usd", 0.0)) for g in gs)
        lines.append(
            f"| {skill} | {model} | {run_date} | {len(gs)} | "
            f"{passed}/{len(gs)} ({_fmt_pct(passed / len(gs))}) | {mean:.2f} | ${cost:.4f} |"
        )
    lines += [
        "",
        "**Reading it:** the cheapest model whose pass-rate holds at 100% for a skill is the model",
        "that skill earns (human-gated). Where a cheaper rung drops recall or precision, harden the",
        "SKILL.md prompt for model-robustness and re-run before moving the pin.",
        "",
    ]
    return "\n".join(lines)


def aggregate(results_dir: str, run_date: str | None = None) -> tuple[str, str]:
    run_date = run_date or os.path.basename(results_dir.rstrip("/")).split("-run")[0]
    gradings = _load_gradings(results_dir)
    bench = build_benchmark(gradings, run_date)
    ladder = build_ladder(gradings, run_date)
    with open(os.path.join(results_dir, "benchmark.md"), "w", encoding="utf-8") as fh:
        fh.write(bench)
    with open(os.path.join(results_dir, "ladder.md"), "w", encoding="utf-8") as fh:
        fh.write(ladder)
    return bench, ladder


def _main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Aggregate care-evals grading.json into benchmark + ladder.")
    ap.add_argument("results_dir", help="results/<date>-<run>/ containing *.grading.json")
    ap.add_argument("--date", help="override the run date label")
    args = ap.parse_args(argv)
    bench, _ = aggregate(args.results_dir, args.date)
    print(bench)
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv[1:]))
