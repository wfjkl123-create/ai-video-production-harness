#!/usr/bin/env python3
"""Run deterministic boundary cases against the Seedance 2.5 prompt validator."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "tests" / "seedance25-execution-contract-cases.json"
VALIDATOR = ROOT / "scripts" / "validate_seedance25_prompt.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("seedance25_prompt_validator", VALIDATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load validator: {VALIDATOR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    validator = load_validator()
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    failures: list[str] = []
    for case in cases:
        result = validator.validate(case["prompt"], case["mode"], case["duration"])
        codes = {finding["code"] for finding in result["findings"]}
        if result["pass"] != case["mustPass"]:
            failures.append(f"{case['id']}: expected pass={case['mustPass']}, got {result['pass']}")
        missing = set(case["mustContainCodes"]) - codes
        if missing:
            failures.append(f"{case['id']}: missing codes {', '.join(sorted(missing))}")

    if failures:
        print("EXECUTION_CONTRACT=FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("EXECUTION_CONTRACT=PASS")
    print(f"CASES_PASSED={len(cases)}/{len(cases)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
