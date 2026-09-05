#!/usr/bin/env python3
"""Verify that a PASS performance report still binds the exact prompt bytes."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def verify(prompt_path: Path, report_path: Path) -> list[str]:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    actual_sha = hashlib.sha256(prompt_path.read_bytes()).hexdigest()
    errors: list[str] = []
    if report.get("status") != "PASS":
        errors.append("report status is not PASS")
    if report.get("promptSha256") != actual_sha:
        errors.append(f"prompt SHA mismatch: report={report.get('promptSha256')} actual={actual_sha}")
    if report.get("promptPath") != str(prompt_path.resolve()):
        errors.append("report promptPath does not resolve to the supplied prompt")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    errors = verify(args.prompt, args.report)
    if errors:
        print("FAIL")
        for error in errors:
            print(f"- {error}")
        return 1
    print("PASS: performance report is bound to the exact prompt SHA.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
