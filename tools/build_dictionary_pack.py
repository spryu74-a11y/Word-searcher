from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DEFAULT_KO_DIC = DATA / "ko-aff-dic-0.7.94" / "ko.dic"
DEFAULT_ENGLISH = DATA / "english_words.txt"
DEFAULT_EXTRA = DATA / "extra_terms.txt"
DEFAULT_USER_WORDS = DATA / "korean_words_natural_common_2023.txt"
DEFAULT_OFFICIAL_WORDS = DATA / "official_words_big_sorted_cleaner.txt"
DEFAULT_DICTIONARY_WORDS = DATA / "korean_dictionary_words_cleaned.txt"
DEFAULT_ARCHAIC_WORDS = DATA / "korean_dictionary_words_with_archaic.txt"
DEFAULT_OPENDICT_EXTRA_WORDS = DATA / "korean_words_opendict_extra.txt"
DEFAULT_NAVER_DICT_WORDS = DATA / "korean_words_with_naver_dict.txt"
DEFAULT_CLEANED_DICTIONARY_WORDS = DATA / "korean_words_dictionary_cleaned.txt"
DEFAULT_WORDROW_MERGED_WORDS = DATA / "korean_words_dictionary_wordrow_merged.txt"
DEFAULT_WORDROW_ONESHOT_WORDS = DATA / "wordrow_oneshot_terms.txt"
DEFAULT_WOORIMALSAEM_WORDS = DATA / "woorimalsam_words.txt"
DEFAULT_PYOJUN_WORDS = DATA / "pyojun_words.txt"
DEFAULT_STDICT_API_WORDS = DATA / "stdict_api_words.txt"
DEFAULT_DIALECT = DATA / "dialect_terms.txt"
DEFAULT_EXCLUDED = DATA / "excluded_terms.txt"
DEFAULT_OUTPUT = DATA / "default-dictionary.js"

HANGUL_RE = re.compile(r"^[가-힣]+$")
ENGLISH_RE = re.compile(r"^[A-Za-z]+$")
WEAK_DEFAULT_PACKS = {
    DEFAULT_CLEANED_DICTIONARY_WORDS.resolve(),
    DEFAULT_WORDROW_MERGED_WORDS.resolve(),
}
HUNSPELL_SURFACE_FORM_FLAGS = {"2", "3", "4"}
BLOCKED_WORDS = {
    "다름스타튬",
    "늠손가락",
    "는저가락",
    "늣저가락",
    "늦저가락",
    "늠밤통",
}
HANGUL_LETTER_NAMES = (
    "쌍기역",
    "쌍디귿",
    "쌍비읍",
    "쌍시옷",
    "쌍지읒",
    "기역",
    "니은",
    "디귿",
    "리을",
    "미음",
    "비읍",
    "시옷",
    "이응",
    "지읒",
    "치읓",
    "키읔",
    "티읕",
    "피읖",
    "히읗",
)
HANGUL_BASE = 0xAC00
HANGUL_END = 0xD7A3
VOWEL_COUNT = 21
TRAILING_COUNT = 28
SYLLABLE_BLOCK = VOWEL_COUNT * TRAILING_COUNT
RIEUL = 5
IEUNG = 11
TRAILING_DIGEUT = 7
TRAILING_RIEUL = 8
VOWEL_A = 0
VOWEL_EO = 4
VOWEL_YEO = 6
VOWEL_O = 8
VOWEL_WA = 9
VOWEL_U = 13
VOWEL_WEO = 14
VOWEL_EU = 18
VOWEL_I = 20
SURFACE_FORM_LEMMA_SUFFIXES = [
    ("져", "지다"),
    ("겨", "기다"),
    ("켜", "키다"),
    ("쳐", "치다"),
    ("려", "리다"),
    ("쥬", "다"),
    ("죠", "다"),
    ("지요", "다"),
    ("해", "하다"),
    ("해요", "하다"),
    ("하여", "하다"),
    ("한", "하다"),
    ("할", "하다"),
    ("돼요", "되다"),
    ("로워", "롭다"),
    ("러워", "럽다"),
    ("거워", "겁다"),
    ("겨워", "겹다"),
    ("까워", "깝다"),
    ("다워", "답다"),
    ("스러워", "스럽다"),
    ("려워", "렵다"),
    ("쉬워", "쉽다"),
]
SHORT_SURFACE_FORM_SUFFIXES = {"해", "하여", "한", "할"}
SURFACE_FORM_EXCEPTIONS = {"버릊", "몽따쥬"}
NON_WORD_SURFACE_FORMS = {
    "몽띠쥬",
    "이쁘쥬",
    "해요",
    "지요",
    "군요",
    "구나",
    "는구나",
    "로구나",
    "습니다",
    "옜습니다",
    "올습니다",
    "읍니다",
    "아요",
    "어요",
    "시어요",
    "으시어요",
    "습죠",
    "읍죠",
    "습지요",
    "읍지요",
    "지긴지요",
}

