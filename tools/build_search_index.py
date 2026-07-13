from __future__ import annotations

import json
import time
from collections import defaultdict, deque
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
# Endings that are always classified as 대체한방. Keep this in sync with the
# browser app and packed search worker.
FORCED_ALTERNATIVE_ENDINGS = {"값", "슨"}


def is_forced_alternative(entry: dict[str, object]) -> bool:
    return entry["language"] == "k" and entry["end"] in FORCED_ALTERNATIVE_ENDINGS


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
        # Word-chain exception: 름 can also continue as 음.
        if syllable == "름" and "음" not in seen:
            seen.add("음")
            variants.append("음")

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


def create_one_shot_counter_start_counts(
    entries: list[dict[str, object]],
) -> dict[str, dict[str, int]]:
    """Index replies that become one-shot once the played word is removed."""
    counts_by_reply_start: dict[str, dict[str, int]] = {}
    for reply in entries:
        if is_forced_alternative(reply) or reply["followerCount"] != 1:
            continue
        reply_start = str(reply["start"])
        counts_by_played_start = counts_by_reply_start.setdefault(reply_start, {})
        for played_start in reply["allowed"]:  # type: ignore[index]
            counts_by_played_start[played_start] = counts_by_played_start.get(played_start, 0) + 1
    return counts_by_reply_start


def create_one_shot_context_reply_indices(
    entries: list[dict[str, object]],
) -> dict[str, dict[str, list[int]]]:
    """Index replies that become one-shot only after the played word is removed."""
    indices_by_reply_start: dict[str, dict[str, list[int]]] = {}
    for index, reply in enumerate(entries):
        if is_forced_alternative(reply) or reply["followerCount"] != 1:
            continue
        by_played_start = indices_by_reply_start.setdefault(str(reply["start"]), {})
        for played_start in reply["allowed"]:  # type: ignore[index]
            by_played_start.setdefault(played_start, []).append(index)
    return indices_by_reply_start


def get_one_shot_context_reply_indices(
    index: int,
    entry: dict[str, object],
    indices_by_reply_start: dict[str, dict[str, list[int]]],
) -> set[int]:
    result: set[int] = set()
    entry_start = str(entry["start"])
    for reply_start in entry["allowed"]:  # type: ignore[index]
        result.update(indices_by_reply_start.get(reply_start, {}).get(entry_start, ()))
    result.discard(index)
    return result


def count_one_shot_counters(
    entry: dict[str, object],
    one_shot_start_counts: dict[str, int],
    counter_start_counts: dict[str, dict[str, int]],
) -> int:
    count = count_by_allowed(entry, one_shot_start_counts, bool(entry["oneShot"]))
    entry_start = str(entry["start"])
    for reply_start in entry["allowed"]:  # type: ignore[index]
        count += counter_start_counts.get(reply_start, {}).get(entry_start, 0)

    # A word cannot be its own reply. Both source counts include that entry
    # when it starts with one of its own allowed continuation syllables.
    if entry["followerCount"] == 1 and entry_start in entry["allowed"]:  # type: ignore[operator]
        if not is_forced_alternative(entry):
            count -= 1
    return max(0, count)


def propagate_static_categories(entries: list[dict[str, object]]) -> int:
    """Propagate context-free blunder and alternative-one-shot categories."""
    changed = True
    passes = 0
    while changed:
        changed = False
        passes += 1

        alternative_start_counts = count_starts(
            entries,
            lambda entry: bool(entry["alternativeOneShot"]),
        )
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
    return passes


