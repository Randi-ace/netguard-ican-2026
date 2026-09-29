#!/usr/bin/env python3
"""Evaluate the first-stage text rule engine on a frozen dataset split."""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hash_utils import sha256_canonical_utf8_text


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATASET_PATH = PROJECT_ROOT / "tests" / "samples" / "ai-text-dataset.csv"
RESULTS_DIR = PROJECT_ROOT / "tests" / "ai" / "results"
RULE_ENGINE = "backend.services.ai_service.AIService.analyze_text"
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
CATEGORIES = (
    "normal",
    "phishing",
    "scam",
    "gambling",
    "adult",
    "malicious",
)
RULE_LEVEL_TO_LABEL = {
    "safe": "not_risk",
    "low": "risk",
    "medium": "risk",
    "high": "risk",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate the first-stage Rule Engine on one dataset split."
    )
    parser.add_argument(
        "--split",
        choices=("val", "test"),
        default="val",
        help="dataset split to evaluate; defaults to val",
    )
    parser.add_argument(
        "--allow-test",
        action="store_true",
        help="explicitly unlock the frozen final test split",
    )
    args = parser.parse_args()
    if args.split == "test" and not args.allow_test:
        parser.error(
            "Final test is frozen. Use --allow-test only during the formal "
            "evaluation stage."
        )
    return args


def configure_output_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")


def load_rule_engine():
    try:
        from backend.services.ai_service import ai_service
    except ImportError as exc:
        raise RuntimeError(
            "Unable to import backend.services.ai_service from the project root"
        ) from exc
    return ai_service.analyze_text


def load_split(path: Path, split: str) -> list[dict[str, str]]:
    if not path.is_file():
        raise RuntimeError(f"Dataset not found: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = [
            {key: (value or "").strip() for key, value in row.items()}
            for row in reader
            if (row.get("split") or "").strip() == split
        ]

    if not rows:
        raise RuntimeError(f"Dataset split {split!r} is empty")
    return rows


def current_git_commit() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def safe_divide(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 0.0


def validate_rule_result(result: Any, sample_id: str) -> tuple[str, float, str]:
    if not isinstance(result, dict):
        raise RuntimeError(f"Rule Engine returned non-object for {sample_id}")

    level = result.get("risk")
    if level not in RULE_LEVEL_TO_LABEL:
        raise RuntimeError(
            f"Rule Engine returned invalid risk level for {sample_id}: {level!r}"
        )

    score = result.get("score")
    if not isinstance(score, (int, float)) or isinstance(score, bool):
        raise RuntimeError(
            f"Rule Engine returned invalid score for {sample_id}: {score!r}"
        )
    score = float(score)
    if not 0.0 <= score <= 1.0:
        raise RuntimeError(
            f"Rule Engine returned out-of-range score for {sample_id}: {score}"
        )

    reason = result.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise RuntimeError(
            f"Rule Engine returned invalid reason for {sample_id}: {reason!r}"
        )
    return level, score, reason.strip()


def error_record(
    row: dict[str, str],
    predicted_label: str,
    rule_level: str,
    rule_score: float,
    rule_reason: str,
) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "text": row["text"],
        "true_label": row["label"],
        "predicted_label": predicted_label,
        "rule_level": rule_level,
        "rule_score": rule_score,
        "rule_reason": rule_reason,
        "category": row["category"],
        "group_id": row["group_id"],
        "note": row["note"],
    }


