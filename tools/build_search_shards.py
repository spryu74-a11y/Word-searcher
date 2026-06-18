from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SOURCE = DATA / "search-index.json"
OUTPUT_DIR = DATA / "search-index-shards"
MANIFEST = DATA / "search-index-manifest.json"


def shard_name(start: str) -> str:
    return f"{ord(start):04x}.json"


def build_shards() -> None:
    payload = json.loads(SOURCE.read_text(encoding="utf-8"))
    entries = payload.get("entries") or []
    buckets = payload.get("buckets") or {}

    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest_shards: dict[str, dict[str, object]] = {}
    for start, indices in sorted(buckets.items()):
        file_name = shard_name(start)
        shard_entries = []
        for index in indices:
            entry = entries[index]
            shard_entries.append([index, *entry])

        shard_payload = {
            "version": 1,
            "start": start,
            "entries": shard_entries,
        }
        (OUTPUT_DIR / file_name).write_text(
            json.dumps(shard_payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
            newline="\n",
        )
        manifest_shards[start] = {
            "file": file_name,
            "count": len(shard_entries),
        }

    manifest = {
        "version": 1,
        "meta": payload.get("meta") or {},
        "stats": payload.get("stats") or {},
        "total": len(entries),
        "shards": manifest_shards,
    }
    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
        newline="\n",
    )

    largest = sorted(
        ((start, info["count"], info["file"]) for start, info in manifest_shards.items()),
        key=lambda item: int(item[1]),
        reverse=True,
    )[:10]
    print(f"wrote {MANIFEST}")
    print(f"shards={len(manifest_shards)} total={len(entries):,}")
    print("largest=" + ", ".join(f"{start}:{count}" for start, count, _file in largest))


if __name__ == "__main__":
    build_shards()
