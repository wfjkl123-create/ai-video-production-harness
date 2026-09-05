#!/usr/bin/env python3
"""Validate Seedance 2.5 official-outline coverage and detailed-manual contracts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
REF_ROOT = SKILL_ROOT / "references"
CONTRACT = REF_ROOT / "seedance25-coverage-contract.json"

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--outline",
        type=Path,
        help="Optional official outline.json; when present, require exact 33 ID/title coverage.",
    )
    return parser.parse_args()


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def main() -> int:
    args = parse_args()
    errors: list[str] = []

    if not CONTRACT.exists():
        print(f"FAIL: missing {CONTRACT}")
        return 1

    data = json.loads(CONTRACT.read_text(encoding="utf-8"))
    rows = data.get("coverage", [])
    required_facets = data.get("requiredFacets") or []
    facet_labels = data.get("facetLabels") or {}
    if set(required_facets) != set(facet_labels):
        fail(errors, "requiredFacets and facetLabels must contain the same keys")

    contract_reference = data.get("contractReference", "")
    contract_path = REF_ROOT / contract_reference
    contract_text = contract_path.read_text(encoding="utf-8") if contract_path.exists() else ""
    contract_sections = {
        match.group(1): match.group(2)
        for match in re.finditer(
            r"^## \[CONTRACT:([A-Z0-9_]+)\].*?\n(.*?)(?=^## \[CONTRACT:|\Z)",
            contract_text,
            flags=re.MULTILINE | re.DOTALL,
        )
    }
    contract_bindings = data.get("contractBindings") or {}
    if data.get("outlineCount") != 33 or len(rows) != 33:
        fail(errors, f"coverage count must be 33, got contract={data.get('outlineCount')} rows={len(rows)}")

    indices = [row.get("index") for row in rows]
    ids = [row.get("id") for row in rows]
    if indices != list(range(33)):
        fail(errors, "coverage indices must be exactly 0..32 in order")
    if len(set(ids)) != 33:
        fail(errors, "outline IDs must be 33 unique values")

    all_references: set[str] = set()
    for row in rows:
        refs = row.get("references") or []
        if not refs:
            fail(errors, f"outline {row.get('index')} {row.get('title')} has no reference")
            continue
        for name in refs:
            all_references.add(name)
            path = REF_ROOT / name
            if not path.exists():
                fail(errors, f"outline {row.get('index')} references missing file: {name}")

        if row.get("kind") in {"function", "method", "feature"}:
            anchor = contract_bindings.get(row.get("id"))
            if not anchor:
                fail(errors, f"outline {row.get('index')} {row.get('title')} has no contract binding")
                continue
            section = contract_sections.get(anchor, "")
            if not section:
                fail(errors, f"outline {row.get('index')} contract anchor missing: {anchor}")
                continue
            missing = [facet for facet in required_facets if facet_labels.get(facet) not in section]
            if missing:
                fail(
                    errors,
                    f"outline {row.get('index')} {row.get('title')} contract {anchor} lacks facets: {','.join(missing)}",
                )

    mandatory_manuals = {
        "16_Seedance2.5参数与功能交互全手册.md",
        "17_Seedance2.5延长与转场方法全手册.md",
        "18_Seedance2.5多模态专项功能全手册.md",
        "19_Seedance2.5白模控制全手册.md",
        "20_Seedance2.5多宫格分镜全手册.md",
        "21_Seedance2.5案例技巧失败与验收.md",
        "23_Seedance2.5逐功能14字段合同.md",
    }
    missing_manuals = sorted(name for name in mandatory_manuals if not (REF_ROOT / name).exists())
    if missing_manuals:
        fail(errors, f"missing mandatory detailed manuals: {', '.join(missing_manuals)}")

    subcoverage_files = {
        "humanDimensions": REF_ROOT / "12_Seedance2.5基础公式与真人角色.md",
        "thirtySecondParts": REF_ROOT / "13_Seedance2.5长视频与延长.md",
        "extensionTransitions": REF_ROOT / "17_Seedance2.5延长与转场方法全手册.md",
        "editComponents": REF_ROOT / "16_Seedance2.5参数与功能交互全手册.md",
        "whiteModelGranularities": REF_ROOT / "19_Seedance2.5白模控制全手册.md",
        "caseFamilies": REF_ROOT / "21_Seedance2.5案例技巧失败与验收.md",
    }
    subcoverage = data.get("methodSubCoverage", {})
    for family, path in subcoverage_files.items():
        values = subcoverage.get(family) or []
        if not values:
            fail(errors, f"methodSubCoverage missing family: {family}")
            continue
        text = path.read_text(encoding="utf-8") if path.exists() else ""
        missing_values = [value for value in values if value not in text]
        if missing_values:
            fail(errors, f"subcoverage {family} missing in {path.name}: {', '.join(missing_values)}")

    if args.outline:
        official = json.loads(args.outline.read_text(encoding="utf-8"))
        if len(official) != 33:
            fail(errors, f"official outline expected 33 rows, got {len(official)}")
        official_pairs = [(row.get("id"), row.get("text")) for row in official]
        contract_pairs = [(row.get("id"), row.get("title")) for row in rows]
        if official_pairs != contract_pairs:
            for index, (expected, actual) in enumerate(zip(official_pairs, contract_pairs)):
                if expected != actual:
                    fail(errors, f"outline mismatch at {index}: expected={expected!r} actual={actual!r}")

    if errors:
        print("COVERAGE_VALIDATION=FAIL")
        for item in errors:
            print(f"- {item}")
        return 1

    print("COVERAGE_VALIDATION=PASS")
    print(f"OUTLINE_COVERED={len(rows)}/33")
    print(f"REFERENCES_USED={len(all_references)}")
    print(f"MANDATORY_MANUALS={len(mandatory_manuals)}/7")
    print(f"DETAILED_CONTRACTS={len(contract_sections)}")
    print(
        "METHOD_SUBCOVERAGE="
        + ",".join(f"{name}:{len(values)}" for name, values in subcoverage.items())
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
