#!/usr/bin/env python3
"""Offline two-pass monocular depth-video runner.

This runner accepts only an explicit local Hugging Face depth-model directory.
It forces Transformers offline, never downloads weights, keeps the source
read-only, derives one exact P2/P98 range from every native depth sample in the
full input window, and then renders silent H.264/yuv420p segments.  Temporal
stabilization uses forward/backward optical-flow consistency and never gives
history more than 0.25 weight.

An optional JSON overlay-mask contract can exclude deterministic overlay pixels
inside source-frame rectangle or polygon candidate regions.  Regions use
absolute source-frame half-open ranges and native source pixel coordinates.
Within each active region, fixed white/yellow source-pixel thresholds,
connected-component size bounds, and native-pixel dilation select only overlay
fills plus their dark outlines.  That remains the default glyph/Telea path.
For compact yellow side labels, ``glyph_bbox_telea_v1`` independently filters
yellow glyph components inside each candidate region, forms one half-open tight
bounding box around that mask's retained core, expands it by an explicit
native-pixel padding, clips it back to that same candidate region, and uses the
resulting box as the Telea mask.  The yellow-only path keeps the global minimum
component size but deliberately does not apply the legacy maximum component
size; its expanded bbox is instead protected by the occupancy guard.  Empty
cores and over-occupancy boxes fail closed.
For subtitle planes that extend beyond the glyphs themselves, an explicit
``vertical_column_band_v1`` fill may use the selected glyph columns to replace
only those columns across a rectangular candidate region.  Each replacement
column is reconstructed from median samples immediately above and below the
region, with feathering confined to the band itself.
An individual mask may explicitly select its full candidate region and replace
it from one or more clean anchor-frame depth patches.  Anchor patches are
aligned by a deterministic exterior-ring scalar offset and feathered only
inside the candidate region.  Every pixel outside the selected region retains
the exact pre-exclusion depth value; no generative fill is used.
For isolated source-texture pseudo-depth, ``highpass_suppression_v1`` may be
bound to an explicit full-candidate half-open mask.  It retains the same
stabilized frame's Gaussian low-frequency shape, clips the removed residual by
an explicit depth-code limit, and feathers only inside the mask.  Concurrent
candidate masks may not overlap this fill, keeping composition unambiguous.

The default output contract is the locked project contract: 30 fps,
720x1280, frames [0,322) and [322,555).
"""

from __future__ import annotations

import argparse
import errno
import gc
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, List, NoReturn, Optional, Sequence, Tuple


RUNNER_ID = "monocular-depth-video-runner-v1"
DEFAULT_EXPECTED_FRAMES = 555
DEFAULT_START_FRAME = 0
DEFAULT_EXPECTED_FPS = Fraction(30, 1)
DEFAULT_OUTPUT_SIZE = (720, 1280)
DEFAULT_SEGMENTS = "0:322,322:555"
DEFAULT_LOW_PERCENTILE = 2.0
DEFAULT_HIGH_PERCENTILE = 98.0
DEFAULT_CURRENT_WEIGHT = 0.80
DEFAULT_HISTORY_WEIGHT = 0.20
MAX_HISTORY_WEIGHT = 0.25
MIN_CURRENT_WEIGHT = 0.75
MAX_SEGMENT_SECONDS = 15
OVERLAY_MASK_SCHEMA_VERSION = 1
OVERLAY_FRAME_INDEXING = "absolute_source_frames_half_open"
OVERLAY_COORDINATE_KIND = "native_source_pixels"
OVERLAY_STRATEGY_ID = "opencv_telea_uint8_v1"
OVERLAY_PIXEL_SELECTOR_ID = "source_white_yellow_components_dilate_v1"
OVERLAY_SELECTOR_GLYPH_COMPONENTS = "glyph_components"
OVERLAY_SELECTOR_GLYPH_BBOX_TELEA = "glyph_bbox_telea_v1"
OVERLAY_SELECTOR_FULL_CANDIDATE = "full_candidate"
OVERLAY_FILL_TELEA = "telea"
OVERLAY_FILL_CLEAN_ANCHOR_PATCH = "clean_anchor_patch"
OVERLAY_FILL_VERTICAL_COLUMN_BAND = "vertical_column_band_v1"
OVERLAY_FILL_HIGHPASS_SUPPRESSION = "highpass_suppression_v1"
DEFAULT_OVERLAY_INPAINT_RADIUS = 3.0
DEFAULT_WHITE_MIN_CHANNEL = 200
DEFAULT_WHITE_MAX_CHANNEL_SPREAD = 36
DEFAULT_YELLOW_MIN_RED = 190
DEFAULT_YELLOW_MIN_GREEN = 160
DEFAULT_YELLOW_MAX_BLUE = 150
DEFAULT_YELLOW_HUE_MIN = 20
DEFAULT_YELLOW_HUE_MAX = 40
DEFAULT_YELLOW_MIN_SATURATION = 48
DEFAULT_YELLOW_MIN_VALUE = 120
DEFAULT_MIN_COMPONENT_PIXELS_NATIVE = 2
DEFAULT_MAX_COMPONENT_PIXELS_NATIVE = 4096
DEFAULT_DILATE_NATIVE_PIXELS = 2
DEFAULT_MAX_SELECTED_FRACTION_OF_CANDIDATE = 0.45
DEFAULT_GLYPH_BBOX_PADDING_NATIVE_PIXELS = 6
DEFAULT_ANCHOR_RING_OFFSET_OUTPUT_PIXELS = 3
DEFAULT_ANCHOR_FEATHER_OUTPUT_PIXELS = 2.0
DEFAULT_VERTICAL_BOUNDARY_SAMPLE_ROWS_OUTPUT = 3
DEFAULT_VERTICAL_FEATHER_OUTPUT_PIXELS = 2.0
MAX_HIGHPASS_SIGMA_OUTPUT_PIXELS = 64.0
MAX_HIGHPASS_DELTA_DEPTH_CODES = 64.0
MAX_HIGHPASS_FEATHER_OUTPUT_PIXELS = 64.0
MODEL_CONFIG_FILES = ("config.json",)
PROCESSOR_CONFIG_FILES = ("preprocessor_config.json", "processor_config.json")
MODEL_WEIGHT_FILES = (
    "model.safetensors",
    "model.safetensors.index.json",
    "pytorch_model.bin",
    "pytorch_model.bin.index.json",
)


@dataclass(frozen=True)
class Segment:
    index: int
    start_frame: int
    end_frame_exclusive: int

    @property
    def frame_count(self) -> int:
        return self.end_frame_exclusive - self.start_frame

    @property
    def filename(self) -> str:
        return "segment-%03d.mp4" % self.index


def json_print(value: Dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True), flush=True)


def default_overlay_pixel_selector() -> Dict[str, Any]:
    return {
        "id": OVERLAY_PIXEL_SELECTOR_ID,
        "whiteMinChannel": DEFAULT_WHITE_MIN_CHANNEL,
        "whiteMaxChannelSpread": DEFAULT_WHITE_MAX_CHANNEL_SPREAD,
        "yellowMinRed": DEFAULT_YELLOW_MIN_RED,
        "yellowMinGreen": DEFAULT_YELLOW_MIN_GREEN,
        "yellowMaxBlue": DEFAULT_YELLOW_MAX_BLUE,
        "yellowHueMin": DEFAULT_YELLOW_HUE_MIN,
        "yellowHueMax": DEFAULT_YELLOW_HUE_MAX,
        "yellowMinSaturation": DEFAULT_YELLOW_MIN_SATURATION,
        "yellowMinValue": DEFAULT_YELLOW_MIN_VALUE,
        "minComponentPixelsNative": DEFAULT_MIN_COMPONENT_PIXELS_NATIVE,
        "maxComponentPixelsNative": DEFAULT_MAX_COMPONENT_PIXELS_NATIVE,
        "dilateNativePixels": DEFAULT_DILATE_NATIVE_PIXELS,
        "maxSelectedFractionOfCandidate": DEFAULT_MAX_SELECTED_FRACTION_OF_CANDIDATE,
    }


def fail(message: str) -> NoReturn:
    raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_fingerprint(value: Dict[str, Any]) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def explicit_existing_file(value: Optional[str], field: str) -> Path:
    if not value:
        fail("%s is required" % field)
    if "://" in value:
        fail("%s must be an explicit local filesystem path, not a URL or model id" % field)
    path = Path(value).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        fail("%s must resolve to an existing local file: %s" % (field, path))
    if not resolved.is_file():
        fail("%s must resolve to an existing local file: %s" % (field, resolved))
    return resolved