ENGLISH_OVERRIDES = {
    "acetone": "아세톤",
    "acid": "애시드",
    "alcohol": "알코올",
    "aldehyde": "알데하이드",
    "alkane": "알케인",
    "alkene": "알켄",
    "alkyne": "알카인",
    "ammonia": "암모니아",
    "aniline": "아닐린",
    "apple": "애플",
    "argon": "아르곤",
    "aspirin": "아스피린",
    "banana": "바나나",
    "benzaldehyde": "벤즈알데하이드",
    "benzene": "벤젠",
    "butane": "뷰테인",
    "butanol": "부탄올",
    "caffeine": "카페인",
    "calcium": "칼슘",
    "camera": "카메라",
    "carbon": "카본",
    "chloride": "클로라이드",
    "chlorine": "클로린",
    "chocolate": "초콜릿",
    "chemistry": "케미스트리",
    "chloroform": "클로로폼",
    "coffee": "커피",
    "computer": "컴퓨터",
    "cookie": "쿠키",
    "copper": "카퍼",
    "decane": "데케인",
    "dioxide": "다이옥사이드",
    "ethane": "에테인",
    "ethanol": "에탄올",
    "ether": "에터",
    "ethylene": "에틸렌",
    "fructose": "프럭토스",
    "game": "게임",
    "glucose": "글루코스",
    "helium": "헬륨",
    "heptane": "헵테인",
    "hexane": "헥세인",
    "hydrogen": "하이드로젠",
    "iodine": "아이오딘",
    "iron": "아이언",
    "ketone": "케톤",
    "lithium": "리튬",
    "lemon": "레몬",
    "methane": "메테인",
    "methanol": "메탄올",
    "music": "뮤직",
    "neon": "네온",
    "nitrate": "나이트레이트",
    "nitrogen": "나이트로젠",
    "nonane": "노네인",
    "octane": "옥테인",
    "orange": "오렌지",
    "oxygen": "옥시전",
    "phenol": "페놀",
    "phosphate": "포스페이트",
    "phosphorus": "포스퍼러스",
    "piano": "피아노",
    "pizza": "피자",
    "potassium": "포타슘",
    "propane": "프로페인",
    "propanol": "프로판올",
    "protein": "프로틴",
    "radio": "라디오",
    "robot": "로봇",
    "sandwich": "샌드위치",
    "secret": "시크릿",
    "silicon": "실리콘",
    "sodium": "소듐",
    "sucrose": "수크로스",
    "sulfate": "설페이트",
    "sulfur": "설퍼",
    "taxi": "택시",
    "toluene": "톨루엔",
    "water": "워터",
    "xenon": "제논",
}

PHONETIC_PATTERNS = [
    ("eigh", "에이"),
    ("ough", "오"),
    ("augh", "오"),
    ("tion", "션"),
    ("sion", "션"),
    ("cial", "셜"),
    ("tial", "셜"),
    ("ph", "프"),
    ("ch", "치"),
    ("sh", "시"),
    ("th", "스"),
    ("ck", "크"),
    ("qu", "쿼"),
    ("xyl", "자일"),
    ("chem", "켐"),
    ("chl", "클"),
    ("chr", "크르"),
    ("sch", "스쿨"),
    ("ing", "잉"),
    ("ium", "이움"),
    ("ane", "에인"),
    ("ene", "엔"),
    ("yne", "아인"),
    ("ose", "오스"),
    ("ide", "아이드"),
    ("ate", "에이트"),
    ("ite", "아이트"),
    ("one", "온"),
    ("ol", "올"),
    ("oo", "우"),
    ("ee", "이"),
    ("ea", "이"),
    ("ai", "에이"),
    ("ay", "에이"),
    ("oa", "오"),
    ("ou", "아우"),
    ("ow", "오"),
    ("oi", "오이"),
    ("oy", "오이"),
    ("er", "어"),
    ("ir", "어"),
    ("ur", "어"),
    ("ar", "아"),
    ("or", "오"),
    ("le", "을"),
]

