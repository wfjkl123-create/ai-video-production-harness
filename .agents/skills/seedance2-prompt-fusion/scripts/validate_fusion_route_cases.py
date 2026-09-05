#!/usr/bin/env python3
"""Regression checks for the canonical Seedance fusion decision routes."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")
FUSION = (ROOT / "references" / "27_Seedance20_v67全量融合与冲突路由.md").read_text(
    encoding="utf-8"
)
PERFORMANCE = (ROOT / "references" / "28_融合后的活人感与表演系统.md").read_text(
    encoding="utf-8"
)
PERFORMANCE_GATE = (ROOT / "references" / "39_叙事表演语义硬门.md").read_text(
    encoding="utf-8"
)
LEGACY_PERFORMANCE = (ROOT / "references" / "02_镜头光影表演活人感词库.md").read_text(
    encoding="utf-8"
)
MATERIAL_COMPILER = (ROOT / "references" / "05_素材编译与电影化质感.md").read_text(
    encoding="utf-8"
)
FUSION_DOCS = {
    number: (ROOT / "references" / filename).read_text(encoding="utf-8")
    for number, filename in {
        29: "29_融合后的需求访谈与提示词编译系统.md",
        30: "30_融合后的导演预演与故事系统.md",
        31: "31_融合后的摄影光影色彩与风格系统.md",
        32: "32_融合后的动作物理产品与特效系统.md",
        33: "33_融合后的声音对白音乐与同步系统.md",
        34: "34_融合后的素材权威角色身份与多模态系统.md",
        35: "35_融合后的多段连续性延长与分镜系统.md",
        36: "36_融合后的去AI味失败诊断与返工系统.md",
        37: "37_融合后的专业制作后期交付与质量系统.md",
        38: "38_融合后的多语言版权安全与证据系统.md",
        40: "40_Higgsfield空间光学可行性路由.md",
        41: "41_镜头任务_FOV_可读性矩阵.md",
        42: "42_机位物理化与首帧调度.md",
        43: "43_创意镜头装置翻译与失败修复.md",
    }.items()
}


CASES = {
    "narrative_live_performance": [
        (SKILL, "narrative 任务把 ref 01 的导演预演与 v6.7 Director's Read 合并执行"),
        (SKILL, "references/28_融合后的活人感与表演系统.md"),
        (PERFORMANCE, "原本在做的事 → 外部触发 → 注意力改变"),
        (PERFORMANCE, "恢复与末态"),
        (SKILL, "叙事表演语义硬门（人物、对白或关系变化时强制）"),
        (PERFORMANCE_GATE, "每个关键节拍的七段可见链"),
        (PERFORMANCE_GATE, "自动硬门"),
        (PERFORMANCE_GATE, "人工逐拍预演门"),
    ],
    "non_narrative_product": [
        (SKILL, "non_narrative 任务只保留具体用途"),
        (FUSION, "不为了填字段制造人物心理"),
        (FUSION, "产品身份与变化解耦"),
    ],
    "reference_authority": [
        (SKILL, "每个受控维度只能有一个权威来源"),
        (FUSION, "允许迁移与禁止迁移"),
        (FUSION, "@素材[exact-id]"),
        (FUSION, "写作者不得自行改号"),
    ],
    "sequence_continuation": [
        (SKILL, "真实观察状态覆盖计划状态"),
        (FUSION, "project/scene/clip lineage"),
        (FUSION, "this_clip_only"),
        (FUSION, "canonical 资产重锚定"),
    ],
    "version_isolation": [
        (SKILL, "Seedance 2.5 强制加载矩阵"),
        (FUSION, "它的时长、模型名、素材上限、端点和 UI 数字只属于 2.0"),
        (FUSION, "2.5 一律由 refs 11–25"),
    ],
    "production_boundary": [
        (FUSION, "提示词结构通过只代表“可提交草稿”"),
        (FUSION, "文件存在、lint PASS 和投放可用不是同一状态"),
        (SKILL, "结构检查"),
        (SKILL, "语义自检"),
    ],
    "wish_to_executable_task": [
        (FUSION_DOCS[29], "用户愿望 → 识别已锁事实与真实未知"),
        (FUSION_DOCS[29], "八要素用于检查完整性"),
        (FUSION_DOCS[29], "内部合同与模型正文分离"),
    ],
    "director_story_synthesis": [
        (FUSION_DOCS[30], "统一导演预演记录"),
        (FUSION_DOCS[30], "一句意图统领完整设置"),
        (FUSION_DOCS[30], "项目声音与戏剧弧线"),
    ],
    "cinematography_style_synthesis": [
        (FUSION_DOCS[31], "一个 Shot 只留一个主运镜"),
        (FUSION_DOCS[31], "光是有来源的空间事件"),
        (FUSION_DOCS[31], "生成意图与后期技术要求"),
    ],
    "spatial_optics_route": [
        (SKILL, "references/40_Higgsfield空间光学可行性路由.md"),
        (FUSION, "Higgsfield 启发式与 Seedance 能力"),
        (FUSION_DOCS[40], "不是独立 Skill、主系统提示词或第二个提示词作者"),
        (FUSION_DOCS[40], "必须向用户或审核门暴露的实质变化"),
    ],
    "shot_job_readability": [
        (FUSION_DOCS[41], "每个 Shot 只选一个主要 `shotJob`"),
        (FUSION_DOCS[41], "FOV 只是一层启发式"),
        (FUSION_DOCS[41], "rigEnvelope + dynamicIntrusionMargin <= pathMinClearance"),
    ],
    "camera_pose_first_frame": [
        (FUSION_DOCS[42], "机位五元组"),
        (FUSION_DOCS[42], "朝向、视线与相机侧别分离"),
        (FUSION_DOCS[42], "首帧不是统一模板"),
    ],
    "creative_device_translation": [
        (FUSION_DOCS[43], "装置翻译合同"),
        (FUSION_DOCS[43], "单主装置纪律"),
        (FUSION_DOCS[43], "180-degree shutter"),
    ],
    "motion_product_vfx_synthesis": [
        (FUSION_DOCS[32], "初始状态 → 触发/力源"),
        (FUSION_DOCS[32], "产品是稳定主体"),
        (FUSION_DOCS[32], "特效必须进入世界"),
    ],
    "audio_sync_synthesis": [
        (FUSION_DOCS[33], "人物图负责身份"),
        (FUSION_DOCS[33], "先实际试读再分配时码"),
        (FUSION_DOCS[33], "生成与后期边界"),
    ],
    "multimodal_authority_synthesis": [
        (FUSION_DOCS[34], "每个受控维度只有一个权威来源"),
        (FUSION_DOCS[34], "允许迁移"),
        (FUSION_DOCS[34], "canonical 身份与瞬时状态分离"),
    ],
    "sequence_synthesis": [
        (FUSION_DOCS[35], "三层状态模型"),
        (FUSION_DOCS[35], "观察状态覆盖原计划的瞬时态"),
        (FUSION_DOCS[35], "canonical 资产"),
    ],
    "diagnosis_retake_synthesis": [
        (FUSION_DOCS[36], "先分类失败"),
        (FUSION_DOCS[36], "最低成本返工阶梯"),
        (FUSION_DOCS[36], "每次 retake 只改变一个主要变量"),
    ],
    "production_delivery_synthesis": [
        (FUSION_DOCS[37], "阶段不能混称"),
        (FUSION_DOCS[37], "分层 QC"),
        (FUSION_DOCS[37], "prompt lint 或合同覆盖率通过"),
    ],
    "language_rights_evidence_synthesis": [
        (FUSION_DOCS[38], "多语言以语义保真为首要目标"),
        (FUSION_DOCS[38], "创意阶段与真实使用阶段分层"),
        (FUSION_DOCS[38], "证据分级与版本隔离"),
    ],
    "cue_driven_liveness_without_quotas": [
        (PERFORMANCE, "全员持续无空档"),
        (PERFORMANCE, "主动静止"),
        (LEGACY_PERFORMANCE, "禁止“每个拍点至少一个微动作”这类计数规则"),
        (MATERIAL_COMPILER, "不固定数量、不均匀散布"),
    ],
}


def main() -> int:
    missing: list[str] = []
    for case, checks in CASES.items():
        for document, marker in checks:
            if marker not in document:
                missing.append(f"{case}: {marker}")
    forbidden = {
        "legacy default everyone continuous motion": "① 持续微动作层（默认全员）" in LEGACY_PERFORMANCE,
        "fixed 3-4 Hold microactions": "全片散布 3-4 个自然微动作" in MATERIAL_COMPILER,
    }
    missing.extend(f"forbidden: {label}" for label, present in forbidden.items() if present)
    if missing:
        print("FAIL")
        for item in missing:
            print(f"- {item}")
        return 1
    print(f"PASS: {len(CASES)}/{len(CASES)} fusion route cases are fully represented.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
