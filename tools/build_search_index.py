from __future__ import annotations

import json
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DICTIONARY_TEXT = DATA / "default-dictionary.txt"
DICTIONARY_META = DATA / "default-dictionary-meta.json"
OUTPUT = DATA / "search-index.json"

HANGUL_BASE = 0xAC00
HANGUL_END = 0xD7A3
VOWEL_COUNT = 21
TRAILING_COUNT = 28
SYLLABLE_BLOCK = VOWEL_COUNT * TRAILING_COUNT
NIEUN = 2
RIEUL = 5
IEUNG = 11
IOTIZED_VOWELS = {2, 3, 6, 7, 12, 17, 20}


def is_hangul_syllable(value: str) -> bool:
    return len(value) == 1 and HANGUL_BASE <= ord(value) <= HANGUL_END


def clean_hangul(value: str) -> str:
    return "".join(char for char in str(value or "") if is_hangul_syllable(char))


def is_hangul_word(value: str) -> bool:
    return bool(value) and all(is_hangul_syllable(char) for char in value)


def decompose_syllable(value: str) -> tuple[int, int, int] | None:
    if not is_hangul_syllable(value):
        return None
    offset = ord(value) - HANGUL_BASE
    return (
        offset // SYLLABLE_BLOCK,
        (offset % SYLLABLE_BLOCK) // TRAILING_COUNT,
        offset % TRAILING_COUNT,
    )


def compose_syllable(lead: int, vowel: int, trail: int) -> str:
    return chr(HANGUL_BASE + lead * SYLLABLE_BLOCK + vowel * TRAILING_COUNT + trail)


def allowed_start_syllables(syllable: str) -> list[str]:
    info = decompose_syllable(syllable)
    if not info:
        return []

    lead, vowel, trail = info
    variants = [syllable]
    seen = {syllable}

    if lead == RIEUL:
        replacement = IEUNG if vowel in IOTIZED_VOWELS else NIEUN
        next_value = compose_syllable(replacement, vowel, trail)
        if next_value not in seen:
            seen.add(next_value)
            variants.append(next_value)

    if lead == NIEUN and vowel in IOTIZED_VOWELS:
        next_value = compose_syllable(IEUNG, vowel, trail)
        if next_value not in seen:
            seen.add(next_value)
            variants.append(next_value)

    return variants


def parse_dictionary() -> tuple[list[dict[str, object]], int]:
    entries_by_key: dict[str, dict[str, object]] = {}
    invalid = 0

    for raw_line in DICTIONARY_TEXT.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        explicit = False
        if "=" in line:
            word, reading = line.split("=", 1)
            word = "".join(word.strip().split())
            reading = clean_hangul(reading)
            explicit = True
        else:
            word = "".join(line.split("/", 1)[0].strip().split())
            reading = clean_hangul(word) if is_hangul_word(word) else ""

        if not word or not reading or len(reading) < 2:
            invalid += 1
            continue

        key = word.lower()
        language = "k" if is_hangul_word(word) else "e"
        entry = {
            "key": key,
            "word": word,
            "reading": reading,
            "language": language,
            "start": reading[0],
            "end": reading[-1],
            "allowed": allowed_start_syllables(reading[-1]),
            "explicit": explicit,
        }
        existing = entries_by_key.get(key)
        if existing is None or (explicit and not existing["explicit"]):
            entries_by_key[key] = entry

    return list(entries_by_key.values()), invalid


def count_by_allowed(entry: dict[str, object], counts: dict[str, int], includes_self: bool) -> int:
    total = sum(counts.get(start, 0) for start in entry["allowed"])  # type: ignore[index]
    if includes_self and entry["start"] in entry["allowed"]:  # type: ignore[operator]
        total -= 1
    return max(0, total)


def count_starts(entries: list[dict[str, object]], predicate) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in entries:
        if predicate(entry):
            start = entry["start"]  # type: ignore[assignment]
            counts[start] = counts.get(start, 0) + 1
    return counts


