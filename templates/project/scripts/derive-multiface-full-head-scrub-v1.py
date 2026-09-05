#!/usr/bin/env python3
"""Create a strongly anonymized, multi-face source reference for face-only edits.

Every detected face is expanded to a full-head envelope and rendered as a strong
coarse mosaic.  The program deliberately fails instead of emitting a reference
when the supplied per-frame face-count contract is not met: a missing split-screen
face must never silently leak the source identity into a downstream video model.

The source audio is copied unchanged.  Only pixels inside the full-head masks are
altered; neck, body, wardrobe, product, subtitles, background and edit cadence stay
outside those masks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stream_hash(path: Path, selector: str) -> str:
    result = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
        "-map", selector, "-c", "copy", "-f", "hash", "-hash", "sha256", "-",
    ], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    line = next((value for value in (result.stdout + "\n" + result.stderr).splitlines() if value.startswith("SHA256=")), "")
    if len(line) != 71:
        fail(f"could not hash stream {selector} in {path}")
    return line.split("=", 1)[1].lower()


def fail(message: str) -> None:
    raise RuntimeError(message)


def parse_expected(spec: str, frame_count: int) -> list[int]:
    """Parse `start:end:count,...`, where end is exclusive."""
    expected: list[int | None] = [None] * frame_count
    for raw_item in spec.split(","):
        item = raw_item.strip()
        if not item:
            continue
        parts = item.split(":")
        if len(parts) != 3:
            fail(f"invalid expected-count item: {item!r}")
        start, end, count = (int(value) for value in parts)
        if not (0 <= start < end <= frame_count and count >= 0):
            fail(f"out-of-range expected-count item: {item!r}")
        for index in range(start, end):
            if expected[index] is not None:
                fail(f"overlapping expected-count contract at frame {index}")
            expected[index] = count
    if any(value is None for value in expected):
        missing = next(index for index, value in enumerate(expected) if value is None)
        fail(f"expected-count contract does not cover frame {missing}")
    return [int(value) for value in expected]


def source_contract(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True, text=True, stdout=subprocess.PIPE,
    )
    payload = json.loads(result.stdout)
    videos = [stream for stream in payload.get("streams", []) if stream.get("codec_type") == "video"]
    audios = [stream for stream in payload.get("streams", []) if stream.get("codec_type") == "audio"]
    if len(videos) != 1:
        fail("source must contain exactly one video stream")
    video = videos[0]
    frame_count = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)
    rate = video.get("avg_frame_rate", "0/0").split("/")
    fps = float(rate[0]) / float(rate[1]) if len(rate) == 2 and float(rate[1]) else 0.0
    if frame_count < 1 or fps <= 0:
        fail("source must expose a positive frame count and frame rate")
    return {
        "path": str(path), "sha256": sha256(path), "width": int(video["width"]),
        "height": int(video["height"]), "frameCount": frame_count, "frameRate": fps,
        "audioStreams": len(audios), "durationSec": float(payload["format"]["duration"]),
    }


def accepted_boxes(faces: np.ndarray | None) -> list[np.ndarray]:
    if faces is None:
        return []
    candidates: list[np.ndarray] = []
    for face in faces:
        x, y, width, height, score = (float(face[index]) for index in (0, 1, 2, 3, 14))
        # A 36x48 lower bound rejects tiny texture false positives while retaining
        # the smaller right-hand comparison-panel face in this 576x1024 source.
        if score >= 0.80 and width >= 36 and height >= 48:
            candidates.append(np.array([x, y, width, height], dtype=np.float64))
    if not candidates:
        return []
    # A high-confidence but much smaller box can be a hair clip or fabric texture.
    # Keep comparison-panel faces (their area is consistently >= 30% of the larger
    # panel face), but reject a candidate below that ratio before applying a blur.
    largest_area = max(float(box[2] * box[3]) for box in candidates)
    return [box for box in candidates if float(box[2] * box[3]) >= largest_area * 0.30]


def full_head_mask(shape: tuple[int, ...], box: np.ndarray) -> np.ndarray:
    x, y, width, height = box.tolist()
    # YuNet reports the facial plane.  Expand above the hairline and over both ears,
    # but terminate at the chin/top-of-neck boundary rather than torso or garment.
    center = (round(x + width * 0.50), round(y + height * 0.28))
    axes = (max(16, round(width * 0.84)), max(20, round(height * 0.80)))
    mask = np.zeros(shape[:2], dtype=np.uint8)
    cv2.ellipse(mask, center, axes, 0, 0, 360, 255, thickness=-1, lineType=cv2.LINE_AA)
    return cv2.GaussianBlur(mask, (15, 15), 0).astype(np.float32) / 255.0


def scrub_frame(
    frame: np.ndarray,
    boxes: list[np.ndarray],
    width: int,
    height: int,
    mosaic_cell_size: int,
    blur_sigma: float,
    mosaic_weight: float,
) -> tuple[np.ndarray, dict]:
    # The head envelope is fixed by full_head_mask.  Strength is configurable so
    # a strict "no recognizable facial features" job can increase concealment
    # without expanding the mask into neck, torso, garments, products or scene.
    mosaic = cv2.resize(
        frame,
        (max(1, width // mosaic_cell_size), max(1, height // mosaic_cell_size)),
        interpolation=cv2.INTER_AREA,
    )
    mosaic = cv2.resize(mosaic, (width, height), interpolation=cv2.INTER_NEAREST)
    if mosaic_weight >= 1.0:
        concealed = mosaic
    else:
        blurred = cv2.GaussianBlur(frame, (0, 0), sigmaX=blur_sigma, sigmaY=blur_sigma)
        concealed = cv2.addWeighted(mosaic, mosaic_weight, blurred, 1.0 - mosaic_weight, 0)
    result = frame.astype(np.float32)
    union = np.zeros(frame.shape[:2], dtype=np.float32)
    face_box_area = 0.0
    lowest_face_bottom = 0.0
    for box in boxes:
        alpha = full_head_mask(frame.shape, box)[..., None]
        union = np.maximum(union, alpha[..., 0])
        face_box_area += float(box[2] * box[3])
        lowest_face_bottom = max(lowest_face_bottom, float(box[1] + box[3]))
        result = result * (1.0 - alpha) + concealed.astype(np.float32) * alpha
    affected = np.argwhere(union > 0.01)
    affected_pixels = int(affected.shape[0])
    bottom = int(affected[:, 0].max()) if affected_pixels else -1
    return np.clip(result, 0, 255).astype(np.uint8), {
        "coverageRatio": affected_pixels / float(width * height),
        "maskToFaceBoxArea": affected_pixels / face_box_area if face_box_area else 0.0,
        "bottomExtensionFaceHeights": max(0.0, (bottom - lowest_face_bottom) / max(float(box[3]) for box in boxes)) if boxes else 0.0,
    }


def residual_face_counts(path: Path, detector, frame_count: int) -> list[int]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        fail("could not open anonymized output for residual-identity audit")
    counts: list[int] = []
    try:
        for frame_index in range(frame_count):
            ok, frame = capture.read()
            if not ok:
                fail(f"anonymized output ended during residual audit at frame {frame_index}")
            detector.setInputSize((frame.shape[1], frame.shape[0]))
            _, faces = detector.detect(frame)
            counts.append(len(accepted_boxes(faces)))
    finally:
        capture.release()
    if any(counts):
        frame_index = next(index for index, count in enumerate(counts) if count)
        fail(f"old facial features remain machine-detectable at frame {frame_index}")
    return counts


def verify_output(path: Path, source: dict) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True, text=True, stdout=subprocess.PIPE,
    )
    payload = json.loads(result.stdout)
    videos = [stream for stream in payload.get("streams", []) if stream.get("codec_type") == "video"]
    audios = [stream for stream in payload.get("streams", []) if stream.get("codec_type") == "audio"]
    if len(videos) != 1:
        fail("output does not contain exactly one video stream")
    video = videos[0]
    frames = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)
    if (int(video["width"]), int(video["height"]), frames, len(audios)) != (
        source["width"], source["height"], source["frameCount"], source["audioStreams"],
    ):
        fail("output media contract differs from source")
    return {
        "path": str(path), "sha256": sha256(path), "width": int(video["width"]),
        "height": int(video["height"]), "frameCount": frames, "frameRate": video.get("avg_frame_rate"),
        "durationSec": float(payload["format"]["duration"]), "audioStreams": len(audios),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("model", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("stats", type=Path)
    parser.add_argument("--expected-counts", required=True, help="start:end:count ranges, end exclusive")
    parser.add_argument("--mosaic-cell-size", type=int, default=18, help="coarse mosaic cell size in output pixels")
    parser.add_argument("--blur-sigma", type=float, default=44.0, help="Gaussian sigma blended inside the full-head mask")
    parser.add_argument("--mosaic-weight", type=float, default=0.90, help="mosaic weight inside the concealed head")
    parser.add_argument("--encoder-preset", default="slow", help="libx264 preset for the derived source video")
    args = parser.parse_args()
    source, model, output, stats = (path.resolve() for path in (args.source, args.model, args.output, args.stats))
    if output.exists() or stats.exists():
        fail("refusing to overwrite output or stats")
    if not source.is_file() or not model.is_file():
        fail("source or YuNet model is missing")
    if args.mosaic_cell_size < 1:
        fail("mosaic-cell-size must be positive")
    if args.blur_sigma <= 0:
        fail("blur-sigma must be positive")
    if not 0.0 <= args.mosaic_weight <= 1.0:
        fail("mosaic-weight must be between 0 and 1")
    contract = source_contract(source)
    expected = parse_expected(args.expected_counts, contract["frameCount"])
    detector = cv2.FaceDetectorYN.create(str(model), "", (contract["width"], contract["height"]), 0.80, 0.30, 5000)
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        fail("could not open source")
    output.parent.mkdir(parents=True, exist_ok=True)
    stats.parent.mkdir(parents=True, exist_ok=True)
    video_only = output.with_name(f".{output.stem}.video-only.tmp.mp4")
    process = subprocess.Popen([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{contract['width']}x{contract['height']}",
        "-r", str(contract["frameRate"]), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", args.encoder_preset,
        "-crf", "17", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video_only),
    ], stdin=subprocess.PIPE)
    detected_counts: list[int] = []
    geometry: list[dict] = []
    try:
        for frame_index in range(contract["frameCount"]):
            ok, frame = capture.read()
            if not ok:
                fail(f"source ended at frame {frame_index}")
            detector.setInputSize((frame.shape[1], frame.shape[0]))
            _, faces = detector.detect(frame)
            boxes = accepted_boxes(faces)
            detected_counts.append(len(boxes))
            if len(boxes) != expected[frame_index]:
                fail(
                    f"face-count contract failed at frame {frame_index}: expected {expected[frame_index]}, got {len(boxes)}; "
                    "refusing to emit a potentially identity-leaking reference"
                )
            if process.stdin is None:
                fail("encoder stdin unavailable")
            scrubbed, frame_geometry = scrub_frame(
                frame, boxes, contract["width"], contract["height"],
                args.mosaic_cell_size, args.blur_sigma, args.mosaic_weight,
            )
            geometry.append(frame_geometry)
            process.stdin.write(scrubbed.tobytes())
    finally:
        capture.release()
        if process.stdin is not None:
            process.stdin.close()
        if process.wait() != 0:
            fail("video encoder failed")
    try:
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", str(video_only), "-i", str(source),
            "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", str(output),
        ], check=True)
    finally:
        if video_only.exists():
            video_only.unlink()
    if max(item["maskToFaceBoxArea"] for item in geometry) > 2.8:
        fail("full-head mask expanded beyond the allowed face-relative envelope")
    if max(item["bottomExtensionFaceHeights"] for item in geometry) > 0.25:
        fail("full-head mask expanded too far below the detected face toward neck or body")
    residual_counts = residual_face_counts(output, detector, contract["frameCount"])
    source_audio_sha256 = stream_hash(source, "0:a:0")
    output_audio_sha256 = stream_hash(output, "0:a:0")
    if source_audio_sha256 != output_audio_sha256:
        fail("output audio packets differ from the source clip")
    payload = {
        "schemaVersion": 1,
        "source": contract,
        "detector": {"name": "OpenCV YuNet", "model": str(model), "scoreThreshold": 0.80, "minimumBox": [36, 48], "minimumRelativeArea": 0.30},
        "faceCountContract": args.expected_counts,
        "detectedFaceCounts": detected_counts,
        "residualFaceCounts": residual_counts,
        "mask": {
            "scope": "every detected full head through chin; no deliberate neck, torso, garment, product, subtitle or background expansion",
            "method": "mosaic plus Gaussian blend inside feathered full-head ellipses",
            "mosaicCellSize": args.mosaic_cell_size,
            "blurSigma": args.blur_sigma,
            "mosaicWeight": args.mosaic_weight,
            "encoderPreset": args.encoder_preset,
        },
        "maskAudit": {
            "geometryStatus": "PASS",
            "maxCoverageRatio": max(item["coverageRatio"] for item in geometry),
            "maxMaskToFaceBoxArea": max(item["maskToFaceBoxArea"] for item in geometry),
            "maxBottomExtensionFaceHeights": max(item["bottomExtensionFaceHeights"] for item in geometry),
            "residualFaceDetectionStatus": "PASS",
        },
        "audioPolicy": "copy original audio unchanged",
        "audioIntegrity": {"status": "PASS", "sourceSha256": source_audio_sha256, "outputSha256": output_audio_sha256},
        "output": verify_output(output, contract),
    }
    stats.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