def find_context_counter_replies(
    entries: list[dict[str, object]],
) -> dict[int, tuple[set[int], set[int]]]:
    """Find counters created by removing one currently playable connection.

    Only a connection that is another connection's sole connection follower can
    start a cascade.  Each candidate is therefore sparse: removing it updates
    predecessors through a reverse queue, alternating between contextual
    alternatives and blunders until the affected component stabilizes.
    """
    connection_indices = [
        index
        for index, entry in enumerate(entries)
        if not entry["oneShot"] and not entry["alternativeOneShot"] and not entry["blunder"]
    ]
    if not connection_indices:
        return {}

    connection_by_start: dict[str, list[int]] = defaultdict(list)
    reverse_by_allowed_start: dict[str, list[int]] = defaultdict(list)
    for index in connection_indices:
        entry = entries[index]
        connection_by_start[str(entry["start"])].append(index)
        for allowed_start in entry["allowed"]:  # type: ignore[index]
            reverse_by_allowed_start[allowed_start].append(index)

    connection_start_counts = {
        start: len(indices) for start, indices in connection_by_start.items()
    }
    connection_follower_counts: dict[int, int] = {}
    candidate_indices: set[int] = set()
    for index in connection_indices:
        entry = entries[index]
        follower_count = count_by_allowed(entry, connection_start_counts, True)
        connection_follower_counts[index] = follower_count
        if follower_count != 1:
            continue
        for allowed_start in entry["allowed"]:  # type: ignore[index]
            unique_reply = next(
                (
                    reply_index
                    for reply_index in connection_by_start.get(allowed_start, ())
                    if reply_index != index
                ),
                None,
            )
            if unique_reply is not None:
                candidate_indices.add(unique_reply)
                break

    unavailable = 0
    contextual_blunder = 1
    contextual_one_shot = 2
    contextual_alternative = 3
    results: dict[int, tuple[set[int], set[int]]] = {}

    for candidate_index in candidate_indices:
        candidate = entries[candidate_index]
        candidate_start = str(candidate["start"])
        remaining_connection_counts: dict[int, int] = {}
        contextual_states: dict[int, int] = {candidate_index: unavailable}
        queue: deque[tuple[int, int]] = deque(((candidate_index, unavailable),))

        while queue:
            changed_index, changed_state = queue.popleft()
            changed_start = str(entries[changed_index]["start"])
            for predecessor_index in reverse_by_allowed_start.get(changed_start, ()):
                if (
                    predecessor_index == changed_index
                    or predecessor_index == candidate_index
                    or predecessor_index in contextual_states
                ):
                    continue

                remaining = (
                    remaining_connection_counts.get(
                        predecessor_index,
                        connection_follower_counts[predecessor_index],
                    )
                    - 1
                )
                remaining_connection_counts[predecessor_index] = remaining

                if changed_state in (contextual_one_shot, contextual_alternative):
                    next_state = contextual_blunder
                elif remaining == 0:
                    predecessor = entries[predecessor_index]
                    candidate_was_follower = (
                        candidate_index != predecessor_index
                        and candidate_start in predecessor["allowed"]  # type: ignore[operator]
                    )
                    available_follower_count = int(predecessor["followerCount"]) - int(
                        candidate_was_follower
                    )
                    next_state = (
                        contextual_one_shot
                        if available_follower_count == 0
                        else contextual_alternative
                    )
                else:
                    continue

                contextual_states[predecessor_index] = next_state
                queue.append((predecessor_index, next_state))

        one_shot_replies: set[int] = set()
        alternative_replies: set[int] = set()
        for reply_start in candidate["allowed"]:  # type: ignore[index]
            for reply_index in connection_by_start.get(reply_start, ()):
                if reply_index == candidate_index:
                    continue
                reply_state = contextual_states.get(reply_index)
                if reply_state == contextual_one_shot:
                    one_shot_replies.add(reply_index)
                elif reply_state == contextual_alternative:
                    alternative_replies.add(reply_index)

        if one_shot_replies or alternative_replies:
            results[candidate_index] = (one_shot_replies, alternative_replies)

    return results