def require_exact_object(value: Any, required_keys: Sequence[str], field: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        fail("%s must be an object" % field)
    required = set(required_keys)
    actual = set(value.keys())
    missing = sorted(required - actual)
    extra = sorted(actual - required)
    if missing:
        fail("%s is missing required keys: %s" % (field, ", ".join(missing)))
    if extra:
        fail("%s contains unsupported keys: %s" % (field, ", ".join(extra)))
    return value


def require_object_keys(
    value: Any,
    required_keys: Sequence[str],
    optional_keys: Sequence[str],
    field: str,
) -> Dict[str, Any]:
    if not isinstance(value, dict):
        fail("%s must be an object" % field)
    required = set(required_keys)
    allowed = required | set(optional_keys)
    actual = set(value.keys())
    missing = sorted(required - actual)
    extra = sorted(actual - allowed)
    if missing:
        fail("%s is missing required keys: %s" % (field, ", ".join(missing)))
    if extra:
        fail("%s contains unsupported keys: %s" % (field, ", ".join(extra)))
    return value


def require_integer(value: Any, field: str) -> int:
    if type(value) is not int:
        fail("%s must be an integer" % field)
    return value


def require_nonempty_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail("%s must be a non-empty string" % field)
    return value.strip()


def polygon_edges_intersect(first_start: Sequence[int], first_end: Sequence[int], second_start: Sequence[int], second_end: Sequence[int]) -> bool:
    def orientation(a: Sequence[int], b: Sequence[int], c: Sequence[int]) -> int:
        cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if cross == 0 else (1 if cross > 0 else -1)

    def on_segment(a: Sequence[int], b: Sequence[int], point: Sequence[int]) -> bool:
        return (
            min(a[0], b[0]) <= point[0] <= max(a[0], b[0])
            and min(a[1], b[1]) <= point[1] <= max(a[1], b[1])
        )

    first_second = orientation(first_start, first_end, second_start)
    first_second_end = orientation(first_start, first_end, second_end)
    second_first = orientation(second_start, second_end, first_start)
    second_first_end = orientation(second_start, second_end, first_end)
    if first_second != first_second_end and second_first != second_first_end:
        return True
    return (
        (first_second == 0 and on_segment(first_start, first_end, second_start))
        or (first_second_end == 0 and on_segment(first_start, first_end, second_end))
        or (second_first == 0 and on_segment(second_start, second_end, first_start))
        or (second_first_end == 0 and on_segment(second_start, second_end, first_end))
    )


def normalize_overlay_shape(value: Any, width: int, height: int, field: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        fail("%s must be an object" % field)
    shape_type = value.get("type")
    if shape_type == "rect":
        shape = require_exact_object(
            value,
            ("type", "x0", "y0", "x1Exclusive", "y1Exclusive"),
            field,
        )
        x0 = require_integer(shape["x0"], "%s.x0" % field)
        y0 = require_integer(shape["y0"], "%s.y0" % field)
        x1 = require_integer(shape["x1Exclusive"], "%s.x1Exclusive" % field)
        y1 = require_integer(shape["y1Exclusive"], "%s.y1Exclusive" % field)
        if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
            fail(
                "%s rect must satisfy 0 <= x0 < x1Exclusive <= %d and 0 <= y0 < y1Exclusive <= %d"
                % (field, width, height)
            )
        return {
            "type": "rect",
            "x0": x0,
            "y0": y0,
            "x1Exclusive": x1,
            "y1Exclusive": y1,
        }
    if shape_type == "polygon":
        shape = require_exact_object(value, ("type", "points"), field)
        points_value = shape["points"]
        if not isinstance(points_value, list) or len(points_value) < 3:
            fail("%s.points must contain at least three native-coordinate vertices" % field)
        points: List[List[int]] = []
        for index, point_value in enumerate(points_value):
            point_field = "%s.points[%d]" % (field, index)
            if not isinstance(point_value, list) or len(point_value) != 2:
                fail("%s must be [x,y]" % point_field)
            x = require_integer(point_value[0], "%s[0]" % point_field)
            y = require_integer(point_value[1], "%s[1]" % point_field)
            if not (0 <= x < width and 0 <= y < height):
                fail("%s must be inside the %dx%d native source coordinate space" % (point_field, width, height))
            points.append([x, y])
        if len({(point[0], point[1]) for point in points}) != len(points):
            fail("%s.points must contain unique vertices and must not repeat the first vertex" % field)
        twice_area = 0
        for point, following in zip(points, points[1:] + points[:1]):
            twice_area += point[0] * following[1] - following[0] * point[1]
        if twice_area == 0:
            fail("%s polygon must have non-zero area" % field)
        edge_count = len(points)
        for first_index in range(edge_count):
            first_start = points[first_index]
            first_end = points[(first_index + 1) % edge_count]
            for second_index in range(first_index + 1, edge_count):
                if second_index == first_index + 1 or (first_index == 0 and second_index == edge_count - 1):
                    continue
                second_start = points[second_index]
                second_end = points[(second_index + 1) % edge_count]
                if polygon_edges_intersect(first_start, first_end, second_start, second_end):
                    fail("%s polygon must not self-intersect" % field)
        return {"type": "polygon", "points": points}
    fail("%s.type must be rect or polygon" % field)


def normalize_overlay_pixel_selector(value: Any) -> Dict[str, Any]:
    field = "overlay mask spec.strategy.pixelSelector"
    selector = require_exact_object(
        value,
        (
            "id", "whiteMinChannel", "whiteMaxChannelSpread",
            "yellowMinRed", "yellowMinGreen", "yellowMaxBlue",
            "yellowHueMin", "yellowHueMax", "yellowMinSaturation", "yellowMinValue",
            "minComponentPixelsNative", "maxComponentPixelsNative",
            "dilateNativePixels", "maxSelectedFractionOfCandidate",
        ),
        field,
    )
    if selector["id"] != OVERLAY_PIXEL_SELECTOR_ID:
        fail("%s.id must be %s" % (field, OVERLAY_PIXEL_SELECTOR_ID))
    normalized: Dict[str, Any] = {"id": OVERLAY_PIXEL_SELECTOR_ID}
    for key in (
        "whiteMinChannel", "whiteMaxChannelSpread",
        "yellowMinRed", "yellowMinGreen", "yellowMaxBlue",
        "yellowMinSaturation", "yellowMinValue",
    ):
        number = require_integer(selector[key], "%s.%s" % (field, key))
        if not 0 <= number <= 255:
            fail("%s.%s must be between 0 and 255" % (field, key))
        normalized[key] = number
    hue_minimum = require_integer(selector["yellowHueMin"], "%s.yellowHueMin" % field)
    hue_maximum = require_integer(selector["yellowHueMax"], "%s.yellowHueMax" % field)
    if not 0 <= hue_minimum <= hue_maximum <= 179:
        fail("%s yellow hue must satisfy 0 <= min <= max <= 179" % field)
    normalized.update({"yellowHueMin": hue_minimum, "yellowHueMax": hue_maximum})
    minimum = require_integer(selector["minComponentPixelsNative"], "%s.minComponentPixelsNative" % field)
    maximum = require_integer(selector["maxComponentPixelsNative"], "%s.maxComponentPixelsNative" % field)
    if minimum < 1 or maximum < minimum:
        fail("%s component pixels must satisfy 1 <= min <= max" % field)
    dilation = require_integer(selector["dilateNativePixels"], "%s.dilateNativePixels" % field)
    if not 1 <= dilation <= 32:
        fail("%s.dilateNativePixels must be between 1 and 32" % field)
    selected_fraction = selector["maxSelectedFractionOfCandidate"]
    if type(selected_fraction) not in (int, float) or not math.isfinite(float(selected_fraction)):
        fail("%s.maxSelectedFractionOfCandidate must be a finite number" % field)
    selected_fraction = float(selected_fraction)
    if not 0.01 <= selected_fraction <= 0.95:
        fail("%s.maxSelectedFractionOfCandidate must be between 0.01 and 0.95" % field)
    normalized.update({
        "minComponentPixelsNative": minimum,
        "maxComponentPixelsNative": maximum,
        "dilateNativePixels": dilation,
        "maxSelectedFractionOfCandidate": selected_fraction,
    })
    return normalized


def normalize_overlay_mask_spec(value: Any, input_window: Dict[str, Any]) -> Dict[str, Any]:
    spec = require_exact_object(
        value,
        ("schemaVersion", "coordinateSpace", "frameIndexing", "strategy", "masks"),
        "overlay mask spec",
    )
    if require_integer(spec["schemaVersion"], "overlay mask spec.schemaVersion") != OVERLAY_MASK_SCHEMA_VERSION:
        fail("overlay mask spec.schemaVersion must be %d" % OVERLAY_MASK_SCHEMA_VERSION)
    coordinate_space = require_exact_object(
        spec["coordinateSpace"], ("kind", "width", "height"), "overlay mask spec.coordinateSpace",
    )
    if coordinate_space["kind"] != OVERLAY_COORDINATE_KIND:
        fail("overlay mask spec.coordinateSpace.kind must be %s" % OVERLAY_COORDINATE_KIND)
    width = require_integer(coordinate_space["width"], "overlay mask spec.coordinateSpace.width")
    height = require_integer(coordinate_space["height"], "overlay mask spec.coordinateSpace.height")
    if width <= 0 or height <= 0:
        fail("overlay mask spec native source dimensions must be positive")
    if spec["frameIndexing"] != OVERLAY_FRAME_INDEXING:
        fail("overlay mask spec.frameIndexing must be %s" % OVERLAY_FRAME_INDEXING)
    strategy = require_exact_object(
        spec["strategy"], ("id", "radiusOutputPixels", "pixelSelector"), "overlay mask spec.strategy",
    )
    if strategy["id"] != OVERLAY_STRATEGY_ID:
        fail("overlay mask spec.strategy.id must be %s" % OVERLAY_STRATEGY_ID)
    radius_value = strategy["radiusOutputPixels"]
    if type(radius_value) not in (int, float) or not math.isfinite(float(radius_value)):
        fail("overlay mask spec.strategy.radiusOutputPixels must be a finite number")
    radius = float(radius_value)
    if not 0.5 <= radius <= 64.0:
        fail("overlay mask spec.strategy.radiusOutputPixels must be between 0.5 and 64")
    masks_value = spec["masks"]
    if not isinstance(masks_value, list) or not masks_value:
        fail("overlay mask spec.masks must contain at least one mask")
    window_start = int(input_window["startFrame"])
    window_end = int(input_window["endFrameExclusive"])
    normalized_masks: List[Dict[str, Any]] = []
    seen_ids = set()
    for index, mask_value in enumerate(masks_value):
        field = "overlay mask spec.masks[%d]" % index
        mask = require_object_keys(
            mask_value,
            ("id", "startFrame", "endFrameExclusive", "shape"),
            (
                "selectorMode", "fillMode", "cleanAnchorFrames",
                "anchorRingOffsetOutputPixels", "featherOutputPixels",
                "boundarySampleRowsOutput", "bboxPaddingNativePixels",
                "sigmaOutputPixels", "maxDeltaDepthCodes",
            ),
            field,
        )
        mask_id = require_nonempty_text(mask["id"], "%s.id" % field)
        if mask_id in seen_ids:
            fail("overlay mask ids must be unique: %s" % mask_id)
        seen_ids.add(mask_id)
        start_frame = require_integer(mask["startFrame"], "%s.startFrame" % field)
        end_frame = require_integer(mask["endFrameExclusive"], "%s.endFrameExclusive" % field)
        if not window_start <= start_frame < end_frame <= window_end:
            fail(
                "%s frame range must be half-open and contained in source input window [%d,%d)"
                % (field, window_start, window_end)
            )
        normalized_shape = normalize_overlay_shape(mask["shape"], width, height, "%s.shape" % field)
        selector_mode = mask.get("selectorMode", OVERLAY_SELECTOR_GLYPH_COMPONENTS)
        if selector_mode not in (
            OVERLAY_SELECTOR_GLYPH_COMPONENTS,
            OVERLAY_SELECTOR_GLYPH_BBOX_TELEA,
            OVERLAY_SELECTOR_FULL_CANDIDATE,
        ):
            fail(
                "%s.selectorMode must be %s, %s, or %s"
                % (
                    field,
                    OVERLAY_SELECTOR_GLYPH_COMPONENTS,
                    OVERLAY_SELECTOR_GLYPH_BBOX_TELEA,
                    OVERLAY_SELECTOR_FULL_CANDIDATE,
                )
            )
        fill_mode = mask.get("fillMode", OVERLAY_FILL_TELEA)
        if fill_mode not in (
            OVERLAY_FILL_TELEA,
            OVERLAY_FILL_CLEAN_ANCHOR_PATCH,
            OVERLAY_FILL_VERTICAL_COLUMN_BAND,
            OVERLAY_FILL_HIGHPASS_SUPPRESSION,
        ):
            fail(
                "%s.fillMode must be %s, %s, %s, or %s"
                % (
                    field,
                    OVERLAY_FILL_TELEA,
                    OVERLAY_FILL_CLEAN_ANCHOR_PATCH,
                    OVERLAY_FILL_VERTICAL_COLUMN_BAND,
                    OVERLAY_FILL_HIGHPASS_SUPPRESSION,
                )
            )
        anchor_frames_value = mask.get("cleanAnchorFrames")
        ring_value = mask.get("anchorRingOffsetOutputPixels")
        feather_value = mask.get("featherOutputPixels")
        boundary_rows_value = mask.get("boundarySampleRowsOutput")
        bbox_padding_value = mask.get("bboxPaddingNativePixels")
        sigma_value = mask.get("sigmaOutputPixels")
        max_delta_value = mask.get("maxDeltaDepthCodes")
        if selector_mode == OVERLAY_SELECTOR_GLYPH_BBOX_TELEA:
            if fill_mode != OVERLAY_FILL_TELEA:
                fail(
                    "%s.selectorMode %s requires fillMode %s"
                    % (field, OVERLAY_SELECTOR_GLYPH_BBOX_TELEA, OVERLAY_FILL_TELEA)
                )
            bbox_padding = require_integer(
                bbox_padding_value
                if bbox_padding_value is not None
                else DEFAULT_GLYPH_BBOX_PADDING_NATIVE_PIXELS,
                "%s.bboxPaddingNativePixels" % field,
            )
            if not 0 <= bbox_padding <= 64:
                fail("%s.bboxPaddingNativePixels must be between 0 and 64" % field)
        else:
            if bbox_padding_value is not None:
                fail(
                    "%s.bboxPaddingNativePixels is supported only when selectorMode is %s"
                    % (field, OVERLAY_SELECTOR_GLYPH_BBOX_TELEA)
                )
            bbox_padding = 0
        if fill_mode == OVERLAY_FILL_TELEA:
            if (
                anchor_frames_value is not None
                or ring_value is not None
                or feather_value is not None
                or boundary_rows_value is not None
                or sigma_value is not None
                or max_delta_value is not None
            ):
                fail(
                    "%s cleanAnchorFrames/anchorRingOffsetOutputPixels/"
                    "boundarySampleRowsOutput/featherOutputPixels/"
                    "sigmaOutputPixels/maxDeltaDepthCodes are not supported "
                    "when fillMode is %s"
                    % (field, OVERLAY_FILL_TELEA)
                )
            clean_anchor_frames: List[int] = []
            ring_offset = 0
            feather = 0.0
            boundary_sample_rows = 0
            sigma_output_pixels = 0.0
            max_delta_depth_codes = 0.0
        elif fill_mode == OVERLAY_FILL_CLEAN_ANCHOR_PATCH:
            if boundary_rows_value is not None or sigma_value is not None or max_delta_value is not None:
                fail(
                    "%s boundarySampleRowsOutput/sigmaOutputPixels/maxDeltaDepthCodes "
                    "are not supported when fillMode is %s"
                    % (field, OVERLAY_FILL_CLEAN_ANCHOR_PATCH)
                )
            if not isinstance(anchor_frames_value, list) or not anchor_frames_value:
                fail("%s.cleanAnchorFrames must contain at least one absolute source frame" % field)
            clean_anchor_frames = []
            for anchor_index, anchor_value in enumerate(anchor_frames_value):
                anchor_field = "%s.cleanAnchorFrames[%d]" % (field, anchor_index)
                anchor_frame = require_integer(anchor_value, anchor_field)
                if not window_start <= anchor_frame < window_end:
                    fail(
                        "%s must be contained in source input window [%d,%d)"
                        % (anchor_field, window_start, window_end)
                    )
                if start_frame <= anchor_frame < end_frame:
                    fail(
                        "%s must be outside the mask's active text interval [%d,%d)"
                        % (anchor_field, start_frame, end_frame)
                    )
                clean_anchor_frames.append(anchor_frame)
            if len(set(clean_anchor_frames)) != len(clean_anchor_frames):
                fail("%s.cleanAnchorFrames must contain unique absolute source frames" % field)
            clean_anchor_frames.sort()
            ring_offset = require_integer(
                ring_value if ring_value is not None else DEFAULT_ANCHOR_RING_OFFSET_OUTPUT_PIXELS,
                "%s.anchorRingOffsetOutputPixels" % field,
            )
            if not 1 <= ring_offset <= 64:
                fail("%s.anchorRingOffsetOutputPixels must be between 1 and 64" % field)
            feather_raw = feather_value if feather_value is not None else DEFAULT_ANCHOR_FEATHER_OUTPUT_PIXELS
            if type(feather_raw) not in (int, float) or not math.isfinite(float(feather_raw)):
                fail("%s.featherOutputPixels must be a finite number" % field)
            feather = float(feather_raw)
            if not 0.0 <= feather <= 16.0:
                fail("%s.featherOutputPixels must be between 0 and 16" % field)
            boundary_sample_rows = 0
            sigma_output_pixels = 0.0
            max_delta_depth_codes = 0.0
        elif fill_mode == OVERLAY_FILL_VERTICAL_COLUMN_BAND:
            if selector_mode != OVERLAY_SELECTOR_GLYPH_COMPONENTS:
                fail(
                    "%s.fillMode %s requires selectorMode %s"
                    % (field, OVERLAY_FILL_VERTICAL_COLUMN_BAND, OVERLAY_SELECTOR_GLYPH_COMPONENTS)
                )
            if normalized_shape["type"] != "rect":
                fail(
                    "%s.fillMode %s requires a rect shape"
                    % (field, OVERLAY_FILL_VERTICAL_COLUMN_BAND)
                )
            if (
                anchor_frames_value is not None
                or ring_value is not None
                or sigma_value is not None
                or max_delta_value is not None
            ):
                fail(
                    "%s cleanAnchorFrames/anchorRingOffsetOutputPixels/"
                    "sigmaOutputPixels/maxDeltaDepthCodes are not supported "
                    "when fillMode is %s"
                    % (field, OVERLAY_FILL_VERTICAL_COLUMN_BAND)
                )
            clean_anchor_frames = []
            ring_offset = 0
            boundary_sample_rows = require_integer(
                boundary_rows_value
                if boundary_rows_value is not None
                else DEFAULT_VERTICAL_BOUNDARY_SAMPLE_ROWS_OUTPUT,
                "%s.boundarySampleRowsOutput" % field,
            )
            if not 1 <= boundary_sample_rows <= 64:
                fail("%s.boundarySampleRowsOutput must be between 1 and 64" % field)
            feather_raw = (
                feather_value
                if feather_value is not None
                else DEFAULT_VERTICAL_FEATHER_OUTPUT_PIXELS
            )
            if type(feather_raw) not in (int, float) or not math.isfinite(float(feather_raw)):
                fail("%s.featherOutputPixels must be a finite number" % field)
            feather = float(feather_raw)
            if not 0.0 <= feather <= 16.0:
                fail("%s.featherOutputPixels must be between 0 and 16" % field)
            sigma_output_pixels = 0.0
            max_delta_depth_codes = 0.0
        else:
            if selector_mode != OVERLAY_SELECTOR_FULL_CANDIDATE:
                fail(
                    "%s.fillMode %s requires selectorMode %s"
                    % (field, OVERLAY_FILL_HIGHPASS_SUPPRESSION, OVERLAY_SELECTOR_FULL_CANDIDATE)
                )
            if anchor_frames_value is not None or ring_value is not None or boundary_rows_value is not None:
                fail(
                    "%s cleanAnchorFrames/anchorRingOffsetOutputPixels/"
                    "boundarySampleRowsOutput are not supported when fillMode is %s"
                    % (field, OVERLAY_FILL_HIGHPASS_SUPPRESSION)
                )
            if sigma_value is None:
                fail("%s.sigmaOutputPixels is required when fillMode is %s" % (field, OVERLAY_FILL_HIGHPASS_SUPPRESSION))
            if type(sigma_value) not in (int, float) or not math.isfinite(float(sigma_value)):
                fail("%s.sigmaOutputPixels must be a finite number" % field)
            sigma_output_pixels = float(sigma_value)
            if not 0.5 <= sigma_output_pixels <= MAX_HIGHPASS_SIGMA_OUTPUT_PIXELS:
                fail(
                    "%s.sigmaOutputPixels must be between 0.5 and %g"
                    % (field, MAX_HIGHPASS_SIGMA_OUTPUT_PIXELS)
                )
            if max_delta_value is None:
                fail("%s.maxDeltaDepthCodes is required when fillMode is %s" % (field, OVERLAY_FILL_HIGHPASS_SUPPRESSION))
            if type(max_delta_value) not in (int, float) or not math.isfinite(float(max_delta_value)):
                fail("%s.maxDeltaDepthCodes must be a finite number" % field)
            max_delta_depth_codes = float(max_delta_value)
            if not 0.0 < max_delta_depth_codes <= MAX_HIGHPASS_DELTA_DEPTH_CODES:
                fail(
                    "%s.maxDeltaDepthCodes must be greater than 0 and at most %g"
                    % (field, MAX_HIGHPASS_DELTA_DEPTH_CODES)
                )
            if feather_value is None:
                fail("%s.featherOutputPixels is required when fillMode is %s" % (field, OVERLAY_FILL_HIGHPASS_SUPPRESSION))
            if type(feather_value) not in (int, float) or not math.isfinite(float(feather_value)):
                fail("%s.featherOutputPixels must be a finite number" % field)
            feather = float(feather_value)
            if not 0.0 <= feather <= MAX_HIGHPASS_FEATHER_OUTPUT_PIXELS:
                fail(
                    "%s.featherOutputPixels must be between 0 and %g"
                    % (field, MAX_HIGHPASS_FEATHER_OUTPUT_PIXELS)
                )
            clean_anchor_frames = []
            ring_offset = 0
            boundary_sample_rows = 0
        normalized_mask = {
            "id": mask_id,
            "startFrame": start_frame,
            "endFrameExclusive": end_frame,
            "shape": normalized_shape,
            "selectorMode": selector_mode,
            "fillMode": fill_mode,
            "cleanAnchorFrames": clean_anchor_frames,
            "anchorRingOffsetOutputPixels": ring_offset,
            "featherOutputPixels": feather,
        }
        if selector_mode == OVERLAY_SELECTOR_GLYPH_BBOX_TELEA:
            normalized_mask["bboxPaddingNativePixels"] = bbox_padding
        if fill_mode == OVERLAY_FILL_VERTICAL_COLUMN_BAND:
            normalized_mask["boundarySampleRowsOutput"] = boundary_sample_rows
        if fill_mode == OVERLAY_FILL_HIGHPASS_SUPPRESSION:
            normalized_mask["sigmaOutputPixels"] = sigma_output_pixels
            normalized_mask["maxDeltaDepthCodes"] = max_delta_depth_codes
        normalized_masks.append(normalized_mask)
    normalized_masks.sort(key=lambda item: (item["startFrame"], item["endFrameExclusive"], item["id"]))
    return {
        "schemaVersion": OVERLAY_MASK_SCHEMA_VERSION,
        "coordinateSpace": {"kind": OVERLAY_COORDINATE_KIND, "width": width, "height": height},
        "frameIndexing": OVERLAY_FRAME_INDEXING,
        "strategy": {
            "id": OVERLAY_STRATEGY_ID,
            "radiusOutputPixels": radius,
            "pixelSelector": normalize_overlay_pixel_selector(strategy["pixelSelector"]),
        },
        "masks": normalized_masks,
    }


def overlay_exclusion_contract(value: Optional[str], input_window: Dict[str, Any]) -> Dict[str, Any]:
    execution_policy = {
        "applicationStage": "after_temporal_stabilization_before_uint8_encoding",
        "maskCombination": "order_independent_union",
        "fillComposition": "telea_then_order_independent_vertical_band_mean_then_anchor_mean_then_nonoverlapping_highpass_suppression",
        "unmaskedPixels": "bit_exact_outside_selected_overlay_pixels",
        "cleanedDepthContinuesAsTemporalHistory": False,
        "preflightValidation": "all_distinct_active_mask_unions_before_inference_or_output_creation",
        "generative": False,
    }
    if not value:
        return {
            "enabled": False,
            "schemaVersion": OVERLAY_MASK_SCHEMA_VERSION,
            "coordinateSpace": OVERLAY_COORDINATE_KIND,
            "frameIndexing": OVERLAY_FRAME_INDEXING,
            "strategy": {
                "id": OVERLAY_STRATEGY_ID,
                "radiusOutputPixels": DEFAULT_OVERLAY_INPAINT_RADIUS,
                "pixelSelector": default_overlay_pixel_selector(),
            },
            **execution_policy,
        }
    spec_path = explicit_existing_file(value, "--overlay-mask-spec")
    try:
        raw_bytes = spec_path.read_bytes()
        raw_value = json.loads(raw_bytes.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail("--overlay-mask-spec must contain valid UTF-8 JSON: %s" % error)
    normalized = normalize_overlay_mask_spec(raw_value, input_window)
    return {
        "enabled": True,
        "specPath": str(spec_path),
        "specSha256": hashlib.sha256(raw_bytes).hexdigest(),
        "specFingerprint": stable_fingerprint(normalized),
        **normalized,
        **execution_policy,
    }


def explicit_model_directory(value: Optional[str]) -> Path:
    if not value:
        fail("--model-path is required")
    if "://" in value:
        fail("--model-path must be an explicit local directory, not a URL or model id")
    path = Path(value).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        fail("--model-path must resolve to an existing local directory: %s" % path)
    if not resolved.is_dir():
        fail("--model-path must resolve to an existing local directory: %s" % resolved)
    for filename in MODEL_CONFIG_FILES:
        if not (resolved / filename).is_file():
            fail("local model directory is missing %s" % filename)
    if not any((resolved / filename).is_file() for filename in PROCESSOR_CONFIG_FILES):
        fail("local model directory is missing a processor config (%s)" % ", ".join(PROCESSOR_CONFIG_FILES))
    if not any((resolved / filename).is_file() for filename in MODEL_WEIGHT_FILES):
        fail("local model directory is missing local model weights (%s)" % ", ".join(MODEL_WEIGHT_FILES))
    return resolved


def fingerprint_model_directory(model_path: Path) -> Dict[str, Any]:
    files: List[Dict[str, Any]] = []
    for path in sorted((candidate for candidate in model_path.rglob("*") if candidate.is_file()), key=lambda p: p.relative_to(model_path).as_posix()):
        relative = path.relative_to(model_path).as_posix()
        files.append({"path": relative, "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    if not files:
        fail("local model directory contains no files")
    manifest = {"path": str(model_path), "files": files}
    return {**manifest, "fingerprint": stable_fingerprint(manifest)}


def parse_fraction(value: str, field: str) -> Fraction:
    try:
        result = Fraction(value)
    except (ValueError, ZeroDivisionError):
        fail("%s must be a positive rational such as 30 or 30000/1001" % field)
    if result <= 0:
        fail("%s must be positive" % field)
    return result


def parse_output_size(value: str) -> Tuple[int, int]:
    try:
        width_text, height_text = value.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except (ValueError, AttributeError):
        fail("--output-size must use WIDTHxHEIGHT, for example 720x1280")
    if width < 2 or height < 2 or width % 2 or height % 2:
        fail("--output-size dimensions must be positive even integers")
    if min(width, height) < 720:
        fail("--output-size short edge must be at least 720")
    return width, height


def parse_segments(value: str, expected_frames: int, fps: Fraction) -> List[Segment]:
    if expected_frames <= 0:
        fail("--expect-frames must be positive")
    raw_parts = value.split(",") if value else []
    if not raw_parts:
        fail("--segments must contain at least one half-open frame range")
    segments: List[Segment] = []
    for index, part in enumerate(raw_parts, start=1):
        try:
            start_text, end_text = part.split(":", 1)
            start, end = int(start_text), int(end_text)
        except ValueError:
            fail("--segments entries must use START:END half-open frame ranges")
        if start < 0 or end <= start:
            fail("segment %d must have 0 <= start < end" % index)
        segments.append(Segment(index=index, start_frame=start, end_frame_exclusive=end))
    if segments[0].start_frame != 0:
        fail("segments must start at source frame 0")
    for previous, current in zip(segments, segments[1:]):
        if previous.end_frame_exclusive != current.start_frame:
            fail("segments must be contiguous with no gaps or duplicate frames")
    if segments[-1].end_frame_exclusive != expected_frames:
        fail("segments must end exactly at --expect-frames")
    for segment in segments:
        duration = Fraction(segment.frame_count, 1) / fps
        if duration > MAX_SEGMENT_SECONDS:
            fail("segment %d exceeds the 15-second maximum" % segment.index)
    return segments


def validate_weights(current_weight: float, history_weight: float) -> None:
    if not MIN_CURRENT_WEIGHT <= current_weight <= 1.0:
        fail("--current-weight must be between 0.75 and 1.0")
    if not 0.0 <= history_weight <= MAX_HISTORY_WEIGHT:
        fail("--history-weight must be between 0.0 and 0.25")
    if not math.isclose(current_weight + history_weight, 1.0, rel_tol=0.0, abs_tol=1e-9):
        fail("current and history weights must sum to exactly 1.0")


def ensure_non_overwriting_outputs(input_path: Path, output_dir: Path, metadata_path: Path, segments: Sequence[Segment]) -> None:
    input_resolved = input_path.resolve(strict=True)
    if metadata_path.exists():
        fail("refusing to overwrite metadata: %s" % metadata_path)
    prospective = [metadata_path] + [output_dir / segment.filename for segment in segments]
    for path in prospective:
        if path.exists():
            fail("refusing to overwrite output: %s" % path)
        if path.resolve(strict=False) == input_resolved:
            fail("an output path aliases the read-only input: %s" % path)


def base_contract() -> Dict[str, Any]:
    return {
        "runnerId": RUNNER_ID,
        "modelPolicy": {
            "explicitExistingLocalDirectoryRequired": True,
            "implicitDownloads": False,
            "transformersOffline": True,
            "sameModelAndPreprocessingForEveryFrame": True,
        },
        "normalization": {
            "scope": "all_frames_all_native_depth_pixels",
            "method": "exact_linear_percentile_from_disk_memmap",
            "lowPercentile": DEFAULT_LOW_PERCENTILE,
            "highPercentile": DEFAULT_HIGH_PERCENTILE,
            "perFrameContrastStretch": False,
        },
        "depthEncoding": {"near": "white", "far": "black", "intermediate": "continuous_grayscale"},
        "temporalStabilization": {
            "method": "forward_backward_optical_flow_consistency",
            "currentWeightAtLeast": MIN_CURRENT_WEIGHT,
            "historyWeightAtMost": MAX_HISTORY_WEIGHT,
            "resetOn": ["scene_cut", "low_flow_confidence", "fast_motion"],
        },
        "overlayExclusion": {
            "optional": True,
            "maskSchemaVersion": OVERLAY_MASK_SCHEMA_VERSION,
            "coordinateSpace": OVERLAY_COORDINATE_KIND,
            "frameIndexing": OVERLAY_FRAME_INDEXING,
            "supportedShapes": ["rect", "polygon"],
            "strategy": OVERLAY_STRATEGY_ID,
            "pixelSelector": OVERLAY_PIXEL_SELECTOR_ID,
            "selectorModes": [
                OVERLAY_SELECTOR_GLYPH_COMPONENTS,
                OVERLAY_SELECTOR_GLYPH_BBOX_TELEA,
                OVERLAY_SELECTOR_FULL_CANDIDATE,
            ],
            "fillModes": [
                OVERLAY_FILL_TELEA,
                OVERLAY_FILL_CLEAN_ANCHOR_PATCH,
                OVERLAY_FILL_VERTICAL_COLUMN_BAND,
                OVERLAY_FILL_HIGHPASS_SUPPRESSION,
            ],
            "candidateRegionsOnly": True,
            "applicationStage": "after_temporal_stabilization_before_uint8_encoding",
            "maskCombination": "order_independent_union",
            "fillComposition": "telea_then_order_independent_vertical_band_mean_then_anchor_mean_then_nonoverlapping_highpass_suppression",
            "unmaskedPixels": "bit_exact_outside_selected_overlay_pixels",
            "cleanedDepthContinuesAsTemporalHistory": False,
            "cleanAnchorPatch": {
                "frameIndexing": OVERLAY_FRAME_INDEXING,
                "anchorFramesMustBeOutsideOwnActiveInterval": True,
                "ringOffsetPurpose": "median_scalar_depth_alignment_outside_selected_roi",
                "defaultRingOffsetOutputPixels": DEFAULT_ANCHOR_RING_OFFSET_OUTPUT_PIXELS,
                "defaultFeatherOutputPixels": DEFAULT_ANCHOR_FEATHER_OUTPUT_PIXELS,
            },
            "verticalColumnBand": {
                "selectorMode": OVERLAY_SELECTOR_GLYPH_COMPONENTS,
                "shape": "rect",
                "columnSupport": "selected_glyph_output_mask",
                "fill": "per_column_top_bottom_median_linear_interpolation",
                "defaultBoundarySampleRowsOutput": DEFAULT_VERTICAL_BOUNDARY_SAMPLE_ROWS_OUTPUT,
                "defaultFeatherOutputPixels": DEFAULT_VERTICAL_FEATHER_OUTPUT_PIXELS,
                "feathering": "inside_band_only",
                "unsupportedColumns": "bit_exact",
            },
            "highpassSuppression": {
                "selectorMode": OVERLAY_SELECTOR_FULL_CANDIDATE,
                "source": "same_stabilized_frame",
                "target": "gaussian_low_frequency_of_same_frame",
                "sigmaOutputPixels": "explicit_per_mask",
                "maxDeltaDepthCodes": "explicit_per_mask",
                "featherOutputPixels": "explicit_per_mask_inside_mask_only",
                "overlapPolicy": "reject_any_concurrent_candidate_overlap",
                "unmaskedPixels": "bit_exact",
            },
            "glyphBoundingBoxTelea": {
                "selectorMode": OVERLAY_SELECTOR_GLYPH_BBOX_TELEA,
                "fillMode": OVERLAY_FILL_TELEA,
                "componentAttribution": "independent_per_mask",
                "coreColor": "source_yellow_only",
                "componentMinimum": "pixel_selector_minimum_applied",
                "componentMaximum": "not_applied_bbox_occupancy_is_authoritative",
                "boundingBox": "half_open_union_of_retained_glyph_core",
                "defaultPaddingNativePixels": DEFAULT_GLYPH_BBOX_PADDING_NATIVE_PIXELS,
                "clipping": "own_candidate_region_only",
                "emptyCore": "bit_exact",
                "occupancyGuard": "fail_closed_per_mask_and_guarded_union",
            },
            "preflightValidation": "all_distinct_active_mask_unions_before_inference_or_output_creation",
            "generative": False,
        },
        "output": {
            "container": "mp4",
            "codec": "h264",
            "pixelFormat": "yuv420p",
            "audio": False,
            "maxSegmentDurationSeconds": MAX_SEGMENT_SECONDS,
            "defaultFrameRate": str(DEFAULT_EXPECTED_FPS),
            "defaultSourceWindow": "[0,555)",
            "defaultFrameCount": DEFAULT_EXPECTED_FRAMES,
            "defaultSize": "%dx%d" % DEFAULT_OUTPUT_SIZE,
            "defaultSegments": DEFAULT_SEGMENTS,
        },
    }


def effective_contract(arguments: argparse.Namespace) -> Dict[str, Any]:
    input_path = explicit_existing_file(arguments.input, "--input")
    model_path = explicit_model_directory(arguments.model_path)
    fps = parse_fraction(arguments.expect_fps, "--expect-fps")
    output_size = parse_output_size(arguments.output_size)
    segments = parse_segments(arguments.segments, arguments.expect_frames, fps)
    if arguments.start_frame < 0:
        fail("--start-frame must be zero or greater")
    validate_weights(arguments.current_weight, arguments.history_weight)
    if not 0.0 <= arguments.low_percentile < arguments.high_percentile <= 100.0:
        fail("percentiles must satisfy 0 <= low < high <= 100")
    if arguments.model_output not in ("inverse_depth", "depth"):
        fail("--model-output must explicitly be inverse_depth or depth")
    if not arguments.output_dir:
        fail("--output-dir is required")
    if not arguments.metadata:
        fail("--metadata is required")
    output_dir = Path(arguments.output_dir).expanduser().resolve(strict=False)
    metadata_path = Path(arguments.metadata).expanduser().resolve(strict=False)
    ensure_non_overwriting_outputs(input_path, output_dir, metadata_path, segments)
    contract = base_contract()
    input_window = {
        "startFrame": arguments.start_frame,
        "endFrameExclusive": arguments.start_frame + arguments.expect_frames,
        "frameCount": arguments.expect_frames,
        "startSeconds": float(Fraction(arguments.start_frame, 1) / fps),
        "endSecondsExclusive": float(Fraction(arguments.start_frame + arguments.expect_frames, 1) / fps),
    }
    contract.update({
        "input": str(input_path),
        "modelPath": str(model_path),
        "modelOutputSemantics": arguments.model_output,
        "inputWindow": input_window,
        "expectedFrames": arguments.expect_frames,
        "expectedFps": str(fps),
        "outputSize": {"width": output_size[0], "height": output_size[1]},
        "outputDirectory": str(output_dir),
        "metadataPath": str(metadata_path),
        "percentiles": {"low": arguments.low_percentile, "high": arguments.high_percentile},
        "weights": {"current": arguments.current_weight, "history": arguments.history_weight},
        "segments": [
            {
                **asdict(segment),
                "frameCount": segment.frame_count,
                "durationSeconds": float(Fraction(segment.frame_count, 1) / fps),
                "filename": segment.filename,
            }
            for segment in segments
        ],
        "overlayExclusion": overlay_exclusion_contract(arguments.overlay_mask_spec, input_window),
    })
    contract["contractFingerprint"] = stable_fingerprint(contract)
    return contract


def run_command(executable: str, arguments: Sequence[str]) -> Dict[str, Any]:
    completed = subprocess.run(
        [executable, *arguments],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError("%s failed (%d): %s" % (executable, completed.returncode, completed.stderr.strip()))
    return {"stdout": completed.stdout, "stderr": completed.stderr}


def probe_video(path: Path, ffprobe: str) -> Dict[str, Any]:
    result = run_command(ffprobe, [
        "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,pix_fmt",
        "-of", "json", str(path),
    ])
    try:
        payload = json.loads(result["stdout"])
        streams = payload["streams"]
        stream = streams[0]
    except (ValueError, KeyError, IndexError, TypeError):
        raise RuntimeError("ffprobe returned invalid or missing video-stream JSON for %s" % path)
    frame_text = stream.get("nb_read_frames") or stream.get("nb_frames")
    try:
        frame_count = int(frame_text)
        width = int(stream["width"])
        height = int(stream["height"])
        average_fps = Fraction(stream["avg_frame_rate"])
        nominal_fps = Fraction(stream["r_frame_rate"])
    except (ValueError, KeyError, TypeError, ZeroDivisionError):
        raise RuntimeError("ffprobe returned incomplete frame-count, size, or frame-rate metadata")
    return {
        "width": width,
        "height": height,
        "frameCount": frame_count,
        "averageFps": average_fps,
        "nominalFps": nominal_fps,
        "pixelFormat": stream.get("pix_fmt"),
    }


def verify_source_probe(probe: Dict[str, Any], contract: Dict[str, Any]) -> None:
    expected_fps = Fraction(contract["expectedFps"])
    required_end = contract["inputWindow"]["endFrameExclusive"]
    if probe["frameCount"] < required_end:
        raise RuntimeError(
            "source has %d decoded frames; locked input window requires frames through %d"
            % (probe["frameCount"], required_end - 1)
        )
    if probe["averageFps"] != expected_fps or probe["nominalFps"] != expected_fps:
        raise RuntimeError(
            "source must be constant %s fps; ffprobe reported avg=%s nominal=%s"
            % (expected_fps, probe["averageFps"], probe["nominalFps"])
        )
    output_width = contract["outputSize"]["width"]
    output_height = contract["outputSize"]["height"]
    if probe["width"] * output_height != probe["height"] * output_width:
        raise RuntimeError("720x1280 output would change the source aspect ratio; cropping, padding, and stretching are forbidden")


def configure_offline_runtime(device_name: str, torch_threads: int) -> Tuple[Any, Any, Any, Any]:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        import torch  # type: ignore
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation  # type: ignore
    except ImportError as error:
        raise RuntimeError("runner dependency is unavailable: %s" % error)
    random.seed(0)
    np.random.seed(0)
    torch.manual_seed(0)
    torch.set_num_threads(torch_threads)
    torch.set_grad_enabled(False)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    torch.use_deterministic_algorithms(True)
    if device_name == "cpu":
        device = torch.device("cpu")
    elif device_name == "mps":
        if not torch.backends.mps.is_available():
            raise RuntimeError("MPS was requested but is unavailable")
        device = torch.device("mps")
    elif device_name == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is unavailable")
        device = torch.device("cuda")
    else:
        raise RuntimeError("unsupported device: %s" % device_name)
    return cv2, np, torch, (AutoImageProcessor, AutoModelForDepthEstimation, device)


class LocalDepthModel:
    def __init__(self, model_path: Path, runtime: Tuple[Any, Any, Any]) -> None:
        AutoImageProcessor, AutoModelForDepthEstimation, device = runtime
        self.device = device
        # Pin the slow processor explicitly. Transformers plans to change the
        # implicit default, which would otherwise silently change preprocessing.
        self.processor = AutoImageProcessor.from_pretrained(
            str(model_path), local_files_only=True, use_fast=False,
        )
        self.model = AutoModelForDepthEstimation.from_pretrained(str(model_path), local_files_only=True)
        self.model.to(device)
        self.model.eval()

    def predict_native(self, frame_bgr: Any, cv2: Any, torch: Any) -> Any:
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        inputs = self.processor(images=frame_rgb, return_tensors="pt")
        inputs = {name: value.to(self.device) for name, value in inputs.items()}
        with torch.inference_mode():
            prediction = self.model(**inputs).predicted_depth
        if prediction.ndim == 4 and prediction.shape[1] == 1:
            prediction = prediction[:, 0]
        if prediction.ndim != 3 or prediction.shape[0] != 1:
            raise RuntimeError("local model predicted_depth must have shape [1,H,W] or [1,1,H,W]")
        depth = prediction[0].detach().float().cpu().numpy()
        return depth


def open_capture(input_path: Path, cv2: Any) -> Any:
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise RuntimeError("OpenCV could not decode input video: %s" % input_path)
    return capture


def inference_pass(
    input_path: Path,
    model: LocalDepthModel,
    start_frame: int,
    frame_count: int,
    scratch_path: Path,
    cv2: Any,
    np: Any,
    torch: Any,
) -> Tuple[Any, Tuple[int, int]]:
    capture = open_capture(input_path, cv2)
    depth_cache = None
    native_shape: Optional[Tuple[int, int]] = None
    index = 0
    try:
        for skipped in range(start_frame):
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError("OpenCV reached EOF while skipping to locked source frame %d" % start_frame)
        while index < frame_count:
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError("OpenCV reached EOF inside the locked input window at relative frame %d" % index)
            depth = model.predict_native(frame, cv2, torch)
            if not np.isfinite(depth).all():
                raise RuntimeError("model produced non-finite depth at frame %d" % index)
            if native_shape is None:
                native_shape = (int(depth.shape[0]), int(depth.shape[1]))
                depth_cache = np.memmap(
                    str(scratch_path), mode="w+", dtype=np.float32,
                    shape=(frame_count, native_shape[0], native_shape[1]),
                )
            if depth.shape != native_shape:
                raise RuntimeError("model native depth shape changed at frame %d" % index)
            depth_cache[index] = depth.astype(np.float32, copy=False)
            index += 1
            if index % 10 == 0 or index == frame_count:
                json_print({"stage": "inference_pass", "framesComplete": index, "framesTotal": frame_count})
    finally:
        capture.release()
    if index != frame_count or depth_cache is None or native_shape is None:
        raise RuntimeError("OpenCV decoded %d frames; expected %d" % (index, frame_count))
    depth_cache.flush()
    return depth_cache, native_shape


def exact_linear_percentiles_from_memmap(depth_cache: Any, percentages: Sequence[float], work_path: Path, np: Any) -> List[float]:
    """Exact NumPy-linear percentiles using a disposable on-disk partition copy."""
    source = depth_cache.reshape(-1)
    total = int(source.size)
    if total < 2:
        raise RuntimeError("depth cache has too few samples for robust percentiles")
    work = np.memmap(str(work_path), mode="w+", dtype=np.float32, shape=(total,))
    chunk = 4 * 1024 * 1024
    for start in range(0, total, chunk):
        end = min(total, start + chunk)
        work[start:end] = source[start:end]
    work.flush()
    positions = [(total - 1) * (float(percent) / 100.0) for percent in percentages]
    indices = sorted(set([int(math.floor(position)) for position in positions] + [int(math.ceil(position)) for position in positions]))
    work.partition(indices)
    values: List[float] = []
    for position in positions:
        lower = int(math.floor(position))
        upper = int(math.ceil(position))
        fraction = position - lower
        values.append(float(work[lower]) * (1.0 - fraction) + float(work[upper]) * fraction)
    del work
    return values


def scene_cut_distance(previous_gray: Any, current_gray: Any, cv2: Any) -> float:
    previous_hist = cv2.calcHist([previous_gray], [0], None, [64], [0, 256])
    current_hist = cv2.calcHist([current_gray], [0], None, [64], [0, 256])
    cv2.normalize(previous_hist, previous_hist, alpha=1.0, norm_type=cv2.NORM_L1)
    cv2.normalize(current_hist, current_hist, alpha=1.0, norm_type=cv2.NORM_L1)
    return float(cv2.compareHist(previous_hist, current_hist, cv2.HISTCMP_BHATTACHARYYA))


def flow_warp_and_confidence(
    previous_gray: Any,
    current_gray: Any,
    previous_depth: Any,
    cv2: Any,
    np: Any,
    flow_scale: float,
    photometric_threshold: float,
    forward_backward_threshold: float,
) -> Tuple[Any, Any, float]:
    height, width = current_gray.shape
    small_width = max(16, int(round(width * flow_scale)))
    small_height = max(16, int(round(height * flow_scale)))
    previous_small = cv2.resize(previous_gray, (small_width, small_height), interpolation=cv2.INTER_AREA)
    current_small = cv2.resize(current_gray, (small_width, small_height), interpolation=cv2.INTER_AREA)
    flow_forward_small = cv2.calcOpticalFlowFarneback(
        previous_small, current_small, None, 0.5, 3, 15, 3, 5, 1.2, 0,
    )
    flow_backward_small = cv2.calcOpticalFlowFarneback(
        current_small, previous_small, None, 0.5, 3, 15, 3, 5, 1.2, 0,
    )
    flow_forward = cv2.resize(flow_forward_small, (width, height), interpolation=cv2.INTER_LINEAR)
    flow_backward = cv2.resize(flow_backward_small, (width, height), interpolation=cv2.INTER_LINEAR)
    flow_forward[..., 0] *= float(width) / small_width
    flow_forward[..., 1] *= float(height) / small_height
    flow_backward[..., 0] *= float(width) / small_width
    flow_backward[..., 1] *= float(height) / small_height
    grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    source_x = grid_x + flow_backward[..., 0]
    source_y = grid_y + flow_backward[..., 1]
    inside = (source_x >= 0.0) & (source_x <= width - 1.0) & (source_y >= 0.0) & (source_y <= height - 1.0)
    warped_depth = cv2.remap(previous_depth, source_x, source_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    warped_gray = cv2.remap(previous_gray, source_x, source_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    warped_forward_x = cv2.remap(flow_forward[..., 0], source_x, source_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    warped_forward_y = cv2.remap(flow_forward[..., 1], source_x, source_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    consistency_error = np.sqrt(
        np.square(flow_backward[..., 0] + warped_forward_x)
        + np.square(flow_backward[..., 1] + warped_forward_y)
    )
    photometric_error = cv2.absdiff(current_gray, warped_gray)
    confidence = inside & (consistency_error <= forward_backward_threshold) & (photometric_error <= photometric_threshold)
    motion = np.sqrt(np.square(flow_backward[..., 0]) + np.square(flow_backward[..., 1]))
    median_motion = float(np.median(motion[inside])) if bool(inside.any()) else float("inf")
    return warped_depth, confidence, median_motion


def stabilize_depth(
    previous_gray: Any,
    current_gray: Any,
    previous_depth: Any,
    current_depth: Any,
    cv2: Any,
    np: Any,
    current_weight: float,
    history_weight: float,
    flow_scale: float,
    photometric_threshold: float,
    forward_backward_threshold: float,
    minimum_confidence: float,
    cut_threshold: float,
    fast_motion_pixels: float,
) -> Tuple[Any, Dict[str, Any]]:
    cut_distance = scene_cut_distance(previous_gray, current_gray, cv2)
    if cut_distance >= cut_threshold:
        return current_depth, {"reset": True, "reason": "scene_cut", "cutDistance": cut_distance}
    warped_depth, confidence, median_motion = flow_warp_and_confidence(
        previous_gray, current_gray, previous_depth, cv2, np,
        flow_scale, photometric_threshold, forward_backward_threshold,
    )
    if median_motion >= fast_motion_pixels:
        return current_depth, {"reset": True, "reason": "fast_motion", "medianMotionPixels": median_motion}
    gradient_x = cv2.Sobel(current_depth, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(current_depth, cv2.CV_32F, 0, 1, ksize=3)
    edge_strength = np.sqrt(np.square(gradient_x) + np.square(gradient_y))
    agreement_limit = np.where(edge_strength >= 0.08, 0.08, 0.20)
    confidence = confidence & (np.abs(current_depth - warped_depth) <= agreement_limit)
    confidence_ratio = float(confidence.mean())
    if confidence_ratio < minimum_confidence:
        return current_depth, {"reset": True, "reason": "low_flow_confidence", "confidence": confidence_ratio}
    stabilized = current_depth.copy()
    stabilized[confidence] = current_weight * current_depth[confidence] + history_weight * warped_depth[confidence]
    return stabilized, {
        "reset": False,
        "confidence": confidence_ratio,
        "medianMotionPixels": median_motion,
        "cutDistance": cut_distance,
    }


class SegmentWriter:
    def __init__(
        self,
        partial_path: Path,
        width: int,
        height: int,
        fps: Fraction,
        expected_frames: int,
        ffmpeg: str,
        preset: str,
        crf: int,
    ) -> None:
        self.partial_path = partial_path
        self.expected_frames = expected_frames
        self.frames_written = 0
        self.process = subprocess.Popen(
            [
                ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
                "-f", "rawvideo", "-pix_fmt", "gray", "-s", "%dx%d" % (width, height),
                "-framerate", str(fps), "-i", "pipe:0", "-frames:v", str(expected_frames),
                "-an", "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
                "-pix_fmt", "yuv420p", "-r", str(fps), "-movflags", "+faststart", "-f", "mp4",
                str(partial_path),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        if self.process.stdin is None:
            raise RuntimeError("could not open ffmpeg raw-video stdin")

    def write(self, gray_frame: Any) -> None:
        if self.process.stdin is None:
            raise RuntimeError("ffmpeg writer is already closed")
        self.process.stdin.write(gray_frame.tobytes())
        self.frames_written += 1

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
            self.process.stdin = None
        stderr = self.process.stderr.read().decode("utf-8", errors="replace") if self.process.stderr else ""
        return_code = self.process.wait()
        if return_code != 0:
            raise RuntimeError("ffmpeg H.264 encode failed (%d): %s" % (return_code, stderr.strip()))
        if self.frames_written != self.expected_frames:
            raise RuntimeError("ffmpeg writer received %d frames; expected %d" % (self.frames_written, self.expected_frames))


def normalize_depth(raw_depth: Any, low_bound: float, high_bound: float, model_output: str, np: Any) -> Any:
    normalized = np.clip((raw_depth - low_bound) / (high_bound - low_bound), 0.0, 1.0)
    if model_output == "depth":
        normalized = 1.0 - normalized
    return normalized.astype(np.float32, copy=False)


def verify_overlay_source_size(overlay_contract: Dict[str, Any], source_probe: Dict[str, Any]) -> None:
    if not overlay_contract.get("enabled"):
        return
    coordinate_space = overlay_contract["coordinateSpace"]
    expected = (int(coordinate_space["width"]), int(coordinate_space["height"]))
    actual = (int(source_probe["width"]), int(source_probe["height"]))
    if expected != actual:
        raise RuntimeError(
            "overlay mask native coordinate space is %dx%d but the source video is %dx%d"
            % (expected[0], expected[1], actual[0], actual[1])
        )


def mask_bounds(mask: Any, np: Any) -> Dict[str, int]:
    rows, columns = np.nonzero(mask)
    if rows.size == 0:
        raise RuntimeError("overlay mask rasterized to zero pixels")
    return {
        "x0": int(columns.min()),
        "y0": int(rows.min()),
        "x1Exclusive": int(columns.max()) + 1,
        "y1Exclusive": int(rows.max()) + 1,
    }


def compile_overlay_masks(
    overlay_contract: Dict[str, Any],
    output_width: int,
    output_height: int,
    cv2: Any,
    np: Any,
) -> List[Dict[str, Any]]:
    if not overlay_contract.get("enabled"):
        return []
    coordinate_space = overlay_contract["coordinateSpace"]
    source_width = int(coordinate_space["width"])
    source_height = int(coordinate_space["height"])
    compiled: List[Dict[str, Any]] = []
    for item in overlay_contract["masks"]:
        native_mask = np.zeros((source_height, source_width), dtype=np.uint8)
        shape = item["shape"]
        if shape["type"] == "rect":
            native_mask[
                shape["y0"]:shape["y1Exclusive"],
                shape["x0"]:shape["x1Exclusive"],
            ] = 255
        elif shape["type"] == "polygon":
            vertices = np.asarray(shape["points"], dtype=np.int32)
            cv2.fillPoly(native_mask, [vertices], 255, lineType=cv2.LINE_8)
        else:
            raise RuntimeError("unsupported normalized overlay shape: %s" % shape["type"])
        if not bool(native_mask.any()):
            raise RuntimeError("overlay mask %s rasterized to zero native pixels" % item["id"])
        output_mask = cv2.resize(
            native_mask,
            (output_width, output_height),
            interpolation=cv2.INTER_NEAREST,
        )
        output_mask = np.where(output_mask > 0, 255, 0).astype(np.uint8)
        compiled.append({
            "id": item["id"],
            "startFrame": item["startFrame"],
            "endFrameExclusive": item["endFrameExclusive"],
            "selectorMode": item.get("selectorMode", OVERLAY_SELECTOR_GLYPH_COMPONENTS),
            "bboxPaddingNativePixels": int(item.get("bboxPaddingNativePixels", 0)),
            "fillMode": item.get("fillMode", OVERLAY_FILL_TELEA),
            "cleanAnchorFrames": list(item.get("cleanAnchorFrames", [])),
            "anchorRingOffsetOutputPixels": int(item.get("anchorRingOffsetOutputPixels", 0)),
            "featherOutputPixels": float(item.get("featherOutputPixels", 0.0)),
            "boundarySampleRowsOutput": int(item.get("boundarySampleRowsOutput", 0)),
            "sigmaOutputPixels": float(item.get("sigmaOutputPixels", 0.0)),
            "maxDeltaDepthCodes": float(item.get("maxDeltaDepthCodes", 0.0)),
            "shapeType": shape["type"],
            "nativeMask": native_mask,
            "mask": output_mask,
            "nativePixelCount": int(np.count_nonzero(native_mask)),
            "outputPixelCount": int(np.count_nonzero(output_mask)),
            "nativeBounds": mask_bounds(native_mask, np),
            "outputBounds": mask_bounds(output_mask, np),
        })
    return compiled


def active_overlay_mask(
    compiled_masks: Sequence[Dict[str, Any]],
    absolute_source_frame: int,
    output_shape: Tuple[int, int],
    np: Any,
) -> Tuple[Optional[Any], List[str]]:
    active = [
        item for item in compiled_masks
        if item["startFrame"] <= absolute_source_frame < item["endFrameExclusive"]
    ]
    if not active:
        return None, []
    union = np.zeros(output_shape, dtype=np.uint8)
    for item in active:
        union = np.maximum(union, item["mask"])
    return union, [item["id"] for item in active]


def retained_overlay_components(
    raw_selected: Any,
    selector: Dict[str, Any],
    cv2: Any,
    np: Any,
    enforce_maximum: bool = True,
) -> Tuple[Any, int, int]:
    """Return retained connected components plus diagnostic counts.

    Callers decide the attribution domain before invoking this helper.  In
    particular, glyph-bbox masks call it independently so a component touching
    a neighboring ROI can never activate or enlarge that neighbor's box.  The
    yellow-only bbox mode disables the legacy maximum component-size filter and
    relies on its expanded-box occupancy guard; the minimum remains mandatory.
    """
    component_count, labels, statistics, _ = cv2.connectedComponentsWithStats(
        raw_selected, connectivity=8, ltype=cv2.CV_32S,
    )
    kept = np.zeros_like(raw_selected)
    kept_component_count = 0
    for label in range(1, component_count):
        area = int(statistics[label, cv2.CC_STAT_AREA])
        meets_minimum = area >= selector["minComponentPixelsNative"]
        meets_maximum = (
            area <= selector["maxComponentPixelsNative"]
            if enforce_maximum
            else True
        )
        if meets_minimum and meets_maximum:
            kept[labels == label] = 255
            kept_component_count += 1
    return kept, component_count - 1, kept_component_count


def select_overlay_pixels(
    source_frame_bgr: Any,
    compiled_masks: Sequence[Dict[str, Any]],
    absolute_source_frame: int,
    output_width: int,
    output_height: int,
    selector: Dict[str, Any],
    cv2: Any,
    np: Any,
) -> Tuple[Optional[Any], List[str], Dict[str, Any]]:
    active = [
        item for item in compiled_masks
        if item["startFrame"] <= absolute_source_frame < item["endFrameExclusive"]
    ]
    if not active:
        return None, [], {
            "candidatePixelsNative": 0,
            "rawSelectedPixelsNative": 0,
            "selectedPixelsNative": 0,
            "selectedPixelsOutput": 0,
            "componentCount": 0,
            "keptComponentCount": 0,
            "selectedFractionOfCandidate": 0.0,
            "selectedMaskIds": [],
            "perMaskSelectedNativePixels": {},
            "perMaskSelectedNativeBounds": {},
            "perMaskSelectedOutputPixels": {},
            "perMaskSelectedFraction": {},
            "rejectedMaskIds": [],
            "rejectedReason": None,
            "occupancyGuardBypassedMaskIds": [],
            "selectedOutputMasks": {},
        }
    if source_frame_bgr.ndim != 3 or source_frame_bgr.shape[2] < 3:
        raise RuntimeError("overlay pixel selection requires a native BGR source frame")
    native_height, native_width = active[0]["nativeMask"].shape
    if source_frame_bgr.shape[0] != native_height or source_frame_bgr.shape[1] != native_width:
        raise RuntimeError(
            "overlay pixel selector source frame is %dx%d but mask coordinates are %dx%d"
            % (source_frame_bgr.shape[1], source_frame_bgr.shape[0], native_width, native_height)
        )
    candidate = np.zeros((native_height, native_width), dtype=np.uint8)
    for item in active:
        candidate = np.maximum(candidate, item["nativeMask"])
    blue = source_frame_bgr[..., 0].astype(np.int16)
    green = source_frame_bgr[..., 1].astype(np.int16)
    red = source_frame_bgr[..., 2].astype(np.int16)
    minimum_channel = np.minimum(np.minimum(red, green), blue)
    maximum_channel = np.maximum(np.maximum(red, green), blue)
    hsv = cv2.cvtColor(source_frame_bgr[..., :3], cv2.COLOR_BGR2HSV)
    hue = hsv[..., 0]
    saturation = hsv[..., 1]
    value = hsv[..., 2]
    white = (
        (minimum_channel >= selector["whiteMinChannel"])
        & ((maximum_channel - minimum_channel) <= selector["whiteMaxChannelSpread"])
    )
    yellow = (
        (red >= selector["yellowMinRed"])
        & (green >= selector["yellowMinGreen"])
        & (blue <= selector["yellowMaxBlue"])
        & (hue >= selector["yellowHueMin"])
        & (hue <= selector["yellowHueMax"])
        & (saturation >= selector["yellowMinSaturation"])
        & (value >= selector["yellowMinValue"])
    )
    legacy_glyph_candidate = np.zeros_like(candidate)
    full_candidate = np.zeros_like(candidate)
    bbox_items: List[Dict[str, Any]] = []
    for item in active:
        selector_mode = item.get("selectorMode", OVERLAY_SELECTOR_GLYPH_COMPONENTS)
        if selector_mode == OVERLAY_SELECTOR_FULL_CANDIDATE:
            full_candidate = np.maximum(full_candidate, item["nativeMask"])
        else:
            if selector_mode == OVERLAY_SELECTOR_GLYPH_BBOX_TELEA:
                bbox_items.append(item)
            else:
                legacy_glyph_candidate = np.maximum(legacy_glyph_candidate, item["nativeMask"])
    legacy_raw_selected = np.where(
        (legacy_glyph_candidate > 0) & (white | yellow), 255, 0,
    ).astype(np.uint8)
    kept, component_count, kept_component_count = retained_overlay_components(
        legacy_raw_selected, selector, cv2, np,
    )
    bbox_core_by_mask: Dict[str, Any] = {}
    bbox_raw_selected = np.zeros_like(candidate)
    for item in bbox_items:
        raw_for_mask = np.where(
            (item["nativeMask"] > 0) & yellow, 255, 0,
        ).astype(np.uint8)
        retained, mask_component_count, mask_kept_component_count = retained_overlay_components(
            raw_for_mask, selector, cv2, np, enforce_maximum=False,
        )
        bbox_raw_selected = np.maximum(bbox_raw_selected, raw_for_mask)
        bbox_core_by_mask[item["id"]] = retained
        component_count += mask_component_count
        kept_component_count += mask_kept_component_count
    raw_selected = np.maximum(legacy_raw_selected, bbox_raw_selected)
    dilation = int(selector["dilateNativePixels"])
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilation + 1, 2 * dilation + 1))
    # Keep mask attribution causal: an active ROI with no selected core must not
    # become "applied" merely because dilation or a bbox from a neighboring ROI
    # crosses their shared edge.  Construct every mask's selection independently
    # inside that mask, then form the order-independent union used for inpaint.
    selected_native_by_mask: Dict[str, Any] = {}
    selected_native = np.zeros_like(kept)
    for item in active:
        selector_mode = item.get("selectorMode", OVERLAY_SELECTOR_GLYPH_COMPONENTS)
        if selector_mode == OVERLAY_SELECTOR_FULL_CANDIDATE:
            selected_for_mask = item["nativeMask"].copy()
        elif selector_mode == OVERLAY_SELECTOR_GLYPH_BBOX_TELEA:
            selected_core = bbox_core_by_mask[item["id"]]
            if bool(selected_core.any()):
                bounds = mask_bounds(selected_core, np)
                padding = int(item.get(
                    "bboxPaddingNativePixels",
                    DEFAULT_GLYPH_BBOX_PADDING_NATIVE_PIXELS,
                ))
                candidate_bounds = item["nativeBounds"]
                x0 = max(candidate_bounds["x0"], bounds["x0"] - padding)
                y0 = max(candidate_bounds["y0"], bounds["y0"] - padding)
                x1 = min(candidate_bounds["x1Exclusive"], bounds["x1Exclusive"] + padding)
                y1 = min(candidate_bounds["y1Exclusive"], bounds["y1Exclusive"] + padding)
                selected_for_mask = np.zeros_like(kept)
                selected_for_mask[y0:y1, x0:x1] = 255
                selected_for_mask = np.where(
                    (selected_for_mask > 0) & (item["nativeMask"] > 0), 255, 0,
                ).astype(np.uint8)
            else:
                selected_for_mask = np.zeros_like(kept)
        else:
            selected_core = np.where(
                (kept > 0) & (item["nativeMask"] > 0), 255, 0,
            ).astype(np.uint8)
            if bool(selected_core.any()):
                selected_for_mask = cv2.dilate(selected_core, kernel, iterations=1)
                selected_for_mask = np.where(
                    (selected_for_mask > 0) & (item["nativeMask"] > 0), 255, 0,
                ).astype(np.uint8)
            else:
                selected_for_mask = np.zeros_like(kept)
        selected_native_by_mask[item["id"]] = selected_for_mask
        selected_native = np.maximum(selected_native, selected_for_mask)
    candidate_pixels = int(np.count_nonzero(candidate))
    selected_native_pixels = int(np.count_nonzero(selected_native))
    selected_fraction = float(selected_native_pixels) / candidate_pixels
    per_mask_selected_native = {
        item["id"]: int(np.count_nonzero(selected_native_by_mask[item["id"]]))
        for item in active
    }
    per_mask_selected_native_bounds = {
        item["id"]: (
            mask_bounds(selected_native_by_mask[item["id"]], np)
            if per_mask_selected_native[item["id"]] > 0
            else None
        )
        for item in active
    }
    per_mask_selected_fraction = {
        item["id"]: float(per_mask_selected_native[item["id"]]) / item["nativePixelCount"]
        for item in active
    }
    guarded_items = [
        item for item in active
        if item.get("selectorMode", OVERLAY_SELECTOR_GLYPH_COMPONENTS) != OVERLAY_SELECTOR_FULL_CANDIDATE
    ]
    per_mask_rejected_ids = [
        item["id"] for item in guarded_items
        if per_mask_selected_fraction[item["id"]] > selector["maxSelectedFractionOfCandidate"]
    ]
    guarded_candidate = np.zeros_like(candidate)
    guarded_selected = np.zeros_like(candidate)
    for item in guarded_items:
        guarded_candidate = np.maximum(guarded_candidate, item["nativeMask"])
        guarded_selected = np.maximum(guarded_selected, selected_native_by_mask[item["id"]])
    guarded_candidate_pixels = int(np.count_nonzero(guarded_candidate))
    guarded_selected_fraction = (
        float(np.count_nonzero(guarded_selected)) / guarded_candidate_pixels
        if guarded_candidate_pixels else 0.0
    )
    union_rejected = bool(guarded_items) and guarded_selected_fraction > selector["maxSelectedFractionOfCandidate"]
    rejected_mask_ids = (
        [item["id"] for item in guarded_items if per_mask_selected_native[item["id"]] > 0]
        if union_rejected
        else per_mask_rejected_ids
    )
    raw_selected_with_full_candidate = np.maximum(raw_selected, full_candidate)
    if union_rejected or per_mask_rejected_ids:
        return None, [item["id"] for item in active], {
            "candidatePixelsNative": candidate_pixels,
            "rawSelectedPixelsNative": int(np.count_nonzero(raw_selected_with_full_candidate)),
            "selectedPixelsNative": selected_native_pixels,
            "selectedPixelsOutput": 0,
            "componentCount": component_count,
            "keptComponentCount": kept_component_count,
            "selectedFractionOfCandidate": selected_fraction,
            "selectedMaskIds": [],
            "perMaskSelectedNativePixels": per_mask_selected_native,
            "perMaskSelectedNativeBounds": per_mask_selected_native_bounds,
            "perMaskSelectedOutputPixels": {item["id"]: 0 for item in active},
            "perMaskSelectedFraction": per_mask_selected_fraction,
            "rejectedMaskIds": rejected_mask_ids,
            "rejectedReason": "selected_fraction_exceeds_limit",
            "occupancyGuardBypassedMaskIds": [
                item["id"] for item in active
                if item.get("selectorMode") == OVERLAY_SELECTOR_FULL_CANDIDATE
            ],
            "selectedOutputMasks": {},
        }
    if selected_native_pixels == 0:
        return None, [item["id"] for item in active], {
            "candidatePixelsNative": candidate_pixels,
            "rawSelectedPixelsNative": int(np.count_nonzero(raw_selected_with_full_candidate)),
            "selectedPixelsNative": 0,
            "selectedPixelsOutput": 0,
            "componentCount": component_count,
            "keptComponentCount": kept_component_count,
            "selectedFractionOfCandidate": 0.0,
            "selectedMaskIds": [],
            "perMaskSelectedNativePixels": per_mask_selected_native,
            "perMaskSelectedNativeBounds": per_mask_selected_native_bounds,
            "perMaskSelectedOutputPixels": {item["id"]: 0 for item in active},
            "perMaskSelectedFraction": per_mask_selected_fraction,
            "rejectedMaskIds": [],
            "rejectedReason": None,
            "occupancyGuardBypassedMaskIds": [],
            "selectedOutputMasks": {},
        }
    selected_output = cv2.resize(
        selected_native,
        (output_width, output_height),
        interpolation=cv2.INTER_NEAREST,
    )
    selected_output = np.where(selected_output > 0, 255, 0).astype(np.uint8)
    per_mask_selected_output = {}
    selected_output_masks = {}
    for item in active:
        selected_for_mask_output = cv2.resize(
            selected_native_by_mask[item["id"]],
            (output_width, output_height),
            interpolation=cv2.INTER_NEAREST,
        )
        selected_for_mask_output = np.where(selected_for_mask_output > 0, 255, 0).astype(np.uint8)
        selected_output_masks[item["id"]] = selected_for_mask_output
        per_mask_selected_output[item["id"]] = int(np.count_nonzero(selected_for_mask_output))
    selected_mask_ids = [item["id"] for item in active if per_mask_selected_output[item["id"]] > 0]
    return selected_output, [item["id"] for item in active], {
        "candidatePixelsNative": candidate_pixels,
        "rawSelectedPixelsNative": int(np.count_nonzero(raw_selected_with_full_candidate)),
        "selectedPixelsNative": selected_native_pixels,
        "selectedPixelsOutput": int(np.count_nonzero(selected_output)),
        "componentCount": component_count,
        "keptComponentCount": kept_component_count,
        "selectedFractionOfCandidate": selected_fraction,
        "selectedMaskIds": selected_mask_ids,
        "perMaskSelectedNativePixels": per_mask_selected_native,
        "perMaskSelectedNativeBounds": per_mask_selected_native_bounds,
        "perMaskSelectedOutputPixels": per_mask_selected_output,
        "perMaskSelectedFraction": per_mask_selected_fraction,
        "rejectedMaskIds": [],
        "rejectedReason": None,
        "occupancyGuardBypassedMaskIds": [
            item["id"] for item in active
            if item.get("selectorMode") == OVERLAY_SELECTOR_FULL_CANDIDATE
        ],
        "selectedOutputMasks": selected_output_masks,
    }


def validate_overlay_mask_spatial_support(
    mask: Any,
    radius_output_pixels: float,
    cv2: Any,
    np: Any,
) -> Tuple[Any, Dict[str, Any]]:
    if mask.ndim != 2:
        raise RuntimeError("overlay mask must be a single-channel raster")
    binary_mask = np.where(mask > 0, 255, 0).astype(np.uint8)
    masked_pixels = int(np.count_nonzero(binary_mask))
    if masked_pixels == 0:
        raise RuntimeError("overlay mask union rasterized to zero pixels")
    if masked_pixels == int(binary_mask.size):
        raise RuntimeError("overlay mask union cannot cover the entire depth frame")
    radius = float(radius_output_pixels)
    ring_iterations = max(1, int(math.ceil(radius)))
    kernel = np.ones((3, 3), dtype=np.uint8)
    dilated = cv2.dilate(binary_mask, kernel, iterations=ring_iterations)
    boundary = (dilated > 0) & (binary_mask == 0)
    boundary_pixels = int(np.count_nonzero(boundary))
    if boundary_pixels < 8:
        raise RuntimeError("overlay mask union has insufficient spatial boundary support for deterministic inpaint")
    return binary_mask, {
        "maskedPixels": masked_pixels,
        "boundaryPixels": boundary_pixels,
        "boundary": boundary,
    }


def preflight_overlay_exclusion(contract: Dict[str, Any]) -> None:
    overlay_contract = contract["overlayExclusion"]
    if not overlay_contract.get("enabled"):
        return
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as error:
        raise RuntimeError("overlay preflight dependency is unavailable: %s" % error)
    width = int(contract["outputSize"]["width"])
    height = int(contract["outputSize"]["height"])
    compiled_masks = compile_overlay_masks(overlay_contract, width, height, cv2, np)
    for item in compiled_masks:
        if item.get("fillMode") == OVERLAY_FILL_VERTICAL_COLUMN_BAND:
            bounds = item["outputBounds"]
            sample_rows = int(item["boundarySampleRowsOutput"])
            if bounds["y0"] - sample_rows < 0 or bounds["y1Exclusive"] + sample_rows > height:
                raise RuntimeError(
                    "overlay vertical-column-band preflight failed for mask=%s: "
                    "rect requires %d complete boundary sample rows above and below"
                    % (item["id"], sample_rows)
                )
        if item.get("fillMode") != OVERLAY_FILL_CLEAN_ANCHOR_PATCH:
            continue
        try:
            validate_overlay_mask_spatial_support(
                item["mask"],
                item["anchorRingOffsetOutputPixels"],
                cv2,
                np,
            )
        except RuntimeError as error:
            raise RuntimeError(
                "overlay clean-anchor preflight failed for mask=%s: %s"
                % (item["id"], error)
            )
    boundaries = sorted({
        frame
        for item in compiled_masks
        for frame in (item["startFrame"], item["endFrameExclusive"])
    })
    for start_frame, end_frame in zip(boundaries, boundaries[1:]):
        if start_frame >= end_frame:
            continue
        active_items = [
            item for item in compiled_masks
            if item["startFrame"] <= start_frame < item["endFrameExclusive"]
        ]
        for left_index, left in enumerate(active_items):
            for right in active_items[left_index + 1:]:
                if (
                    left.get("fillMode") != OVERLAY_FILL_HIGHPASS_SUPPRESSION
                    and right.get("fillMode") != OVERLAY_FILL_HIGHPASS_SUPPRESSION
                ):
                    continue
                if bool(np.any((left["mask"] > 0) & (right["mask"] > 0))):
                    raise RuntimeError(
                        "overlay highpass-suppression preflight overlap for source frames "
                        "[%d,%d): masks=%s,%s"
                        % (start_frame, end_frame, left["id"], right["id"])
                    )
        union, active_ids = active_overlay_mask(compiled_masks, start_frame, (height, width), np)
        if union is None:
            continue
        try:
            validate_overlay_mask_spatial_support(
                union,
                overlay_contract["strategy"]["radiusOutputPixels"],
                cv2,
                np,
            )
        except RuntimeError as error:
            raise RuntimeError(
                "overlay preflight failed for source frames [%d,%d) masks=%s: %s"
                % (start_frame, end_frame, ",".join(active_ids), error)
            )


def exclude_overlay_from_depth(
    depth: Any,
    mask: Any,
    radius_output_pixels: float,
    cv2: Any,
    np: Any,
) -> Tuple[Any, Dict[str, Any]]:
    if depth.ndim != 2:
        raise RuntimeError("overlay exclusion requires a single-channel depth frame")
    if mask.shape != depth.shape:
        raise RuntimeError("overlay mask shape does not match the output depth frame")
    binary_mask, spatial = validate_overlay_mask_spatial_support(
        mask, radius_output_pixels, cv2, np,
    )
    masked_pixels = spatial["maskedPixels"]
    boundary_pixels = spatial["boundaryPixels"]
    boundary = spatial["boundary"]
    radius = float(radius_output_pixels)
    source = np.ascontiguousarray(depth, dtype=np.float32)
    quantized = np.rint(np.clip(source, 0.0, 1.0) * 255.0).astype(np.uint8)
    inpainted_u8 = cv2.inpaint(quantized, binary_mask, radius, cv2.INPAINT_TELEA)
    inpainted = inpainted_u8.astype(np.float32) / 255.0
    if not np.isfinite(inpainted).all():
        raise RuntimeError("overlay inpaint produced non-finite depth")
    result = np.clip(inpainted, 0.0, 1.0).astype(np.float32, copy=False)
    unmasked = binary_mask == 0
    # OpenCV is not allowed to perturb any pixel outside the explicit mask.
    result[unmasked] = source[unmasked]
    return result, {
        "maskedPixels": masked_pixels,
        "boundaryPixels": boundary_pixels,
        "boundaryMin": float(source[boundary].min()),
        "boundaryMax": float(source[boundary].max()),
    }


def prepare_clean_anchor_depths(
    compiled_masks: Sequence[Dict[str, Any]],
    depth_cache: Any,
    contract: Dict[str, Any],
    low_bound: float,
    high_bound: float,
    model_output: str,
    output_width: int,
    output_height: int,
    cv2: Any,
    np: Any,
) -> Dict[str, Any]:
    """Resolve explicit clean anchor frames into deterministic output-space depth.

    Anchor frames use the same global normalization and resize as render frames,
    but deliberately do not inherit temporal state from a text-bearing frame.
    Multiple anchors are reduced by a per-pixel median in sorted frame order.
    """
    needed_frames = sorted({
        frame
        for item in compiled_masks
        if item.get("fillMode") == OVERLAY_FILL_CLEAN_ANCHOR_PATCH
        for frame in item.get("cleanAnchorFrames", [])
    })
    normalized_by_frame: Dict[int, Any] = {}
    window_start = int(contract["inputWindow"]["startFrame"])
    for absolute_frame in needed_frames:
        relative_frame = absolute_frame - window_start
        if not 0 <= relative_frame < int(contract["expectedFrames"]):
            raise RuntimeError("clean anchor frame %d is outside the decoded depth cache" % absolute_frame)
        normalized_native = normalize_depth(
            depth_cache[relative_frame], low_bound, high_bound, model_output, np,
        )
        normalized_output = cv2.resize(
            normalized_native, (output_width, output_height), interpolation=cv2.INTER_CUBIC,
        )
        normalized_by_frame[absolute_frame] = np.clip(
            normalized_output, 0.0, 1.0,
        ).astype(np.float32, copy=False)
    anchors: Dict[str, Any] = {}
    for item in compiled_masks:
        if item.get("fillMode") != OVERLAY_FILL_CLEAN_ANCHOR_PATCH:
            continue
        frames = item.get("cleanAnchorFrames", [])
        if not frames:
            raise RuntimeError("clean anchor mask %s has no resolved anchor frames" % item["id"])
        layers = [normalized_by_frame[frame] for frame in frames]
        if len(layers) == 1:
            anchors[item["id"]] = layers[0].copy()
        else:
            anchors[item["id"]] = np.median(
                np.stack(layers, axis=0), axis=0,
            ).astype(np.float32, copy=False)
    return anchors


def clean_anchor_patch_contribution(
    depth: Any,
    mask: Any,
    anchor_depth: Any,
    ring_offset_output_pixels: int,
    feather_output_pixels: float,
    cv2: Any,
    np: Any,
) -> Tuple[Any, Any, Dict[str, Any]]:
    if depth.ndim != 2 or anchor_depth.ndim != 2:
        raise RuntimeError("clean anchor patch fill requires single-channel depth frames")
    if mask.shape != depth.shape or anchor_depth.shape != depth.shape:
        raise RuntimeError("clean anchor patch mask/anchor shape does not match the output depth frame")
    binary_mask = np.where(mask > 0, 255, 0).astype(np.uint8)
    masked_pixels = int(np.count_nonzero(binary_mask))
    if masked_pixels == 0:
        raise RuntimeError("clean anchor patch mask rasterized to zero pixels")
    ring_offset = int(ring_offset_output_pixels)
    kernel = np.ones((3, 3), dtype=np.uint8)
    dilated = cv2.dilate(binary_mask, kernel, iterations=ring_offset)
    ring = (dilated > 0) & (binary_mask == 0)
    ring_pixels = int(np.count_nonzero(ring))
    if ring_pixels < 8:
        raise RuntimeError("clean anchor patch has insufficient exterior ring support")
    source = np.ascontiguousarray(depth, dtype=np.float32)
    anchor = np.ascontiguousarray(anchor_depth, dtype=np.float32)
    if not np.isfinite(source).all() or not np.isfinite(anchor).all():
        raise RuntimeError("clean anchor patch received non-finite depth")
    scalar_offset = float(np.median(source[ring] - anchor[ring]))
    target = np.clip(anchor + scalar_offset, 0.0, 1.0).astype(np.float32, copy=False)
    feather = float(feather_output_pixels)
    alpha = np.zeros_like(source, dtype=np.float32)
    inside = binary_mask > 0
    if feather <= 0.0:
        alpha[inside] = 1.0
    else:
        distance = cv2.distanceTransform(binary_mask, cv2.DIST_L2, 3)
        alpha[inside] = np.minimum(1.0, distance[inside] / feather)
    return target, alpha, {
        "maskedPixels": masked_pixels,
        "ringPixels": ring_pixels,
        "anchorScalarOffset": scalar_offset,
        "featherOutputPixels": feather,
    }


def vertical_column_band_contribution(
    depth: Any,
    selected_glyph_mask: Any,
    candidate_mask: Any,
    output_bounds: Dict[str, int],
    boundary_sample_rows_output: int,
    feather_output_pixels: float,
    cv2: Any,
    np: Any,
) -> Tuple[Any, Any, Any, Dict[str, Any]]:
    """Reconstruct selected glyph columns across a rectangular candidate band.

    Column support is derived only from the already-filtered glyph mask.  For
    every supported column, complete rows immediately above and below the
    candidate rect are reduced by a median.  Linear interpolation uses the
    geometric centers of those sample strips, which exactly reconstructs a
    linear vertical surface.  Alpha never extends outside the resulting band.
    """
    source = np.ascontiguousarray(depth, dtype=np.float32)
    if source.ndim != 2:
        raise RuntimeError("vertical column band fill requires a single-channel depth frame")
    if selected_glyph_mask.shape != source.shape or candidate_mask.shape != source.shape:
        raise RuntimeError("vertical column band mask shape does not match the output depth frame")
    if not np.isfinite(source).all():
        raise RuntimeError("vertical column band fill received non-finite depth")
    selected = np.where(selected_glyph_mask > 0, 255, 0).astype(np.uint8)
    candidate = np.where(candidate_mask > 0, 255, 0).astype(np.uint8)
    if bool(np.any((selected > 0) & (candidate == 0))):
        raise RuntimeError("vertical column band selected glyph pixels escape the candidate rect")
    x0 = int(output_bounds["x0"])
    x1 = int(output_bounds["x1Exclusive"])
    y0 = int(output_bounds["y0"])
    y1 = int(output_bounds["y1Exclusive"])
    sample_rows = int(boundary_sample_rows_output)
    if sample_rows < 1:
        raise RuntimeError("vertical column band requires at least one boundary sample row")
    if y0 - sample_rows < 0 or y1 + sample_rows > source.shape[0]:
        raise RuntimeError(
            "vertical column band requires %d complete boundary sample rows above and below"
            % sample_rows
        )
    local_selected = selected[y0:y1, x0:x1] > 0
    column_support = np.any(local_selected, axis=0)
    if not bool(column_support.any()):
        raise RuntimeError("vertical column band received no selected glyph columns")
    supported_x = np.flatnonzero(column_support) + x0
    band = np.zeros_like(selected, dtype=np.uint8)
    band[y0:y1, supported_x] = 255

    top_median = np.median(source[y0 - sample_rows:y0, supported_x], axis=0)
    bottom_median = np.median(source[y1:y1 + sample_rows, supported_x], axis=0)
    top_sample_center = float(y0) - (float(sample_rows) + 1.0) / 2.0
    bottom_sample_center = float(y1) + (float(sample_rows) - 1.0) / 2.0
    row_positions = np.arange(y0, y1, dtype=np.float32)
    interpolation_weight = (
        (row_positions - top_sample_center)
        / (bottom_sample_center - top_sample_center)
    ).astype(np.float32, copy=False)
    interpolated = (
        top_median[None, :] * (1.0 - interpolation_weight[:, None])
        + bottom_median[None, :] * interpolation_weight[:, None]
    ).astype(np.float32, copy=False)
    target = source.copy()
    target[np.ix_(np.arange(y0, y1), supported_x)] = interpolated

    feather = float(feather_output_pixels)
    alpha = np.zeros_like(source, dtype=np.float32)
    if feather <= 0.0:
        row_alpha = np.ones(y1 - y0, dtype=np.float32)
    else:
        # Feather only along y and only inside [y0,y1).  Horizontal feathering
        # would under-fill every isolated or narrow glyph-supported column and
        # leave the text depth plane behind.  Unsupported adjacent columns stay
        # exactly untouched instead.
        distance_to_vertical_edge = np.minimum(
            np.arange(1, y1 - y0 + 1, dtype=np.float32),
            np.arange(y1 - y0, 0, -1, dtype=np.float32),
        )
        row_alpha = np.minimum(1.0, distance_to_vertical_edge / feather)
    alpha[np.ix_(np.arange(y0, y1), supported_x)] = row_alpha[:, None]
    return target, alpha, band, {
        "selectedGlyphPixels": int(np.count_nonzero(selected)),
        "supportedColumns": int(supported_x.size),
        "bandPixels": int(np.count_nonzero(band)),
        "boundarySampleRowsOutput": sample_rows,
        "featherOutputPixels": feather,
        "topBoundaryMin": float(top_median.min()),
        "topBoundaryMax": float(top_median.max()),
        "bottomBoundaryMin": float(bottom_median.min()),
        "bottomBoundaryMax": float(bottom_median.max()),
    }


def highpass_suppression_contribution(
    depth: Any,
    mask: Any,
    sigma_output_pixels: float,
    max_delta_depth_codes: float,
    feather_output_pixels: float,
    cv2: Any,
    np: Any,
) -> Tuple[Any, Any, Dict[str, Any]]:
    """Suppress only the masked frame's bounded high-frequency residual.

    The target is the same stabilized frame's Gaussian low-frequency depth.
    The difference from the source is clipped in 8-bit depth-code units before
    an inside-only distance-transform feather is applied.  Outside-mask floats
    are restored by the caller's hard preservation boundary.
    """
    source = np.ascontiguousarray(depth, dtype=np.float32)
    if source.ndim != 2:
        raise RuntimeError("highpass suppression requires a single-channel depth frame")
    if mask.shape != source.shape:
        raise RuntimeError("highpass suppression mask shape does not match the output depth frame")
    if not np.isfinite(source).all():
        raise RuntimeError("highpass suppression received non-finite depth")
    binary_mask = np.where(mask > 0, 255, 0).astype(np.uint8)
    inside = binary_mask > 0
    masked_pixels = int(np.count_nonzero(inside))
    if masked_pixels == 0:
        raise RuntimeError("highpass suppression mask rasterized to zero pixels")
    sigma = float(sigma_output_pixels)
    maximum_codes = float(max_delta_depth_codes)
    feather = float(feather_output_pixels)
    if not 0.5 <= sigma <= MAX_HIGHPASS_SIGMA_OUTPUT_PIXELS:
        raise RuntimeError("highpass suppression sigmaOutputPixels is outside the validated range")
    if not 0.0 < maximum_codes <= MAX_HIGHPASS_DELTA_DEPTH_CODES:
        raise RuntimeError("highpass suppression maxDeltaDepthCodes is outside the validated range")
    if not 0.0 <= feather <= MAX_HIGHPASS_FEATHER_OUTPUT_PIXELS:
        raise RuntimeError("highpass suppression featherOutputPixels is outside the validated range")
    low_frequency = cv2.GaussianBlur(
        source,
        (0, 0),
        sigmaX=sigma,
        sigmaY=sigma,
        borderType=cv2.BORDER_REFLECT_101,
    )
    limit = maximum_codes / 255.0
    clipped_delta = np.clip(low_frequency - source, -limit, limit).astype(np.float32, copy=False)
    target = np.clip(source + clipped_delta, 0.0, 1.0).astype(np.float32, copy=False)
    alpha = np.zeros_like(source, dtype=np.float32)
    if feather <= 0.0:
        alpha[inside] = 1.0
    else:
        distance = cv2.distanceTransform(binary_mask, cv2.DIST_L2, 5)
        alpha[inside] = np.minimum(1.0, distance[inside] / feather)
    applied_codes = np.abs(clipped_delta[inside] * alpha[inside]) * 255.0
    raw_codes = np.abs((low_frequency[inside] - source[inside]) * 255.0)
    return target, alpha, {
        "maskedPixels": masked_pixels,
        "sigmaOutputPixels": sigma,
        "maxDeltaDepthCodes": maximum_codes,
        "featherOutputPixels": feather,
        "absoluteAppliedDeltaDepthCodes": {
            "max": float(applied_codes.max()),
            "p95": float(np.percentile(applied_codes, 95)),
            "p99": float(np.percentile(applied_codes, 99)),
        },
        "absoluteRawHighpassDepthCodes": {
            "p95": float(np.percentile(raw_codes, 95)),
            "p99": float(np.percentile(raw_codes, 99)),
        },
    }


def apply_selected_overlay_fills(
    depth: Any,
    compiled_masks: Sequence[Dict[str, Any]],
    selected_output_masks: Dict[str, Any],
    anchor_depths: Dict[str, Any],
    radius_output_pixels: float,
    cv2: Any,
    np: Any,
) -> Tuple[Any, Dict[str, Any]]:
    """Apply all explicit fills without modifying their effective-union exterior.

    Vertical-column targets and anchor targets are each combined by an
    order-independent weighted mean and maximum feather alpha. Highpass masks
    are required to be spatially disjoint from every concurrent candidate, so
    their same-frame low-frequency contribution is order-independent too.
    """
    source = np.ascontiguousarray(depth, dtype=np.float32)
    if source.ndim != 2:
        raise RuntimeError("overlay exclusion requires a single-channel depth frame")
    masks_by_id = {item["id"]: item for item in compiled_masks}
    unknown_ids = sorted(set(selected_output_masks) - set(masks_by_id))
    if unknown_ids:
        raise RuntimeError("selected overlay masks are not compiled: %s" % ",".join(unknown_ids))
    selected_items = [
        masks_by_id[mask_id]
        for mask_id in sorted(selected_output_masks)
        if bool(np.any(selected_output_masks[mask_id] > 0))
    ]
    if not selected_items:
        return source.copy(), {
            "maskedPixels": 0,
            "boundaryPixels": 0,
            "boundaryMin": None,
            "boundaryMax": None,
            "fillModesApplied": [],
            "anchorMasks": {},
            "verticalColumnBandMasks": {},
            "highpassSuppressionMasks": {},
        }
    vertical_contributions: Dict[str, Tuple[Any, Any, Dict[str, Any]]] = {}
    highpass_contributions: Dict[str, Tuple[Any, Any, Dict[str, Any]]] = {}
    selected_union = np.zeros_like(source, dtype=np.uint8)
    anchor_union = np.zeros_like(source, dtype=np.uint8)
    vertical_union = np.zeros_like(source, dtype=np.uint8)
    highpass_union = np.zeros_like(source, dtype=np.uint8)
    telea_union = np.zeros_like(source, dtype=np.uint8)
    for item in selected_items:
        selected_mask = np.where(selected_output_masks[item["id"]] > 0, 255, 0).astype(np.uint8)
        fill_mode = item.get("fillMode", OVERLAY_FILL_TELEA)
        if fill_mode == OVERLAY_FILL_VERTICAL_COLUMN_BAND:
            target, alpha, effective_mask, diagnostics = vertical_column_band_contribution(
                source,
                selected_mask,
                item["mask"],
                item["outputBounds"],
                item["boundarySampleRowsOutput"],
                item["featherOutputPixels"],
                cv2,
                np,
            )
            vertical_contributions[item["id"]] = (target, alpha, diagnostics)
        elif fill_mode == OVERLAY_FILL_HIGHPASS_SUPPRESSION:
            target, alpha, diagnostics = highpass_suppression_contribution(
                source,
                selected_mask,
                item["sigmaOutputPixels"],
                item["maxDeltaDepthCodes"],
                item["featherOutputPixels"],
                cv2,
                np,
            )
            highpass_contributions[item["id"]] = (target, alpha, diagnostics)
            effective_mask = selected_mask
        else:
            effective_mask = selected_mask
        selected_union = np.maximum(selected_union, effective_mask)
        if fill_mode == OVERLAY_FILL_CLEAN_ANCHOR_PATCH:
            anchor_union = np.maximum(anchor_union, effective_mask)
        elif fill_mode == OVERLAY_FILL_VERTICAL_COLUMN_BAND:
            vertical_union = np.maximum(vertical_union, effective_mask)
        elif fill_mode == OVERLAY_FILL_HIGHPASS_SUPPRESSION:
            highpass_union = np.maximum(highpass_union, effective_mask)
        else:
            telea_union = np.maximum(telea_union, effective_mask)
    other_union = np.maximum(np.maximum(telea_union, vertical_union), anchor_union)
    if bool(np.any((highpass_union > 0) & (other_union > 0))):
        raise RuntimeError("highpass suppression overlaps another active fill at runtime")
    # Higher-authority explicit fills own overlaps.  This keeps the result
    # invariant to mask ordering while preserving legacy behavior when no new
    # fill mode is present.
    telea_union = np.where(
        (telea_union > 0)
        & (vertical_union == 0)
        & (anchor_union == 0)
        & (highpass_union == 0),
        255,
        0,
    ).astype(np.uint8)
    result = source.copy()
    fill_modes_applied: List[str] = []
    if bool(telea_union.any()):
        result, _ = exclude_overlay_from_depth(
            result, telea_union, radius_output_pixels, cv2, np,
        )
        fill_modes_applied.append(OVERLAY_FILL_TELEA)
    vertical_target_sum = np.zeros_like(source, dtype=np.float32)
    vertical_target_weight = np.zeros_like(source, dtype=np.float32)
    vertical_maximum_alpha = np.zeros_like(source, dtype=np.float32)
    vertical_diagnostics: Dict[str, Dict[str, Any]] = {}
    for item in selected_items:
        if item.get("fillMode") != OVERLAY_FILL_VERTICAL_COLUMN_BAND:
            continue
        target, alpha, diagnostics = vertical_contributions[item["id"]]
        # Anchor-covered pixels are reserved for the higher-authority anchor
        # contribution.  The alpha remains strictly inside this mask's band.
        owned_alpha = alpha.copy()
        owned_alpha[anchor_union > 0] = 0.0
        vertical_target_sum += target * owned_alpha
        vertical_target_weight += owned_alpha
        vertical_maximum_alpha = np.maximum(vertical_maximum_alpha, owned_alpha)
        vertical_diagnostics[item["id"]] = diagnostics
    vertical_covered = vertical_target_weight > 0.0
    if bool(vertical_covered.any()):
        vertical_target = np.zeros_like(source, dtype=np.float32)
        vertical_target[vertical_covered] = (
            vertical_target_sum[vertical_covered]
            / vertical_target_weight[vertical_covered]
        )
        result[vertical_covered] = (
            result[vertical_covered] * (1.0 - vertical_maximum_alpha[vertical_covered])
            + vertical_target[vertical_covered] * vertical_maximum_alpha[vertical_covered]
        )
        fill_modes_applied.append(OVERLAY_FILL_VERTICAL_COLUMN_BAND)
    target_sum = np.zeros_like(source, dtype=np.float32)
    target_weight = np.zeros_like(source, dtype=np.float32)
    maximum_alpha = np.zeros_like(source, dtype=np.float32)
    anchor_diagnostics: Dict[str, Dict[str, Any]] = {}
    for item in selected_items:
        if item.get("fillMode") != OVERLAY_FILL_CLEAN_ANCHOR_PATCH:
            continue
        if item["id"] not in anchor_depths:
            raise RuntimeError("clean anchor depth is missing for overlay mask %s" % item["id"])
        target, alpha, diagnostics = clean_anchor_patch_contribution(
            source,
            selected_output_masks[item["id"]],
            anchor_depths[item["id"]],
            item["anchorRingOffsetOutputPixels"],
            item["featherOutputPixels"],
            cv2,
            np,
        )
        target_sum += target * alpha
        target_weight += alpha
        maximum_alpha = np.maximum(maximum_alpha, alpha)
        anchor_diagnostics[item["id"]] = diagnostics
    anchor_covered = target_weight > 0.0
    if bool(anchor_covered.any()):
        averaged_target = np.zeros_like(source, dtype=np.float32)
        averaged_target[anchor_covered] = (
            target_sum[anchor_covered] / target_weight[anchor_covered]
        )
        result[anchor_covered] = (
            result[anchor_covered] * (1.0 - maximum_alpha[anchor_covered])
            + averaged_target[anchor_covered] * maximum_alpha[anchor_covered]
        )
        fill_modes_applied.append(OVERLAY_FILL_CLEAN_ANCHOR_PATCH)
    highpass_diagnostics: Dict[str, Dict[str, Any]] = {}
    for item in selected_items:
        if item.get("fillMode") != OVERLAY_FILL_HIGHPASS_SUPPRESSION:
            continue
        target, alpha, diagnostics = highpass_contributions[item["id"]]
        covered = alpha > 0.0
        result[covered] = (
            result[covered] * (1.0 - alpha[covered])
            + target[covered] * alpha[covered]
        )
        highpass_diagnostics[item["id"]] = diagnostics
    if highpass_diagnostics:
        fill_modes_applied.append(OVERLAY_FILL_HIGHPASS_SUPPRESSION)
    result = np.clip(result, 0.0, 1.0).astype(np.float32, copy=False)
    outside = selected_union == 0
    # This assignment is the hard pre-encoding float preservation boundary.
    # For vertical bands it covers every unsupported column inside the ROI as
    # well as the complete ROI exterior.
    result[outside] = source[outside]
    _, spatial = validate_overlay_mask_spatial_support(
        selected_union, radius_output_pixels, cv2, np,
    )
    boundary = spatial["boundary"]
    return result, {
        "maskedPixels": spatial["maskedPixels"],
        "boundaryPixels": spatial["boundaryPixels"],
        "boundaryMin": float(source[boundary].min()),
        "boundaryMax": float(source[boundary].max()),
        "fillModesApplied": fill_modes_applied,
        "anchorMasks": anchor_diagnostics,
        "verticalColumnBandMasks": vertical_diagnostics,
        "highpassSuppressionMasks": highpass_diagnostics,
    }


def render_pass(
    input_path: Path,
    depth_cache: Any,
    contract: Dict[str, Any],
    low_bound: float,
    high_bound: float,
    scratch_directory: Path,
    arguments: argparse.Namespace,
    cv2: Any,
    np: Any,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any], Dict[str, Any], List[Tuple[Path, Path]]]:
    width = contract["outputSize"]["width"]
    height = contract["outputSize"]["height"]
    fps = Fraction(contract["expectedFps"])
    segments = [Segment(index=item["index"], start_frame=item["start_frame"], end_frame_exclusive=item["end_frame_exclusive"]) for item in contract["segments"]]
    output_dir = Path(contract["outputDirectory"])
    overlay_contract = contract["overlayExclusion"]
    compiled_overlay_masks = compile_overlay_masks(overlay_contract, width, height, cv2, np)
    clean_anchor_depths = prepare_clean_anchor_depths(
        compiled_overlay_masks,
        depth_cache,
        contract,
        low_bound,
        high_bound,
        arguments.model_output,
        width,
        height,
        cv2,
        np,
    )
    mask_active_counts = {item["id"]: 0 for item in compiled_overlay_masks}
    mask_application_counts = {item["id"]: 0 for item in compiled_overlay_masks}
    mask_selected_native_pixel_applications = {item["id"]: 0 for item in compiled_overlay_masks}
    mask_selected_output_pixel_applications = {item["id"]: 0 for item in compiled_overlay_masks}
    overlay_candidate_frames_active = 0
    overlay_frames_without_selected_pixels = 0
    overlay_frames_rejected_by_occupancy = 0
    overlay_candidate_native_pixel_applications = 0
    overlay_raw_selected_native_pixel_applications = 0
    overlay_selected_native_pixel_applications = 0
    overlay_frames_applied = 0
    overlay_pixel_applications = 0
    overlay_boundary_min: Optional[float] = None
    overlay_boundary_max: Optional[float] = None
    partial_to_final: List[Tuple[Path, Path]] = []
    for segment in segments:
        partial_to_final.append((
            scratch_directory / (segment.filename + ".partial.mp4"),
            output_dir / segment.filename,
        ))
    capture = open_capture(input_path, cv2)
    previous_gray = None
    previous_depth = None
    reset_events: List[Dict[str, Any]] = []
    confidence_sum = 0.0
    confidence_observations = 0
    writer: Optional[SegmentWriter] = None
    segment_cursor = 0
    frame_index = 0
    try:
        for skipped in range(contract["inputWindow"]["startFrame"]):
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError("OpenCV reached EOF while skipping to the locked render window")
        while frame_index < contract["expectedFrames"]:
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError("OpenCV reached EOF inside the locked render window at relative frame %d" % frame_index)
            segment = segments[segment_cursor]
            if frame_index == segment.start_frame:
                partial_path, _ = partial_to_final[segment_cursor]
                writer = SegmentWriter(
                    partial_path, width, height, fps, segment.frame_count,
                    arguments.ffmpeg, arguments.preset, arguments.crf,
                )
            normalized_native = normalize_depth(
                depth_cache[frame_index], low_bound, high_bound, arguments.model_output, np,
            )
            current_depth = cv2.resize(normalized_native, (width, height), interpolation=cv2.INTER_CUBIC)
            current_depth = np.clip(current_depth, 0.0, 1.0).astype(np.float32, copy=False)
            resized_frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
            current_gray = cv2.cvtColor(resized_frame, cv2.COLOR_BGR2GRAY)
            if previous_gray is not None and previous_depth is not None:
                current_depth, diagnostics = stabilize_depth(
                    previous_gray, current_gray, previous_depth, current_depth,
                    cv2, np, arguments.current_weight, arguments.history_weight,
                    arguments.flow_scale, arguments.photometric_threshold,
                    arguments.forward_backward_threshold, arguments.minimum_confidence,
                    arguments.cut_threshold, arguments.fast_motion_pixels,
                )
                if diagnostics["reset"]:
                    reset_events.append({"frame": frame_index, **diagnostics})
                elif "confidence" in diagnostics:
                    confidence_sum += diagnostics["confidence"]
                    confidence_observations += 1
            absolute_source_frame = contract["inputWindow"]["startFrame"] + frame_index
            overlay_mask, active_mask_ids, selector_diagnostics = select_overlay_pixels(
                frame,
                compiled_overlay_masks,
                absolute_source_frame,
                width,
                height,
                overlay_contract["strategy"]["pixelSelector"] if overlay_contract.get("enabled") else default_overlay_pixel_selector(),
                cv2,
                np,
            )
            if active_mask_ids:
                overlay_candidate_frames_active += 1
                overlay_candidate_native_pixel_applications += selector_diagnostics["candidatePixelsNative"]
                overlay_raw_selected_native_pixel_applications += selector_diagnostics["rawSelectedPixelsNative"]
                overlay_selected_native_pixel_applications += selector_diagnostics["selectedPixelsNative"]
                for mask_id in active_mask_ids:
                    mask_active_counts[mask_id] += 1
                    mask_selected_native_pixel_applications[mask_id] += selector_diagnostics["perMaskSelectedNativePixels"].get(mask_id, 0)
                    mask_selected_output_pixel_applications[mask_id] += selector_diagnostics["perMaskSelectedOutputPixels"].get(mask_id, 0)
            output_depth = current_depth
            if overlay_mask is not None:
                output_depth, overlay_diagnostics = apply_selected_overlay_fills(
                    current_depth,
                    compiled_overlay_masks,
                    selector_diagnostics["selectedOutputMasks"],
                    clean_anchor_depths,
                    overlay_contract["strategy"]["radiusOutputPixels"],
                    cv2,
                    np,
                )
                overlay_frames_applied += 1
                overlay_pixel_applications += overlay_diagnostics["maskedPixels"]
                boundary_min = overlay_diagnostics.get("boundaryMin")
                boundary_max = overlay_diagnostics.get("boundaryMax")
                if boundary_min is not None:
                    overlay_boundary_min = boundary_min if overlay_boundary_min is None else min(overlay_boundary_min, boundary_min)
                if boundary_max is not None:
                    overlay_boundary_max = boundary_max if overlay_boundary_max is None else max(overlay_boundary_max, boundary_max)
                for mask_id in selector_diagnostics["selectedMaskIds"]:
                    mask_application_counts[mask_id] += 1
            elif active_mask_ids:
                overlay_frames_without_selected_pixels += 1
                if selector_diagnostics["rejectedReason"] == "selected_fraction_exceeds_limit":
                    overlay_frames_rejected_by_occupancy += 1
            output_gray = np.rint(np.clip(output_depth, 0.0, 1.0) * 255.0).astype(np.uint8)
            if writer is None:
                raise RuntimeError("no active segment writer at source frame %d" % frame_index)
            writer.write(output_gray)
            previous_gray = current_gray
            previous_depth = current_depth
            frame_index += 1
            if frame_index == segment.end_frame_exclusive:
                writer.close()
                writer = None
                segment_cursor += 1
            if frame_index % 10 == 0 or frame_index == contract["expectedFrames"]:
                json_print({"stage": "render_pass", "framesComplete": frame_index, "framesTotal": contract["expectedFrames"]})
    finally:
        capture.release()
        if writer is not None and writer.process.poll() is None:
            if writer.process.stdin is not None:
                writer.process.stdin.close()
            writer.process.terminate()
            writer.process.wait()
    if frame_index != contract["expectedFrames"]:
        raise RuntimeError("OpenCV decoded %d render frames; expected %d" % (frame_index, contract["expectedFrames"]))
    if segment_cursor != len(segments):
        raise RuntimeError("not every locked segment was encoded")
    segment_details = [
        {
            "id": "segment-%03d" % segment.index,
            "startFrame": segment.start_frame,
            "endFrameExclusive": segment.end_frame_exclusive,
            "frameCount": segment.frame_count,
            "durationSeconds": float(Fraction(segment.frame_count, 1) / fps),
            "output": str(partial_to_final[segment.index - 1][1]),
        }
        for segment in segments
    ]
    temporal = {
        "method": "forward_backward_optical_flow_consistency",
        "currentWeight": arguments.current_weight,
        "historyWeight": arguments.history_weight,
        "stateContinuesAcrossSegmentBoundaries": True,
        "resetEvents": reset_events,
        "meanAcceptedConfidence": confidence_sum / confidence_observations if confidence_observations else None,
    }
    overlay_execution = {
        "enabled": bool(overlay_contract.get("enabled")),
        "applicationStage": "after_temporal_stabilization_before_uint8_encoding",
        "unmaskedPixels": "bit_exact_outside_selected_overlay_pixels",
        "cleanedDepthContinuesAsTemporalHistory": False,
        "cleanAnchorDepthSource": "globally_normalized_unstabilized_anchor_frame_median",
        "candidateFramesActive": overlay_candidate_frames_active,
        "activeFramesWithoutSelectedPixels": overlay_frames_without_selected_pixels,
        "framesRejectedByOccupancyGuard": overlay_frames_rejected_by_occupancy,
        "candidateNativePixelApplications": overlay_candidate_native_pixel_applications,
        "rawSelectedNativePixelApplications": overlay_raw_selected_native_pixel_applications,
        "preGuardSelectedNativePixelApplications": overlay_selected_native_pixel_applications,
        "framesApplied": overlay_frames_applied,
        "maskPixelApplications": overlay_pixel_applications,
        "observedBoundaryDepthRange": {
            "min": overlay_boundary_min,
            "max": overlay_boundary_max,
        },
        "coordinateScale": {
            "x": float(width) / overlay_contract["coordinateSpace"]["width"] if overlay_contract.get("enabled") else None,
            "y": float(height) / overlay_contract["coordinateSpace"]["height"] if overlay_contract.get("enabled") else None,
        },
        "masks": [
            {
                key: value
                for key, value in item.items()
                if key not in ("mask", "nativeMask")
            } | {
                "framesActive": mask_active_counts[item["id"]],
                "framesApplied": mask_application_counts[item["id"]],
                "preGuardSelectedNativePixelApplications": mask_selected_native_pixel_applications[item["id"]],
                "selectedOutputPixelApplications": mask_selected_output_pixel_applications[item["id"]],
            }
            for item in compiled_overlay_masks
        ],
    }
    return segment_details, temporal, overlay_execution, partial_to_final


def probe_output(path: Path, ffprobe: str) -> Dict[str, Any]:
    result = run_command(ffprobe, [
        "-v", "error", "-count_frames", "-show_streams", "-of", "json", str(path),
    ])
    try:
        streams = json.loads(result["stdout"])["streams"]
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("ffprobe returned invalid output verification JSON for %s" % path)
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    audios = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if len(videos) != 1:
        raise RuntimeError("output must contain exactly one video stream: %s" % path)
    video = videos[0]
    frame_text = video.get("nb_read_frames") or video.get("nb_frames")
    try:
        frame_count = int(frame_text)
        fps = Fraction(video["avg_frame_rate"])
    except (ValueError, KeyError, TypeError, ZeroDivisionError):
        raise RuntimeError("output verification is missing frame count or frame rate: %s" % path)
    return {
        "codec": video.get("codec_name"),
        "pixelFormat": video.get("pix_fmt"),
        "width": int(video.get("width", 0)),
        "height": int(video.get("height", 0)),
        "frameCount": frame_count,
        "fps": fps,
        "audioStreamCount": len(audios),
    }


def verify_partial_outputs(
    partial_to_final: Sequence[Tuple[Path, Path]],
    contract: Dict[str, Any],
    ffprobe: str,
) -> List[Dict[str, Any]]:
    verified: List[Dict[str, Any]] = []
    for item, (partial_path, final_path) in zip(contract["segments"], partial_to_final):
        probe = probe_output(partial_path, ffprobe)
        failures: List[str] = []
        if probe["codec"] != "h264":
            failures.append("codec=%s" % probe["codec"])
        if probe["pixelFormat"] != "yuv420p":
            failures.append("pixelFormat=%s" % probe["pixelFormat"])
        if (probe["width"], probe["height"]) != (contract["outputSize"]["width"], contract["outputSize"]["height"]):
            failures.append("size=%dx%d" % (probe["width"], probe["height"]))
        if probe["frameCount"] != item["frameCount"]:
            failures.append("frameCount=%d" % probe["frameCount"])
        if probe["fps"] != Fraction(contract["expectedFps"]):
            failures.append("fps=%s" % probe["fps"])
        if probe["audioStreamCount"] != 0:
            failures.append("audioStreamCount=%d" % probe["audioStreamCount"])
        if failures:
            raise RuntimeError("output contract failed for %s: %s" % (partial_path, ", ".join(failures)))
        verified.append({
            "path": str(final_path),
            "codec": probe["codec"],
            "pixelFormat": probe["pixelFormat"],
            "width": probe["width"],
            "height": probe["height"],
            "frameCount": probe["frameCount"],
            "fps": str(probe["fps"]),
            "audioStreamCount": probe["audioStreamCount"],
            "sha256": sha256_file(partial_path),
        })
    return verified


def publish_file_exclusive(source: Path, destination: Path, link_fn: Any = os.link) -> None:
    """Publish without overwrite, with a verified copy fallback when hard links are unsupported."""
    try:
        link_fn(str(source), str(destination))
        return
    except OSError as error:
        fallback_errnos = {errno.EXDEV, errno.EPERM}
        for name in ("ENOTSUP", "EOPNOTSUPP"):
            value = getattr(errno, name, None)
            if value is not None:
                fallback_errnos.add(value)
        if error.errno not in fallback_errnos:
            raise
    try:
        with source.open("rb") as reader, destination.open("xb") as writer:
            shutil.copyfileobj(reader, writer, length=1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        if sha256_file(source) != sha256_file(destination):
            raise RuntimeError("filesystem fallback copy changed file bytes: %s" % destination)
    except BaseException:
        try:
            destination.unlink()
        except FileNotFoundError:
            pass
        raise


def publish_outputs(partial_to_final: Sequence[Tuple[Path, Path]]) -> None:
    published: List[Path] = []
    try:
        for partial_path, final_path in partial_to_final:
            publish_file_exclusive(partial_path, final_path)
            published.append(final_path)
        for partial_path, _ in partial_to_final:
            partial_path.unlink()
    except BaseException:
        for path in published:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        raise


def write_metadata_atomic(path: Path, metadata: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial.%d" % os.getpid())
    if temporary.exists():
        raise FileExistsError("refusing to overwrite metadata temporary file: %s" % temporary)
    payload = json.dumps(metadata, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        publish_file_exclusive(temporary, path)
        temporary.unlink()
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def algorithm_self_test(ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe") -> Dict[str, Any]:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    with tempfile.TemporaryDirectory(prefix="depth-runner-self-test-") as directory:
        root = Path(directory)
        cache = np.memmap(str(root / "cache.f32"), mode="w+", dtype=np.float32, shape=(2, 5, 10))
        cache[:] = np.arange(100, dtype=np.float32).reshape(2, 5, 10)
        cache.flush()
        actual = exact_linear_percentiles_from_memmap(cache, [2.0, 98.0], root / "work.f32", np)
        expected = np.percentile(np.arange(100, dtype=np.float32), [2.0, 98.0], method="linear")
        if not np.allclose(actual, expected, atol=1e-7):
            raise AssertionError("exact percentile self-test failed: %r != %r" % (actual, expected.tolist()))
        previous_gray = np.full((64, 64), 80, dtype=np.uint8)
        current_gray = previous_gray.copy()
        previous_depth = np.full((64, 64), 0.25, dtype=np.float32)
        current_depth = np.full((64, 64), 0.35, dtype=np.float32)
        stabilized, diagnostics = stabilize_depth(
            previous_gray, current_gray, previous_depth, current_depth, cv2, np,
            0.8, 0.2, 0.5, 28.0, 1.5, 0.4, 0.65, 80.0,
        )
        if diagnostics["reset"] or not np.allclose(stabilized, 0.33, atol=1e-5):
            raise AssertionError("optical-flow weighted blend self-test failed")
        cut_gray = np.full((64, 64), 255, dtype=np.uint8)
        _, cut_diagnostics = stabilize_depth(
            previous_gray, cut_gray, previous_depth, current_depth, cv2, np,
            0.8, 0.2, 0.5, 28.0, 1.5, 0.4, 0.65, 80.0,
        )
        if not cut_diagnostics["reset"] or cut_diagnostics["reason"] != "scene_cut":
            raise AssertionError("scene-cut reset self-test failed")
        source_contract = {
            "expectedFrames": 555,
            "expectedFps": "30",
            "inputWindow": {"startFrame": 0, "endFrameExclusive": 555},
            "outputSize": {"width": 720, "height": 1280},
        }
        verify_source_probe(
            {
                "frameCount": 3002,
                "averageFps": Fraction(30, 1),
                "nominalFps": Fraction(30, 1),
                "width": 576,
                "height": 1024,
            },
            source_contract,
        )
        try:
            verify_source_probe(
                {
                    "frameCount": 554,
                    "averageFps": Fraction(30, 1),
                    "nominalFps": Fraction(30, 1),
                    "width": 576,
                    "height": 1024,
                },
                source_contract,
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError("short-source window validation self-test failed")
        self_test_selector = default_overlay_pixel_selector()
        overlay_spec = normalize_overlay_mask_spec(
            {
                "schemaVersion": 1,
                "coordinateSpace": {"kind": "native_source_pixels", "width": 4, "height": 4},
                "frameIndexing": "absolute_source_frames_half_open",
                "strategy": {
                    "id": "opencv_telea_uint8_v1",
                    "radiusOutputPixels": 2,
                    "pixelSelector": self_test_selector,
                },
                "masks": [
                    {
                        "id": "rect-half-open",
                        "startFrame": 3,
                        "endFrameExclusive": 5,
                        "shape": {"type": "rect", "x0": 1, "y0": 1, "x1Exclusive": 3, "y1Exclusive": 3},
                    },
                    {
                        "id": "polygon-supported",
                        "startFrame": 6,
                        "endFrameExclusive": 7,
                        "shape": {"type": "polygon", "points": [[0, 0], [2, 0], [0, 2]]},
                    },
                ],
            },
            {"startFrame": 0, "endFrameExclusive": 10},
        )
        overlay_contract = {
            "enabled": True,
            "specPath": "self-test-inline",
            "specSha256": "0" * 64,
            "specFingerprint": stable_fingerprint(overlay_spec),
            **overlay_spec,
        }
        compiled_masks = compile_overlay_masks(overlay_contract, 8, 8, cv2, np)
        active_states = []
        for source_frame in (2, 3, 4, 5):
            _, active_ids = active_overlay_mask(compiled_masks, source_frame, (8, 8), np)
            active_states.append(active_ids)
        if active_states != [[], ["rect-half-open"], ["rect-half-open"], []]:
            raise AssertionError("overlay half-open frame selection self-test failed: %r" % active_states)
        rect_mask = next(item for item in compiled_masks if item["id"] == "rect-half-open")
        if rect_mask["outputPixelCount"] != 16 or rect_mask["outputBounds"] != {
            "x0": 2, "y0": 2, "x1Exclusive": 6, "y1Exclusive": 6,
        }:
            raise AssertionError("overlay native-coordinate scaling self-test failed: %r" % rect_mask)
        polygon_mask = next(item for item in compiled_masks if item["id"] == "polygon-supported")
        if polygon_mask["outputPixelCount"] <= 0:
            raise AssertionError("overlay polygon rasterization self-test failed")
        production_scale_spec = normalize_overlay_mask_spec(
            {
                "schemaVersion": 1,
                "coordinateSpace": {"kind": "native_source_pixels", "width": 576, "height": 1024},
                "frameIndexing": "absolute_source_frames_half_open",
                "strategy": {
                    "id": "opencv_telea_uint8_v1",
                    "radiusOutputPixels": 3,
                    "pixelSelector": self_test_selector,
                },
                "masks": [{
                    "id": "production-scale",
                    "startFrame": 100,
                    "endFrameExclusive": 101,
                    "shape": {"type": "rect", "x0": 40, "y0": 800, "x1Exclusive": 536, "y1Exclusive": 900},
                }],
            },
            {"startFrame": 100, "endFrameExclusive": 110},
        )
        production_scale_mask = compile_overlay_masks(
            {"enabled": True, **production_scale_spec}, 720, 1280, cv2, np,
        )[0]
        if production_scale_mask["outputBounds"] != {
            "x0": 50, "y0": 1000, "x1Exclusive": 670, "y1Exclusive": 1125,
        }:
            raise AssertionError("overlay 576x1024 to 720x1280 scaling self-test failed: %r" % production_scale_mask)
        selector_test_config = {
            **self_test_selector,
            "maxComponentPixelsNative": 8,
            "dilateNativePixels": 1,
        }
        selector_spec = normalize_overlay_mask_spec(
            {
                "schemaVersion": 1,
                "coordinateSpace": {"kind": "native_source_pixels", "width": 16, "height": 12},
                "frameIndexing": "absolute_source_frames_half_open",
                "strategy": {
                    "id": "opencv_telea_uint8_v1",
                    "radiusOutputPixels": 2,
                    "pixelSelector": selector_test_config,
                },
                "masks": [{
                    "id": "subtitle-candidate-roi",
                    "startFrame": 3,
                    "endFrameExclusive": 5,
                    "shape": {"type": "rect", "x0": 1, "y0": 2, "x1Exclusive": 15, "y1Exclusive": 10},
                }],
            },
            {"startFrame": 0, "endFrameExclusive": 10},
        )
        selector_contract = {"enabled": True, **selector_spec}
        selector_masks = compile_overlay_masks(selector_contract, 16, 12, cv2, np)
        source_pixels = np.full((12, 16, 3), 80, dtype=np.uint8)
        source_pixels[5:7, 4:6] = (255, 255, 255)
        source_pixels[5:7, 9:11] = (20, 220, 245)
        source_pixels[3:6, 12:16] = (255, 255, 255)
        selected_mask, selected_ids, selector_diagnostics = select_overlay_pixels(
            source_pixels,
            selector_masks,
            3,
            16,
            12,
            selector_contract["strategy"]["pixelSelector"],
            cv2,
            np,
        )
        if selected_mask is None or selected_ids != ["subtitle-candidate-roi"]:
            raise AssertionError("overlay pixel selector did not select the explicit active ROI")
        if selector_diagnostics["keptComponentCount"] != 2:
            raise AssertionError("overlay pixel selector component filtering self-test failed: %r" % selector_diagnostics)
        if not (
            selector_diagnostics["rawSelectedPixelsNative"]
            < selector_diagnostics["selectedPixelsNative"]
            < selector_diagnostics["candidatePixelsNative"]
        ):
            raise AssertionError("overlay pixel selector dilation or ROI containment self-test failed: %r" % selector_diagnostics)
        if selected_mask[3, 3] != 0:
            raise AssertionError("overlay pixel selector erased a non-overlay pixel inside the candidate ROI")
        full_white_pixels = np.full((12, 16, 3), 255, dtype=np.uint8)
        occupancy_mask, _, occupancy_diagnostics = select_overlay_pixels(
            full_white_pixels,
            selector_masks,
            3,
            16,
            12,
            self_test_selector,
            cv2,
            np,
        )
        if (
            occupancy_mask is not None
            or occupancy_diagnostics["rejectedReason"] != "selected_fraction_exceeds_limit"
            or not math.isclose(occupancy_diagnostics["selectedFractionOfCandidate"], 1.0)
        ):
            raise AssertionError("overlay high-occupancy fail-closed self-test failed: %r" % occupancy_diagnostics)
        skin_tone_pixels = np.full((12, 16, 3), (120, 170, 210), dtype=np.uint8)
        skin_mask, _, skin_diagnostics = select_overlay_pixels(
            skin_tone_pixels,
            selector_masks,
            3,
            16,
            12,
            self_test_selector,
            cv2,
            np,
        )
        if skin_mask is not None or skin_diagnostics["rawSelectedPixelsNative"] != 0:
            raise AssertionError("overlay skin-tone rejection self-test failed: %r" % skin_diagnostics)
        attribution_spec = normalize_overlay_mask_spec(
            {
                "schemaVersion": 1,
                "coordinateSpace": {"kind": "native_source_pixels", "width": 20, "height": 10},
                "frameIndexing": "absolute_source_frames_half_open",
                "strategy": {
                    "id": "opencv_telea_uint8_v1",
                    "radiusOutputPixels": 2,
                    "pixelSelector": self_test_selector,
                },
                "masks": [
                    {
                        "id": "left-roi",
                        "startFrame": 3,
                        "endFrameExclusive": 4,
                        "shape": {"type": "rect", "x0": 0, "y0": 1, "x1Exclusive": 10, "y1Exclusive": 9},
                    },
                    {
                        "id": "right-roi",
                        "startFrame": 3,
                        "endFrameExclusive": 4,
                        "shape": {"type": "rect", "x0": 10, "y0": 1, "x1Exclusive": 20, "y1Exclusive": 9},
                    },
                ],
            },
            {"startFrame": 0, "endFrameExclusive": 10},
        )
        attribution_masks = compile_overlay_masks({"enabled": True, **attribution_spec}, 20, 10, cv2, np)
        attribution_pixels = np.full((10, 20, 3), 80, dtype=np.uint8)
        # The selected core touches the left ROI's right edge.  Dilation must
        # remain attributed to the left ROI and must not activate the adjacent,
        # otherwise-empty right ROI.
        attribution_pixels[4:6, 8:10] = (255, 255, 255)
        attribution_mask, attribution_active_ids, attribution_diagnostics = select_overlay_pixels(
            attribution_pixels,
            attribution_masks,
            3,
            20,
            10,
            self_test_selector,
            cv2,
            np,
        )
        if (
            attribution_mask is None
            or attribution_active_ids != ["left-roi", "right-roi"]
            or attribution_diagnostics["selectedMaskIds"] != ["left-roi"]
            or attribution_diagnostics["perMaskSelectedOutputPixels"]["right-roi"] != 0
        ):
            raise AssertionError("overlay per-mask attribution self-test failed: %r" % attribution_diagnostics)
        per_mask_guard_selector = {
            **self_test_selector,
            "maxSelectedFractionOfCandidate": 0.6,
        }
        per_mask_guard_pixels = np.full((10, 20, 3), 80, dtype=np.uint8)
        per_mask_guard_pixels[1:9, 0:10] = (255, 255, 255)
        per_mask_guard_mask, _, per_mask_guard_diagnostics = select_overlay_pixels(
            per_mask_guard_pixels,
            attribution_masks,
            3,
            20,
            10,
            per_mask_guard_selector,
            cv2,
            np,
        )
        if (
            per_mask_guard_mask is not None
            or per_mask_guard_diagnostics["selectedFractionOfCandidate"] > 0.6
            or per_mask_guard_diagnostics["rejectedMaskIds"] != ["left-roi"]
            or per_mask_guard_diagnostics["perMaskSelectedFraction"]["left-roi"] != 1.0
        ):
            raise AssertionError(
                "overlay per-mask occupancy fail-closed self-test failed: %r"
                % per_mask_guard_diagnostics
            )
        baseline_depth = np.tile(np.linspace(0.2, 0.4, 16, dtype=np.float32), (12, 1))
        contaminated_depth = baseline_depth.copy()
        contaminated_depth[selected_mask > 0] = 1.0
        cleaned_depth, _ = exclude_overlay_from_depth(
            contaminated_depth,
            selected_mask,
            selector_contract["strategy"]["radiusOutputPixels"],
            cv2,
            np,
        )
        unmasked = selected_mask == 0
        if not np.array_equal(cleaned_depth[unmasked], contaminated_depth[unmasked]):
            raise AssertionError("overlay exclusion changed an unmasked pixel")
        if float(cleaned_depth[~unmasked].max()) >= 0.75:
            raise AssertionError("overlay exclusion left a high-depth plane inside the mask")
        full_candidate_spec = normalize_overlay_mask_spec(
            {
                "schemaVersion": 1,
                "coordinateSpace": {"kind": "native_source_pixels", "width": 16, "height": 12},
                "frameIndexing": "absolute_source_frames_half_open",
                "strategy": {
                    "id": "opencv_telea_uint8_v1",
                    "radiusOutputPixels": 2,
                    "pixelSelector": self_test_selector,
                },
                "masks": [{
                    "id": "explicit-full-candidate-anchor",
                    "startFrame": 3,
                    "endFrameExclusive": 5,
                    "selectorMode": "full_candidate",
                    "fillMode": "clean_anchor_patch",
                    "cleanAnchorFrames": [2, 5],
                    "anchorRingOffsetOutputPixels": 2,
                    "featherOutputPixels": 2,
                    "shape": {"type": "rect", "x0": 3, "y0": 3, "x1Exclusive": 13, "y1Exclusive": 9},
                }],
            },
            {"startFrame": 0, "endFrameExclusive": 10},
        )
        full_candidate_masks = compile_overlay_masks(
            {"enabled": True, **full_candidate_spec}, 16, 12, cv2, np,
        )
        dark_source = np.full((12, 16, 3), 80, dtype=np.uint8)
        full_candidate_states = []
        full_candidate_selection = None
        full_candidate_diagnostics = None
        for absolute_frame in (2, 3, 4, 5):
            candidate_mask, candidate_ids, candidate_diagnostics = select_overlay_pixels(
                dark_source,
                full_candidate_masks,
                absolute_frame,
                16,
                12,
                self_test_selector,
                cv2,
                np,
            )
            full_candidate_states.append(candidate_ids)
            if absolute_frame == 3:
                full_candidate_selection = candidate_mask
                full_candidate_diagnostics = candidate_diagnostics
        if full_candidate_states != [[], ["explicit-full-candidate-anchor"], ["explicit-full-candidate-anchor"], []]:
            raise AssertionError("explicit full-candidate half-open selection self-test failed: %r" % full_candidate_states)
        if (
            full_candidate_selection is None
            or int(np.count_nonzero(full_candidate_selection)) != full_candidate_masks[0]["outputPixelCount"]
            or full_candidate_diagnostics is None
            or full_candidate_diagnostics["occupancyGuardBypassedMaskIds"] != ["explicit-full-candidate-anchor"]
        ):
            raise AssertionError("explicit full-candidate selector self-test failed: %r" % full_candidate_diagnostics)
        default_dark_mask, _, _ = select_overlay_pixels(
            dark_source,
            selector_masks,
            3,
            16,
            12,
            self_test_selector,
            cv2,
            np,
        )
        if default_dark_mask is not None:
            raise AssertionError("default glyph selector unexpectedly selected the full candidate ROI")
        anchor_baseline = np.tile(np.linspace(0.2, 0.5, 16, dtype=np.float32), (12, 1))
        anchor_reference = np.clip(anchor_baseline - 0.05, 0.0, 1.0)
        anchor_contaminated = anchor_baseline.copy()
        anchor_contaminated[full_candidate_selection > 0] = 1.0
        anchor_cleaned, _ = apply_selected_overlay_fills(
            anchor_contaminated,
            full_candidate_masks,
            full_candidate_diagnostics["selectedOutputMasks"],
            {"explicit-full-candidate-anchor": anchor_reference},
            2,
            cv2,
            np,
        )
        anchor_outside = full_candidate_selection == 0
        if not np.array_equal(anchor_cleaned[anchor_outside], anchor_contaminated[anchor_outside]):
            raise AssertionError("clean-anchor fill changed a pixel outside the explicit full-candidate ROI")
        if float(anchor_cleaned[6, 8]) >= 0.7:
            raise AssertionError("clean-anchor fill left the full-candidate center contaminated")
        highpass_spec = normalize_overlay_mask_spec(
            {
                "schemaVersion": 1,
                "coordinateSpace": {"kind": "native_source_pixels", "width": 64, "height": 64},
                "frameIndexing": "absolute_source_frames_half_open",
                "strategy": {
                    "id": "opencv_telea_uint8_v1",
                    "radiusOutputPixels": 2,
                    "pixelSelector": self_test_selector,
                },
                "masks": [{
                    "id": "f322-highpass-only",
                    "startFrame": 3,
                    "endFrameExclusive": 4,
                    "selectorMode": "full_candidate",
                    "fillMode": "highpass_suppression_v1",
                    "sigmaOutputPixels": 5,
                    "maxDeltaDepthCodes": 4,
                    "featherOutputPixels": 8,
                    "shape": {"type": "rect", "x0": 8, "y0": 8, "x1Exclusive": 56, "y1Exclusive": 56},
                }],
            },
            {"startFrame": 0, "endFrameExclusive": 10},
        )
        highpass_masks = compile_overlay_masks(
            {"enabled": True, **highpass_spec}, 64, 64, cv2, np,
        )
        highpass_pixels = np.full((64, 64, 3), 80, dtype=np.uint8)
        highpass_states = []
        highpass_selection_diagnostics = None
        for absolute_frame in (2, 3, 4):
            _, candidate_ids, candidate_diagnostics = select_overlay_pixels(
                highpass_pixels,
                highpass_masks,
                absolute_frame,
                64,
                64,
                self_test_selector,
                cv2,
                np,
            )
            highpass_states.append(candidate_ids)
            if absolute_frame == 3:
                highpass_selection_diagnostics = candidate_diagnostics
        if highpass_states != [[], ["f322-highpass-only"], []]:
            raise AssertionError("highpass suppression half-open selection failed: %r" % highpass_states)
        if highpass_selection_diagnostics is None:
            raise AssertionError("highpass suppression full-candidate selection is missing")
        highpass_y, highpass_x = np.mgrid[0:64, 0:64].astype(np.float32)
        highpass_baseline = 0.20 + highpass_x * 0.002 + highpass_y * 0.001
        checker = (((highpass_x.astype(np.int32) + highpass_y.astype(np.int32)) % 2) * 2 - 1).astype(np.float32)
        highpass_contaminated = highpass_baseline.copy()
        highpass_mask = highpass_masks[0]["mask"] > 0
        highpass_contaminated[highpass_mask] += checker[highpass_mask] * (4.0 / 255.0)
        highpass_cleaned, highpass_diagnostics = apply_selected_overlay_fills(
            highpass_contaminated,
            highpass_masks,
            highpass_selection_diagnostics["selectedOutputMasks"],
            {},
            2,
            cv2,
            np,
        )
        if not np.array_equal(highpass_cleaned[~highpass_mask], highpass_contaminated[~highpass_mask]):
            raise AssertionError("highpass suppression changed a float outside the explicit mask")
        central = np.zeros_like(highpass_mask)
        central[20:44, 20:44] = True
        before_residual = highpass_contaminated - cv2.GaussianBlur(
            highpass_contaminated, (0, 0), 5, borderType=cv2.BORDER_REFLECT_101,
        )
        after_residual = highpass_cleaned - cv2.GaussianBlur(
            highpass_cleaned, (0, 0), 5, borderType=cv2.BORDER_REFLECT_101,
        )
        before_rms = float(np.sqrt(np.mean(np.square(before_residual[central]))))
        after_rms = float(np.sqrt(np.mean(np.square(after_residual[central]))))
        if not after_rms <= before_rms * 0.20:
            raise AssertionError(
                "highpass suppression did not remove the bounded residual: before=%r after=%r"
                % (before_rms, after_rms)
            )
        highpass_detail = highpass_diagnostics["highpassSuppressionMasks"]["f322-highpass-only"]
        if (
            highpass_detail["sigmaOutputPixels"] != 5.0
            or highpass_detail["maxDeltaDepthCodes"] != 4.0
            or highpass_detail["featherOutputPixels"] != 8.0
            or highpass_detail["absoluteAppliedDeltaDepthCodes"]["p99"] > 4.0 + 1e-6
        ):
            raise AssertionError("highpass suppression diagnostics or delta bound failed: %r" % highpass_detail)
        glyph_bbox_selector = {
            **self_test_selector,
            "minComponentPixelsNative": 2,
            # The 2x2 yellow glyph component below intentionally exceeds this
            # legacy maximum.  Bbox mode must retain it and let bbox occupancy,
            # not legacy white/glyph sizing, decide safety.
            "maxComponentPixelsNative": 3,
            "maxSelectedFractionOfCandidate": 0.85,
        }
        glyph_bbox_spec = normalize_overlay_mask_spec(
            {
                "schemaVersion": 1,
                "coordinateSpace": {"kind": "native_source_pixels", "width": 30, "height": 16},
                "frameIndexing": "absolute_source_frames_half_open",
                "strategy": {
                    "id": "opencv_telea_uint8_v1",
                    "radiusOutputPixels": 2,
                    "pixelSelector": glyph_bbox_selector,
                },
                "masks": [
                    {
                        "id": "bbox-left-label",
                        "startFrame": 3,
                        "endFrameExclusive": 5,
                        "selectorMode": "glyph_bbox_telea_v1",
                        "fillMode": "telea",
                        "bboxPaddingNativePixels": 6,
                        "shape": {"type": "rect", "x0": 1, "y0": 2, "x1Exclusive": 15, "y1Exclusive": 14},
                    },
                    {
                        "id": "bbox-right-empty",
                        "startFrame": 3,
                        "endFrameExclusive": 5,
                        "selectorMode": "glyph_bbox_telea_v1",
                        "fillMode": "telea",
                        "bboxPaddingNativePixels": 6,
                        "shape": {"type": "rect", "x0": 15, "y0": 2, "x1Exclusive": 29, "y1Exclusive": 14},
                    },
                ],
            },
            {"startFrame": 0, "endFrameExclusive": 10},
        )
        glyph_bbox_contract = {"enabled": True, **glyph_bbox_spec}
        glyph_bbox_masks = compile_overlay_masks(glyph_bbox_contract, 30, 16, cv2, np)
        glyph_bbox_pixels = np.full((16, 30, 3), 80, dtype=np.uint8)
        # A large white garment-like surface shares the left candidate.  The
        # yellow-only mode must ignore it completely when deriving the bbox.
        glyph_bbox_pixels[3:13, 2:7] = (255, 255, 255)
        # The retained glyph core touches the left candidate's half-open right
        # edge.  Its padded bbox must clip at x=15 and must not activate the
        # adjacent right candidate.
        glyph_bbox_pixels[6:8, 13:15] = (20, 220, 245)
        glyph_bbox_states = []
        glyph_bbox_selection = None
        glyph_bbox_diagnostics = None
        for absolute_frame in (2, 3, 4, 5):
            candidate_mask, candidate_ids, candidate_diagnostics = select_overlay_pixels(
                glyph_bbox_pixels,
                glyph_bbox_masks,
                absolute_frame,
                30,
                16,
                glyph_bbox_selector,
                cv2,
                np,
            )
            glyph_bbox_states.append(candidate_ids)
            if absolute_frame == 3:
                glyph_bbox_selection = candidate_mask
                glyph_bbox_diagnostics = candidate_diagnostics
        if glyph_bbox_states != [[], ["bbox-left-label", "bbox-right-empty"], ["bbox-left-label", "bbox-right-empty"], []]:
            raise AssertionError("glyph bbox selector half-open range self-test failed: %r" % glyph_bbox_states)
        expected_bbox_bounds = {"x0": 7, "y0": 2, "x1Exclusive": 15, "y1Exclusive": 14}
        if (
            glyph_bbox_selection is None
            or glyph_bbox_diagnostics is None
            or glyph_bbox_diagnostics["selectedMaskIds"] != ["bbox-left-label"]
            or glyph_bbox_diagnostics["rawSelectedPixelsNative"] != 4
            or glyph_bbox_diagnostics["keptComponentCount"] != 1
            or glyph_bbox_diagnostics["perMaskSelectedNativePixels"]["bbox-right-empty"] != 0
            or glyph_bbox_diagnostics["perMaskSelectedNativeBounds"]["bbox-left-label"] != expected_bbox_bounds
            or glyph_bbox_diagnostics["perMaskSelectedNativeBounds"]["bbox-right-empty"] is not None
        ):
            raise AssertionError(
                "glyph bbox padding, clipping, or per-mask attribution self-test failed: %r"
                % glyph_bbox_diagnostics
            )
        left_output_selection = glyph_bbox_diagnostics["selectedOutputMasks"]["bbox-left-label"]
        right_output_selection = glyph_bbox_diagnostics["selectedOutputMasks"]["bbox-right-empty"]
        if bool(right_output_selection.any()) or bool(np.any(left_output_selection[:, 15:] > 0)):
            raise AssertionError("glyph bbox selection escaped its own half-open candidate ROI")
        glyph_bbox_rows = np.arange(16, dtype=np.float32)[:, None]
        glyph_bbox_columns = np.arange(30, dtype=np.float32)[None, :]
        glyph_bbox_baseline = 0.15 + glyph_bbox_rows * 0.01 + glyph_bbox_columns * 0.002
        glyph_bbox_contaminated = glyph_bbox_baseline.copy()
        glyph_bbox_contaminated[glyph_bbox_selection > 0] = 0.95
        glyph_bbox_cleaned, _ = apply_selected_overlay_fills(
            glyph_bbox_contaminated,
            glyph_bbox_masks,
            glyph_bbox_diagnostics["selectedOutputMasks"],
            {},
            2,
            cv2,
            np,
        )
        glyph_bbox_exterior = glyph_bbox_selection == 0
        if not np.array_equal(
            glyph_bbox_cleaned[glyph_bbox_exterior],
            glyph_bbox_contaminated[glyph_bbox_exterior],
        ):
            raise AssertionError("glyph bbox Telea changed an exterior float")
        if not np.array_equal(
            glyph_bbox_cleaned[glyph_bbox_masks[1]["mask"] > 0],
            glyph_bbox_contaminated[glyph_bbox_masks[1]["mask"] > 0],
        ):
            raise AssertionError("glyph bbox Telea changed another mask's empty candidate")
        if float(glyph_bbox_cleaned[7, 13]) >= 0.75:
            raise AssertionError("glyph bbox Telea left the compact label depth plane")
        glyph_bbox_all_white = np.full((16, 30, 3), 255, dtype=np.uint8)
        glyph_bbox_white_mask, _, glyph_bbox_white_diagnostics = select_overlay_pixels(
            glyph_bbox_all_white,
            glyph_bbox_masks,
            3,
            30,
            16,
            glyph_bbox_selector,
            cv2,
            np,
        )
        if (
            glyph_bbox_white_mask is not None
            or glyph_bbox_white_diagnostics["rejectedReason"] is not None
            or glyph_bbox_white_diagnostics["rawSelectedPixelsNative"] != 0
            or glyph_bbox_white_diagnostics["selectedPixelsNative"] != 0
        ):
            raise AssertionError(
                "glyph bbox pure-white candidate was not ignored: %r"
                % glyph_bbox_white_diagnostics
            )
        glyph_bbox_all_yellow = np.full((16, 30, 3), (20, 220, 245), dtype=np.uint8)
        glyph_bbox_yellow_mask, _, glyph_bbox_yellow_diagnostics = select_overlay_pixels(
            glyph_bbox_all_yellow,
            glyph_bbox_masks,
            3,
            30,
            16,
            glyph_bbox_selector,
            cv2,
            np,
        )
        if (
            glyph_bbox_yellow_mask is not None
            or glyph_bbox_yellow_diagnostics["rejectedReason"] != "selected_fraction_exceeds_limit"
            or glyph_bbox_yellow_diagnostics["selectedFractionOfCandidate"] != 1.0
        ):
            raise AssertionError(
                "glyph bbox yellow high-occupancy candidate did not fail closed: %r"
                % glyph_bbox_yellow_diagnostics
            )
        glyph_bbox_fragmented_yellow = np.full((16, 30, 3), 80, dtype=np.uint8)
        glyph_bbox_fragmented_yellow[5:7, 2:4] = (20, 220, 245)
        glyph_bbox_fragmented_yellow[5:7, 12:14] = (20, 220, 245)
        glyph_bbox_fragmented_mask, _, glyph_bbox_fragmented_diagnostics = select_overlay_pixels(
            glyph_bbox_fragmented_yellow,
            glyph_bbox_masks,
            3,
            30,
            16,
            glyph_bbox_selector,
            cv2,
            np,
        )
        if (
            glyph_bbox_fragmented_mask is not None
            or glyph_bbox_fragmented_diagnostics["keptComponentCount"] != 2
            or glyph_bbox_fragmented_diagnostics["rejectedMaskIds"] != ["bbox-left-label"]
            or glyph_bbox_fragmented_diagnostics["rejectedReason"] != "selected_fraction_exceeds_limit"
        ):
            raise AssertionError(
                "glyph bbox fragmented yellow surface did not fail closed: %r"
                % glyph_bbox_fragmented_diagnostics
            )
        glyph_bbox_beige = np.full((16, 30, 3), (180, 210, 230), dtype=np.uint8)
        glyph_bbox_beige_mask, _, glyph_bbox_beige_diagnostics = select_overlay_pixels(
            glyph_bbox_beige,
            glyph_bbox_masks,
            3,
            30,
            16,
            glyph_bbox_selector,
            cv2,
            np,
        )
        if (
            glyph_bbox_beige_mask is not None
            or glyph_bbox_beige_diagnostics["rawSelectedPixelsNative"] != 0
            or glyph_bbox_beige_diagnostics["selectedPixelsNative"] != 0
        ):
            raise AssertionError(
                "glyph bbox selected a uniform beige surface: %r"
                % glyph_bbox_beige_diagnostics
            )
        vertical_spec = normalize_overlay_mask_spec(
            {
                "schemaVersion": 1,
                "coordinateSpace": {"kind": "native_source_pixels", "width": 20, "height": 16},
                "frameIndexing": "absolute_source_frames_half_open",
                "strategy": {
                    "id": "opencv_telea_uint8_v1",
                    "radiusOutputPixels": 2,
                    "pixelSelector": selector_test_config,
                },
                "masks": [{
                    "id": "white-subtitle-column-band",
                    "startFrame": 3,
                    "endFrameExclusive": 5,
                    "selectorMode": "glyph_components",
                    "fillMode": "vertical_column_band_v1",
                    "boundarySampleRowsOutput": 3,
                    "featherOutputPixels": 2,
                    "shape": {"type": "rect", "x0": 2, "y0": 4, "x1Exclusive": 18, "y1Exclusive": 12},
                }],
            },
            {"startFrame": 0, "endFrameExclusive": 10},
        )
        vertical_contract = {"enabled": True, **vertical_spec}
        vertical_masks = compile_overlay_masks(vertical_contract, 20, 16, cv2, np)
        vertical_pixels = np.full((16, 20, 3), 80, dtype=np.uint8)
        vertical_pixels[7:9, 8:11] = (255, 255, 255)
        vertical_states = []
        vertical_selection = None
        vertical_selection_diagnostics = None
        for absolute_frame in (2, 3, 4, 5):
            candidate_mask, candidate_ids, candidate_diagnostics = select_overlay_pixels(
                vertical_pixels,
                vertical_masks,
                absolute_frame,
                20,
                16,
                vertical_contract["strategy"]["pixelSelector"],
                cv2,
                np,
            )
            vertical_states.append(candidate_ids)
            if absolute_frame == 3:
                vertical_selection = candidate_mask
                vertical_selection_diagnostics = candidate_diagnostics
        if vertical_states != [[], ["white-subtitle-column-band"], ["white-subtitle-column-band"], []]:
            raise AssertionError("vertical column band half-open selection self-test failed: %r" % vertical_states)
        if vertical_selection is None or vertical_selection_diagnostics is None:
            raise AssertionError("vertical column band glyph selector produced no selection")
        full_white_vertical = np.full((16, 20, 3), 255, dtype=np.uint8)
        vertical_occupancy_mask, _, vertical_occupancy_diagnostics = select_overlay_pixels(
            full_white_vertical,
            vertical_masks,
            3,
            20,
            16,
            default_overlay_pixel_selector(),
            cv2,
            np,
        )
        if (
            vertical_occupancy_mask is not None
            or vertical_occupancy_diagnostics["rejectedReason"] != "selected_fraction_exceeds_limit"
            or vertical_occupancy_diagnostics["selectedFractionOfCandidate"] != 1.0
        ):
            raise AssertionError(
                "vertical column band all-white occupancy did not fail closed: %r"
                % vertical_occupancy_diagnostics
            )
        vertical_large_component_mask, _, vertical_large_component_diagnostics = select_overlay_pixels(
            full_white_vertical,
            vertical_masks,
            3,
            20,
            16,
            vertical_contract["strategy"]["pixelSelector"],
            cv2,
            np,
        )
        if (
            vertical_large_component_mask is not None
            or vertical_large_component_diagnostics["rawSelectedPixelsNative"] == 0
            or vertical_large_component_diagnostics["keptComponentCount"] != 0
            or vertical_large_component_diagnostics["selectedPixelsNative"] != 0
        ):
            raise AssertionError(
                "vertical column band oversized component did not fail closed: %r"
                % vertical_large_component_diagnostics
            )
        beige_pixels = np.full((16, 20, 3), (180, 210, 230), dtype=np.uint8)
        beige_mask, _, beige_diagnostics = select_overlay_pixels(
            beige_pixels,
            vertical_masks,
            3,
            20,
            16,
            vertical_contract["strategy"]["pixelSelector"],
            cv2,
            np,
        )
        if beige_mask is not None or beige_diagnostics["rawSelectedPixelsNative"] != 0:
            raise AssertionError("vertical column band selected a uniform beige surface: %r" % beige_diagnostics)
        vertical_rows = np.arange(16, dtype=np.float32)[:, None]
        vertical_columns = np.arange(20, dtype=np.float32)[None, :]
        vertical_baseline = 0.12 + vertical_rows * 0.025 + vertical_columns * 0.001
        vertical_contaminated = vertical_baseline.copy()
        rect_bounds = vertical_masks[0]["outputBounds"]
        local_support = np.any(
            vertical_selection[
                rect_bounds["y0"]:rect_bounds["y1Exclusive"],
                rect_bounds["x0"]:rect_bounds["x1Exclusive"],
            ] > 0,
            axis=0,
        )
        supported_columns = np.flatnonzero(local_support) + rect_bounds["x0"]
        vertical_contaminated[
            np.ix_(np.arange(rect_bounds["y0"], rect_bounds["y1Exclusive"]), supported_columns)
        ] = 0.95
        vertical_cleaned, vertical_fill_diagnostics = apply_selected_overlay_fills(
            vertical_contaminated,
            vertical_masks,
            vertical_selection_diagnostics["selectedOutputMasks"],
            {},
            2,
            cv2,
            np,
        )
        vertical_band = np.zeros_like(vertical_selection, dtype=bool)
        vertical_band[
            rect_bounds["y0"]:rect_bounds["y1Exclusive"], supported_columns
        ] = True
        if not np.array_equal(vertical_cleaned[~vertical_band], vertical_contaminated[~vertical_band]):
            raise AssertionError("vertical column band changed an unsupported column or ROI-exterior float")
        center_x = int(supported_columns[len(supported_columns) // 2])
        if not np.allclose(
            vertical_cleaned[7:9, center_x],
            vertical_baseline[7:9, center_x],
            rtol=0.0,
            atol=1e-6,
        ):
            raise AssertionError(
                "vertical column band did not linearly reconstruct the top/bottom surface: %r"
                % vertical_cleaned[7:9, center_x]
            )
        vertical_detail = vertical_fill_diagnostics["verticalColumnBandMasks"]["white-subtitle-column-band"]
        if (
            vertical_detail["supportedColumns"] != int(supported_columns.size)
            or vertical_detail["bandPixels"] != int(np.count_nonzero(vertical_band))
            or vertical_detail["featherOutputPixels"] != 2.0
        ):
            raise AssertionError("vertical column band diagnostics self-test failed: %r" % vertical_detail)
        single_column_selection = np.zeros_like(vertical_selection, dtype=np.uint8)
        single_column_x = 9
        single_column_selection[8, single_column_x] = 255
        single_column_contaminated = vertical_baseline.copy()
        single_column_contaminated[
            rect_bounds["y0"]:rect_bounds["y1Exclusive"], single_column_x
        ] = 0.95
        single_column_cleaned, _ = apply_selected_overlay_fills(
            single_column_contaminated,
            vertical_masks,
            {"white-subtitle-column-band": single_column_selection},
            {},
            2,
            cv2,
            np,
        )
        if not math.isclose(
            float(single_column_cleaned[8, single_column_x]),
            float(vertical_baseline[8, single_column_x]),
            rel_tol=0.0,
            abs_tol=1e-6,
        ):
            raise AssertionError("single-column vertical band center was not fully replaced")
        if not np.array_equal(
            single_column_cleaned[:, single_column_x - 1],
            single_column_contaminated[:, single_column_x - 1],
        ):
            raise AssertionError("single-column vertical band changed an unsupported adjacent column")
        invalid_anchor_rejected = False
        try:
            normalize_overlay_mask_spec(
                {
                    "schemaVersion": 1,
                    "coordinateSpace": {"kind": "native_source_pixels", "width": 16, "height": 12},
                    "frameIndexing": "absolute_source_frames_half_open",
                    "strategy": {
                        "id": "opencv_telea_uint8_v1",
                        "radiusOutputPixels": 2,
                        "pixelSelector": self_test_selector,
                    },
                    "masks": [{
                        "id": "invalid-anchor-inside-text-interval",
                        "startFrame": 3,
                        "endFrameExclusive": 5,
                        "selectorMode": "full_candidate",
                        "fillMode": "clean_anchor_patch",
                        "cleanAnchorFrames": [4],
                        "shape": {"type": "rect", "x0": 3, "y0": 3, "x1Exclusive": 13, "y1Exclusive": 9},
                    }],
                },
                {"startFrame": 0, "endFrameExclusive": 10},
            )
        except ValueError:
            invalid_anchor_rejected = True
        if not invalid_anchor_rejected:
            raise AssertionError("clean anchor inside the active text interval was not rejected")
        try:
            normalize_overlay_mask_spec(
                {
                    "schemaVersion": 1,
                    "coordinateSpace": {"kind": "native_source_pixels", "width": 4, "height": 4},
                    "frameIndexing": "absolute_source_frames_half_open",
                    "strategy": {
                        "id": "opencv_telea_uint8_v1",
                        "radiusOutputPixels": 2,
                        "pixelSelector": self_test_selector,
                    },
                    "masks": [{
                        "id": "out-of-bounds",
                        "startFrame": 3,
                        "endFrameExclusive": 3,
                        "shape": {"type": "rect", "x0": 1, "y0": 1, "x1Exclusive": 5, "y1Exclusive": 3},
                    }],
                },
                {"startFrame": 0, "endFrameExclusive": 10},
            )
        except ValueError:
            pass
        else:
            raise AssertionError("invalid overlay mask rejection self-test failed")
        encoder_results: List[Dict[str, Any]] = []
        for index, count in enumerate((2, 3), start=1):
            encoded = root / ("segment-%03d.mp4" % index)
            writer = SegmentWriter(encoded, 720, 1280, Fraction(30, 1), count, ffmpeg, "ultrafast", 23)
            for frame_index in range(count):
                writer.write(np.full((1280, 720), 32 + index * 40 + frame_index, dtype=np.uint8))
            writer.close()
            probe = probe_output(encoded, ffprobe)
            if (
                probe["codec"] != "h264"
                or probe["pixelFormat"] != "yuv420p"
                or probe["width"] != 720
                or probe["height"] != 1280
                or probe["frameCount"] != count
                or probe["fps"] != Fraction(30, 1)
                or probe["audioStreamCount"] != 0
            ):
                raise AssertionError("H.264 segment encoder self-test failed: %r" % probe)
            encoder_results.append({**probe, "fps": str(probe["fps"])})
        fallback_source = root / "filesystem-fallback.source"
        fallback_destination = root / "filesystem-fallback.destination"
        fallback_source.write_bytes(b"verified-exclusive-copy-fallback")

        def unsupported_link(_source: str, _destination: str) -> None:
            raise OSError(getattr(errno, "ENOTSUP", errno.EPERM), "hard links unsupported")

        publish_file_exclusive(fallback_source, fallback_destination, link_fn=unsupported_link)
        if fallback_destination.read_bytes() != fallback_source.read_bytes():
            raise AssertionError("filesystem fallback publication self-test failed")
    return {
        "runnerId": RUNNER_ID,
        "percentiles": actual,
        "flowBlend": "PASS",
        "sceneCutReset": "PASS",
        "longSourceWindow": "PASS",
        "overlayHalfOpenRanges": "PASS",
        "overlayCoordinateScaling": "PASS",
        "overlayOccupancyGuard": "PASS",
        "overlaySkinToneRejected": "PASS",
        "overlayPerMaskAttribution": "PASS",
        "overlayPerMaskOccupancyGuard": "PASS",
        "overlayPixelSelectorRoiPreserved": "PASS",
        "overlayUnmaskedPixelsUnchanged": "PASS",
        "overlayHighPlaneRemoved": "PASS",
        "overlayExplicitFullCandidateHalfOpen": "PASS",
        "overlayFullCandidateRequiresExplicitMode": "PASS",
        "overlayCleanAnchorOutsideUnchanged": "PASS",
        "overlayCleanAnchorInvalidFrameRejected": "PASS",
        "overlayHighpassSuppressionHalfOpen": "PASS",
        "overlayHighpassSuppressionOutsideUnchanged": "PASS",
        "overlayHighpassSuppressionBounded": "PASS",
        "overlayHighpassSuppressionResidualRemoved": "PASS",
        "overlayGlyphBboxYellowOnly": "PASS",
        "overlayGlyphBboxLargeYellowComponentRetained": "PASS",
        "overlayGlyphBboxHalfOpen": "PASS",
        "overlayGlyphBboxPaddingClipped": "PASS",
        "overlayGlyphBboxIndependentPerMask": "PASS",
        "overlayGlyphBboxWhiteGarmentIgnored": "PASS",
        "overlayGlyphBboxOccupancyGuard": "PASS",
        "overlayGlyphBboxExteriorUnchanged": "PASS",
        "overlayVerticalColumnBandHalfOpen": "PASS",
        "overlayVerticalColumnBandOccupancyGuard": "PASS",
        "overlayVerticalColumnBandLargeComponentFailClosed": "PASS",
        "overlayVerticalColumnBandBeigeRejected": "PASS",
        "overlayVerticalColumnBandUnsupportedColumnsUnchanged": "PASS",
        "overlayVerticalColumnBandLinearSurface": "PASS",
        "overlayVerticalColumnBandSingleColumn": "PASS",
        "overlayInvalidMaskRejected": "PASS",
        "encoder": "PASS",
        "filesystemFallback": "PASS",
        "encodedSegments": encoder_results,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input")
    parser.add_argument("--model-path")
    parser.add_argument("--model-output", choices=("inverse_depth", "depth"))
    parser.add_argument("--output-dir")
    parser.add_argument("--metadata")
    parser.add_argument("--start-frame", type=int, default=DEFAULT_START_FRAME)
    parser.add_argument("--expect-frames", type=int, default=DEFAULT_EXPECTED_FRAMES)
    parser.add_argument("--expect-fps", default=str(DEFAULT_EXPECTED_FPS))
    parser.add_argument("--output-size", default="%dx%d" % DEFAULT_OUTPUT_SIZE)
    parser.add_argument("--segments", default=DEFAULT_SEGMENTS)
    parser.add_argument(
        "--overlay-mask-spec",
        help=(
            "optional UTF-8 JSON mask contract using absolute source-frame half-open ranges "
            "and rect/polygon shapes in native source pixel coordinates; per-mask defaults are "
            "glyph_components plus telea, with glyph_bbox_telea_v1 for an independently padded "
            "tight glyph bbox, explicit full_candidate plus clean_anchor_patch, or rect-only "
            "glyph_components plus vertical_column_band_v1 support"
        ),
    )
    parser.add_argument("--low-percentile", type=float, default=DEFAULT_LOW_PERCENTILE)
    parser.add_argument("--high-percentile", type=float, default=DEFAULT_HIGH_PERCENTILE)
    parser.add_argument("--current-weight", type=float, default=DEFAULT_CURRENT_WEIGHT)
    parser.add_argument("--history-weight", type=float, default=DEFAULT_HISTORY_WEIGHT)
    parser.add_argument("--flow-scale", type=float, default=0.5)
    parser.add_argument("--photometric-threshold", type=float, default=28.0)
    parser.add_argument("--forward-backward-threshold", type=float, default=1.5)
    parser.add_argument("--minimum-confidence", type=float, default=0.40)
    parser.add_argument("--cut-threshold", type=float, default=0.65)
    parser.add_argument("--fast-motion-pixels", type=float, default=80.0)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    parser.add_argument("--torch-threads", type=int, default=1)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--preset", choices=("ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"), default="medium")
    parser.add_argument("--crf", type=int, default=15)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--print-contract", action="store_true")
    parser.add_argument("--algorithm-self-test", action="store_true")
    return parser


def validate_numeric_runtime_options(arguments: argparse.Namespace) -> None:
    if not 0.1 <= arguments.flow_scale <= 1.0:
        fail("--flow-scale must be between 0.1 and 1.0")
    if arguments.photometric_threshold <= 0.0:
        fail("--photometric-threshold must be positive")
    if arguments.forward_backward_threshold <= 0.0:
        fail("--forward-backward-threshold must be positive")
    if not 0.0 <= arguments.minimum_confidence <= 1.0:
        fail("--minimum-confidence must be between 0 and 1")
    if not 0.0 <= arguments.cut_threshold <= 1.0:
        fail("--cut-threshold must be between 0 and 1")
    if arguments.fast_motion_pixels <= 0.0:
        fail("--fast-motion-pixels must be positive")
    if arguments.torch_threads < 1:
        fail("--torch-threads must be positive")
    if not 0 <= arguments.crf <= 51:
        fail("--crf must be between 0 and 51")


def run(arguments: argparse.Namespace) -> Dict[str, Any]:
    validate_numeric_runtime_options(arguments)
    contract = effective_contract(arguments)
    preflight_overlay_exclusion(contract)
    input_path = Path(contract["input"])
    model_path = Path(contract["modelPath"])
    output_dir = Path(contract["outputDirectory"])
    metadata_path = Path(contract["metadataPath"])
    source_hash_before = sha256_file(input_path)
    model_manifest_before = fingerprint_model_directory(model_path)
    source_probe = probe_video(input_path, arguments.ffprobe)
    verify_source_probe(source_probe, contract)
    verify_overlay_source_size(contract["overlayExclusion"], source_probe)
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    cv2, np, torch, model_runtime = configure_offline_runtime(arguments.device, arguments.torch_threads)
    model = LocalDepthModel(model_path, model_runtime)
    runtime_identity = {
        "processorClass": model.processor.__class__.__name__,
        "modelClass": model.model.__class__.__name__,
        "numpyVersion": np.__version__,
        "opencvVersion": cv2.__version__,
        "torchVersion": torch.__version__,
    }
    with tempfile.TemporaryDirectory(prefix="depth-video-run-", dir=str(output_dir.parent)) as scratch_text:
        scratch = Path(scratch_text)
        depth_cache, native_shape = inference_pass(
            input_path, model, contract["inputWindow"]["startFrame"], contract["expectedFrames"], scratch / "depth-cache.f32",
            cv2, np, torch,
        )
        del model
        gc.collect()
        low_bound, high_bound = exact_linear_percentiles_from_memmap(
            depth_cache,
            [arguments.low_percentile, arguments.high_percentile],
            scratch / "quantile-work.f32",
            np,
        )
        if not math.isfinite(low_bound) or not math.isfinite(high_bound) or high_bound <= low_bound:
            raise RuntimeError("full-window P2/P98 produced an unusable depth range")
        segment_details, temporal, overlay_execution, partial_to_final = render_pass(
            input_path, depth_cache, contract, low_bound, high_bound, scratch,
            arguments, cv2, np,
        )
        verified_outputs = verify_partial_outputs(partial_to_final, contract, arguments.ffprobe)
        source_hash_after = sha256_file(input_path)
        if source_hash_after != source_hash_before:
            raise RuntimeError("read-only source SHA-256 changed during conversion")
        model_manifest_after = fingerprint_model_directory(model_path)
        if model_manifest_after["fingerprint"] != model_manifest_before["fingerprint"]:
            raise RuntimeError("local model files changed during conversion")
        publish_outputs(partial_to_final)
    for segment, verification in zip(segment_details, verified_outputs):
        segment.update(verification)
    metadata: Dict[str, Any] = {
        "schemaVersion": 1,
        "runnerId": RUNNER_ID,
        "contractFingerprint": contract["contractFingerprint"],
        "source": {
            "path": str(input_path),
            "sha256Before": source_hash_before,
            "sha256After": source_hash_after,
            "width": source_probe["width"],
            "height": source_probe["height"],
            "frameCount": source_probe["frameCount"],
            "fps": str(source_probe["averageFps"]),
            "inputWindow": contract["inputWindow"],
        },
        "model": {
            **model_manifest_before,
            "device": arguments.device,
            "torchThreads": arguments.torch_threads,
            "outputSemantics": arguments.model_output,
            "offline": True,
            **runtime_identity,
        },
        "normalization": {
            "scope": "all_frames_all_native_depth_pixels",
            "nativeDepthHeight": native_shape[0],
            "nativeDepthWidth": native_shape[1],
            "method": "exact_linear_percentile_from_disk_memmap",
            "lowPercentile": arguments.low_percentile,
            "highPercentile": arguments.high_percentile,
            "lowBound": low_bound,
            "highBound": high_bound,
            "perFrameContrastStretch": False,
        },
        "depthEncoding": "near_white_far_black",
        "temporalStabilization": temporal,
        "overlayExclusion": {
            "contract": contract["overlayExclusion"],
            "execution": overlay_execution,
        },
        "output": {
            "container": "mp4",
            "codec": "h264",
            "pixelFormat": "yuv420p",
            "width": contract["outputSize"]["width"],
            "height": contract["outputSize"]["height"],
            "fps": contract["expectedFps"],
            "totalFrames": sum(item["frameCount"] for item in verified_outputs),
            "audio": False,
            "segments": segment_details,
        },
    }
    metadata["executionFingerprint"] = stable_fingerprint(metadata)
    write_metadata_atomic(metadata_path, metadata)
    return metadata


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        if arguments.print_contract:
            json_print(base_contract())
            return 0
        if arguments.algorithm_self_test:
            json_print(algorithm_self_test(arguments.ffmpeg, arguments.ffprobe))
            return 0
        validate_numeric_runtime_options(arguments)
        contract = effective_contract(arguments)
        if arguments.validate_only:
            preflight_overlay_exclusion(contract)
            json_print(contract)
            return 0
        metadata = run(arguments)
        json_print(metadata)
        return 0
    except (AssertionError, FileNotFoundError, FileExistsError, RuntimeError, TypeError, ValueError, OSError) as error:
        print("ERROR: %s" % error, file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
