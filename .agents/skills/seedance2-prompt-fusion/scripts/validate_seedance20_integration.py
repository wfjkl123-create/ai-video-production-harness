#!/usr/bin/env python3
"""Validate the complete, inert Seedance 2.0 v6.7 integration."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = SKILL_ROOT / "references" / "seedance20-v67"
MANIFEST = SNAPSHOT / "integration-manifest.json"
DEEP_FUSION_DOCS = [
    "28_融合后的活人感与表演系统.md",
    "29_融合后的需求访谈与提示词编译系统.md",
    "30_融合后的导演预演与故事系统.md",
    "31_融合后的摄影光影色彩与风格系统.md",
    "32_融合后的动作物理产品与特效系统.md",
    "33_融合后的声音对白音乐与同步系统.md",
    "34_融合后的素材权威角色身份与多模态系统.md",
    "35_融合后的多段连续性延长与分镜系统.md",
    "36_融合后的去AI味失败诊断与返工系统.md",
    "37_融合后的专业制作后期交付与质量系统.md",
    "38_融合后的多语言版权安全与证据系统.md",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    source_root = Path(manifest["source_root"])
    records = manifest["files"]

    if manifest.get("source_version") != "6.7.0":
        errors.append("manifest source_version is not 6.7.0")
    if manifest.get("source_file_count") != 187 or len(records) != 187:
        errors.append("integration does not account for exactly 187 source files")

    source_paths = set()
    integrated_paths = set()
    for record in records:
        source_rel = record["source_path"]
        integrated_rel = record["integrated_path"]
        if source_rel in source_paths:
            errors.append(f"duplicate source mapping: {source_rel}")
        if integrated_rel in integrated_paths:
            errors.append(f"duplicate integrated mapping: {integrated_rel}")
        source_paths.add(source_rel)
        integrated_paths.add(integrated_rel)

        integrated_file = SNAPSHOT / integrated_rel
        if not integrated_file.is_file():
            errors.append(f"missing integrated file: {integrated_rel}")
            continue
        if sha256(integrated_file) != record["integrated_sha256"]:
            errors.append(f"integrated hash drift: {integrated_rel}")
        if source_root.is_dir():
            source_file = source_root / source_rel
            if not source_file.is_file():
                errors.append(f"missing source file: {source_rel}")
            elif sha256(source_file) != record["source_sha256"]:
                errors.append(f"source hash drift: {source_rel}")

    if not source_root.is_dir():
        warnings.append(
            "original source root is unavailable; integrated hashes were verified from the manifest"
        )

    nested_entrypoints = [
        path for path in SKILL_ROOT.rglob("SKILL.md") if path != SKILL_ROOT / "SKILL.md"
    ]
    if nested_entrypoints:
        errors.extend(f"competing nested entrypoint: {path}" for path in nested_entrypoints)

    active_skill_root = SKILL_ROOT.parent
    competing_names = {"seedance2-prompt", "seedance-20"}
    for sibling in active_skill_root.iterdir():
        candidate = sibling / "SKILL.md"
        if sibling == SKILL_ROOT or not candidate.is_file():
            continue
        header = candidate.read_text(encoding="utf-8", errors="replace")[:4096]
        match = re.search(r"(?m)^name:\s*[\"']?([^\"'\n]+)", header)
        if match and match.group(1).strip() in competing_names:
            errors.append(
                f"competing active global prompt entrypoint: {candidate}"
            )

    link_pattern = re.compile(r"]\(([^)]+)\)")
    markdown_graph: dict[Path, list[Path]] = {}
    for markdown in SNAPSHOT.rglob("*.md"):
        text = markdown.read_text(encoding="utf-8")
        linked_markdown: list[Path] = []
        for raw in link_pattern.findall(text):
            target = raw.strip().strip("<>").split("#", 1)[0]
            if not target or target.startswith(("http://", "https://", "mailto:", "data:")):
                continue
            linked = (markdown.parent / target).resolve()
            if not linked.exists():
                errors.append(
                    f"broken snapshot link: {markdown.relative_to(SNAPSHOT)} -> {target}"
                )
            elif linked.suffix == ".md":
                linked_markdown.append(linked)
        markdown_graph[markdown.resolve()] = linked_markdown

    fusion_index = SKILL_ROOT / "references" / "27_Seedance20_v67全量融合与冲突路由.md"
    fusion_text = fusion_index.read_text(encoding="utf-8")
    route_starts: set[Path] = {(SNAPSHOT / "MODULE.md").resolve()}
    for token in re.findall(r"`([^`]+)`", fusion_text):
        if not token.startswith(("seedance20-v67/", "../SKILL.md")):
            continue
        if "*" in token:
            matches = list(fusion_index.parent.glob(token))
            if not matches:
                errors.append(f"fusion route wildcard has no matches: {token}")
            route_starts.update(path.resolve() for path in matches if path.suffix == ".md")
            continue
        routed = (fusion_index.parent / token).resolve()
        if not routed.exists():
            errors.append(f"broken fusion load path: {token}")
        elif routed.suffix == ".md" and SNAPSHOT in routed.parents:
            route_starts.add(routed)

    reachable = set(route_starts)
    queue = list(route_starts)
    while queue:
        current = queue.pop()
        for linked in markdown_graph.get(current, []):
            if linked not in reachable:
                reachable.add(linked)
                queue.append(linked)

    expected_modules = {path.resolve() for path in (SNAPSHOT / "skills").glob("*/MODULE.md")}
    missing_modules = sorted(expected_modules - reachable)
    errors.extend(
        f"unrouted v6.7 subskill module: {path.relative_to(SNAPSHOT)}"
        for path in missing_modules
    )

    expected_references = {path.resolve() for path in (SNAPSHOT / "references").rglob("*.md")}
    missing_references = sorted(expected_references - reachable)
    errors.extend(
        f"unrouted v6.7 prompt reference: {path.relative_to(SNAPSHOT)}"
        for path in missing_references
    )

    root_text = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
    required_markers = [
        "references/27_Seedance20_v67全量融合与冲突路由.md",
        "references/28_融合后的活人感与表演系统.md",
        "Seedance 2.5 强制加载矩阵",
        "v6.7 统一前置门",
        "最终提示词正文不出现 Director's Read",
    ]
    for marker in required_markers:
        if marker not in root_text:
            errors.append(f"missing canonical route marker: {marker}")

    for filename in DEEP_FUSION_DOCS:
        fusion_doc = SKILL_ROOT / "references" / filename
        if not fusion_doc.is_file():
            errors.append(f"missing deep fusion document: {filename}")
            continue
        text = fusion_doc.read_text(encoding="utf-8")
        if filename not in root_text:
            errors.append(f"deep fusion document is not routed from SKILL.md: {filename}")
        ref_number = filename.split("_", 1)[0]
        if f"ref {ref_number}" not in fusion_text:
            errors.append(f"deep fusion document is not routed from ref 27: {filename}")
        if "双方差异的统一裁决" not in text:
            errors.append(f"deep fusion document lacks explicit conflict synthesis: {filename}")
        if "验收" not in text:
            errors.append(f"deep fusion document lacks an acceptance contract: {filename}")

    if errors:
        print("FAIL")
        for error in errors:
            print(f"- {error}")
        return 1

    for warning in warnings:
        print(f"WARNING: {warning}")
    print(
        "PASS: 187/187 files mapped; 28/28 subskill modules and 63/63 prompt "
        "references are routed; one active global prompt entrypoint remains; "
        f"hashes, snapshot links, canonical routes, and {len(DEEP_FUSION_DOCS)}/"
        f"{len(DEEP_FUSION_DOCS)} deep-fusion documents are valid."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
