#!/usr/bin/env python3
"""Validate one Seedance 2.5 prompt against online-official and Word evidence."""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
REF_ROOT = SKILL_ROOT / "references"
DUAL_MANIFEST = REF_ROOT / "seedance25-dual-source-manifest.json"
COVERAGE_CONTRACT = REF_ROOT / "seedance25-coverage-contract.json"
CONTRACT_MANUAL = REF_ROOT / "23_Seedance2.5逐功能14字段合同.md"
VIDEO_CATALOG = REF_ROOT / "seedance25-official-video-cases.jsonl"
IMAGE_CATALOG = REF_ROOT / "seedance25-official-image-catalog.jsonl"
PROMPT_CATALOG = REF_ROOT / "seedance25-official-prompt-case-catalog.jsonl"
PROMPT_VALIDATOR = SKILL_ROOT / "scripts" / "validate_seedance25_prompt.py"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_prompt_validator():
    spec = importlib.util.spec_from_file_location("seedance25_prompt_validator", PROMPT_VALIDATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load prompt validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def contract_sections(text: str) -> dict[str, str]:
    return {
        match.group(1): match.group(2)
        for match in re.finditer(
            r"^## \[CONTRACT:([A-Z0-9_]+)\].*?\n(.*?)(?=^## \[CONTRACT:|\Z)",
            text,
            flags=re.MULTILINE | re.DOTALL,
        )
    }


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def tsv_data_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def word_term_evidence(paths: list[Path], terms: list[str]) -> list[dict]:
    evidence: list[dict] = []
    for path in paths:
        for row in tsv_data_rows(path):
            joined = " ".join(str(value) for value in row.values())
            matched = [term for term in terms if term.lower() in joined.lower()]
            if matched:
                evidence.append(
                    {
                        "file": str(path.resolve()),
                        "matchedTerms": matched,
                        "sourceIndex": row.get("source_index") or row.get("sourceIndex"),
                        "type": row.get("type"),
                        "tableIndex": row.get("table_index") or row.get("tableIndex"),
                        "cellRef": row.get("cell_ref") or row.get("cellRef"),
                        "textSha256": hashlib.sha256(joined.encode("utf-8")).hexdigest(),
                    }
                )
                if len(evidence) >= 5:
                    return evidence
    return evidence


def prompt_span(text: str, needle: str) -> dict | None:
    index = text.find(needle)
    if index < 0:
        return None
    end = index + len(needle)
    return {
        "start": index,
        "end": end,
        "sha256": hashlib.sha256(text[index:end].encode("utf-8")).hexdigest(),
        "preview": text[index:end],
    }


def select_online_evidence(candidates: list[dict], terms: list[str], duration_needle: str, limit: int = 2) -> list[dict]:
    scored: list[tuple[int, int, dict]] = []
    generic = ("支持", "公式", "使用", "输入", "控制", "时间戳")
    for row in candidates:
        block_type = str(row.get("type", ""))
        if block_type.startswith("heading") or block_type in {"image", "file"}:
            continue
        text = str(row.get("text", "")).strip()
        if not text:
            continue
        score = sum(3 for term in terms if term.lower() in text.lower())
        score += sum(1 for term in generic if term in text)
        if duration_needle and duration_needle in text:
            score += 4
        if len(text) < 12:
            score -= 2
        scored.append((score, len(text), row))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [row for score, _, row in scored if score > 0][:limit]


def normalize_copy_text(text: str) -> str:
    return re.sub(r"\s+", "", text).lower()


def long_official_copy_hits(prompt_text: str, blocks: list[dict], window: int = 80) -> list[dict]:
    normalized_prompt = normalize_copy_text(prompt_text)
    hits: list[dict] = []
    for row in blocks:
        if row.get("type") not in {"code", "codeblock"}:
            continue
        official = normalize_copy_text(str(row.get("text", "")))
        if len(official) < window:
            continue
        for start in range(0, len(official) - window + 1, max(20, window // 2)):
            shingle = official[start : start + window]
            if shingle in normalized_prompt:
                hits.append(
                    {
                        "recordId": row.get("recordId"),
                        "sourceOrder": row.get("sourceOrder"),
                        "window": window,
                        "sha256": hashlib.sha256(shingle.encode("utf-8")).hexdigest(),
                    }
                )
                break
        if len(hits) >= 5:
            break
    return hits


def searchable_case_text(row: dict) -> str:
    fields = (
        "chapter",
        "section",
        "caseFamily",
        "promptOrCaseText",
        "mainVisualChanges",
        "successPoints",
        "failureOrRisk",
        "reusableRule",
    )
    return " ".join(str(row.get(field, "")) for field in fields)


def select_cases(rows: list[dict], terms: list[str]) -> tuple[list[dict], list[dict]]:
    matches = [row for row in rows if any(term.lower() in searchable_case_text(row).lower() for term in terms)]
    successes: list[dict] = []
    risks: list[dict] = []
    seen_sha: set[str] = set()
    for row in matches:
        sha = str(row.get("sha256", ""))
        if sha and sha in seen_sha:
            continue
        if sha:
            seen_sha.add(sha)
        risk_text = str(row.get("failureOrRisk", ""))
        is_risk = bool(risk_text) and "未见决定性失败" not in risk_text
        target = risks if is_risk else successes
        if len(target) < 3:
            target.append(row)
    if not successes:
        successes = matches[:1]
    return successes, risks


def case_summary(row: dict) -> dict:
    return {
        "nodeId": row.get("nodeId") or row.get("nodeIndex") or row.get("id"),
        "chapter": row.get("chapter") or row.get("section"),
        "durationSeconds": row.get("durationSeconds"),
        "hasAudio": row.get("hasAudio"),
        "success": row.get("successPoints"),
        "risk": row.get("failureOrRisk"),
        "reusableRule": row.get("reusableRule"),
        "sha256": row.get("sha256"),
    }


def markdown_report(result: dict) -> str:
    lines = [
        "# Seedance 2.5 提示词双源验证报告",
        "",
        f"- 最终状态：**{result['finalStatus']}**",
        f"- Prompt：`{result['prompt']['path']}`",
        f"- Prompt SHA-256：`{result['prompt']['sha256']}`",
        f"- operation / mode / duration：`{result['operation']}` / `{result['mode']}` / `{result['duration']}`",
        f"- 验证时间：`{result['verifiedAt']}`",
        "",
        "## 检查结果",
        "",
    ]
    for name, value in result["checks"].items():
        lines.append(f"- {name}：**{value}**")
    lines += [
        "",
        "## 在线官方证据",
        "",
        f"- 快照：`{result['online']['snapshotDate']}`；目录 `{result['online']['outlineCount']}/33`；正文记录 `{result['online']['blockCount']}`。",
        f"- 绑定目录：{', '.join(result['online']['outlineTitles'])}",
        f"- 新鲜度：{result['online']['freshnessDays']} 天；状态 `{result['online']['freshnessStatus']}`。",
        "- 正文坐标：",
        "",
    ]
    for item in result["claims"][0]["onlineEvidence"]:
        lines.append(f"  - outline `{item['outlineId']}` → recordId `{item['recordId']}` / sourceOrder `{item['sourceOrder']}` / `{item['blockType']}`")
    lines += [
        "",
        "## Word 交叉证据",
        "",
        f"- DOCX SHA：`{result['word']['actualSha256']}`；预期：`{result['word']['expectedSha256']}`。",
        f"- 文字命中：{', '.join(result['word']['matchedTerms']) or '无'}；状态 `{result['word']['crosscheckStatus']}`。",
        f"- 动态证据：`{result['word']['dynamicEvidenceStatus']}`。Word 无嵌入视频/音频/OLE，不能证明运动、声音、口型或转场效果。",
        f"- 中文渲染：`cjkRenderVerified={str(result['word']['cjkRenderVerified']).lower()}`；LibreOffice 的 CJK 缺字使中文字形、换行和像素级排版不可验。",
        "- OOXML 坐标：",
        "",
    ]
    for item in result["word"]["evidence"]:
        lines.append(f"  - sourceIndex `{item.get('sourceIndex')}` / tableIndex `{item.get('tableIndex')}` / type `{item.get('type')}` / terms `{','.join(item.get('matchedTerms', []))}`")
    lines += [
        "",
        "## 相似成功案例",
        "",
    ]
    for row in result["cases"]["success"]:
        lines.append(f"- `{row['nodeId']}`：{row.get('reusableRule') or row.get('success') or row.get('chapter')}")
    lines += ["", "## 失败或高风险案例", ""]
    if result["cases"]["risk"]:
        for row in result["cases"]["risk"]:
            lines.append(f"- `{row['nodeId']}`：{row.get('risk')}")
    else:
        lines.append("- 未找到可明确归因的同类失败节点；已记录为证据缺口，不能解释为稳定成功。")
    lines += [
        "",
        "## 剧情语义人工检查",
        "",
        f"- 状态：**{result['semantic']['status']}**",
        f"- 说明：{result['semantic']['note']}",
        "",
        "## 修订与剩余边界",
        "",
    ]
    for item in result["notes"]:
        lines.append(f"- {item}")
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    manifest = json.loads(DUAL_MANIFEST.read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", type=Path)
    parser.add_argument("--operation", choices=sorted(manifest["operations"]), required=True)
    parser.add_argument("--mode", choices=("standard", "ultra", "extend", "edit", "white_model", "storyboard"), required=True)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--online-outline", type=Path, required=True)
    parser.add_argument("--online-blocks", type=Path, required=True)
    parser.add_argument("--word-docx", type=Path, required=True)
    parser.add_argument("--word-text", type=Path, required=True)
    parser.add_argument("--word-report", type=Path, required=True)
    parser.add_argument("--word-source-order", type=Path, required=True)
    parser.add_argument("--word-tables", type=Path, required=True)
    parser.add_argument("--semantic-status", choices=("PASS", "FAIL", "PENDING"), default="PENDING")
    parser.add_argument("--semantic-note", default="尚未完成 Agent 人工剧情语义核验。")
    parser.add_argument("--max-online-age-days", type=int, default=7)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--report-json", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dual = json.loads(DUAL_MANIFEST.read_text(encoding="utf-8"))
    coverage = json.loads(COVERAGE_CONTRACT.read_text(encoding="utf-8"))
    operation = dual["operations"][args.operation]
    errors: list[str] = []
    notes: list[str] = []

    prompt_text = args.prompt.read_text(encoding="utf-8")
    prompt_sha = sha256_file(args.prompt)
    prompt_validator = load_prompt_validator()
    structural = prompt_validator.validate(prompt_text, args.mode, args.duration)
    if not structural["pass"]:
        errors.append("prompt structural validator failed")

    sections = contract_sections(CONTRACT_MANUAL.read_text(encoding="utf-8"))
    section = sections.get(operation["contract"], "")
    facet_labels = coverage["facetLabels"]
    missing_facets = [name for name in coverage["requiredFacets"] if facet_labels[name] not in section]
    if missing_facets:
        errors.append("operation contract missing facets: " + ",".join(missing_facets))

    outline = json.loads(args.online_outline.read_text(encoding="utf-8"))
    blocks = json.loads(args.online_blocks.read_text(encoding="utf-8"))
    guarantee_phrases = ("100%", "百分之百", "必定成功", "一定成功", "绝对不会", "完全不被修改", "无损保证")
    guarantee_hits = [phrase for phrase in guarantee_phrases if phrase in prompt_text]
    if guarantee_hits:
        errors.append("unsupported output guarantee: " + ",".join(guarantee_hits))
    copy_hits = long_official_copy_hits(prompt_text, blocks)
    if copy_hits:
        errors.append(f"long official prompt copy detected: {len(copy_hits)} hit(s)")
    online_baseline = dual["online"]["baselineFiles"]
    word_baseline = dual["word"]["baselineFiles"]
    integrity = {
        "onlineBlocks": sha256_file(args.online_blocks) == online_baseline["officialBlocks"]["sha256"],
        "onlineOutline": sha256_file(args.online_outline) == online_baseline["outline"]["sha256"],
        "promptCatalog": sha256_file(PROMPT_CATALOG) == online_baseline["promptCatalog"]["sha256"],
        "imageCatalog": sha256_file(IMAGE_CATALOG) == online_baseline["imageCatalog"]["sha256"],
        "videoCatalog": sha256_file(VIDEO_CATALOG) == online_baseline["videoCatalog"]["sha256"],
        "wordAuditReport": sha256_file(args.word_report) == word_baseline["auditReport"]["sha256"],
        "wordFullText": sha256_file(args.word_text) == word_baseline["fullText"]["sha256"],
        "wordSourceOrder": sha256_file(args.word_source_order) == word_baseline["sourceOrder"]["sha256"],
        "wordTables": sha256_file(args.word_tables) == word_baseline["tables"]["sha256"],
    }
    failed_integrity = [name for name, passed in integrity.items() if not passed]
    if failed_integrity:
        errors.append("source fingerprint mismatch: " + ",".join(failed_integrity))
    source_order_rows = tsv_data_rows(args.word_source_order)
    table_rows = tsv_data_rows(args.word_tables)
    if len(source_order_rows) != word_baseline["sourceOrder"]["dataRows"]:
        errors.append(f"Word source-order row mismatch: {len(source_order_rows)}")
    if len(table_rows) != word_baseline["tables"]["dataRows"]:
        errors.append(f"Word table row mismatch: {len(table_rows)}")
    outline_by_id = {row.get("id"): row for row in outline}
    missing_outline = [item for item in operation["outlineIds"] if item not in outline_by_id]
    if len(outline) != dual["online"]["outlineItems"]:
        errors.append(f"online outline count mismatch: {len(outline)}")
    if len(blocks) != dual["online"]["officialLeafRecords"]:
        errors.append(f"online block count mismatch: {len(blocks)}")
    if missing_outline:
        errors.append("online outline IDs missing: " + ",".join(missing_outline))
    block_section_ids = {section_id for row in blocks for section_id in row.get("sectionIds", [])}
    missing_block_evidence = [item for item in operation["outlineIds"] if item not in block_section_ids]
    if missing_block_evidence:
        errors.append("online blocks missing bound section evidence: " + ",".join(missing_block_evidence))

    snapshot = date.fromisoformat(dual["online"]["snapshotDate"])
    freshness_days = (date.today() - snapshot).days
    freshness_status = "PASS" if freshness_days <= args.max_online_age_days else "STALE"
    if freshness_status != "PASS":
        errors.append(f"online snapshot stale: {freshness_days} days")

    actual_word_sha = sha256_file(args.word_docx)
    expected_word_sha = dual["word"]["sha256"]
    if actual_word_sha != expected_word_sha:
        errors.append("Word DOCX SHA mismatch")
    word_text = args.word_text.read_text(encoding="utf-8")
    word_report_text = args.word_report.read_text(encoding="utf-8")
    if expected_word_sha not in word_report_text:
        errors.append("Word audit report does not bind expected SHA")
    matched_terms = [term for term in operation["wordTerms"] if term.lower() in word_text.lower()]
    word_evidence = word_term_evidence([args.word_source_order, args.word_tables], operation["wordTerms"])
    if len(matched_terms) == len(operation["wordTerms"]):
        word_crosscheck = "CORROBORATED"
    elif matched_terms:
        word_crosscheck = "PARTIAL"
    else:
        word_crosscheck = "NOT_FOUND"
        notes.append("Word 未命中当前 operation 关键词；这不否定在线能力，但需保留导出缺失说明。")
    dynamic_status = operation.get("wordDynamicStatus", "NOT_PROVABLE_FROM_WORD")

    cases = load_jsonl(VIDEO_CATALOG)
    image_cases = load_jsonl(IMAGE_CATALOG)
    prompt_cases = load_jsonl(PROMPT_CATALOG)
    if len(cases) != online_baseline["videoCatalog"]["records"]:
        errors.append(f"video catalog count mismatch: {len(cases)}")
    if len(image_cases) != online_baseline["imageCatalog"]["records"]:
        errors.append(f"image catalog count mismatch: {len(image_cases)}")
    if len(prompt_cases) != online_baseline["promptCatalog"]["records"]:
        errors.append(f"prompt catalog count mismatch: {len(prompt_cases)}")
    successes, risks = select_cases(cases, operation["caseTerms"])
    if not successes:
        errors.append("no comparable online success structure found")
    if not risks:
        notes.append("未找到可明确归因的同类失败节点；不能据此推断稳定成功。")

    semantic_ok = args.semantic_status == "PASS"
    if args.semantic_status == "FAIL":
        errors.append("semantic audit failed")
    if args.semantic_status == "PENDING":
        notes.append("机器检查不能替代剧情、对白、关系变化和反转的人工语义检查。")

    machine_pass = not errors
    if not machine_pass or args.semantic_status == "FAIL":
        final_status = "VERIFIED_FAIL"
    elif semantic_ok:
        final_status = "VERIFIED_PASS"
    else:
        final_status = "MACHINE_PASS_HUMAN_PENDING"

    duration_needle = f"{int(args.duration)}秒" if args.duration is not None and args.duration.is_integer() else str(args.duration or "")
    online_evidence = []
    for outline_id in operation["outlineIds"]:
        candidates = [row for row in blocks if outline_id in row.get("sectionIds", [])]
        selected = select_online_evidence(candidates, operation["wordTerms"] + operation["caseTerms"], duration_needle)
        for row in selected:
            text_value = str(row.get("text", ""))
            online_evidence.append(
                {
                    "outlineId": outline_id,
                    "recordId": row.get("recordId"),
                    "sourceOrder": row.get("sourceOrder"),
                    "sectionPath": row.get("sectionPath"),
                    "blockType": row.get("type"),
                    "textSha256": hashlib.sha256(text_value.encode("utf-8")).hexdigest(),
                }
            )
    claims = [
        {
            "claimId": "C01",
            "claimOrigin": "official_capability",
            "claimType": "capability",
            "modality": "dynamic_timing",
            "statementStrength": "fact",
            "freshnessClass": "volatile",
            "promptSpan": prompt_span(prompt_text, duration_needle) if duration_needle else None,
            "onlineStatus": "MATCH" if online_evidence else "MISSING",
            "onlineEvidence": online_evidence,
            "wordStatus": word_crosscheck,
            "wordEvidence": word_evidence,
            "resolution": "AGREE" if matched_terms else "ONLINE_ONLY",
            "limitations": ["Word cannot prove dynamic timing or generated motion"],
            "postGenerationAcceptance": ["verify actual duration", "verify timeline beats", "inspect final frame", "listen to dialogue and lip sync"],
            "decision": "PASS" if online_evidence else "FAIL",
        },
        {
            "claimId": "C02",
            "claimOrigin": "creative_choice",
            "claimType": "creative",
            "modality": "text",
            "statementStrength": "target",
            "freshnessClass": "stable",
            "promptSpan": None,
            "onlineStatus": "NOT_APPLICABLE",
            "onlineEvidence": [],
            "wordStatus": "NOT_APPLICABLE",
            "wordEvidence": [],
            "resolution": "NOT_APPLICABLE",
            "limitations": ["Creative plot is validated against the user brief and semantic audit, not the manuals"],
            "postGenerationAcceptance": ["verify conflict, relationship change and ending reversal"],
            "decision": "PASS" if semantic_ok else "FAIL",
        },
    ]

    result = {
        "finalStatus": final_status,
        "verifiedAt": datetime.now().astimezone().isoformat(),
        "operation": args.operation,
        "mode": args.mode,
        "duration": args.duration,
        "prompt": {"path": str(args.prompt.resolve()), "sha256": prompt_sha},
        "checks": {
            "结构硬门": "PASS" if structural["pass"] else "FAIL",
            "十四字段合同": "PASS" if not missing_facets else "FAIL",
            "在线官方一致性": "PASS" if not (missing_outline or missing_block_evidence) else "FAIL",
            "Word源文件完整性": "PASS" if actual_word_sha == expected_word_sha else "FAIL",
            "Word文字交叉": word_crosscheck,
            "剧情语义": args.semantic_status,
            "证据文件指纹": "PASS" if not failed_integrity else "FAIL",
            "无输出保证": "PASS" if not guarantee_hits else "FAIL",
            "无官方长提示词复制": "PASS" if not copy_hits else "FAIL",
        },
        "structural": structural,
        "contract": {"anchor": operation["contract"], "missingFacets": missing_facets},
        "online": {
            "snapshotDate": dual["online"]["snapshotDate"],
            "outlineCount": len(outline),
            "blockCount": len(blocks),
            "outlineIds": operation["outlineIds"],
            "outlineTitles": [outline_by_id[item]["text"] for item in operation["outlineIds"] if item in outline_by_id],
            "freshnessDays": freshness_days,
            "freshnessStatus": freshness_status,
            "blocksSha256": sha256_file(args.online_blocks),
            "outlineSha256": sha256_file(args.online_outline),
            "catalogCounts": {"prompt": len(prompt_cases), "image": len(image_cases), "video": len(cases)},
            "commentsExcluded": True,
        },
        "word": {
            "path": str(args.word_docx.resolve()),
            "expectedSha256": expected_word_sha,
            "actualSha256": actual_word_sha,
            "matchedTerms": matched_terms,
            "crosscheckStatus": word_crosscheck,
            "dynamicEvidenceStatus": dynamic_status,
            "sourceOrderRows": len(source_order_rows),
            "tableRows": len(table_rows),
            "embeddedVideo": 0,
            "embeddedAudio": 0,
            "cjkRenderVerified": False,
            "evidence": word_evidence,
        },
        "cases": {
            "success": [case_summary(row) for row in successes],
            "risk": [case_summary(row) for row in risks],
        },
        "semantic": {"status": args.semantic_status, "note": args.semantic_note},
        "claims": claims,
        "guaranteeHits": guarantee_hits,
        "longOfficialCopyHits": copy_hits,
        "sourceIntegrity": integrity,
        "mandatoryLimitations": {
            "wordCannotProveVideo": True,
            "wordCannotProveAudio": True,
            "wordCannotProveDynamicBehavior": True,
            "wordCannotProveChineseRendering": True,
        },
        "errors": errors,
        "notes": notes,
    }

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(markdown_report(result), encoding="utf-8")
    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(final_status)
        for key, value in result["checks"].items():
            print(f"{key}={value}")
        for error in errors:
            print(f"ERROR: {error}")
    return 0 if final_status in {"VERIFIED_PASS", "MACHINE_PASS_HUMAN_PENDING"} else 1


if __name__ == "__main__":
    sys.exit(main())
