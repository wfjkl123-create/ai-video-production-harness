#!/usr/bin/env python3
"""Minimum semantic gate for dialogue and lived-in human performance prompts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path


TIME_RANGE_RE = re.compile(r"(?:^|[\n。；])\s*\[?(?P<start>\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-—–~至到]\s*(?P<end>\d+(?:\.\d+)?)\s*(?:s|秒)", re.I | re.M)
QUOTE_RE = re.compile(r"[“\"]([^”\"]{2,240})[”\"]")
ABSTRACT = ("紧张", "尴尬", "被戳中", "自然", "克制", "松弛", "犹豫", "开心", "震惊", "难过", "不安")
TRIGGER = ("听见", "看到", "看见", "当", "说到", "话音", "触到", "因为", "这句话", "问完", "产品出现", "举起")
ATTENTION = ("视线", "眼睛", "看向", "目光", "头晚", "转头", "没有看", "不看镜头")
BODY = ("呼吸", "鼻息", "吞咽", "手指", "拇指", "下颌", "肩", "嘴角", "嘴唇", "气口", "停住", "停半拍", "松开", "收住", "压住", "身体", "上身", "眉")
CHOICE = ("才", "没有立刻", "仍", "继续", "忍住", "收住", "选择", "回答", "反问", "开口", "不接话", "靠近", "移开")
FEEDBACK = ("听者", "对方", "她听见", "回应", "反馈", "衣料", "布料", "包带", "背景", "路人", "车流", "镜头", "肩带")
END_STATE = ("末态", "收尾", "停在", "保持", "留下", "余波", "仍看", "最后", "结束", "稳住", "没有定格")
SPEECH = ("说", "问", "回答", "开口", "反问", "低声", "音量", "声线", "气口", "原音频")
LISTENER = ("听者", "对方", "另一人", "试穿者", "推荐者", "朋友", "她听见", "同时")
NEGATIVE_MARKERS = ("不要", "禁止", "不得", "无字幕", "无文字", "无水印", "不看镜头", "不能", "避免")
TRIGGER_CLOCK_RE = re.compile(r"(?:之前|直到|听(?:见|到).{0,18}(?:时|后|才)|说(?:到|出).{0,18}(?:时|后|才)|话音.{0,12}(?:时|后|才)|(?:放下|推到|接触|响起).{0,12}(?:时|后|才))")
FACS_AU_RE = re.compile(r"(?<![A-Za-z0-9_])(?:FACS|AU(?:\s*0?\d{1,2}(?:[A-E])?)?|Action\s+Units?)(?![A-Za-z0-9_])", re.I)
MODEL_FACING_GOVERNANCE_BLOCK_RE = re.compile(
    r"【(?P<block_type>performance-continuity-v1|director-constraints-v1)｜"
    r"(?P<shot_id>[^｜\n】]+)(?:｜[^\n】]+)*】[\s\S]*?"
    r"【/(?P=block_type)｜(?P=shot_id)】"
)
GOVERNANCE_LABEL_RE = re.compile(r"【/?(?:performance-continuity-v1|director-constraints-v1)｜[^\n】]+】")


@dataclass
class Finding:
    code: str
    severity: str
    message: str


def contains_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


def parse_ranges(text: str) -> list[tuple[float, float]]:
    return [(float(m.group("start")), float(m.group("end"))) for m in TIME_RANGE_RE.finditer(text)]


def without_governance_blocks(text: str) -> str:
    """Remove compiler-required control blocks from semantic prose counting.

    The blocks remain model-facing continuity constraints, but their labels,
    quoted emphasis anchors, and repeated prohibitions are not additional
    dialogue turns or free-form negative prompting.
    """
    return MODEL_FACING_GOVERNANCE_BLOCK_RE.sub("", text)


def validate(text: str, profile: str, duration: float | None) -> dict[str, object]:
    findings: list[Finding] = []
    semantic_text = without_governance_blocks(text)
    if GOVERNANCE_LABEL_RE.search(semantic_text):
        findings.append(Finding(
            "MALFORMED_GOVERNANCE_BLOCK",
            "error",
            "director/performance governance blocks must close with the same block type and Shot ID.",
        ))
    range_matches = list(TIME_RANGE_RE.finditer(text))
    ranges = [(float(match.group("start")), float(match.group("end"))) for match in range_matches]
    quotes = []
    for match in QUOTE_RE.finditer(semantic_text):
        before = semantic_text[max(0, match.start() - 30):match.start()]
        if contains_any(before, SPEECH) or match.group(1).rstrip().endswith(("。", "！", "？", ".", "!", "?")):
            quotes.append(match)

    if profile == "dialogue" and not quotes:
        findings.append(Finding("MISSING_DIALOGUE", "error", "dialogue profile requires at least one timecoded spoken line in quotation marks."))
    if profile == "dialogue" and (len(ranges) < 3 or not ranges or ranges[0][0] > 0.05):
        findings.append(Finding("MISSING_PERFORMANCE_TIMELINE", "error", "对白/关系镜头需要从 0 秒开始且至少三个连续表演时段。"))
    if profile == "dialogue" and quotes and not TRIGGER_CLOCK_RE.search(text):
        findings.append(Finding("MISSING_DIALOGUE_TRIGGER_CLOCK", "error", "关键对白缺少可验证的触发词/动作与听者反应时点；必须说明听到什么之后才反应，或在什么之前禁止反应。"))
    if FACS_AU_RE.search(text):
        findings.append(Finding("FACS_AU_IN_MODEL_PROMPT", "error", "FACS/AU 只能留在导演审计记录；模型提示词必须改写为可见的自然语言面部变化。"))

    if ranges:
        for start, end in ranges:
            if end <= start:
                findings.append(Finding("INVALID_TIME_RANGE", "error", f"时间段 {start:g}-{end:g}s 必须满足 end > start。"))
        for previous, current in zip(ranges, ranges[1:]):
            if current[0] < previous[0] or current[0] < previous[1] - 0.01:
                findings.append(Finding("TIMELINE_OUT_OF_ORDER", "error", f"时间段 {current[0]:g}-{current[1]:g}s 在正文中乱序或与上一段重叠。"))
                break
            if current[0] - previous[1] > 0.35:
                findings.append(Finding("TIMELINE_GAP", "error", f"时间轴在 {previous[1]:g}s 到 {current[0]:g}s 之间存在大空洞。"))
                break
        if duration is not None and abs(max(end for _, end in ranges) - duration) > 0.2:
            findings.append(Finding("DURATION_NOT_COVERED", "error", f"时间轴末端未覆盖声明总时长 {duration:g}s。"))
        if profile == "dialogue" and any(quote.start() < range_matches[0].start() for quote in quotes):
            findings.append(Finding("DIALOGUE_OUTSIDE_TIMELINE", "error", "对白出现在首个表演时码之前，未绑定到可执行时间段。"))

    chain_groups = {
        "MISSING_TRIGGER": TRIGGER,
        "MISSING_ATTENTION_SHIFT": ATTENTION,
        "MISSING_BODY_LEAK": BODY,
        "MISSING_ACTIVE_CHOICE": CHOICE,
        "MISSING_COUNTERPART_FEEDBACK": FEEDBACK,
        "MISSING_END_STATE": END_STATE,
    }
    for code, terms in chain_groups.items():
        if not contains_any(text, terms):
            findings.append(Finding(code, "error", f"缺少可见表演链证据：{code}。"))

    for term in ABSTRACT:
        for match in re.finditer(re.escape(term), text):
            window = text[max(0, match.start() - 90): min(len(text), match.end() + 120)]
            if not contains_any(window, BODY):
                findings.append(Finding("ABSTRACT_EMOTION_WITHOUT_CARRIER", "error", f"抽象情绪“{term}”附近没有可见身体载体。"))
                break

    for quote in quotes:
        before = semantic_text[max(0, quote.start() - 180):quote.start()]
        after = semantic_text[quote.end():min(len(semantic_text), quote.end() + 220)]
        context = before + after
        if not contains_any(before, SPEECH):
            findings.append(Finding("DIALOGUE_WITHOUT_SPEAKER_ACTION", "error", f"台词“{quote.group(1)}”前缺少说话人或开口动作。"))
        if not contains_any(context, ATTENTION):
            findings.append(Finding("DIALOGUE_WITHOUT_GAZE_TARGET", "error", f"台词“{quote.group(1)}”附近缺少明确视线目标。"))
        if not contains_any(after, LISTENER) or not contains_any(after, BODY + ATTENTION + CHOICE):
            findings.append(Finding("DIALOGUE_WITHOUT_LISTENER_REACTION", "error", f"台词“{quote.group(1)}”后缺少听者的同步可见反应。"))

    # “点头像” is purchase-guidance dialogue, not the generic nod action
    # “点头”.  Exclude the lexical continuation so exact ad copy is not
    # forced to change merely to satisfy the performance lint.
    nod_re = r"(?:轻轻|微微)?点头(?!像)"
    if re.search(nod_re, text):
        for match in re.finditer(nod_re, text):
            prefix = text[max(0, match.start() - 6):match.start()]
            if "不" in prefix or "没有" in prefix:
                continue
            window = text[max(0, match.start() - 100):min(len(text), match.end() + 100)]
            if not contains_any(window, TRIGGER) or not contains_any(window, BODY):
                findings.append(Finding("GENERIC_REACTION_ACTION", "error", "点头没有同时绑定触发与身体余波，像通用动作模板。"))
                break

    negative_count = sum(semantic_text.count(term) for term in NEGATIVE_MARKERS)
    if negative_count > 8:
        findings.append(Finding("NEGATIVE_OVERLOAD", "error", f"负面约束出现 {negative_count} 次，超过 8 次；会挤占表演因果。"))

    unique: dict[tuple[str, str], Finding] = {}
    for finding in findings:
        unique[(finding.code, finding.message)] = finding
    final_findings = list(unique.values())
    return {
        "status": "PASS" if not any(item.severity == "error" for item in final_findings) else "FAIL",
        "profile": profile,
        "duration": duration,
        "timeRanges": [{"start": start, "end": end} for start, end in ranges],
        "dialogueCount": len(quotes),
        "findings": [asdict(item) for item in final_findings],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt", type=Path)
    parser.add_argument("--profile", choices=("dialogue", "character-action"), default="dialogue")
    parser.add_argument("--duration", type=float)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    raw = args.prompt.read_bytes()
    text = raw.decode("utf-8")
    report = validate(text, args.profile, args.duration)
    report["promptPath"] = str(args.prompt.resolve())
    report["promptSha256"] = hashlib.sha256(raw).hexdigest()
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    if args.json or not args.report:
        print(encoded)
    else:
        print(f"{report['status']}: {args.prompt} -> {args.report}")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
