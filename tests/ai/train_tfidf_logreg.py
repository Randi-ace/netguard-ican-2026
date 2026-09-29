#!/usr/bin/env python3
"""Train TF-IDF + Logistic Regression v1 on train and assess it on val."""

from __future__ import annotations

import json
import platform
import subprocess
import sys
from datetime import datetime, timezone

import joblib
import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

from hash_utils import sha256_binary_file, sha256_canonical_utf8_text
from tfidf_logreg_common import (
    ARTIFACT_PATH,
    DATASET_PATH,
    MANIFEST_PATH,
    MODEL_VERSION,
    current_git_commit,
    evaluate_pipeline,
    load_split,
    prediction_contract,
)


def configure_output_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")


def build_pipeline() -> Pipeline:
    return Pipeline(
        steps=[
            (
                "tfidf",
                TfidfVectorizer(
                    analyzer="char",
                    ngram_range=(2, 5),
                    min_df=1,
                    sublinear_tf=True,
                ),
            ),
            (
                "classifier",
                LogisticRegression(
                    C=4.0,
                    class_weight="balanced",
                    max_iter=2000,
                    random_state=42,
                    solver="lbfgs",
                ),
            ),
        ]
    )


def main() -> int:
    configure_output_encoding()
    train_rows = load_split("train")
    val_rows = load_split("val")

    pipeline = build_pipeline()
    pipeline.fit(
        [row["text"] for row in train_rows],
        [row["category"] for row in train_rows],
    )
    validation_metrics = evaluate_pipeline(pipeline, val_rows)
    classes = [str(value) for value in pipeline.classes_]

    ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(pipeline, ARTIFACT_PATH, compress=3)

    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    manifest = {
        "model_name": "SmartGuard text risk classifier",
        "model_version": MODEL_VERSION,
        "created_at": timestamp,
        "git_commit": current_git_commit(),
        "artifact": {
            "path": ARTIFACT_PATH.relative_to(ARTIFACT_PATH.parents[2]).as_posix(),
            "sha256": sha256_binary_file(ARTIFACT_PATH),
            "type": "sklearn.pipeline.Pipeline",
            "pipeline_steps": [name for name, _ in pipeline.steps],
        },
        "dataset": {
            "path": DATASET_PATH.relative_to(ARTIFACT_PATH.parents[2]).as_posix(),
            "sha256": sha256_canonical_utf8_text(DATASET_PATH),
            "training_split": "train",
            "training_samples": len(train_rows),
            "validation_split": "val",
            "validation_samples": len(val_rows),
            "test_split_used": False,
        },
        "model_parameters": {
            "tfidf": {
                "analyzer": "char",
                "ngram_range": [2, 5],
                "min_df": 1,
                "sublinear_tf": True,
            },
            "logistic_regression": {
                "C": 4.0,
                "class_weight": "balanced",
                "max_iter": 2000,
                "random_state": 42,
                "solver": "lbfgs",
            },
        },
        "classes": classes,
        "test_macro_f1": None,
        "prediction_contract": prediction_contract(),
        "versions": {
            "python": platform.python_version(),
            "scikit_learn": sklearn.__version__,
            "joblib": joblib.__version__,
        },
        "validation_metrics": validation_metrics,
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    binary = validation_metrics["binary"]
    category = validation_metrics["category"]
    print(f"Model artifact: {ARTIFACT_PATH}")
    print(f"Manifest: {MANIFEST_PATH}")
    print(f"classes_: {classes}")
    print(f"Validation samples: {validation_metrics['sample_count']}")
    print(f"Validation binary F1: {binary['f1']:.6f}")
    print(f"Validation category accuracy: {category['accuracy']:.6f}")
    print(f"Validation category macro F1: {category['macro_f1']:.6f}")
    print("Test split used: false")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