LETTER_READINGS = {
    "a": "아",
    "b": "브",
    "c": "크",
    "d": "드",
    "e": "이",
    "f": "프",
    "g": "그",
    "h": "흐",
    "i": "이",
    "j": "지",
    "k": "크",
    "l": "르",
    "m": "므",
    "n": "느",
    "o": "오",
    "p": "프",
    "q": "큐",
    "r": "르",
    "s": "스",
    "t": "트",
    "u": "유",
    "v": "브",
    "w": "우",
    "x": "엑스",
    "y": "이",
    "z": "즈",
}


def read_korean_hunspell(path: Path) -> list[str]:
    words: list[str] = []
    if not path.exists():
        return words

    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
        line = line.strip()
        if not line:
            continue
        if index == 0 and line.isdigit():
            continue
        raw_word, _, raw_flags = line.partition("/")
        flags = {flag.strip() for flag in raw_flags.split(",") if flag.strip()}
        if flags & HUNSPELL_SURFACE_FORM_FLAGS:
            continue
        word = unicodedata.normalize("NFC", raw_word.strip())
        if HANGUL_RE.fullmatch(word):
            words.append(word)
    return words


def read_english_words(path: Path) -> list[str]:
    words: list[str] = []
    if not path.exists():
        return words

    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        word = line.strip()
        if ENGLISH_RE.fullmatch(word):
            lowered = word.lower()
            words.append(f"{lowered}={english_to_hangul(lowered)}")
    return words


def english_to_hangul(word: str) -> str:
    if word in ENGLISH_OVERRIDES:
        return ENGLISH_OVERRIDES[word]

    result: list[str] = []
    index = 0
    while index < len(word):
        matched = None
        for pattern, reading in PHONETIC_PATTERNS:
            if word.startswith(pattern, index):
                matched = (pattern, reading)
                break
        if matched:
            result.append(matched[1])
            index += len(matched[0])
            continue
        result.append(LETTER_READINGS.get(word[index], ""))
        index += 1
    return "".join(result)


def read_optional_word_file(path: Path) -> list[str]:
    if not path.exists():
        return []

    words: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        value = unicodedata.normalize("NFC", line.strip().lstrip("\ufeff"))
        if not value or value.startswith("#"):
            continue
        if "=" in value:
            word, reading = value.split("=", 1)
            word = word.strip()
            reading = reading.strip()
            if (HANGUL_RE.fullmatch(word) or ENGLISH_RE.fullmatch(word)) and HANGUL_RE.fullmatch(reading):
                words.append(f"{word}={reading}")
            continue
        parenthetical = re.fullmatch(r"([가-힣]+)\(([가-힣]+)\)", value)
        if parenthetical:
            words.extend(parenthetical.groups())
            continue
        if HANGUL_RE.fullmatch(value) or ENGLISH_RE.fullmatch(value):
            words.append(value)
    return words


def read_excluded_words(path: Path) -> set[str]:
    if not path.exists():
        return set()

    excluded: set[str] = set()
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        word = value.split("=", 1)[0].strip()
        if HANGUL_RE.fullmatch(word) or ENGLISH_RE.fullmatch(word):
            excluded.add(word.lower())
    return excluded


