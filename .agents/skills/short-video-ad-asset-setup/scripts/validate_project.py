#!/usr/bin/env python3
"""Validate core truth and continuity invariants for an ad asset project."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


REQUIRED_FILES = (
    "project-state.json",
    "planning/intake.json",
    "planning/asset-plan.json",
    "planning/segmentation.input.json",
    "assets/project/asset-manifest.json",
)
VALID_GATE_STATES = {"pending", "awaiting_review", "approved", "locked", "rejected", "blocked"}


def load_json(path: Path, errors: list[str]) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot read valid JSON: {path}: {exc}")
        return {}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path)
    args = parser.parse_args()
    root = args.project_dir.expanduser().resolve()
    errors: list[str] = []
    warnings: list[str] = []

    if not root.is_dir():
        parser.error(f"not a directory: {root}")
    for relative in REQUIRED_FILES:
        if not (root / relative).is_file():
            errors.append(f"missing required file: {relative}")
    if errors:
        for item in errors:
            print(f"FAIL {item}")
        return 1

    state = load_json(root / "project-state.json", errors)
    intake = load_json(root / "planning/intake.json", errors)
    plan = load_json(root / "planning/asset-plan.json", errors)
    segmentation = load_json(root / "planning/segmentation.input.json", errors)
    manifest = load_json(root / "assets/project/asset-manifest.json", errors)
    project_id = state.get("projectId")
    if not project_id:
        errors.append("project-state.json has no projectId")
    for name, payload in (("intake", intake), ("asset plan", plan), ("segmentation", segmentation), ("manifest", manifest)):
        if payload.get("projectId") != project_id:
            errors.append(f"{name} projectId does not match project-state.json")

    gates = state.get("gates", {})
    for name, value in gates.items():
        if value not in VALID_GATE_STATES:
            errors.append(f"gate {name} has invalid state: {value!r}")
    auth = state.get("authorizations", {})
    for name in ("imageGeneration", "videoGeneration", "upload", "publication", "mediaBuying"):
        if not isinstance(auth.get(name), bool):
            errors.append(f"authorization {name} must be true or false")

    if not auth.get("imageGeneration", False):
        generated = [a.get("id", "<unknown>") for a in manifest.get("assets", []) if a.get("status") == "generated"]
        if generated:
            errors.append("generated assets exist while imageGeneration authorization is false: " + ", ".join(generated))
    if plan.get("generationScope") and not auth.get("imageGeneration", False):
        warnings.append("generationScope is populated but imageGeneration authorization is false")

    reviews: dict[str, dict] = {}
    for review_path in (root / "reviews").glob("*.json"):
        review = load_json(review_path, errors)
        review_id = review.get("id")
        if review_id:
            reviews[review_id] = review

    for artifact in state.get("artifacts", []):
        relative = artifact.get("path")
        expected = artifact.get("sha256")
        if not relative:
            errors.append(f"artifact {artifact.get('id', '<unknown>')} has no path")
            continue
        artifact_path = root / relative
        if not artifact_path.is_file():
            errors.append(f"artifact path does not exist: {relative}")
            continue
        if expected and sha256_file(artifact_path) != expected:
            errors.append(f"artifact hash mismatch: {relative}")
        if artifact.get("status") == "locked":
            review_id = artifact.get("lockedByReviewId")
            if not review_id:
                errors.append(f"locked artifact has no lockedByReviewId: {artifact.get('id', relative)}")
                continue
            review = reviews.get(review_id)
            if not review:
                errors.append(f"locked artifact review record not found: {review_id}")
                continue
            if review.get("artifactId") != artifact.get("id"):
                errors.append(f"review {review_id} artifactId does not match {artifact.get('id', relative)}")
            if expected and review.get("artifactSha256") != expected:
                errors.append(f"review {review_id} hash does not match locked artifact")

    segments = segmentation.get("segments", [])
    target = float(segmentation.get("targetDurationSec", intake.get("targetDurationSec", 0)) or 0)
    if segments:
        total = sum(float(item.get("duration", 0) or 0) for item in segments)
        if abs(total - target) > 0.001:
            errors.append(f"segment durations total {total:g}s, target is {target:g}s")
        for index, segment in enumerate(segments):
            if not segment.get("startState") or not segment.get("endState"):
                errors.append(f"segment {segment.get('id', index)} lacks startState or endState")
            if index:
                previous = segments[index - 1]
                if segment.get("previousSegmentId") != previous.get("id"):
                    errors.append(f"segment {segment.get('id', index)} previousSegmentId mismatch")
                if previous.get("nextSegmentId") != segment.get("id"):
                    errors.append(f"segment {previous.get('id', index - 1)} nextSegmentId mismatch")
                if not previous.get("endState", {}).get("handoffOcclusion"):
                    warnings.append(f"segment {previous.get('id', index - 1)} has no handoffOcclusion")
    elif segmentation.get("status") in {"awaiting_review", "approved", "locked"}:
        errors.append("segmentation status requires at least one segment")

    for item in warnings:
        print(f"WARN {item}")
    for item in errors:
        print(f"FAIL {item}")
    if errors:
        print(f"RESULT FAIL ({len(errors)} errors, {len(warnings)} warnings)")
        return 1
    print(f"RESULT PASS ({len(warnings)} warnings)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
