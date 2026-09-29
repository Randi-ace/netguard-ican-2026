#!/usr/bin/env python3
"""Validate the frozen schema and split integrity of AI text dataset v1."""

from __future__ import annotations

import csv
import sys
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path

from hash_utils import sha256_canonical_utf8_text


EXPECTED_HEADER = [
    "id",
    "text",
    "label",
    "category",
    "source",
    "url",
    "title",
    "group_id",
    "split",
    "note",
]
VALID_LABELS = ("risk", "not_risk")
VALID_CATEGORIES = (
    "normal",
    "phishing",
    "scam",
    "gambling",
    "adult",
    "malicious",
)
VALID_SPLITS = ("train", "val", "test")
NEAR_DUPLICATE_THRESHOLD = 0.92
NEAR_DUPLICATE_MIN_LENGTH = 24
DATASET_PATH = (
    Path(__file__).resolve().parents[1]
    / "samples"
    / "ai-text-dataset.csv"
)


def normalize_text(value: str) -> str:
    """Normalize text for duplicate checks without language-specific packages."""
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(
        char
        for char in normalized
        if unicodedata.category(char)[0] in {"L", "N"}
    )


def format_counter(counter: Counter[str], order: tuple[str, ...]) -> str:
    return ", ".join(f"{key}={counter.get(key, 0)}" for key in order)


def add_issue(issues: list[str], code: str, message: str) -> None:
    issues.append(f"{code}: {message}")


def load_rows(path: Path, errors: list[str]) -> list[dict[str, str]]:
    if not path.is_file():
        add_issue(errors, "dataset-missing", f"CSV file not found: {path}")
        return []

    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames != EXPECTED_HEADER:
                add_issue(
                    errors,
                    "header-mismatch",
                    f"expected {EXPECTED_HEADER}, got {reader.fieldnames}",
                )
                return []
            rows = list(reader)
    except (OSError, UnicodeError, csv.Error) as exc:
        add_issue(errors, "csv-read-error", str(exc))
        return []

    for row_number, row in enumerate(rows, start=2):
        if None in row or any(value is None for value in row.values()):
            add_issue(
                errors,
                "row-width",
                f"row {row_number} does not contain exactly {len(EXPECTED_HEADER)} fields",
            )
    return rows


