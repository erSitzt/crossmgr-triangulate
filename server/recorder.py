"""Session recorder: one JSON header line, then one read per line (JSONL).

Header: {"type": "header", "startedAt": iso, "label": str, "reader": {...config}, "meta": {...}}
Reads:  {"epc", "port", "rssi", "phase", "doppler", "channel", "ts", "n"}
"""
from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TextIO

SESSIONS_DIR = Path(__file__).resolve().parent.parent / "sessions"


class Recorder:
    def __init__(self, directory: Path = SESSIONS_DIR) -> None:
        self.directory = directory
        self._file: Optional[TextIO] = None
        self._lock = threading.Lock()
        self.path: Optional[Path] = None
        self.count = 0

    @property
    def active(self) -> bool:
        return self._file is not None

    def start(self, label: str, reader: dict, meta: dict | None = None) -> Path:
        self.stop()
        self.directory.mkdir(parents=True, exist_ok=True)
        now = datetime.now(timezone.utc)
        slug = re.sub(r"[^A-Za-z0-9_-]+", "-", label).strip("-")[:40] or "session"
        self.path = self.directory / f"{now:%Y%m%d-%H%M%S}-{slug}.jsonl"
        self._file = self.path.open("w", encoding="utf-8")
        self.count = 0
        header = {"type": "header", "startedAt": now.isoformat(), "label": label, "reader": reader, "meta": meta or {}}
        self._file.write(json.dumps(header) + "\n")
        return self.path

    def write(self, reads: list[dict]) -> None:
        with self._lock:
            if not self._file:
                return
            for r in reads:
                self._file.write(json.dumps(r, separators=(",", ":")) + "\n")
            self.count += len(reads)

    def stop(self) -> Optional[Path]:
        with self._lock:
            if not self._file:
                return None
            self._file.close()
            self._file = None
            return self.path

    def status(self) -> dict:
        return {"recording": self.active, "path": self.path.name if self.path else None, "count": self.count}


def list_sessions(directory: Path = SESSIONS_DIR) -> list[dict]:
    if not directory.exists():
        return []
    out = []
    for p in sorted(directory.glob("*.jsonl"), reverse=True):
        with p.open(encoding="utf-8") as f:
            try:
                header = json.loads(f.readline())
            except json.JSONDecodeError:
                header = {}
        out.append({"name": p.name, "label": header.get("label"), "startedAt": header.get("startedAt"),
                    "bytes": p.stat().st_size})
    return out
