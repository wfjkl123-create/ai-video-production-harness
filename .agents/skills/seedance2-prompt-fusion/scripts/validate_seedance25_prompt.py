#!/usr/bin/env python3
"""Lightweight structural validator for Seedance 2.5 Chinese prompts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path


TIME_RANGE_PATTERNS = (
    re.compile(r"(?<!\d)(\d{1,3}(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—~至]\s*(\d{1,3}(?:\.\d+)?)\s*(?:s|秒)"),
    re.compile(r"\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-–—~至]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\]?"),
)

UNRESOLVED_REFERENCES = (
    "如上",
    "上述",
    "前述",
    "沿用前面",
    "沿用此前",
    "参考前面",
    "参考上一个",
    "同上",
)


@dataclass
class Finding:
    level: str
    code: str
    message: str


def _clock_to_seconds(h_or_m: str, m_or_s: str, s: str | None) -> float:
    if s is None:
        return int(h_or_m) * 60 + int(m_or_s)
    return int(h_or_m) * 3600 + int(m_or_s) * 60 + int(s)


def extract_ranges(text: str) -> list[tuple[float, float]]:
    ranges: list[tuple[float, float]] = []
    for match in TIME_RANGE_PATTERNS[0].finditer(text):
        ranges.append((float(match.group(1)), float(match.group(2))))
    for match in TIME_RANGE_PATTERNS[1].finditer(text):
        start = _clock_to_seconds(match.group(1), match.group(2), match.group(3))
        end = _clock_to_seconds(match.group(4), match.group(5), match.group(6))
        ranges.append((start, end))
    return sorted(set(ranges))


def validate(text: str, mode: str, duration: float | None) -> dict:
    findings: list[Finding] = []
    ranges = extract_ranges(text)

    if not text.strip():
        findings.append(Finding("error", "EMPTY", "提示词为空。"))

    for phrase in UNRESOLVED_REFERENCES:
        if phrase in text:
            findings.append(
                Finding("error", "UNRESOLVED_CONTEXT", f"发现依赖外部上下文的指代：{phrase}")
            )

    if mode == "standard" and duration is not None and not (4 <= duration <= 30):
        findings.append(Finding("error", "STANDARD_DURATION", "普通 2.5 生成时长应在 4–30 秒。"))
    if mode == "ultra" and duration is not None and not (30 <= duration <= 180):
        findings.append(Finding("error", "ULTRA_DURATION", "超长模式时长应在 30–180 秒。"))
    if mode == "extend" and duration is not None and not (4 <= duration <= 30):
        findings.append(Finding("error", "EXTEND_DURATION", "单次新增时长应在 4–30 秒。"))

    if mode in {"standard", "ultra", "storyboard"} and duration is not None and duration > 15 and not ranges:
        findings.append(Finding("error", "MISSING_TIMELINE", "长视频缺少可解析的时间戳区间。"))

    if ranges:
        for start, end in ranges:
            if end <= start:
                findings.append(Finding("error", "INVALID_RANGE", f"无效区间：{start:g}-{end:g}s"))
        ordered = sorted(ranges)
        require_zero_start = mode not in {"edit", "extend"}
        if require_zero_start and ordered[0][0] != 0:
            findings.append(Finding("error", "TIMELINE_START", "时间轴未从 0 秒开始。"))
        for (_, prev_end), (next_start, _) in zip(ordered, ordered[1:]):
            if abs(prev_end - next_start) > 1e-6:
                relation = "缺口" if next_start > prev_end else "重叠"
                findings.append(
                    Finding("error", "TIMELINE_GAP", f"时间轴{relation}：{prev_end:g}s → {next_start:g}s")
                )
        if require_zero_start and duration is not None and abs(ordered[-1][1] - duration) > 1e-6:
            findings.append(
                Finding(
                    "error",
                    "TIMELINE_END",
                    f"时间轴结束于 {ordered[-1][1]:g}s，与请求 {duration:g}s 不一致。",
                )
            )

    media_markers = re.findall(r"@(?:图|图片|视频|音频)\s*\d+|@素材\[[^\]\n]+\]", text)
    if media_markers and not re.search(r"负责|只负责|仅负责|用于|保持.*一致|参考.*(?:身份|动作|场景|音色)", text):
        findings.append(Finding("warning", "MEDIA_ROLE", "引用了素材，但未清楚声明素材职责。"))

    if mode == "extend" and not re.search(r"末尾|终态|继承|保持.*一致|衔接", text):
        findings.append(Finding("error", "EXTEND_HANDOFF", "延长提示词没有明确继承原视频末尾状态。"))
    if mode == "extend":
        ambiguous_extension_terms = ("向前续写", "前向续写", "往前延长", "向后续写", "后向续写")
        if any(term in text for term in ambiguous_extension_terms):
            findings.append(Finding("error", "EXTEND_DIRECTION_AMBIGUOUS", "延长方向必须写成相对原片末帧的明确尾接边界。"))
        if not re.search(r"末帧之后|尾部新增|追加.*(?:末帧|原片之后)|接在.*末(?:帧|尾)", text):
            findings.append(Finding("error", "EXTEND_BOUNDARY", "延长提示词必须明确新增段接在原片末帧之后。"))
    if mode == "edit" and not re.search(r"保留|保持.*不变|不修改", text):
        findings.append(Finding("error", "EDIT_PRESERVE", "编辑提示词缺少未修改项/保留项。"))
    if mode == "white_model" and not re.search(r"白模.*(?:动作|运镜|空间|站位)|(?:动作|运镜|空间|站位).*白模", text):
        findings.append(Finding("error", "WHITE_MODEL_ROLE", "未声明白模负责动作、空间或摄影机。"))
    if mode == "storyboard" and not re.search(r"每格.*镜头|一格一镜|阅读顺序|左上.*右下", text):
        findings.append(Finding("error", "STORYBOARD_ORDER", "未声明宫格阅读顺序或一格一镜。"))

    if duration is not None and duration >= 20:
        if not re.search(r"全局|贯穿|始终保持|全片", text):
            findings.append(Finding("warning", "GLOBAL_LOCK", "长视频没有明显的全局一致性约束。"))
        if not re.search(r"禁止|不要|无字幕|无水印", text):
            findings.append(Finding("warning", "NEGATIVE", "长视频没有针对性禁止项。"))

    errors = [item for item in findings if item.level == "error"]
    return {
        "pass": not errors,
        "mode": mode,
        "duration": duration,
        "timelineRanges": ranges,
        "findings": [asdict(item) for item in findings],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", type=Path, help="UTF-8 提示词文本文件")
    parser.add_argument(
        "--mode",
        choices=("standard", "ultra", "extend", "edit", "white_model", "storyboard"),
        default="standard",
    )
    parser.add_argument("--duration", type=float)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    text = args.prompt.read_text(encoding="utf-8")
    result = validate(text, args.mode, args.duration)
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("PASS" if result["pass"] else "FAIL")
        for item in result["findings"]:
            print(f"[{item['level'].upper()}] {item['code']}: {item['message']}")
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
