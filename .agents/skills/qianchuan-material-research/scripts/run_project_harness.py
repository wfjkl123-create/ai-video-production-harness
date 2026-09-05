"""Run a workspace Qianchuan research harness if the project provides one."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path.cwd()
    entrypoint = root / "run_qianchuan_research.py"
    if not entrypoint.exists():
        print(f"Missing {entrypoint}")
        return 1
    return subprocess.call([sys.executable, str(entrypoint)])


if __name__ == "__main__":
    raise SystemExit(main())

