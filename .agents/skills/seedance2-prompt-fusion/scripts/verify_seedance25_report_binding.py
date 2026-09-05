#!/usr/bin/env python3
"""Reject stale Seedance 2.5 dual-source reports whose prompt SHA no longer matches."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", type=Path)
    parser.add_argument("report_json", type=Path)
    args = parser.parse_args()

    report = json.loads(args.report_json.read_text(encoding="utf-8"))
    expected = str(report.get("prompt", {}).get("sha256", ""))
    actual = sha256_file(args.prompt)
    status = report.get("finalStatus")
    passed = actual == expected and status == "VERIFIED_PASS"
    print("REPORT_BINDING=PASS" if passed else "REPORT_BINDING=FAIL")
    print(f"PROMPT_SHA={actual}")
    print(f"REPORT_SHA={expected}")
    print(f"REPORT_STATUS={status}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())