def evaluate(rows: list[dict[str, str]], analyze_text) -> dict[str, Any]:
    tn = fp = fn = tp = 0
    false_positives: list[dict[str, Any]] = []
    false_negatives: list[dict[str, Any]] = []
    category_breakdown = {
        category: {"sample_count": 0, "correct": 0, "incorrect": 0}
        for category in CATEGORIES
    }

    for row in rows:
        sample_id = row["id"]
        true_label = row["label"]
        if true_label not in {"risk", "not_risk"}:
            raise RuntimeError(
                f"Dataset contains invalid label for {sample_id}: {true_label!r}"
            )
        category = row["category"]
        if category not in category_breakdown:
            raise RuntimeError(
                f"Dataset contains invalid category for {sample_id}: {category!r}"
            )

        rule_result = analyze_text(row["text"])
        rule_level, rule_score, rule_reason = validate_rule_result(
            rule_result, sample_id
        )
        predicted_label = RULE_LEVEL_TO_LABEL[rule_level]
        is_correct = predicted_label == true_label

        category_stats = category_breakdown[category]
        category_stats["sample_count"] += 1
        category_stats["correct" if is_correct else "incorrect"] += 1

        if true_label == "not_risk" and predicted_label == "not_risk":
            tn += 1
        elif true_label == "not_risk" and predicted_label == "risk":
            fp += 1
            false_positives.append(
                error_record(
                    row,
                    predicted_label,
                    rule_level,
                    rule_score,
                    rule_reason,
                )
            )
        elif true_label == "risk" and predicted_label == "not_risk":
            fn += 1
            false_negatives.append(
                error_record(
                    row,
                    predicted_label,
                    rule_level,
                    rule_score,
                    rule_reason,
                )
            )
        else:
            tp += 1

    sample_count = len(rows)
    accuracy = safe_divide(tp + tn, sample_count)
    precision = safe_divide(tp, tp + fp)
    recall = safe_divide(tp, tp + fn)
    f1 = safe_divide(2 * precision * recall, precision + recall)

    return {
        "sample_count": sample_count,
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "confusion_matrix": [[tn, fp], [fn, tp]],
        "tn": tn,
        "fp": fp,
        "fn": fn,
        "tp": tp,
        "positive_support": tp + fn,
        "negative_support": tn + fp,
        "category_breakdown": category_breakdown,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
    }


def build_result(split: str, evaluation: dict[str, Any]) -> dict[str, Any]:
    return {
        "evaluation_name": "first-stage-rule-baseline-validation",
        "evaluation_version": "rule-baseline-v1",
        "evaluated_at": datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        ),
        "git_commit": current_git_commit(),
        "dataset_path": "tests/samples/ai-text-dataset.csv",
        "dataset_sha256": sha256_canonical_utf8_text(DATASET_PATH),
        "dataset_split": split,
        "sample_count": evaluation["sample_count"],
        "positive_class": "risk",
        "rule_engine": RULE_ENGINE,
        "rule_input": "text",
        "prediction_mapping": dict(RULE_LEVEL_TO_LABEL),
        "accuracy": evaluation["accuracy"],
        "precision": evaluation["precision"],
        "recall": evaluation["recall"],
        "f1": evaluation["f1"],
        "confusion_matrix": evaluation["confusion_matrix"],
        "tn": evaluation["tn"],
        "fp": evaluation["fp"],
        "fn": evaluation["fn"],
        "tp": evaluation["tp"],
        "positive_support": evaluation["positive_support"],
        "negative_support": evaluation["negative_support"],
        "category_breakdown": evaluation["category_breakdown"],
        "false_positives": evaluation["false_positives"],
        "false_negatives": evaluation["false_negatives"],
    }


def print_error_samples(label: str, samples: list[dict[str, Any]]) -> None:
    print(f"{label}: {len(samples)}")
    for sample in samples:
        print(
            f"  {sample['id']} | {sample['category']} | "
            f"{sample['true_label']} -> {sample['predicted_label']} | "
            f"{sample['rule_level']} {sample['rule_score']:.2f} | "
            f"{sample['rule_reason']}"
        )


def print_result(result: dict[str, Any], output_path: Path) -> None:
    print(f"Evaluation split: {result['dataset_split']}")
    print(f"Sample count: {result['sample_count']}")
    print(f"Accuracy: {result['accuracy']:.6f}")
    print(f"Precision: {result['precision']:.6f}")
    print(f"Recall: {result['recall']:.6f}")
    print(f"F1: {result['f1']:.6f}")
    print(f"TN={result['tn']} FP={result['fp']} FN={result['fn']} TP={result['tp']}")
    print(f"Confusion matrix: {result['confusion_matrix']}")
    print("Category breakdown:")
    for category in CATEGORIES:
        stats = result["category_breakdown"][category]
        print(
            f"  {category}: sample_count={stats['sample_count']} "
            f"correct={stats['correct']} incorrect={stats['incorrect']}"
        )
    print_error_samples("False Positives", result["false_positives"])
    print_error_samples("False Negatives", result["false_negatives"])
    print(f"Dataset SHA-256: {result['dataset_sha256']}")
    print(f"Result JSON: {output_path.relative_to(PROJECT_ROOT).as_posix()}")


def main() -> int:
    configure_output_encoding()
    args = parse_args()
    rows = load_split(DATASET_PATH, args.split)
    analyze_text = load_rule_engine()
    evaluation = evaluate(rows, analyze_text)
    result = build_result(args.split, evaluation)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = RESULTS_DIR / f"rule-baseline-{args.split}.json"
    output_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print_result(result, output_path)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
