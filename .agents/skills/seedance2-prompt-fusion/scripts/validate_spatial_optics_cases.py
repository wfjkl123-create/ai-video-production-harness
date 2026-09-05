#!/usr/bin/env python3
"""Regression and adversarial cases for the spatial-optics contract."""

from __future__ import annotations

import importlib.util
import copy
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = ROOT / "scripts" / "validate_spatial_optics_contract.py"
CASES_PATH = ROOT / "tests" / "spatial-optics-cases.json"
SCHEMA_PATH = ROOT / "references" / "spatial-optics-contract.schema.json"


def load_validator():
    spec = importlib.util.spec_from_file_location("spatial_optics_validator", VALIDATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def deep_merge(target, patch):
    for key, value in patch.items():
        if value == {"$delete": True}:
            target.pop(key, None)
        elif isinstance(value, dict) and set(value) == {"$replace"}:
            target[key] = value["$replace"]
        elif isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_merge(target[key], value)
        else:
            target[key] = value
    return target


def main() -> int:
    validator = load_validator()
    json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    document = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    base_contract = document["baseContract"]
    cases = document["cases"]
    non_finite_contract = copy.deepcopy(base_contract)
    non_finite_contract["riskFlags"] = ["confined_space"]
    non_finite_contract["space"] = {"mode": "static", "cameraEnvelopeM": float("inf"), "safetyMarginM": 0.1, "availableClearanceM": float("inf")}
    cases.append({
        "name": "non_finite_clearance_fails",
        "replaceContract": non_finite_contract,
        "expectedStatus": "FAIL",
        "expectedCodes": ["SCHEMA_VALIDATION_ERROR"],
    })
    failures: list[str] = []
    for case in cases:
        contract = case.get("replaceContract")
        if contract is None:
            contract = deep_merge(copy.deepcopy(base_contract), case.get("patch", {}))
        result = validator.validate(contract)
        codes = {finding["code"] for finding in result["findings"]}
        if result["status"] != case["expectedStatus"]:
            failures.append(f"{case['name']}: expected {case['expectedStatus']}, got {result['status']}")
        missing = set(case["expectedCodes"]) - codes
        if missing:
            failures.append(f"{case['name']}: missing codes {sorted(missing)}")
        if "allowedCodes" in case:
            unexpected = codes - set(case["allowedCodes"])
            if unexpected:
                failures.append(f"{case['name']}: unexpected codes {sorted(unexpected)}")
        if case["expectedStatus"] == "PASS":
            if result["contractValidationStatus"] != "CONTRACT_VALIDATION_PASS" or result["promptBodyLintStatus"] != "PROMPT_BODY_LINT_PASS":
                failures.append(f"{case['name']}: PASS case did not pass both explicit gates")
            if result["platformExecutionStatus"] != "PLATFORM_EXECUTION_NOT_VERIFIED":
                failures.append(f"{case['name']}: platform execution boundary missing")
    if failures:
        print("FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print(f"PASS: {len(cases)}/{len(cases)} spatial-optics regression and adversarial cases.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