def classify_entries(entries: list[dict[str, object]], invalid: int) -> dict[str, int]:
    start_counts = count_starts(entries, lambda _entry: True)
    one_shot_start_counts: dict[str, int] = {}
    ko = 0
    en = 0

    for entry in entries:
        follower_count = count_by_allowed(entry, start_counts, True)
        forced_alternative = is_forced_alternative(entry)
        entry["followerCount"] = follower_count
        entry["oneShot"] = not forced_alternative and follower_count == 0
        entry["oneShotReplyCount"] = 0
        entry["alternativeOneShotReplyCount"] = 0
        entry["killableFollowerCount"] = 0
        entry["alternativeOneShot"] = forced_alternative
        entry["blunder"] = False
        entry["_contextOneShotReplyIndices"] = set()
        entry["_contextAlternativeOneShotReplyIndices"] = set()
        entry["contextOneShotReplyWords"] = []
        entry["contextAlternativeOneShotReplyWords"] = []
        if entry["oneShot"]:
            start = entry["start"]  # type: ignore[assignment]
            one_shot_start_counts[start] = one_shot_start_counts.get(start, 0) + 1
        if entry["language"] == "k":
            ko += 1
        else:
            en += 1

    one_shot_counter_start_counts = create_one_shot_counter_start_counts(entries)
    one_shot_context_reply_indices = create_one_shot_context_reply_indices(entries)
    for index, entry in enumerate(entries):
        context_indices = get_one_shot_context_reply_indices(
            index,
            entry,
            one_shot_context_reply_indices,
        )
        entry["_contextOneShotReplyIndices"] = context_indices
        entry["oneShotReplyCount"] = count_one_shot_counters(
            entry,
            one_shot_start_counts,
            one_shot_counter_start_counts,
        )

    passes = propagate_static_categories(entries)

    # Removing a played connection can collapse a longer safe cycle.  Record
    # the reply's contextual category, promote only the played candidate to a
    # blunder, then let the ordinary context-free fixed point absorb the newly
    # established blunder before looking for another affected component.
    while True:
        contextual_counters = find_context_counter_replies(entries)
        if not contextual_counters:
            break
        for index, (one_shot_replies, alternative_replies) in contextual_counters.items():
            entry = entries[index]
            entry["_contextOneShotReplyIndices"].update(one_shot_replies)  # type: ignore[union-attr]
            entry["_contextAlternativeOneShotReplyIndices"].update(  # type: ignore[union-attr]
                alternative_replies
            )
            entry["blunder"] = True
        passes += propagate_static_categories(entries)

    alternative_start_counts = count_starts(entries, lambda entry: bool(entry["alternativeOneShot"]))
    killable_start_counts = count_starts(entries, lambda entry: bool(entry["blunder"]))
    final_one_shot_start_counts = count_starts(entries, lambda entry: bool(entry["oneShot"]))
    one_shot = 0
    alternative = 0

    for index, entry in enumerate(entries):
        context_one_shot_indices: set[int] = entry["_contextOneShotReplyIndices"]  # type: ignore[assignment]
        context_alternative_indices: set[int] = entry[  # type: ignore[assignment]
            "_contextAlternativeOneShotReplyIndices"
        ]
        context_alternative_indices.difference_update(context_one_shot_indices)

        one_shot_reply_count = count_by_allowed(
            entry,
            final_one_shot_start_counts,
            bool(entry["oneShot"]),
        )
        alternative_reply_count = count_by_allowed(
            entry,
            alternative_start_counts,
            bool(entry["alternativeOneShot"]),
        )

        # Contextual categories override the reply's context-free category for
        # this played word.  Adjust rather than add blindly so a later fixed
        # point promotion cannot double-count the same counter.
        for reply_index in context_one_shot_indices:
            if reply_index == index:
                continue
            reply = entries[reply_index]
            if not reply["oneShot"]:
                one_shot_reply_count += 1
            if reply["alternativeOneShot"]:
                alternative_reply_count -= 1
        for reply_index in context_alternative_indices:
            if reply_index == index:
                continue
            reply = entries[reply_index]
            if reply["oneShot"]:
                one_shot_reply_count -= 1
            if not reply["alternativeOneShot"]:
                alternative_reply_count += 1

        entry["oneShotReplyCount"] = max(0, one_shot_reply_count)
        entry["alternativeOneShotReplyCount"] = max(0, alternative_reply_count)
        entry["killableFollowerCount"] = count_by_allowed(
            entry,
            killable_start_counts,
            bool(entry["blunder"]),
        )
        entry["contextOneShotReplyWords"] = [
            str(entries[reply_index]["word"])
            for reply_index in sorted(
                context_one_shot_indices,
                key=lambda reply_index: (
                    str(entries[reply_index]["reading"]),
                    str(entries[reply_index]["word"]),
                ),
            )
            if reply_index != index
        ]
        entry["contextAlternativeOneShotReplyWords"] = [
            str(entries[reply_index]["word"])
            for reply_index in sorted(
                context_alternative_indices,
                key=lambda reply_index: (
                    str(entries[reply_index]["reading"]),
                    str(entries[reply_index]["word"]),
                ),
            )
            if reply_index != index
        ]
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
        packed_entry = [
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
        context_one_shot_words = entry["contextOneShotReplyWords"]
        context_alternative_words = entry["contextAlternativeOneShotReplyWords"]
        if context_one_shot_words or context_alternative_words:
            packed_entry.append([context_one_shot_words, context_alternative_words])
        packed_entries.append(packed_entry)

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
