#!/usr/bin/env python3
"""Create a non-overwriting short-video ad asset project scaffold."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def dump_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent", required=True, type=Path, help="Directory that will contain the project")
    parser.add_argument("--project-id", required=True, help="Lowercase letters, digits, and hyphens")
    parser.add_argument("--title", required=True)
    parser.add_argument("--duration", required=True, type=float, help="Target duration in seconds")
    parser.add_argument("--aspect-ratio", default="9:16")
    parser.add_argument(
        "--source-role",
        choices=("inspiration", "fact_source", "generation_reference", "none"),
        default="none",
    )
    parser.add_argument(
        "--review-scope",
        action="append",
        choices=("creative_quality", "performance", "platform_risk"),
        default=[],
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not PROJECT_ID_RE.fullmatch(args.project_id):
        parser.error("--project-id must contain lowercase letters, digits, and single hyphens")
    if args.duration <= 0:
        parser.error("--duration must be greater than zero")
    if not re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", args.aspect_ratio):
        parser.error("--aspect-ratio must look like 9:16")

    project_dir = args.parent.expanduser().resolve() / args.project_id
    if project_dir.exists():
        parser.error(f"refusing to overwrite existing path: {project_dir}")

    relative_dirs = (
        "brief/reference",
        "planning/creative-briefs",
        "planning/story-plans",
        "assets/project",
        "reviews",
        "prompts",
        "generations",
        "workbench",
    )
    files = (
        "project-state.json",
        "planning/intake.json",
        "planning/asset-plan.json",
        "planning/segmentation.input.json",
        "assets/project/asset-manifest.json",
    )
    if args.dry_run:
        print(project_dir)
        for item in relative_dirs + files:
            print(f"  {item}")
        return 0

    for relative in relative_dirs:
        (project_dir / relative).mkdir(parents=True, exist_ok=False)

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    review_scope = args.review_scope or ["creative_quality"]
    dump_json(
        project_dir / "project-state.json",
        {
            "schemaVersion": 1,
            "projectId": args.project_id,
            "title": args.title,
            "phase": "intake",
            "artifacts": [],
            "gates": {
                "creativeBrief": "pending",
                "storyPlan": "pending",
                "productAudit": "pending",
                "segmentation": "pending",
                "visualAssets": "pending",
            },
            "authorizations": {
                "imageGeneration": False,
                "videoGeneration": False,
                "upload": False,
                "publication": False,
                "mediaBuying": False,
            },
            "blockedReason": None,
            "createdAt": now,
            "updatedAt": now,
        },
    )
    dump_json(
        project_dir / "planning/intake.json",
        {
            "projectId": args.project_id,
            "title": args.title,
            "targetDurationSec": args.duration,
            "aspectRatio": args.aspect_ratio,
            "reviewScope": review_scope,
            "sourceRole": None if args.source_role == "none" else args.source_role,
            "sourceItems": [],
            "creativeGoal": "",
            "successDefinition": "",
            "knownConstraints": [],
            "unknowns": [],
            "status": "draft",
        },
    )
    dump_json(
        project_dir / "planning/asset-plan.json",
        {
            "projectId": args.project_id,
            "derivedFromStoryPlanId": None,
            "principle": "minimal_sufficient_assets",
            "suggestedRoles": ["character", "product_reference", "opening_frame"],
            "requiredAssets": [],
            "missingAssets": [],
            "generationScope": [],
            "status": "draft",
        },
    )
    dump_json(
        project_dir / "planning/segmentation.input.json",
        {
            "projectId": args.project_id,
            "targetDurationSec": args.duration,
            "segmentationBasis": "generator_limits_and_causal_continuity",
            "segments": [],
            "status": "draft",
        },
    )
    dump_json(
        project_dir / "assets/project/asset-manifest.json",
        {"projectId": args.project_id, "assets": [], "updatedAt": now},
    )
    print(f"Created {project_dir}")
    for item in files:
        print(f"  {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
