from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "default-dictionary.js"
TEXT_OUTPUT = ROOT / "data" / "default-dictionary.txt"
META_OUTPUT = ROOT / "data" / "default-dictionary-meta.json"


def extract_assignment(source: str, name: str) -> str:
    match = re.search(rf"window\.{re.escape(name)}\s*=\s*(.*?);\s*", source, re.S)
    if not match:
        raise SystemExit(f"missing {name} in {SOURCE}")
    return match.group(1)


def main() -> None:
    source = SOURCE.read_text(encoding="utf-8")
    meta = json.loads(extract_assignment(source, "KKUNG_DEFAULT_DICTIONARY_META"))
    text = json.loads(extract_assignment(source, "KKUNG_DEFAULT_DICTIONARY_TEXT"))

    TEXT_OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    META_OUTPUT.write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {TEXT_OUTPUT} ({len(text.splitlines()):,} lines)")
    print(f"wrote {META_OUTPUT}")


if __name__ == "__main__":
    main()
