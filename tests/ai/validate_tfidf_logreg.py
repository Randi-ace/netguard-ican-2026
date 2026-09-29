#!/usr/bin/env python3
"""Validate the saved TF-IDF model v1 artifact on the val split only."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

import joblib
from sklearn.pipeline import Pipeline

from hash_utils import sha256_binary_file, sha256_canonical_utf8_text
from tfidf_logreg_common import (
    ARTIFACT_PATH,
    DATASET_PATH,
    MANIFEST_PATH,
    MODEL_VERSION,
    RESULT_PATH,
    evaluate_pipeline,
    load_split,
    prediction_contract,
)


def configure_output_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")


def main() -> int:
    configure_output_encoding()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    artifact_hash = sha256_binary_file(ARTIFACT_PATH)
    dataset_hash = sha256_canonical_utf8_text(DATASET_PATH)
    if artifact_hash != manifest["artifact"]["sha256"]:
        raise RuntimeError("Artifact SHA-256 does not match the manifest")
    if dataset_hash != manifest["dataset"]["sha256"]:
        raise RuntimeError("Dataset SHA-256 does not match the manifest")
    if manifest["dataset"].get("test_split_used") is not False:
        raise RuntimeError("Manifest does not confirm that the test split stayed frozen")
    if manifest.get("test_macro_f1") is not None:
        raise RuntimeError("Manifest test_macro_f1 must remain null before final test")

    pipeline = joblib.load(ARTIFACT_PATH)
    if not isinstance(pipeline, Pipeline):
        raise RuntimeError("Artifact is not a complete sklearn Pipeline")
    if list(pipeline.named_steps) != ["tfidf", "classifier"]:
        raise RuntimeError("Artifact pipeline steps are not tfidf -> classifier")

    classes = [str(value) for value in pipeline.classes_]
    if classes != manifest["classes"]:
        raise RuntimeError("Artifact classes_ does not match manifest classes")

    rows = load_split("val")
    metrics = evaluate_pipeline(pipeline, rows)
    if metrics != manifest["validation_metrics"]:
        raise RuntimeError("Recomputed validation metrics do not match the manifest")

    result = {
        "evaluation_name": "tfidf-logreg-v1-validation",
        "model_version": MODEL_VERSION,
        "evaluated_at": datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        ),
        "git_commit": manifest["git_commit"],
        "artifact_path": manifest["artifact"]["path"],
        "artifact_sha256": artifact_hash,
        "dataset_path": manifest["dataset"]["path"],
        "dataset_sha256": dataset_hash,
        "dataset_split": "val",
        "test_split_used": False,
        "classes": classes,
        "test_macro_f1": manifest["test_macro_f1"],
        "prediction_contract": prediction_contract(),
        "versions": manifest["versions"],
        "metrics": metrics,
    }
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    binary = metrics["binary"]
    category = metrics["category"]
    print("Evaluation split: val")
    print(f"Sample count: {metrics['sample_count']}")
    print(f"Binary accuracy: {binary['accuracy']:.6f}")
    print(f"Binary precision: {binary['precision']:.6f}")
    print(f"Binary recall: {binary['recall']:.6f}")
    print(f"Binary F1: {binary['f1']:.6f}")
    print(f"Binary confusion matrix: {binary['confusion_matrix']}")
    print(f"Category accuracy: {category['accuracy']:.6f}")
    print(f"Category macro F1: {category['macro_f1']:.6f}")
    print(f"classes_: {classes}")
    print(f"Dataset SHA-256: {dataset_hash}")
    print(f"Artifact SHA-256: {artifact_hash}")
    print("Test split used: false")
    print(f"Result JSON: {RESULT_PATH}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