def validate_rows(
    rows: list[dict[str, str]],
    errors: list[str],
    warnings: list[str],
) -> None:
    ids: defaultdict[str, list[int]] = defaultdict(list)
    exact_texts: defaultdict[str, list[tuple[int, str, str]]] = defaultdict(list)
    normalized_texts: defaultdict[
        str, list[tuple[int, str, str, str]]
    ] = defaultdict(list)
    group_splits: defaultdict[str, set[str]] = defaultdict(set)

    prepared_rows: list[tuple[int, dict[str, str], str]] = []

    for row_number, row in enumerate(rows, start=2):
        clean = {
            field: (row.get(field) or "").strip()
            for field in EXPECTED_HEADER
        }
        sample_id = clean["id"]
        text = clean["text"]
        label = clean["label"]
        category = clean["category"]
        source = clean["source"]
        group_id = clean["group_id"]
        split = clean["split"]

        if not sample_id:
            add_issue(errors, "id-empty", f"row {row_number}")
        else:
            ids[sample_id].append(row_number)

        if not text:
            add_issue(errors, "text-empty", f"row {row_number} ({sample_id or 'no-id'})")

        if label not in VALID_LABELS:
            add_issue(
                errors,
                "label-invalid",
                f"row {row_number} ({sample_id}): {label!r}",
            )

        if category not in VALID_CATEGORIES:
            add_issue(
                errors,
                "category-invalid",
                f"row {row_number} ({sample_id}): {category!r}",
            )

        if split not in VALID_SPLITS:
            add_issue(
                errors,
                "split-invalid",
                f"row {row_number} ({sample_id}): {split!r}",
            )

        if not group_id:
            add_issue(errors, "group-empty", f"row {row_number} ({sample_id})")
        elif split:
            group_splits[group_id].add(split)

        if not source:
            add_issue(errors, "source-empty", f"row {row_number} ({sample_id})")

        if category == "normal" and label != "not_risk":
            add_issue(
                errors,
                "normal-label",
                f"row {row_number} ({sample_id}) must use label='not_risk'",
            )
        elif category in VALID_CATEGORIES[1:] and label != "risk":
            add_issue(
                errors,
                "risk-label",
                f"row {row_number} ({sample_id}) must use label='risk'",
            )

        if text:
            normalized = normalize_text(text)
            exact_texts[text].append((row_number, sample_id, split))
            normalized_texts[normalized].append(
                (row_number, sample_id, split, text)
            )
            prepared_rows.append((row_number, clean, normalized))

    for sample_id, row_numbers in ids.items():
        if len(row_numbers) > 1:
            add_issue(
                errors,
                "id-duplicate",
                f"{sample_id!r} appears on rows {row_numbers}",
            )

    for group_id, splits in group_splits.items():
        if len(splits) > 1:
            add_issue(
                errors,
                "group-cross-split",
                f"{group_id!r} appears in splits {sorted(splits)}",
            )

    for text, occurrences in exact_texts.items():
        if len(occurrences) <= 1:
            continue
        locations = [(row, sample_id) for row, sample_id, _ in occurrences]
        add_issue(
            errors,
            "text-exact-duplicate",
            f"rows/ids {locations}: {text[:80]!r}",
        )
        splits = {split for _, _, split in occurrences}
        if len(splits) > 1:
            add_issue(
                errors,
                "text-exact-cross-split",
                f"rows/ids {locations} appear in splits {sorted(splits)}",
            )

    for normalized, occurrences in normalized_texts.items():
        if len(occurrences) <= 1:
            continue
        raw_texts = {text for _, _, _, text in occurrences}
        if len(raw_texts) <= 1:
            continue
        locations = [(row, sample_id) for row, sample_id, _, _ in occurrences]
        add_issue(
            errors,
            "text-normalized-duplicate",
            f"rows/ids {locations}: normalized={normalized[:80]!r}",
        )

    for index, (left_row, left, left_normalized) in enumerate(prepared_rows):
        if len(left_normalized) < NEAR_DUPLICATE_MIN_LENGTH:
            continue
        for right_row, right, right_normalized in prepared_rows[index + 1 :]:
            if left["split"] == right["split"]:
                continue
            if len(right_normalized) < NEAR_DUPLICATE_MIN_LENGTH:
                continue
            if left_normalized == right_normalized:
                continue
            length_ratio = min(len(left_normalized), len(right_normalized)) / max(
                len(left_normalized), len(right_normalized)
            )
            if length_ratio < NEAR_DUPLICATE_THRESHOLD:
                continue
            similarity = SequenceMatcher(
                None,
                left_normalized,
                right_normalized,
                autojunk=False,
            ).ratio()
            if similarity >= NEAR_DUPLICATE_THRESHOLD:
                add_issue(
                    warnings,
                    "near-duplicate-cross-split",
                    (
                        f"{left['id']} (row {left_row}, {left['split']}) and "
                        f"{right['id']} (row {right_row}, {right['split']}): "
                        f"similarity={similarity:.3f}"
                    ),
                )


def print_summary(path: Path, rows: list[dict[str, str]]) -> str:
    label_counts = Counter((row.get("label") or "").strip() for row in rows)
    category_counts = Counter(
        (row.get("category") or "").strip() for row in rows
    )
    split_counts = Counter((row.get("split") or "").strip() for row in rows)
    group_count = len(
        {
            (row.get("group_id") or "").strip()
            for row in rows
            if (row.get("group_id") or "").strip()
        }
    )
    dataset_hash = (
        sha256_canonical_utf8_text(path) if path.is_file() else "N/A"
    )

    print(f"Dataset: {path}")
    print(f"Total samples: {len(rows)}")
    print(f"Label distribution: {format_counter(label_counts, VALID_LABELS)}")
    print(
        "Category distribution: "
        f"{format_counter(category_counts, VALID_CATEGORIES)}"
    )
    print(f"Split distribution: {format_counter(split_counts, VALID_SPLITS)}")
    for split in VALID_SPLITS:
        split_categories = Counter(
            (row.get("category") or "").strip()
            for row in rows
            if (row.get("split") or "").strip() == split
        )
        print(
            f"Category distribution [{split}]: "
            f"{format_counter(split_categories, VALID_CATEGORIES)}"
        )
    print(f"Group count: {group_count}")
    print(f"Dataset SHA-256: {dataset_hash}")
    return dataset_hash


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    rows = load_rows(DATASET_PATH, errors)
    if rows:
        validate_rows(rows, errors, warnings)

    print_summary(DATASET_PATH, rows)
    for warning in warnings:
        print(f"WARNING {warning}")
    for error in errors:
        print(f"ERROR {error}")
    print(f"WARNING count: {len(warnings)}")
    print(f"ERROR count: {len(errors)}")
    print("RESULT: PASS" if not errors else "RESULT: FAIL")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
