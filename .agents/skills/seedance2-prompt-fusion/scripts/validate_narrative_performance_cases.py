#!/usr/bin/env python3
"""Regression tests for the narrative performance semantic gate."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = ROOT / "scripts" / "validate_narrative_performance.py"
CASES_PATH = ROOT / "tests" / "narrative-performance-cases.json"


def load_validator():
    spec = importlib.util.spec_from_file_location("narrative_performance_validator", VALIDATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    validator = load_validator()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    failures: list[str] = []
    for case in cases:
        result = validator.validate(case["prompt"], case["profile"], case["duration"])
        codes = {finding["code"] for finding in result["findings"]}
        if result["status"] != case["expectedStatus"]:
            failures.append(f"{case['name']}: expected {case['expectedStatus']}, got {result['status']}")
        if "expectedDialogueCount" in case and result["dialogueCount"] != case["expectedDialogueCount"]:
            failures.append(f"{case['name']}: expected dialogueCount {case['expectedDialogueCount']}, got {result['dialogueCount']}")
        missing = set(case["expectedCodes"]) - codes
        if missing:
            failures.append(f"{case['name']}: missing codes {sorted(missing)}")
    if failures:
        print("FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print(f"PASS: {len(cases)}/{len(cases)} narrative performance regression cases.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
