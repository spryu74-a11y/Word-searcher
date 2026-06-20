"""Validate the immutable v2 search index after rebuilding it."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "data" / "search-index.json"


def main() -> None:
    payload = json.loads(INDEX.read_text(encoding="utf-8"))
    assert payload.get("version") == 2, "run tools/build_search_index.py first"
    entries = payload.get("entries") or []
    by_first = payload.get("byFirstChar") or {}
    by_last = payload.get("byLastChar") or {}
    assert len(entries) == int((payload.get("stats") or {}).get("total") or 0)

    first_seen: set[int] = set()
    for start, indices in by_first.items():
        previous = ""
        for index in indices:
            entry = entries[index]
            assert entry[7] == start
            assert entry[1] >= previous, f"first-char bucket {start} is not reading-sorted"
            previous = entry[1]
            first_seen.add(index)

    last_seen: set[int] = set()
    for end, indices in by_last.items():
        for index in indices:
            entry = entries[index]
            assert entry[8] == end
            assert isinstance(entry[9], list) and entry[9]
            assert entry[10] == str(entry[0]).lower()
            last_seen.add(index)

    expected = set(range(len(entries)))
    assert first_seen == expected, "byFirstChar must cover every entry exactly once"
    assert last_seen == expected, "byLastChar must cover every entry exactly once"

    # Playing 값표 removes 표준값's only safe follow-up; its remaining 값
    # entries are all blunders, so 값표 must be a blunder as well.
    by_key = {str(entry[10]): entry for entry in entries if len(entry) > 10}
    value_table = by_key.get("값표")
    assert value_table is not None, "값표 must be present in the search index"
    assert value_table[5] >= 1, "값표 must expose its return-trap counter"
    assert value_table[6] == 3, "값표 must be categorized as a blunder"
    print(f"search index v2 validated: entries={len(entries):,} first={len(by_first):,} last={len(by_last):,}")


if __name__ == "__main__":
    main()