def classify_entries(entries: list[dict[str, object]], invalid: int) -> dict[str, int]:
    start_counts = count_starts(entries, lambda _entry: True)
    one_shot_start_counts: dict[str, int] = {}
    ko = 0
    en = 0

    for entry in entries:
        follower_count = count_by_allowed(entry, start_counts, True)
        entry["followerCount"] = follower_count
        entry["oneShot"] = follower_count == 0
        entry["oneShotReplyCount"] = 0
        entry["alternativeOneShotReplyCount"] = 0
        entry["killableFollowerCount"] = 0
        entry["alternativeOneShot"] = False
        entry["blunder"] = False
        if entry["oneShot"]:
            start = entry["start"]  # type: ignore[assignment]
            one_shot_start_counts[start] = one_shot_start_counts.get(start, 0) + 1
        if entry["language"] == "k":
            ko += 1
        else:
            en += 1

    for entry in entries:
        entry["oneShotReplyCount"] = count_by_allowed(entry, one_shot_start_counts, bool(entry["oneShot"]))

    changed = True
    passes = 0
    while changed:
        changed = False
        passes += 1

        alternative_start_counts = count_starts(entries, lambda entry: bool(entry["alternativeOneShot"]))
        for entry in entries:
            entry["alternativeOneShotReplyCount"] = count_by_allowed(
                entry,
                alternative_start_counts,
                bool(entry["alternativeOneShot"]),
            )
            if (
                not entry["oneShot"]
                and not entry["alternativeOneShot"]
                and not entry["blunder"]
                and (entry["oneShotReplyCount"] > 0 or entry["alternativeOneShotReplyCount"] > 0)
            ):
                entry["blunder"] = True
                changed = True

        killable_start_counts = count_starts(entries, lambda entry: bool(entry["blunder"]))
        for entry in entries:
            entry["killableFollowerCount"] = count_by_allowed(
                entry,
                killable_start_counts,
                bool(entry["blunder"]),
            )
            if (
                not entry["oneShot"]
                and not entry["alternativeOneShot"]
                and not entry["blunder"]
                and entry["followerCount"] > 0
                and entry["killableFollowerCount"] == entry["followerCount"]
            ):
                entry["alternativeOneShot"] = True
                changed = True

    alternative_start_counts = count_starts(entries, lambda entry: bool(entry["alternativeOneShot"]))
    killable_start_counts = count_starts(entries, lambda entry: bool(entry["blunder"]))
    one_shot = 0
    alternative = 0

    for entry in entries:
        entry["alternativeOneShotReplyCount"] = count_by_allowed(
            entry,
            alternative_start_counts,
            bool(entry["alternativeOneShot"]),
        )
        entry["killableFollowerCount"] = count_by_allowed(
            entry,
            killable_start_counts,
            bool(entry["blunder"]),
        )
        if entry["oneShot"]:
            one_shot += 1
        if entry["alternativeOneShot"]:
            alternative += 1

    return {
        "total": len(entries),
        "ko": ko,
        "en": en,
        "oneShot": one_shot,
        "alternativeOneShot": alternative,
        "invalid": invalid,
        "passes": passes,
    }


def build_index() -> None:
    started = time.perf_counter()
    entries, invalid = parse_dictionary()
    stats = classify_entries(entries, invalid)
    stats["buildMs"] = round((time.perf_counter() - started) * 1000)

    # These are immutable, load-time indexes.  The browser worker consumes
    # byFirstChar for normal and reply searches and keeps byLastChar available
    # for chain analysis without ever scanning the dictionary.
    by_first_char: dict[str, list[int]] = {}
    by_last_char: dict[str, list[int]] = {}
    packed_entries: list[list[object]] = []
    for index, entry in enumerate(entries):
        by_first_char.setdefault(entry["start"], []).append(index)  # type: ignore[arg-type]
        by_last_char.setdefault(entry["end"], []).append(index)  # type: ignore[arg-type]
        category = 0
        if entry["oneShot"]:
            category = 1
        elif entry["alternativeOneShot"]:
            category = 2
        elif entry["blunder"]:
            category = 3
        packed_entries.append(
            [
                entry["word"],
                entry["reading"],
                entry["language"],
                entry["followerCount"],
                entry["oneShotReplyCount"],
                entry["alternativeOneShotReplyCount"],
                category,
                entry["start"],
                entry["end"],
                entry["allowed"],
                entry["key"],
            ]
        )

    # A two-or-more syllable query can binary-search this order rather than
    # filtering every word in the first-syllable bucket.
    for indices in by_first_char.values():
        indices.sort(key=lambda index: (str(entries[index]["reading"]), str(entries[index]["word"])))

    meta = json.loads(DICTIONARY_META.read_text(encoding="utf-8")) if DICTIONARY_META.exists() else {}
    payload = {
        "version": 2,
        "meta": meta,
        "stats": stats,
        "entries": packed_entries,
        "byFirstChar": by_first_char,
        "byLastChar": by_last_char,
        # Kept temporarily so an older shard builder can still read a newly
        # generated full index.  Runtime code reads byFirstChar first.
        "buckets": by_first_char,
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
        newline="\n",
    )
    print(
        f"wrote {OUTPUT} total={stats['total']:,} ko={stats['ko']:,} "
        f"en={stats['en']:,} passes={stats['passes']} buildMs={stats['buildMs']}"
    )


if __name__ == "__main__":
    build_index()
