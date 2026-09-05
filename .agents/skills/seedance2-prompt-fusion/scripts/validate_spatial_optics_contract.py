#!/usr/bin/env python3
"""Fail-closed validation for Seedance spatial-optics contracts and prompt bodies."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


REQUIRED_TOP = {
    "contractVersion", "surface", "modelVersion", "shotJob", "readabilityTarget",
    "worldMap", "firstFrame", "changeClass", "approvedIntent", "language",
    "promptBody", "claims", "sourceMediaTags", "outputMediaTags",
}
ALLOWED_TOP = REQUIRED_TOP | {
    "customShotJob", "framing", "optics", "riskFlags", "cameraPose", "space",
    "devices", "adjustments", "motion",
}
SHOT_JOBS = {
    "geography", "relationship", "microacting", "product_detail", "action_impact",
    "reveal", "camera_device", "atmosphere", "suspense", "transformation", "hook", "custom",
}
TRUSTED_EXACT_EVIDENCE = {"official_parameter_contract", "current_runtime_verified", "user_supplied"}
PROTECTED_EMPTY_MODES = {"intentional_empty", "entrance", "reveal", "pov_recovery", "device_setup"}
HIGH_RISK_FLAGS = {"strong_angle", "confined_space", "moving_camera", "complex_blocking"}
MOVING_DEVICES = {"dolly_zoom", "dolly zoom", "whip_pan", "whip pan", "甩镜", "orbit", "tracking"}
DUTCH_NAMES = {"dutch_angle", "dutch angle", "荷兰角"}
GUARANTEE_RE = re.compile(r"(?:100\s*%|百分之百|像素级(?:一致|还原|复刻)|绝对(?:一致|锁定|还原)|perfect\s+match|pixel[- ]perfect)", re.I)
INTERNAL_LABEL_RE = re.compile(r"(?:FOV[-_\s]*solver|feasibility[-_\s]*veto|world[-_\s]*map|evidence[-_\s]*tier|shot[-_\s]*job|readability[-_\s]*target|camera[-_\s]*pose|change[-_\s]*class|可行性否决权|内部空间光学合同)", re.I)
HARNESS_TAG_RE = re.compile(r"^@素材\[([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]$")
HARNESS_TAG_IN_BODY_RE = re.compile(r"@素材\[[^\]\s]+\]")
FREE_ALIAS_RE = re.compile(r"@(?:图|视频|音频)\d+|@产品图|@(?:Image|Video|Audio)\d+", re.I)
HIGGSFIELD_TAG_RE = re.compile(r"@(?:Image|Video|Audio)\d+", re.I)
BODY_OPTICS_PATTERNS = {
    "diagonalFovDeg": re.compile(r"(?:FOV|视场角)[^。；\n]{0,12}?(\d+(?:\.\d+)?)\s*(?:°|度)", re.I),
    "focalLengthMm": re.compile(r"(?:(\d+(?:\.\d+)?)\s*mm\s*(?:镜头|焦段|定焦|变焦)|(?:镜头|焦段|定焦|变焦)[^。；\n]{0,12}?(\d+(?:\.\d+)?)\s*mm)", re.I),
    "cameraDistanceM": re.compile(r"(?:相机|机位)(?:离|距离|到|与)[^。；\n]{0,16}?(\d+(?:\.\d+)?)\s*(?:m|米)", re.I),
    "rollDeg": re.compile(r"(?:滚转|倾斜)(?:角度)?[^。；\n]{0,12}?(\d+(?:\.\d+)?)\s*(?:°|度)", re.I),
}
SHUTTER_RE = re.compile(r"180\s*(?:-degree|degree|°|度)?\s*shutter|180\s*度快门", re.I)
DEVICE_IN_BODY_RE = re.compile(r"dolly[-_\s]*zoom|crash[-_\s]*zoom|dutch[-_\s]*angle|whip[-_\s]*pan|荷兰角|甩镜|绕拍|orbit(?:ing)?\s*shot|tracking\s*shot", re.I)
CONFINED_IN_BODY_RE = re.compile(r"狭小|窄小|狭窄|逼仄|局促空间|车内|车厢|电梯(?:内|轿厢)|柜内|贴墙|紧贴后壁|贴近后壁|tight\s+(?:room|space|corridor)|confined\s+space", re.I)
SHA_RE = re.compile(r"^[a-f0-9]{64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SCHEMA_PATH = Path(__file__).resolve().parents[1] / "references" / "spatial-optics-contract.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


@dataclass
class Finding:
    code: str
    severity: str
    gate: str
    message: str


def _add(findings: list[Finding], code: str, message: str, gate: str = "contract") -> None:
    findings.append(Finding(code, "error", gate, message))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _placeholder(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    normalized = value.strip().lower()
    if not normalized:
        return True
    if any(normalized.startswith(term) for term in ("待定", "未知", "以后", "随便")):
        return True
    return bool(re.match(r"^(?:unknown|maybe|tbd|somewhere|later)(?:\b|[\s,:：-])", normalized, re.I))


def _schema_type_matches(instance: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(instance, dict)
    if expected == "array":
        return isinstance(instance, list)
    if expected == "string":
        return isinstance(instance, str)
    if expected == "number":
        return _is_number(instance)
    if expected == "boolean":
        return isinstance(instance, bool)
    return True


def _schema_errors(instance: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    errors: list[str] = []
    expected_type = schema.get("type")
    if expected_type and not _schema_type_matches(instance, expected_type):
        return [f"{path}: expected {expected_type}"]
    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: must equal {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: value is not in enum")
    if isinstance(instance, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in instance:
                errors.append(f"{path}: missing required property {key}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in instance:
                if key not in properties:
                    errors.append(f"{path}: unexpected property {key}")
        if "minProperties" in schema and len(instance) < schema["minProperties"]:
            errors.append(f"{path}: requires at least {schema['minProperties']} properties")
        for key, value in instance.items():
            if key in properties:
                errors.extend(_schema_errors(value, properties[key], f"{path}.{key}"))
    elif isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: requires at least {schema['minItems']} items")
        if schema.get("uniqueItems"):
            serialized = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in instance]
            if len(serialized) != len(set(serialized)):
                errors.append(f"{path}: items must be unique")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(instance):
                errors.extend(_schema_errors(item, item_schema, f"{path}[{index}]"))
    elif isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: string is too short")
        if "pattern" in schema and not re.fullmatch(schema["pattern"], instance):
            errors.append(f"{path}: string does not match pattern")
    elif _is_number(instance):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: value below minimum")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: value above maximum")
        if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
            errors.append(f"{path}: value must exceed exclusiveMinimum")
        if "exclusiveMaximum" in schema and instance >= schema["exclusiveMaximum"]:
            errors.append(f"{path}: value must be below exclusiveMaximum")
    return errors


def _get_dotted(data: dict[str, Any], path: str) -> Any:
    current: Any = data
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _canonical_device_name(value: str) -> str:
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "dollyzoom": "dolly_zoom", "dolly_zoom": "dolly_zoom",
        "crashzoom": "crash_zoom", "crash_zoom": "crash_zoom",
        "dutchangle": "dutch_angle", "dutch_angle": "dutch_angle", "荷兰角": "dutch_angle",
        "whippan": "whip_pan", "whip_pan": "whip_pan", "甩镜": "whip_pan",
        "orbit": "orbit", "orbitingshot": "orbit", "orbiting_shot": "orbit", "绕拍": "orbit",
        "trackingshot": "tracking", "tracking_shot": "tracking",
    }
    compact = normalized.replace("_", "")
    return aliases.get(normalized, aliases.get(compact, normalized))


def _body_optics_values(text: str) -> dict[str, list[float]]:
    values: dict[str, list[float]] = {}
    for field, pattern in BODY_OPTICS_PATTERNS.items():
        found: list[float] = []
        for match in pattern.finditer(text):
            raw = next((group for group in match.groups() if group is not None), None)
            if raw is not None:
                found.append(float(raw))
        if found:
            values[field] = found
    return values


def _require_dict_fields(findings: list[Finding], data: Any, name: str, fields: tuple[str, ...]) -> dict[str, Any]:
    if data is None:
        _add(findings, "MISSING_REQUIRED_FIELD", f"缺少必填对象 {name}。")
        return {}
    if not isinstance(data, dict):
        _add(findings, "SCHEMA_TYPE_ERROR", f"{name} 必须是对象。")
        return {}
    missing = [field for field in fields if field not in data]
    if missing:
        _add(findings, "MISSING_REQUIRED_FIELD", f"{name} 缺少必填字段：{', '.join(missing)}。")
    return data


def _scan_placeholders(findings: list[Finding], value: Any, path: str = "") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"promptBody", "claims"}:
                continue
            _scan_placeholders(findings, item, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _scan_placeholders(findings, item, f"{path}[{index}]")
    elif _placeholder(value):
        _add(findings, "PLACEHOLDER_VALUE", f"{path} 含未解决占位值：{value!r}。")


def _validate_exact_evidence(findings: list[Finding], contract: dict[str, Any], optics: dict[str, Any]) -> None:
    exact_fields = {key: optics.get(key) for key in ("diagonalFovDeg", "focalLengthMm", "cameraDistanceM", "rollDeg") if key in optics}
    ranges = {
        "diagonalFovDeg": (0, 180, False),
        "focalLengthMm": (0, 2000, True),
        "cameraDistanceM": (0, 1000, True),
        "rollDeg": (-180, 180, False),
    }
    for key, value in exact_fields.items():
        if not _is_number(value):
            _add(findings, "SCHEMA_TYPE_ERROR", f"optics.{key} 必须是数字。")
            continue
        low, high, allow_high = ranges[key]
        valid = value > low and (value <= high if allow_high else value < high) if key != "rollDeg" else low <= value <= high
        if not valid:
            _add(findings, "OPTICS_VALUE_OUT_OF_RANGE", f"optics.{key}={value} 超出合法范围。")
    if not exact_fields:
        return
    if "diagonalFovDeg" in exact_fields and "focalLengthMm" in exact_fields:
        sensor_diagonal = optics.get("sensorDiagonalMm")
        projection = optics.get("projection")
        focal_value = exact_fields["focalLengthMm"]
        fov_value = exact_fields["diagonalFovDeg"]
        if not _is_number(sensor_diagonal) or sensor_diagonal <= 0 or not _is_number(focal_value) or focal_value <= 0 or not _is_number(fov_value) or projection is None:
            _add(findings, "MISSING_OPTICAL_GEOMETRY", "同时声明精确FOV与焦距时，必须提供sensorDiagonalMm与projection。")
        elif projection != "rectilinear":
            _add(findings, "UNSUPPORTED_DUAL_OPTICS_PROJECTION", "fisheye/equirectangular未绑定专用关系模型时，不得同时硬锁精确FOV与焦距。")
        else:
            expected_fov = math.degrees(2 * math.atan(sensor_diagonal / (2 * focal_value)))
            tolerance = max(2.0, expected_fov * 0.05)
            if abs(fov_value - expected_fov) > tolerance:
                _add(findings, "FOV_FOCAL_INCONSISTENCY", f"当前传感器/rectilinear口径下，{focal_value}mm对应约{expected_fov:.1f}°，与声明FOV不一致。")
    tier = optics.get("evidenceTier")
    if tier not in TRUSTED_EXACT_EVIDENCE:
        _add(findings, "UNVERIFIED_OPTICS_PRECISION", "任何精确FOV、焦段、距离或滚转值都必须绑定当前参数合同、当前运行验证或用户明确测量值。")
        return
    evidence = _require_dict_fields(findings, optics.get("evidence"), "optics.evidence", ("id", "surface", "modelVersion", "verifiedAt"))
    if evidence:
        if evidence.get("surface") != contract.get("surface") or evidence.get("modelVersion") != contract.get("modelVersion"):
            _add(findings, "EVIDENCE_SCOPE_MISMATCH", "精确光学证据的 surface/modelVersion 与当前合同不一致。")
        if _placeholder(evidence.get("id")) or not DATE_RE.fullmatch(str(evidence.get("verifiedAt", ""))):
            _add(findings, "INVALID_EVIDENCE_REFERENCE", "精确光学证据必须有稳定 ID 与 YYYY-MM-DD 日期。")
        if tier in {"official_parameter_contract", "current_runtime_verified"}:
            parameter_ranges = evidence.get("parameterRanges")
            if not isinstance(parameter_ranges, dict):
                _add(findings, "MISSING_PARAMETER_RANGE", "平台参数合同或当前运行验证必须声明有效 parameterRanges。")
            else:
                for key, value in exact_fields.items():
                    bounds = parameter_ranges.get(key)
                    if not isinstance(bounds, list) or len(bounds) != 2 or not all(_is_number(item) for item in bounds) or not (bounds[0] <= value <= bounds[1]):
                        _add(findings, "VALUE_OUTSIDE_EVIDENCE_RANGE", f"optics.{key} 未被 evidence.parameterRanges 覆盖。")


def validate(contract: dict[str, Any]) -> dict[str, Any]:
    findings: list[Finding] = []
    if not isinstance(contract, dict):
        _add(findings, "SCHEMA_TYPE_ERROR", "空间光学合同根节点必须是对象。")
        return _report(findings)

    schema_errors = _schema_errors(contract, SCHEMA)
    for error in schema_errors:
        _add(findings, "SCHEMA_VALIDATION_ERROR", error)

    missing_top = sorted(REQUIRED_TOP - set(contract))
    if missing_top:
        _add(findings, "MISSING_REQUIRED_FIELD", f"合同缺少必填顶层字段：{', '.join(missing_top)}。")
    unknown_top = sorted(set(contract) - ALLOWED_TOP)
    if unknown_top:
        _add(findings, "UNKNOWN_FIELD", f"合同包含未知顶层字段：{', '.join(unknown_top)}。")
    if contract.get("contractVersion") != "spatial-optics-v1":
        _add(findings, "INVALID_CONTRACT_VERSION", "contractVersion 必须为 spatial-optics-v1。")
    if contract.get("surface") not in {"harness", "higgsfield", "seedance", "jimeng", "other"}:
        _add(findings, "INVALID_ENUM", "surface 不是受支持枚举。")
    if _placeholder(contract.get("modelVersion")):
        _add(findings, "MISSING_REQUIRED_FIELD", "modelVersion 必须明确。")
    if contract.get("shotJob") not in SHOT_JOBS:
        _add(findings, "INVALID_ENUM", "shotJob 不是内置任务或 custom。")
    if contract.get("shotJob") == "custom" and (not isinstance(contract.get("customShotJob"), str) or _placeholder(contract.get("customShotJob"))):
        _add(findings, "MISSING_CUSTOM_SHOT_JOB", "custom shotJob 必须声明自定义任务名。")

    readability = _require_dict_fields(findings, contract.get("readabilityTarget"), "readabilityTarget", ("primaryEvidence", "visibleFeatures", "occlusion", "motionBlur"))
    world_map = _require_dict_fields(findings, contract.get("worldMap"), "worldMap", ("controlledObjects", "cameraZone", "actionAxis", "occlusions", "exits"))
    first_frame = _require_dict_fields(findings, contract.get("firstFrame"), "firstFrame", ("mode", "dramaticTask", "postRevealState"))
    approved = _require_dict_fields(findings, contract.get("approvedIntent"), "approvedIntent", ("sha256", "lockedFields", "sourcePayload"))
    language = _require_dict_fields(findings, contract.get("language"), "language", ("bodyLanguage", "dialogueLanguage", "userRequestedEnglish", "dialogueTranslatedToEnglish"))
    _scan_placeholders(findings, contract)

    if readability:
        if not isinstance(readability.get("visibleFeatures"), list) or not readability.get("visibleFeatures"):
            _add(findings, "MISSING_READABILITY_EVIDENCE", "readabilityTarget.visibleFeatures 必须是非空数组。")
        if readability.get("occlusion") not in {"none", "partial", "heavy"} or readability.get("motionBlur") not in {"low", "medium", "high"}:
            _add(findings, "INVALID_ENUM", "readabilityTarget 的 occlusion/motionBlur 枚举无效。")
    if world_map:
        if not isinstance(world_map.get("controlledObjects"), list) or not world_map.get("controlledObjects"):
            _add(findings, "MISSING_WORLD_MAP", "worldMap.controlledObjects 必须是非空数组。")

    if contract.get("shotJob") == "microacting" and readability:
        ratio = readability.get("faceFrameHeightRatio")
        face_px = readability.get("faceHeightPx")
        output_px = readability.get("outputHeightPx")
        ratio_evidence = _is_number(ratio) and 0 < ratio <= 1
        pixel_evidence = _is_number(face_px) and _is_number(output_px) and 0 < face_px <= output_px
        if not (ratio_evidence or pixel_evidence) or not readability.get("measurementSource"):
            _add(findings, "MISSING_MICROACTING_SCALE_EVIDENCE", "微表演必须绑定脸部画面高度占比或脸部/输出像素高度及测量来源，不能用裸布尔值免责。")
        else:
            effective_ratio = ratio if ratio_evidence else face_px / output_px
            if effective_ratio < 0.15 or (pixel_evidence and face_px < 120):
                _add(findings, "READABILITY_CONFLICT", "微表演脸部高度低于内部明显不可读筛查阈值；需提高画框占比、改用身体证据或拆镜。")
        if readability.get("occlusion") == "heavy" or readability.get("motionBlur") == "high":
            _add(findings, "READABILITY_CONFLICT", "微表演被重遮挡或强运动模糊破坏可读性。")

    optics = contract.get("optics", {})
    if optics is not None and not isinstance(optics, dict):
        _add(findings, "SCHEMA_TYPE_ERROR", "optics 必须是对象。")
        optics = {}
    _validate_exact_evidence(findings, contract, optics)

    risk_flags = contract.get("riskFlags", [])
    if not isinstance(risk_flags, list) or any(flag not in HIGH_RISK_FLAGS for flag in risk_flags):
        _add(findings, "INVALID_ENUM", "riskFlags 必须是已知枚举数组。")
        risk_flags = []
    devices = contract.get("devices", [])
    if not isinstance(devices, list):
        _add(findings, "SCHEMA_TYPE_ERROR", "devices 必须是数组。")
        devices = []

    normalized_names: list[str] = []
    primary_count = 0
    simultaneous_strong = 0
    required_device_fields = ("name", "dominant", "intensity", "simultaneous", "setup", "trigger", "cameraBehavior", "subjectBehavior", "peak", "recovery")
    for index, device in enumerate(devices):
        device = _require_dict_fields(findings, device, f"devices[{index}]", required_device_fields)
        if not device:
            continue
        name = _canonical_device_name(str(device.get("name", "")))
        normalized_names.append(name)
        if device.get("dominant") is True:
            primary_count += 1
        if device.get("intensity") == "strong" and device.get("simultaneous") is True:
            simultaneous_strong += 1
    if devices and primary_count != 1:
        _add(findings, "PRIMARY_DEVICE_COUNT", "存在镜头装置时必须且只能有一个 dominant 主装置。")
    if simultaneous_strong > 1:
        _add(findings, "SIMULTANEOUS_STRONG_DEVICES", "两个以上强装置不得在同一瞬间争夺同一Shot。")
    if contract.get("shotJob") == "camera_device" and not devices:
        _add(findings, "MISSING_DEVICE_CONTRACT", "camera_device shotJob 必须提供至少一个完整装置合同。")

    needs_pose = contract.get("shotJob") == "camera_device" or bool(set(risk_flags) & HIGH_RISK_FLAGS) or bool(devices)
    camera_pose = contract.get("cameraPose")
    if needs_pose:
        camera_pose = _require_dict_fields(findings, camera_pose, "cameraPose", ("height", "side", "distanceOrClearance", "aimPoint"))
        if any(name in DUTCH_NAMES for name in normalized_names) and "rollDirection" not in camera_pose:
            _add(findings, "CAMERA_POSE_INCOMPLETE", "荷兰角机位必须声明 rollDirection，并与俯仰分离。")

    moving_required = "moving_camera" in risk_flags or any(name in MOVING_DEVICES for name in normalized_names)
    confined_required = "confined_space" in risk_flags
    space = contract.get("space")
    if moving_required or confined_required:
        space = _require_dict_fields(findings, space, "space", ("mode",))
        if moving_required:
            required = ("rigEnvelopeM", "dynamicIntrusionMarginM", "pathMinClearanceM", "startClearanceM", "endClearanceM")
            for key in required:
                if not _is_number(space.get(key)):
                    _add(findings, "MISSING_MOVING_CLEARANCE", f"运动机位缺少数值 space.{key}。")
            if space.get("mode") != "moving":
                _add(findings, "INVALID_SPACE_MODE", "运动机位必须使用 space.mode=moving。")
            if all(_is_number(space.get(key)) for key in required):
                need = space["rigEnvelopeM"] + space["dynamicIntrusionMarginM"]
                if min(space["pathMinClearanceM"], space["startClearanceM"], space["endClearanceM"]) < need:
                    _add(findings, "MOVING_CLEARANCE_CONFLICT", "运动路径最小净空不足以容纳设备包络与主体动态侵入余量。")
        elif confined_required:
            required = ("cameraEnvelopeM", "safetyMarginM", "availableClearanceM")
            for key in required:
                if not _is_number(space.get(key)):
                    _add(findings, "MISSING_STATIC_CLEARANCE", f"狭小空间静态机位缺少数值 space.{key}。")
            if space.get("mode") != "static":
                _add(findings, "INVALID_SPACE_MODE", "非运动狭小空间必须使用 space.mode=static。")
            if all(_is_number(space.get(key)) for key in required) and space["cameraEnvelopeM"] + space["safetyMarginM"] > space["availableClearanceM"]:
                _add(findings, "STATIC_CLEARANCE_CONFLICT", "静态机位净空不足以容纳相机包络与安全余量。")

    if first_frame:
        mode = str(first_frame.get("mode", "")).lower()
        if mode not in {"subject_visible", *PROTECTED_EMPTY_MODES}:
            _add(findings, "INVALID_ENUM", "firstFrame.mode 不是受支持枚举。")
        if mode in PROTECTED_EMPTY_MODES:
            for key in ("revealTrigger", "firstVisiblePosition"):
                if key not in first_frame or _placeholder(first_frame.get(key)):
                    _add(findings, "INCOMPLETE_FIRST_FRAME_EXCEPTION", f"{mode} 首帧例外缺少 {key}。")
            if first_frame.get("requireAllSubjectsVisible") is True:
                _add(findings, "INTENTIONAL_REVEAL_OVERRIDDEN", "有意空镜、入场或揭示被“首帧全员可见”覆盖。")

    if approved:
        source_payload = approved.get("sourcePayload")
        if not SHA_RE.fullmatch(str(approved.get("sha256", ""))) or not isinstance(approved.get("lockedFields"), dict) or not approved.get("lockedFields") or not isinstance(source_payload, dict):
            _add(findings, "INVALID_APPROVED_INTENT_BINDING", "approvedIntent 必须绑定可重算sourcePayload、64位SHA和至少一个lockedFields字段。")
        else:
            canonical_payload = json.dumps(source_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            computed_sha = hashlib.sha256(canonical_payload).hexdigest()
            if computed_sha != approved.get("sha256"):
                _add(findings, "APPROVED_INTENT_SHA_MISMATCH", "approvedIntent.sha256 与规范化sourcePayload重算结果不一致。")
            if source_payload.get("lockedFields") != approved.get("lockedFields"):
                _add(findings, "APPROVED_INTENT_PAYLOAD_MISMATCH", "approvedIntent.lockedFields 与sourcePayload.lockedFields不一致。")
    adjustments = contract.get("adjustments", [])
    if not isinstance(adjustments, list):
        _add(findings, "SCHEMA_TYPE_ERROR", "adjustments 必须是数组。")
        adjustments = []
    locked_fields = approved.get("lockedFields", {}) if approved else {}
    material_change = False
    adjustment_by_field: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(adjustments):
        item = _require_dict_fields(findings, item, f"adjustments[{index}]", ("field", "before", "after", "surfacedToUser"))
        if not item:
            continue
        field = item.get("field")
        if isinstance(field, str):
            adjustment_by_field[field] = item
        if field in locked_fields:
            if item.get("before") != locked_fields[field]:
                _add(findings, "APPROVED_INTENT_BEFORE_MISMATCH", f"adjustments[{index}].before 与 lockedFields.{field} 不一致。")
            if item.get("after") != locked_fields[field]:
                material_change = True
                if item.get("surfacedToUser") is not True:
                    _add(findings, "HIDDEN_MATERIAL_CHANGE", f"锁定字段 {field} 被改变但未暴露给用户/审核门。")
    for field, locked_value in locked_fields.items():
        current_value = _get_dotted(contract, field)
        if current_value != locked_value:
            material_change = True
            adjustment = adjustment_by_field.get(field)
            if not adjustment or adjustment.get("before") != locked_value or adjustment.get("after") != current_value or adjustment.get("surfacedToUser") is not True:
                _add(findings, "HIDDEN_MATERIAL_CHANGE", f"当前合同的锁定字段 {field} 已改变，但缺少与 approvedIntent 一致且已暴露的 before/after 记录。")
    if material_change and contract.get("changeClass") != "material_creative_change":
        _add(findings, "INVALID_CHANGE_CLASS", "锁定字段发生变化时 changeClass 必须为 material_creative_change。")
    if contract.get("changeClass") not in {"none", "lossless_normalization", "parameter_degradation", "material_creative_change"}:
        _add(findings, "INVALID_ENUM", "changeClass 不是受支持枚举。")

    prompt_body = contract.get("promptBody")
    if not isinstance(prompt_body, str) or not prompt_body.strip():
        _add(findings, "MISSING_PROMPT_BODY", "promptBody 必须是非空最终模型正文。", "promptBody")
        prompt_body = ""
    claims = contract.get("claims")
    if not isinstance(claims, list) or any(not isinstance(item, str) for item in claims):
        _add(findings, "SCHEMA_TYPE_ERROR", "claims 必须是字符串数组。")
        claims = []
    normalized_prompt_body = unicodedata.normalize("NFKC", prompt_body)
    normalized_claims = [unicodedata.normalize("NFKC", item) for item in claims]
    if any(GUARANTEE_RE.search(item) for item in normalized_claims) or GUARANTEE_RE.search(normalized_prompt_body):
        _add(findings, "UNSUPPORTED_GUARANTEE", "正文或声明不得承诺100%、像素级或绝对匹配。", "promptBody")
    if INTERNAL_LABEL_RE.search(normalized_prompt_body):
        _add(findings, "INTERNAL_LABEL_IN_PROMPT_BODY", "内部合同、路由或审计字段不得进入模型正文。", "promptBody")
    body_optics = _body_optics_values(normalized_prompt_body)
    for field, values in body_optics.items():
        if field not in optics:
            _add(findings, "UNDECLARED_EXACT_OPTICS", f"正文出现精确{field}数值，但合同 optics.{field} 未声明并绑定证据。", "promptBody")
        elif _is_number(optics[field]) and any(abs(value - float(optics[field])) > 1e-6 for value in values):
            _add(findings, "PROMPT_OPTICS_VALUE_MISMATCH", f"正文中的{field}数值与合同 optics.{field} 不一致。", "promptBody")
    body_devices = [_canonical_device_name(match.group(0)) for match in DEVICE_IN_BODY_RE.finditer(normalized_prompt_body)]
    undeclared_devices = sorted(set(body_devices) - set(normalized_names))
    if undeclared_devices:
        _add(findings, "UNDECLARED_CAMERA_DEVICE", f"正文出现未在devices合同声明的强镜头装置：{', '.join(undeclared_devices)}。", "promptBody")
    if CONFINED_IN_BODY_RE.search(normalized_prompt_body) and "confined_space" not in risk_flags:
        _add(findings, "UNDECLARED_SPATIAL_RISK", "正文出现狭小/受限空间，但riskFlags未声明confined_space。", "promptBody")
    motion = contract.get("motion", {})
    if SHUTTER_RE.search(normalized_prompt_body):
        if not isinstance(motion, dict) or motion.get("evidenceTier") not in TRUSTED_EXACT_EVIDENCE:
            _add(findings, "UNVERIFIED_SHUTTER_CONTROL", "未验证surface的180度快门必须改写为可见运动模糊。", "promptBody")

    if language:
        body_language = str(language.get("bodyLanguage", "")).lower()
        if body_language.startswith("en") and language.get("userRequestedEnglish") is not True:
            _add(findings, "UNREQUESTED_LANGUAGE_DRIFT", "未获用户要求时不能把中文Seedance正文默认改成英文。", "promptBody")
        if str(language.get("dialogueLanguage", "")).lower().startswith("zh") and language.get("dialogueTranslatedToEnglish") is True:
            _add(findings, "DIALOGUE_LANGUAGE_DRIFT", "中文台词不能为了第三方模板翻成英文。", "promptBody")
        if body_language.startswith("zh"):
            body_without_tags = HARNESS_TAG_IN_BODY_RE.sub("", normalized_prompt_body)
            han_count = len(re.findall(r"[\u4e00-\u9fff]", body_without_tags))
            english_words = len(re.findall(r"\b[A-Za-z]{3,}\b", body_without_tags))
            if (english_words >= 1 and han_count == 0) or (english_words >= 10 and english_words > han_count * 2):
                _add(findings, "PROMPT_BODY_LANGUAGE_MISMATCH", "声明中文正文，但 promptBody 实际主要为英文。", "promptBody")

    source_tags = contract.get("sourceMediaTags")
    output_tags = contract.get("outputMediaTags")
    if not isinstance(source_tags, list) or not isinstance(output_tags, list) or any(not isinstance(tag, str) for tag in (source_tags or []) + (output_tags or [])):
        _add(findings, "SCHEMA_TYPE_ERROR", "sourceMediaTags/outputMediaTags 必须是字符串数组。")
        source_tags, output_tags = [], []
    surface = contract.get("surface")
    if surface == "harness":
        if source_tags != output_tags:
            _add(findings, "HARNESS_TAG_RENUMBERED", "Harness稳定资产ID必须从来源到输出逐字、有序保持。", "promptBody")
        if any(not HARNESS_TAG_RE.fullmatch(tag) for tag in output_tags):
            _add(findings, "HARNESS_TAG_CONFLICT", "Harness只允许安全的@素材[exact-id]，禁止路径和自由别名。", "promptBody")
        if FREE_ALIAS_RE.search(prompt_body):
            _add(findings, "HARNESS_TAG_CONFLICT", "Harness正文不得出现自由@图N/@视频N/@ImageN别名。", "promptBody")
        if HARNESS_TAG_IN_BODY_RE.findall(prompt_body) != output_tags:
            _add(findings, "PROMPT_TAG_BODY_MISMATCH", "promptBody中的Harness标签与outputMediaTags不一致。", "promptBody")
    elif surface == "higgsfield":
        if source_tags != output_tags:
            _add(findings, "HIGGSFIELD_TAG_RENUMBERED", "Higgsfield原生标签必须从来源到输出逐字、有序保持。", "promptBody")
        if HIGGSFIELD_TAG_RE.findall(prompt_body) != output_tags:
            _add(findings, "PROMPT_TAG_BODY_MISMATCH", "promptBody中的Higgsfield标签与outputMediaTags不一致。", "promptBody")

    return _report(findings)


def _report(findings: list[Finding]) -> dict[str, Any]:
    unique: dict[tuple[str, str, str], Finding] = {}
    for finding in findings:
        unique[(finding.code, finding.gate, finding.message)] = finding
    final = list(unique.values())
    contract_fail = any(item.gate == "contract" and item.severity == "error" for item in final)
    prompt_fail = any(item.gate == "promptBody" and item.severity == "error" for item in final)
    return {
        "status": "PASS" if not contract_fail and not prompt_fail else "FAIL",
        "contractValidationStatus": "CONTRACT_VALIDATION_PASS" if not contract_fail else "CONTRACT_VALIDATION_FAIL",
        "promptBodyLintStatus": "PROMPT_BODY_LINT_PASS" if not prompt_fail else "PROMPT_BODY_LINT_FAIL",
        "platformExecutionStatus": "PLATFORM_EXECUTION_NOT_VERIFIED",
        "findings": [asdict(item) for item in final],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("contract", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    raw = args.contract.read_bytes()
    try:
        def reject_constant(value: str) -> None:
            raise ValueError(f"non-finite JSON number: {value}")

        contract = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"status": "FAIL", "error": f"invalid JSON: {exc}"}, ensure_ascii=False, indent=2))
        return 1
    report = validate(contract)
    report["contractPath"] = str(args.contract.resolve())
    report["contractSha256"] = hashlib.sha256(raw).hexdigest()
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    if args.json or not args.report:
        print(encoded)
    else:
        print(f"{report['status']}: {args.contract} -> {args.report}")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