def unique_ordered(words: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []

    for word in words:
        key = word.split("=", 1)[0].lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(word)
    return result


def is_combined_hangul_letter_name(value: str) -> bool:
    word = re.sub(r"\s+", "", value or "")
    if not word:
        return False

    index = 0
    count = 0
    while index < len(word):
        name = next(
            (candidate for candidate in HANGUL_LETTER_NAMES if word.startswith(candidate, index)),
            None,
        )
        if not name:
            return False
        index += len(name)
        count += 1

    return count >= 2


def word_key(line: str) -> str:
    return line.split("=", 1)[0].lower()


def word_text(line: str) -> str:
    return line.split("=", 1)[0].strip()


def is_hangul_syllable(value: str) -> bool:
    return len(value) == 1 and HANGUL_BASE <= ord(value) <= HANGUL_END


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


def surface_form_lemma_keys(word: str) -> set[str]:
    candidates: set[str] = set()

    def add_lemma(value: str) -> None:
        lemma = value.lower()
        if lemma and lemma != word.lower():
            candidates.add(lemma)

    def add_suffix_lemma(suffix: str, lemma_suffix: str) -> None:
        if not word.endswith(suffix):
            return
        if suffix in SHORT_SURFACE_FORM_SUFFIXES and len(word) <= len(suffix) + 1:
            return
        add_lemma(f"{word[:-len(suffix)]}{lemma_suffix}")

    for suffix, lemma_suffix in SURFACE_FORM_LEMMA_SUFFIXES:
        add_suffix_lemma(suffix, lemma_suffix)

    if word.endswith("돼"):
        add_lemma(f"{word[:-1]}되다")
    for suffix in ("어", "아", "여"):
        if word.endswith(suffix) and len(word) > len(suffix):
            add_lemma(f"{word[:-len(suffix)]}다")

    info = decompose_syllable(word[-1])
    if not info:
        return candidates

    lead, vowel, trail = info
    if trail != 0:
        return candidates

    prefix = word[:-1]
    if vowel == VOWEL_YEO:
        add_lemma(f"{prefix}{compose_syllable(lead, VOWEL_I, 0)}다")
    if vowel == VOWEL_WA:
        add_lemma(f"{prefix}{compose_syllable(lead, VOWEL_O, 0)}다")
    if vowel == VOWEL_WEO:
        add_lemma(f"{prefix}{compose_syllable(lead, VOWEL_U, 0)}다")
    if vowel in {VOWEL_A, VOWEL_EO} and lead != IEUNG:
        add_lemma(f"{prefix}{compose_syllable(lead, VOWEL_EU, 0)}다")
    if word.endswith("어") and len(word) > 1:
        previous_info = decompose_syllable(word[-2])
        if previous_info and previous_info[2] == TRAILING_RIEUL:
            previous_lead, previous_vowel, _ = previous_info
            add_lemma(
                f"{word[:-2]}{compose_syllable(previous_lead, previous_vowel, TRAILING_DIGEUT)}다"
            )
    if vowel in {VOWEL_A, VOWEL_EO} and lead == RIEUL and len(word) > 1:
        previous_info = decompose_syllable(word[-2])
        if previous_info and previous_info[2] == TRAILING_RIEUL:
            previous_lead, previous_vowel, _ = previous_info
            add_lemma(
                f"{word[:-2]}{compose_syllable(previous_lead, previous_vowel, 0)}"
                f"{compose_syllable(RIEUL, VOWEL_EU, 0)}다"
            )

    return candidates


def is_conjugated_surface_form(line: str, all_keys: set[str]) -> bool:
    word = word_text(line)
    if len(word) < 2 or not HANGUL_RE.fullmatch(word):
        return False
    if word in SURFACE_FORM_EXCEPTIONS:
        return False
    if word in NON_WORD_SURFACE_FORMS:
        return True

    if len(word) >= 2 and f"{word}다".lower() in all_keys:
        return True

    for lemma in surface_form_lemma_keys(word):
        if lemma in all_keys:
            return True
    return False


def build_pack(
    korean_path: Path,
    english_path: Path,
    extra_paths: list[Path],
    excluded_path: Path,
    include_dialect: bool,
    output_path: Path,
) -> None:
    korean = unique_ordered(read_korean_hunspell(korean_path))
    english = unique_ordered(read_english_words(english_path))
    effective_extra_paths = list(extra_paths)
    has_dialect = any(path.resolve() == DEFAULT_DIALECT.resolve() for path in effective_extra_paths)
    if include_dialect and not has_dialect:
        effective_extra_paths.append(DEFAULT_DIALECT)
        has_dialect = True

    trusted_extras: list[str] = []
    weak_extras: list[str] = []
    trusted_extra_keys: set[str] = set()
    protected_extra_keys: set[str] = set()
    for path in effective_extra_paths:
        words = read_optional_word_file(path)
        if path.resolve() in WEAK_DEFAULT_PACKS:
            weak_extras.extend(words)
        else:
            trusted_extras.extend(words)
            keys = {word_key(word) for word in words}
            trusted_extra_keys.update(keys)
            protected_extra_keys.update(keys)

    excluded = read_excluded_words(excluded_path) | BLOCKED_WORDS
    trusted_keys = trusted_extra_keys | {word_key(line) for line in korean}
    filtered_weak_extras = [word for word in weak_extras if word_key(word) in trusted_keys]
    filtered = len(weak_extras) - len(filtered_weak_extras)
    extras = trusted_extras + filtered_weak_extras
    candidate_lines = unique_ordered(extras + korean + english)
    candidate_keys = {word_key(line) for line in candidate_lines}
    surface_forms = {
        word_key(line)
        for line in candidate_lines
        if is_conjugated_surface_form(line, candidate_keys)
    }
    letter_name_compounds = {
        word_key(line)
        for line in candidate_lines
        if is_combined_hangul_letter_name(word_text(line))
    }
    blocked_words = {
        word_key(line)
        for line in candidate_lines
        if word_key(line) in BLOCKED_WORDS
    }
    unfiltered_lines = [
        line
        for line in candidate_lines
        if word_key(line) not in surface_forms
        and word_key(line) not in letter_name_compounds
        and word_key(line) not in blocked_words
        and (word_key(line) not in excluded or word_key(line) in protected_extra_keys)
    ]
    lines = unfiltered_lines
    text = "\n".join(lines)
    local_sources = [f"local {path.name}" for path in effective_extra_paths]
    meta = {
        "korean": len(korean),
        "english": len(english),
        "extra": len(extras),
        "excluded": len(excluded),
        "filtered": filtered,
        "blockedWords": len(blocked_words),
        "hunspellSkippedSurfaceFlags": sorted(HUNSPELL_SURFACE_FORM_FLAGS),
        "letterNameCompounds": len(letter_name_compounds),
        "surfaceForms": len(surface_forms),
        "includeDialect": has_dialect,
        "totalLines": len(lines),
        "sources": [
            "spellcheck-ko/hunspell-dict-ko 0.7.94 ko.dic",
            "dwyl/english-words words_alpha.txt",
            *local_sources,
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "window.KKUNG_DEFAULT_DICTIONARY_META = "
        + json.dumps(meta, ensure_ascii=False)
        + ";\nwindow.KKUNG_DEFAULT_DICTIONARY_TEXT = "
        + json.dumps(text, ensure_ascii=False)
        + ";\n",
        encoding="utf-8",
    )

    print(f"wrote {output_path}")
    print(
        f"korean={len(korean)} english={len(english)} extra={len(extras)} "
        f"filtered={filtered} total={len(lines)}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ko", type=Path, default=DEFAULT_KO_DIC)
    parser.add_argument("--english", type=Path, default=DEFAULT_ENGLISH)
    parser.add_argument(
        "--extra",
        type=Path,
        action="append",
        default=[
            DEFAULT_EXTRA,
            DEFAULT_USER_WORDS,
            DEFAULT_OFFICIAL_WORDS,
            DEFAULT_DICTIONARY_WORDS,
            DEFAULT_ARCHAIC_WORDS,
            DEFAULT_DIALECT,
            DEFAULT_OPENDICT_EXTRA_WORDS,
            DEFAULT_NAVER_DICT_WORDS,
            DEFAULT_WOORIMALSAEM_WORDS,
            DEFAULT_PYOJUN_WORDS,
            DEFAULT_STDICT_API_WORDS,
            DEFAULT_CLEANED_DICTIONARY_WORDS,
            DEFAULT_WORDROW_ONESHOT_WORDS,
            DEFAULT_WORDROW_MERGED_WORDS,
        ],
    )
    parser.add_argument("--excluded", type=Path, default=DEFAULT_EXCLUDED)
    parser.add_argument("--include-dialect", action="store_true")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    build_pack(args.ko, args.english, args.extra, args.excluded, args.include_dialect, args.output)


if __name__ == "__main__":
    main()
