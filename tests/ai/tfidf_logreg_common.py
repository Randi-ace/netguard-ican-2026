#!/usr/bin/env python3
"""Shared data loading and evaluation helpers for TF-IDF model v1."""

from __future__ import annotations

import csv
import subprocess
from pathlib import Path
from typing import Any

from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    precision_recall_fscore_support,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATASET_PATH = PROJECT_ROOT / "tests" / "samples" / "ai-text-dataset.csv"
ARTIFACT_PATH = PROJECT_ROOT / "models" / "ai" / "tfidf-logreg-v1.joblib"
MANIFEST_PATH = (
    PROJECT_ROOT / "models" / "ai" / "tfidf-logreg-v1.manifest.json"
)
RESULT_PATH = (
    PROJECT_ROOT / "tests" / "ai" / "results" / "tfidf-logreg-v1-val.json"
)
MODEL_VERSION = "tfidf-logreg-v1"
CATEGORIES = ("normal", "phishing", "scam", "gambling", "adult", "malicious")
ALLOWED_SPLITS = ("train", "val")


def load_split(split: str) -> list[dict[str, str]]:
    """Load an explicitly permitted split without ever exposing final test data."""
    if split not in ALLOWED_SPLITS:
        raise ValueError(
            f"Split {split!r} is not available to model v1; use only {ALLOWED_SPLITS}"
        )
    if not DATASET_PATH.is_file():
        raise RuntimeError(f"Dataset not found: {DATASET_PATH}")

    with DATASET_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = [
            {key: (value or "").strip() for key, value in row.items()}
            for row in csv.DictReader(handle)
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


def prediction_contract() -> dict[str, str]:
    return {
        "ai_score": "1 - P(normal)",
        "ai_category": "argmax(probability)",
        "ai_confidence": "max(probability)",
        "binary_label": "not_risk when ai_category == normal, otherwise risk",
    }


def evaluate_pipeline(pipeline: Any, rows: list[dict[str, str]]) -> dict[str, Any]:
    texts = [row["text"] for row in rows]
    probabilities = pipeline.predict_proba(texts)
    classes = [str(value) for value in pipeline.classes_]

    if "normal" not in classes:
        raise RuntimeError("Fitted model classes_ does not contain 'normal'")
    if set(classes) != set(CATEGORIES):
        raise RuntimeError(
            f"Fitted model classes_ mismatch: expected {sorted(CATEGORIES)}, got {classes}"
        )

    normal_index = classes.index("normal")
    predictions: list[dict[str, Any]] = []
    true_binary: list[str] = []
    predicted_binary: list[str] = []
    true_categories: list[str] = []
    predicted_categories: list[str] = []

    for row, row_probabilities in zip(rows, probabilities, strict=True):
        probability_values = [float(value) for value in row_probabilities]
        best_index = max(range(len(classes)), key=probability_values.__getitem__)
        ai_category = classes[best_index]
        ai_confidence = probability_values[best_index]
        ai_score = 1.0 - probability_values[normal_index]
        binary_label = "not_risk" if ai_category == "normal" else "risk"

        true_binary.append(row["label"])
        predicted_binary.append(binary_label)
        true_categories.append(row["category"])
        predicted_categories.append(ai_category)
        predictions.append(
            {
                "id": row["id"],
                "true_label": row["label"],
                "predicted_label": binary_label,
                "true_category": row["category"],
                "ai_category": ai_category,
                "ai_score": ai_score,
                "ai_confidence": ai_confidence,
            }
        )

    binary_precision, binary_recall, binary_f1, _ = precision_recall_fscore_support(
        true_binary,
        predicted_binary,
        labels=["risk"],
        average=None,
        zero_division=0,
    )
    category_precision, category_recall, category_f1, category_support = (
        precision_recall_fscore_support(
            true_categories,
            predicted_categories,
            labels=classes,
            average=None,
            zero_division=0,
        )
    )
    _, _, category_macro_f1, _ = precision_recall_fscore_support(
        true_categories,
        predicted_categories,
        labels=classes,
        average="macro",
        zero_division=0,
    )

    category_metrics = {
        category: {
            "precision": float(category_precision[index]),
            "recall": float(category_recall[index]),
            "f1": float(category_f1[index]),
            "support": int(category_support[index]),
        }
        for index, category in enumerate(classes)
    }

    errors = [
        prediction
        for prediction in predictions
        if prediction["true_category"] != prediction["ai_category"]
    ]
    matrix = confusion_matrix(
        true_binary,
        predicted_binary,
        labels=["not_risk", "risk"],
    ).tolist()

    return {
        "sample_count": len(rows),
        "binary": {
            "positive_class": "risk",
            "accuracy": float(accuracy_score(true_binary, predicted_binary)),
            "precision": float(binary_precision[0]),
            "recall": float(binary_recall[0]),
            "f1": float(binary_f1[0]),
            "confusion_matrix_labels": ["not_risk", "risk"],
            "confusion_matrix": matrix,
            "tn": int(matrix[0][0]),
            "fp": int(matrix[0][1]),
            "fn": int(matrix[1][0]),
            "tp": int(matrix[1][1]),
        },
        "category": {
            "accuracy": float(
                accuracy_score(true_categories, predicted_categories)
            ),
            "macro_f1": float(category_macro_f1),
            "per_class": category_metrics,
        },
        "error_count": len(errors),
        "errors": errors,
    }
