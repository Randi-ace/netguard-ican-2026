#!/usr/bin/env python3
"""Stable hashing helpers for AI model artifacts and UTF-8 datasets."""

from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_binary_file(path: Path) -> str:
    """Hash a binary file without transforming its bytes."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_canonical_utf8_text(path: Path) -> str:
    """Hash UTF-8 text after normalizing CRLF and CR line endings to LF."""
    raw = path.read_bytes()
    raw.decode("utf-8")
    normalized = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return hashlib.sha256(normalized).hexdigest()
