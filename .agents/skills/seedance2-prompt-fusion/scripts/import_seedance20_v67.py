#!/usr/bin/env python3
"""Import a complete Seedance 2.0 skill release as inert internal modules.

The imported package remains readable and hash-traceable inside the canonical
seedance2-prompt skill.  Nested SKILL.md entrypoints are renamed to MODULE.md
so they cannot compete with the canonical skill for discovery or prompting.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def destination_relative(source_relative: Path) -> Path:
    if source_relative.name == "SKILL.md":
        return source_relative.with_name("MODULE.md")
    return source_relative


def copy_file(source: Path, destination: Path) -> bool:
    payload = source.read_bytes()
    transformed = False
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        return transformed

    rewritten = text.replace("SKILL.md", "MODULE.md")
    transformed = rewritten != text
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(rewritten, encoding="utf-8")
    shutil.copystat(source, destination)
    return transformed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    source = args.source.resolve()
    destination = args.destination.resolve()
    if not source.is_dir():
        raise SystemExit(f"source is not a directory: {source}")
    if destination.exists():
        raise SystemExit(f"destination already exists: {destination}")

    records = []
    for source_file in sorted(path for path in source.rglob("*") if path.is_file()):
        source_relative = source_file.relative_to(source)
        target_relative = destination_relative(source_relative)
        target_file = destination / target_relative
        transformed = copy_file(source_file, target_file)
        records.append(
            {
                "source_path": source_relative.as_posix(),
                "integrated_path": target_relative.as_posix(),
                "source_sha256": sha256(source_file),
                "integrated_sha256": sha256(target_file),
                "transformation": "SKILL.md renamed/relinked to MODULE.md"
                if transformed or source_relative.name == "SKILL.md"
                else "byte-equivalent copy",
            }
        )

    manifest = {
        "schema_version": 1,
        "source_name": "seedance-20",
        "source_version": "6.7.0",
        "source_root": str(source),
        "canonical_owner": "seedance2-prompt",
        "import_policy": {
            "coverage": "all regular source files",
            "entrypoint_policy": "nested skill entrypoints are inert MODULE.md references",
            "semantic_policy": "canonical fusion routing is defined outside this snapshot",
        },
        "source_file_count": len(records),
        "files": records,
    }
    (destination / "integration-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"imported {len(records)} files into {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
